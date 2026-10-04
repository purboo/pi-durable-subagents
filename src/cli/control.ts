import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Outbox } from "../kernel/mailbox.ts";
import { readJournalSnapshot } from "../kernel/journal.ts";
import { reduceLifecycle, type DecisionRecord } from "../kernel/lifecycle.ts";
import { OsLock } from "../platform/lock.ts";
import { orchInbox, orchLedger, orchLock, outboxRoot } from "../paths.ts";
import type { DrainBody, Request } from "../types.ts";

export type Control = "resume" | "drain" | "stop" | "stop-all";
/** P1: Start the detached orchestrator only after probing its OS lock. */
export async function startOrchestrator(home: string, env: NodeJS.ProcessEnv): Promise<void> {
  const lock = await new OsLock().tryAcquire(orchLock(home));
  if (!lock) return;
  await lock.release();
  const entry = env.DSA_ORCHESTRATOR_ENTRY ?? fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../orchestrator/main.ts" : "../orchestrator/main.js", import.meta.url));
  const child = spawn(process.execPath, [entry], { detached: true, stdio: "ignore", env: { ...env, DSA_HOME: home } });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
}
/** P5, P38: Serialize the stable CLI sender across processes and recover its durable outbox. */
export async function submit(home: string, command: Control, target?: string, env: NodeJS.ProcessEnv = process.env): Promise<Request[]> {
  if (command === "stop" && !target) throw new Error("stop requires a workflow or call id");
  await mkdir(home, { recursive: true });
  const sender = `cli:${userInfo().username}@${hostname()}`;
  const locker = new OsLock(), deadline = performance.now() + 10_000;
  let lock = await locker.tryAcquire(join(home, `${sender}.lock`));
  while (!lock && performance.now() < deadline) { await delay(50); lock = await locker.tryAcquire(join(home, `${sender}.lock`)); }
  if (!lock) throw new Error("CLI sender is busy; retry the command");
  try {
    const outbox = await Outbox.open(outboxRoot(home), sender, () => orchInbox(home));
    try {
      const records = readJournalSnapshot(orchLedger(home)).filter(e => ["admitted", "applied", "rejected", "withdrawn"].includes(e.type)) as unknown as DecisionRecord[];
      for (const rid of reduceLifecycle(records).resolved.keys()) await outbox.markResolved(rid);
      await outbox.republishPending();
      const requests: Request[] = [];
      if (command === "stop-all") {
        const body: DrainBody = { fence: true };
        requests.push(await outbox.send("orch", "drain", body));
      } else requests.push(await outbox.send("orch", command, command === "stop" ? { target } : command === "resume" && target ? { wid: target } : {}));
      // Publish first: even a starter failure leaves a recoverable request and no idle-exit race.
      await startOrchestrator(home, env);
      return requests;
    } finally { await outbox.close(); }
  } finally { await lock.release(); }
}
