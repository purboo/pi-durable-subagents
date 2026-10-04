import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Outbox, scanInbox } from "../kernel/mailbox.ts";
import { readJournalSnapshot } from "../kernel/journal.ts";
import { reduceLifecycle, type DecisionRecord } from "../kernel/lifecycle.ts";
import { OsLock } from "../platform/lock.ts";
import { orchInbox, orchLedger, orchLock, outboxRoot } from "../paths.ts";
import { unfinishedWorkflow } from "../agent/main/snapshots.ts";
import { JT, type DrainBody, type Request } from "../types.ts";

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
/** P1, P38: Requests addressed to the orchestrator that some sender recorded as sent and that neither the sender nor the
 *  ledger has resolved. Read-only: other senders' outboxes are never modified here. */
async function pendingOutboxes(home: string): Promise<boolean> {
  const dir = join(outboxRoot(home), "outbox");
  const names = await readdir(dir).catch(error => { if (error.code === "ENOENT") return [] as string[]; throw error; });
  const ledger = readJournalSnapshot(orchLedger(home));
  const decided = reduceLifecycle(ledger.filter(e => [JT.admitted, JT.applied, JT.rejected, JT.withdrawn].includes(e.type as typeof JT.admitted)) as unknown as DecisionRecord[]).resolved;
  const created = new Set(ledger.filter(e => e.type === JT.created).map(e => String(e.rid)));
  for (const name of names.filter(n => n.endsWith(".jsonl"))) {
    const pending = new Map<string, Request>();
    for (const entry of readJournalSnapshot(join(dir, name))) {
      if (entry.type === "sent") { const req = entry.request as Request; pending.set(req.rid, req); }
      else if (entry.type === "resolved") pending.delete(String(entry.rid));
    }
    for (const req of pending.values()) if (req.to === "orch" && !decided.has(req.rid) && !created.has(req.rid)) return true;
  }
  return false;
}
/** P1: The pending-work rule shared with the main agent's starter: a non-empty orchestrator inbox, a pending
 *  request to the orchestrator in any sender outbox, a workflow without JT.done, or an unsealed generation. */
export async function pendingWork(home: string): Promise<boolean> {
  return (await scanInbox(orchInbox(home))).length > 0 || await pendingOutboxes(home) || unfinishedWorkflow(home);
}
/** P1: The optional service's starter: start the orchestrator only when work is pending; publish no request
 *  (unlike `resume`, it never undoes a drain or stop-all). Returns whether the starter was invoked. */
export async function start(home: string, env: NodeJS.ProcessEnv, starter: (home: string, env: NodeJS.ProcessEnv) => Promise<void> = startOrchestrator): Promise<boolean> {
  if (!await pendingWork(home)) return false;
  await starter(home, env);
  return true;
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
