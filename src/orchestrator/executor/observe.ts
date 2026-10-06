// Private workflow entries: observation{exec,event}; timeout-intent{exec,call}; settled{exec}.
// time{exec,active} is per execution; stall attention stores exec/horizon only for live re-arm.
import { appendFileSync, watch } from "node:fs";
import { join } from "node:path";
import { stat as fileStat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { JT, type Entry, type ProcInfo, type Spawned } from "../../types.ts";
import { callDir, callSession } from "../../paths.ts";
import { monotoneTime } from "../../kernel/guards.ts";
import type { CallTicket, OrchestratorConfig } from "../contract.ts";
import { readSession, type SessionEntry } from "./session.ts";
import { ActiveTime, activeTotal } from "./time.ts";
import { observation, reached, sessionUsage, totalUsage, type Usage } from "./usage.ts";

type Dependencies = {
  home: string; config: OrchestratorConfig; ticket: CallTicket; exec: string; child: Spawned;
  setWake(fn: () => void): void; interrupted(): boolean;
  serial<T>(fn: () => Promise<T>): Promise<T>;
  /** Incremental native session read (defaults to readSession of the call's session). */
  read?(): Promise<SessionEntry[]>;
  track(): Promise<ProcInfo[]>; fence(): Promise<void>;
  questions(entries: SessionEntry[]): Promise<void>;
  recordUsage(values: { id: string; usage: Usage }[]): Promise<void>;
  switched(event: Record<string, unknown>): Promise<void>;
  pendingSwitch(): Entry | undefined;
};
/** P18, P31, P9: Observe slim evidence, decide limits and fence before returning to settlement. */
export async function observeExecution(d: Dependencies) {
  const { home, config, ticket: t, exec, child, serial } = d;
  const session = callSession(home, t.wid, t.key, t.gen), clock = new ActiveTime(), started = clock.last;
  const prior = activeTotal(t.journal.entries(), t.callId);
  let size = (await fileStat(session).catch(() => ({ size: 0 }))).size, checkpoint = performance.now();
  let signal!: () => void;
  const boundary = new Promise<void>(resolve => { signal = resolve; d.setWake(resolve); });
  let failure: unknown, pending: Promise<unknown> = Promise.resolve(), ending = false;
  const has = (type: string) => t.journal.entries().some(e => e.type === type && e.exec === exec);
  const enqueue = (fn: () => Promise<unknown>) => { if (!ending) pending = pending.then(fn).catch(error => { failure = error; signal(); }); };
  const saveTime = () => serial(async () => {
    const previous = t.journal.entries().findLast(e => e.type === "time" && e.exec === exec);
    if (!monotoneTime({ active: Number(previous?.active ?? 0) }, { active: clock.active })) throw new Error("Nonmonotone active time");
    await t.journal.append("time", { exec, active: clock.active });
  });
  const limits = async () => {
    if (t.spec.timeoutMs !== undefined && prior + clock.active >= t.spec.timeoutMs) {
      await serial(async () => { if (!has("timeout-intent")) await t.journal.append("timeout-intent", { exec, call: t.callId }); }); signal();
    }
    if (reached(totalUsage(t.journal.entries(), t.callId), t.spec.budget)) signal();
  };
  const stall = () => serial(async () => {
    const id = `stall:${t.callId}`;
    const items = t.journal.entries().filter(e => e.type === JT.attention && (e.item as { id: string }).id === id);
    const last = items.at(-1)?.item as { rev: number } | undefined;
    const open = last && !t.journal.entries().some(e => e.type === JT.attentionResolved && e.id === id && e.rev === last.rev);
    const fresh = items.at(-1)?.exec === exec ? clock.last > Number(items.at(-1)?.horizon) : clock.last > started;
    if (open && fresh) await t.journal.append(JT.attentionResolved, { id, rev: last!.rev, resolution: "activity" });
    else if (!open && !clock.asking && performance.now() - clock.last >= (config.k?.stallMs ?? 600000))
      await t.journal.append(JT.attention, { exec, horizon: clock.last, item: { id, rev: (last?.rev ?? 0) + 1, kind: "stall", text: "No execution activity", wid: t.wid, call: t.callId } });
  });
  child.stdin.on("error", () => {});
  // Diagnostics only (never evidence for decisions): keep the first 256 KiB of the child's stderr per call.
  let logged = 0; const log = join(callDir(home, t.wid, t.key, t.gen), "stderr.log");
  child.stderr.on("data", (chunk: Buffer) => { if (logged < 262144) { logged += chunk.length; try { appendFileSync(log, chunk.subarray(0, Math.max(0, 262144 - logged + chunk.length))); } catch { /* best effort */ } } });
  const lines = createInterface({ input: child.stdout });
  const drained = new Promise<void>(resolve => lines.once("close", () => resolve()));
  lines.on("line", line => {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line); } catch { return; }
    if (ending) return;
    // P18: Apply RPC boundaries at receipt, before any in-flight scan can resume.
    // Durable observations remain queued; clock transitions never wait on I/O.
    clock.event(event, performance.now());
    enqueue(async () => {
      const slim = observation(event);
      if (slim) {
        await serial(() => t.journal.append("observation", { exec, event: slim }));
        if (event.type === "message_start") await d.switched(event);
        if (event.type === "message_end") await d.recordUsage([{ id: String(slim.id), usage: slim.usage as Usage }]);
      }
      await limits(); await stall();
      if (event.type === "agent_settled") {
        await serial(async () => { if (!has("settled")) await t.journal.append("settled", { exec }); }); signal();
      }
    });
  });
  let scanning = false;
  const scan = () => {
    if (scanning) return;
    scanning = true;
    enqueue(async () => { try {
      clock.scan(await d.track());
      const nextSize = (await fileStat(session).catch(() => ({ size: 0 }))).size;
      if (nextSize > size) { clock.evidence(); size = nextSize; }
      const entries = await (d.read ? d.read() : readSession(session));
      await d.questions(entries); await d.recordUsage(sessionUsage(entries, t.callId));
      await limits(); await stall();
      if (performance.now() - checkpoint >= (config.k?.checkpointMs ?? 10000)) { await saveTime(); checkpoint = performance.now(); }
      const reservation = d.pendingSwitch();
      if (reservation && Date.now() - reservation.ts >= (config.k?.switchTimeoutMs ?? 300000)) signal();
    } finally { scanning = false; } });
  };
  const timer = setInterval(scan, config.k?.trackerMs ?? 1000);
  const watcher = watch(callDir(home, t.wid, t.key, t.gen), scan);
  watcher.on("error", () => {});
  try {
    if (d.interrupted()) signal();
    // `exit` can fire before the child's last stdout lines are read (seen on loaded CI): an agent_settled still in the
    // pipe would be dropped and a finished run counted as a loss and run again. Read to the end of its output first,
    // bounded, since a grandchild may still hold the pipe open.
    if (await Promise.race([boundary.then(() => false), child.exited.then(() => true)])) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([drained, new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
      clearTimeout(timer);
    }
  } finally {
    watcher.close(); clearInterval(timer); d.setWake(() => {}); ending = true; await pending;
    await d.fence(); await saveTime();
    lines.close(); child.stdout.resume();
  }
  if (failure) throw failure;
}
