// Private journal entries (A1): tracked{exec,pid,start}; loss{exec}; settled{exec};
// stop-intent{call}; forward{rid,rid2,dest,hash,envelope:{to,kind,body,cond?}};
// forward-delivered{rid,rid2,call,reason?}: the first observed child receipt of a forward (once per forward; reason when
// the child resolved it as rejected, e.g. withdrawn); forward-retired{rid,rid2,reason}: sealed/retired without a receipt (P27).
// observation{exec,event}; selected{exec,model}; switch-observed{exec,rid,pool}.
// P28 entries are documented in hibernate.ts; generation session publication in generation.ts.
// session-corrupt{call,line}: a malformed native session line was skipped (once per line, E4).
// fence-failed{exec,error} is documented in sweep.ts. The orchestrator ledger owns hold/release{pool,slot,exec}
// and mem{available,admitted,exec} (every admission; a repeated refusal at most every 30 s per call). All transitions are serialized before publication.
import { mkdir, open, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CT, JT, type CallResult, type Containment, type Entry, type JournalHandle, type ProcInfo, type Request, type SendBody, type Spawned, type WithdrawBody } from "../../types.ts";
import { callDir, callInbox, callSession, outboxRoot } from "../../paths.ts";
import { Outbox } from "../../kernel/mailbox.ts";
import { contentHash, forwardRid } from "../../kernel/ids.ts";
import { capacity, seal } from "../../kernel/guards.ts";
import { buildPiArgs } from "../../compat/pi-args.ts";
import { parseModel, resolveModel, type Model } from "../../compat/model.ts";
import { buildCallResult } from "../../compat/result.ts";
import type { CallEffects, CallTicket, Executor, Ledgers } from "../contract.ts";
import createEffects from "./effects/index.ts";
import { continueSession } from "./generation.ts";
import { hibernation, openQuestion } from "./hibernate.ts";
import { evidence, fatalProviderError, forgetSession, readSessionState, receiptId, sessionModel, type SessionEntry } from "./session.ts";
import { activeTotal } from "./time.ts";
import { observeExecution } from "./observe.ts";
import { availableMemory } from "./memory.ts";
import { reached, sessionUsage, totalUsage, type Usage } from "./usage.ts";
import { recordFenceFailure, resolveFenceAttention, serialContainment, skipLostCandidate, sweepExecutions } from "./sweep.ts";
import { gateRetired } from "./effects/gate.ts";

type Envelope = Pick<Request, "to" | "kind" | "body" | "cond">;
type Active = { ticket: CallTicket; controller: AbortController; promise: Promise<CallResult>; wake: () => void; stopped: boolean; retired?: boolean; suspended?: boolean;
  parking?: string; onPark: Set<() => void>; refusedAt?: number };
const MEM_RECORD_MS = 30000;
/** A4, P29: A child admitted within this window may not show in MemAvailable yet; its share is reserved explicitly. */
const MEM_WARMUP_MS = 30000;
const ignoreMissing = (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; };
const callOf = (exec: string) => exec.slice(0, exec.lastIndexOf("#"));
const shutdownError = () => Object.assign(new Error("executor shutdown; call resumes on recovery"), { name: "ExecutorShutdown" });
const extension = fileURLToPath(new URL(`../../agent/extension.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url));
const entriesFor = (journal: JournalHandle, call: string) => journal.entries().filter(e => e.call === call);
const current = (journal: JournalHandle, call: string) => entriesFor(journal, call).findLast(e => e.type === JT.exec)?.exec as string | undefined;
const sealed = (journal: JournalHandle, call: string) => entriesFor(journal, call).find(e => e.type === JT.sealed)?.result as CallResult | undefined;
const has = (journal: JournalHandle, type: string, exec: string) => journal.entries().some(e => e.type === type && e.exec === exec);
function address(call: string) {
  const match = /^(.*)@(\d+)\/(.*)@(\d+)$/.exec(call);
  if (!match) throw new Error(`Invalid call identity: ${call}`);
  return { wid: match[1]!, key: match[3]!, gen: Number(match[4]) };
}

async function defaultModel(): Promise<string | undefined> {
  const path = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");
  const settings = JSON.parse(await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return "{}"; throw error; })) as { defaultProvider?: string; defaultModel?: string };
  return settings.defaultModel ? `${settings.defaultProvider ? `${settings.defaultProvider}/` : ""}${settings.defaultModel}` : undefined;
}

/** P2, P9, P22: Construct the journal-owned execution authority under the engine's OS lock. */
export default function createExecutor(ledgers: Ledgers, options: { memory?: () => Promise<number>; sweepMs?: number; effects?: CallEffects; containment?: Containment } = {}): Executor {
  const { home, config, orch } = ledgers;
  const containment = options.containment ?? serialContainment(), effects = options.effects ?? createEffects(ledgers);
  const active = new Map<string, Active>(), completed = new Map<string, Promise<CallResult>>(), journals = new Map<string, JournalHandle>();
  let queue: Promise<unknown> = Promise.resolve(), closed = false;
  let suspending: Promise<void> | undefined;
  let sweeping: Promise<void> | undefined;
  // F1: execs whose fence failed in this process; they are retried only by the sweep.
  const failing = new Set<string>();
  // F2: a sweep error is transient: report it and retry at the next K1; it never blocks dispatch.
  const sweepTimer = setInterval(() => {
    if (!sweeping) sweeping = sweepExecutions([...journals.values()].filter(j => !j.closed), containment, { failing: exec => failing.has(exec), fenced: swept, failed: fenceFailed })
      .catch(error => console.error(`durable-subagents: sweep failed, retrying in K1: ${String(error)}`)).finally(() => { sweeping = undefined; });
  }, options.sweepMs ?? 30000);
  sweepTimer.unref();
  const waiters = new Set<() => void>();
  const inbox = (call: string) => { const a = address(call); return callInbox(home, a.wid, a.key, a.gen); };
  const outbox = Outbox.open(outboxRoot(home), "orch", inbox);
  // Serial sections contain durable transitions, never slot waits, process waits or fences.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn); queue = next.catch(() => {}); return next;
  };
  const wake = () => { for (const fn of waiters) fn(); waiters.clear(); };
  // F3: fold only orchestrator entries appended since the last fold (holdings, observed switches, K7 skips).
  const ledger = { seen: 0, held: new Map<string, Entry>(), observed: new Set<string>(), skips: new Map<string, number>() };
  const folded = () => {
    const entries = orch.entries();
    for (; ledger.seen < entries.length; ledger.seen++) {
      const e = entries[ledger.seen]!, id = `${e.pool}:${e.slot}`;
      if (e.type === "hold") ledger.held.set(id, e);
      else if (e.type === "release" && ledger.held.get(id)?.exec === e.exec) ledger.held.delete(id);
      else if (e.type === "switch-observed") ledger.observed.add(`${e.exec}\n${e.rid}`);
      else if (e.type === "skip") ledger.skips.set(`${e.pool}\n${e.model}`, Math.max(Number(e.until), ledger.skips.get(`${e.pool}\n${e.model}`) ?? 0));
    }
    return ledger;
  };
  const holdings = () => [...folded().held.values()];
  const skipped = (pool: string, model: Model) => (folded().skips.get(`${pool}\n${model.provider}/${model.id}`) ?? 0) > Date.now();
  async function release(exec: string) {
    await serial(async () => { for (const h of holdings().filter(e => e.exec === exec)) await orch.append("release", { pool: h.pool, slot: h.slot, exec }); });
    wake();
  }
  function tracked(journal: JournalHandle, exec: string): ProcInfo[] {
    return journal.entries().filter(e => e.type === "tracked" && e.exec === exec).map(e => ({ pid: Number(e.pid), ppid: 0, start: String(e.start) }));
  }
  async function track(journal: JournalHandle, exec: string, found?: ProcInfo[]) {
    const known = tracked(journal, exec);
    found ??= (await containment.scan(new Map([[exec, known]]))).get(exec) ?? [];
    await serial(async () => {
      const ids = new Set(tracked(journal, exec).map(p => `${p.pid}:${p.start}`));
      for (const p of found) if (p.start && !ids.has(`${p.pid}:${p.start}`)) {
        await journal.append("tracked", { exec, pid: p.pid, start: p.start }); ids.add(`${p.pid}:${p.start}`);
      }
    });
    return found;
  }
  /** P22, F1: Fence an execution; false when its processes did not provably exit. With `park` the call instead waits,
   *  unsealed and without a new execution, until a sweep proves retirement (suspend/shutdown still interrupt it). */
  async function fence(journal: JournalHandle, exec: string, opts: { child?: Spawned; park?: Active } = {}): Promise<boolean> {
    opts.child?.stdin.end();
    if (has(journal, JT.fenced, exec)) return true;
    if (!failing.has(exec)) {
      let retired = false;
      try { await containment.fence(exec, tracked(journal, exec)); retired = true; }
      catch (error) { await fenceFailed(journal, exec, callOf(exec), error); }
      if (retired) { await fenceSucceeded(journal, exec); return true; }
    }
    if (!opts.park) return false;
    await parked(opts.park, journal, exec);
    return true;
  }
  async function fenceSucceeded(journal: JournalHandle, exec: string) {
    failing.delete(exec);
    await serial(async () => {
      if (!has(journal, JT.fenced, exec)) await journal.append(JT.fenced, { exec });
      await resolveFenceAttention(journal, exec);
    });
  }
  /** F1: A fence timeout is recorded once with one unknown attention item for the origin; any failure parks the exec. */
  async function fenceFailed(journal: JournalHandle, exec: string, call: string, error: unknown) {
    if (!failing.has(exec)) console.error(`durable-subagents: fence of ${exec} failed: ${String(error)}`);
    failing.add(exec);
    if (/Fence timeout/.test(String(error))) await serial(() => recordFenceFailure(journal, exec, call, error));
  }
  async function parked(a: Active, journal: JournalHandle, exec: string) {
    a.parking = exec;
    for (const fn of a.onPark) fn();
    try {
      while (!has(journal, JT.fenced, exec)) {
        if (closed || a.suspended) throw shutdownError();
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, config.k?.trackerMs ?? 1000); a.wake = () => { clearTimeout(timer); resolve(); }; });
      }
    } finally { a.parking = undefined; }
  }
  /** F1: Wait for a run to settle, or to park on an unfenced execution (a stop/retire never waits on a stuck fence). */
  function settledOrParked(a: Active): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (a.parking) return resolve(undefined);
      const now = () => resolve(undefined);
      a.onPark.add(now);
      void a.promise.then(resolve, reject).finally(() => a.onPark.delete(now));
    });
  }
  /** P23, F1: A sweep proved an exec retired: commit the fence, free its slots and resume or settle its call. */
  async function swept(journal: JournalHandle, exec: string, call: string, wasFenced: boolean) {
    if (exec.startsWith("gate:")) { failing.delete(exec); await serial(() => gateRetired(journal, exec)); return; }
    await fenceSucceeded(journal, exec);
    if (wasFenced) return;
    await release(exec);
    const a = active.get(call);
    if (a) { a.wake(); return; }
    if (closed || sealed(journal, call) || current(journal, call) !== exec || !entriesFor(journal, call).some(e => e.type === "stop-intent")) return;
    const { key, gen } = address(call);
    await finish(journal, call, exec, buildCallResult({ key, gen, status: "stopped", output: "" }));
  }
  // E4: a malformed native session line is skipped exactly like pi does, and recorded once per line.
  const corruptions = new Set<string>();
  async function readCall(journal: JournalHandle, call: string): Promise<SessionEntry[]> {
    const a = address(call), { entries, corrupt } = await readSessionState(callSession(home, a.wid, a.key, a.gen));
    for (const line of corrupt) {
      const id = `${call}\n${line}`;
      if (corruptions.has(id)) continue;
      corruptions.add(id);
      if (journal.entries().some(e => e.type === "session-corrupt" && e.call === call && e.line === line)) continue;
      console.error(`durable-subagents: skipped malformed line ${line} of the session of ${call}`);
      await journal.append("session-corrupt", { call, line });
    }
    return entries;
  }
  // E2: inbox files are deleted once their resolution is durable: a child receipt (after an fsync of the session)
  // or the call's seal. The child never re-applies a resolved request: its receipts are in the session it recovers.
  const collected = new Map<string, Set<string>>();
  async function collectReceipts(call: string, entries: SessionEntry[]) {
    const done = collected.get(call) ?? new Set<string>(); collected.set(call, done);
    const fresh = new Set<string>();
    for (const e of entries) {
      const rid = receiptId(e);
      if (rid && !done.has(rid) && !/^\.|[/\\\0]/.test(rid) && !(e.customType === CT.rejected && e.data?.reason === "identity-conflict")) fresh.add(rid);
    }
    if (!fresh.size) return;
    const a = address(call), file = await open(callSession(home, a.wid, a.key, a.gen), "r");
    try { await file.sync(); } finally { await file.close(); }
    const sender = await outbox, dir = inbox(call);
    for (const rid of fresh) {
      await sender.markResolved(rid);
      await unlink(join(dir, `${rid}.json`)).catch(ignoreMissing);
      done.add(rid);
    }
  }
  async function collectSealed(call: string) {
    const sender = await outbox, dir = inbox(call);
    for (const name of await readdir(dir).catch(error => { ignoreMissing(error); return []; })) {
      if (name.endsWith(".json") && !name.startsWith(".")) await sender.markResolved(name.slice(0, -5));
      await rm(join(dir, name), { force: true });
    }
  }
  /** P7, P27: Record forward-delivered once when a forward's child receipt is first observed; serial sections only. */
  async function forwardsDelivered(journal: JournalHandle, call: string, entries: SessionEntry[]) {
    const all = journal.entries();
    const open = all.filter(e => e.type === "forward" && e.dest === call &&
      !all.some(r => r.rid2 === e.rid2 && (r.type === "forward-retired" || (r.type === "forward-delivered" && r.call === call))));
    if (!open.length) return;
    const receipts = new Map<string, SessionEntry>();
    for (const e of entries) {
      const rid = receiptId(e);
      if (rid && !receipts.has(rid) && !(e.customType === CT.rejected && e.data?.reason === "identity-conflict")) receipts.set(rid, e);
    }
    for (const e of open) {
      const receipt = receipts.get(String(e.rid2)); if (!receipt) continue;
      const reason = receipt.customType === CT.rejected ? receipt.data?.reason : undefined;
      await journal.append("forward-delivered", { rid: e.rid, rid2: e.rid2, call, ...(reason !== undefined ? { reason: String(reason) } : {}) });
    }
  }
  async function retireForwards(journal: JournalHandle, call: string) {
    const entries = await readCall(journal, call);
    await forwardsDelivered(journal, call, entries);
    const receipts = new Set(entries.map(receiptId).filter(rid => rid !== undefined));
    for (const e of journal.entries().filter(e => e.type === "forward" && e.dest === call)) {
      if (!receipts.has(String(e.rid2)) && !journal.entries().some(r => r.type === "forward-retired" && r.rid2 === e.rid2))
        await journal.append("forward-retired", { rid: e.rid, rid2: e.rid2, reason: "retired-without-child-receipt" });
      await (await outbox).markResolved(String(e.rid2));
    }
  }
  async function recordUsage(t: CallTicket, values: { id: string; usage: Usage }[]) {
    await serial(async () => {
      const recorded = new Set(t.journal.entries().filter(e => e.type === "usage" && e.call === t.callId).map(e => e.id));
      for (const u of values) if (!recorded.has(u.id)) { await t.journal.append("usage", { call: t.callId, ...u }); recorded.add(u.id); }
      await workflowReached(t);
    });
  }
  async function workflowReached(t: CallTicket) {
    const hit = reached(totalUsage(t.journal.entries()), t.workflowBudget), id = `budget:${t.wid}`;
    if (hit && !t.journal.entries().some(e => e.type === JT.attention && (e.item as { id: string }).id === id))
      await t.journal.append(JT.attention, { item: { id, rev: 1, kind: "budget", text: "Workflow budget reached", wid: t.wid } });
    return hit;
  }
  async function retireAttention(journal: JournalHandle, call: string) {
    for (const e of journal.entries().filter(e => e.type === JT.attention)) {
      const item = e.item as { id: string; rev: number; call?: string; kind?: string };
      if (item.kind === "finished" || item.id === `unknown:${call}` || item.id.startsWith("fence:")) continue;
      if (item.call === call && !journal.entries().some(r => r.type === JT.attentionResolved && r.id === item.id && r.rev === item.rev))
        await journal.append(JT.attentionResolved, { id: item.id, rev: item.rev, resolution: "retired" });
    }
  }
  /** P15, AC4: A call sealed `unknown` raises exactly one unknown item for its origin; seal and recovery both run this. */
  async function unknownAttention(journal: JournalHandle, call: string) {
    const result = sealed(journal, call), id = `unknown:${call}`;
    if (result?.status !== "unknown" || journal.entries().some(e => e.type === JT.attention && (e.item as { id?: string }).id === id)) return;
    const text = `Call ${call} ended with an unknown outcome: ${result.error || "no evidence of what it did"}. It was not re-run; check its effects before continuing.`;
    await journal.append(JT.attention, { item: { id, rev: 1, kind: "unknown", text, wid: address(call).wid, call } });
  }
  async function finish(journal: JournalHandle, call: string, exec: string, result: CallResult) {
    const a = active.get(call);
    if (a && !sealed(journal, call) && !["stopped", "timeout", "budget"].includes(result.status)) {
      const started = Date.now(), prior = activeTotal(journal.entries(), call);
      const check = async () => {
        if (stopped(a)) a.controller.abort();
        if (a.ticket.spec.timeoutMs !== undefined && prior + Date.now() - started >= a.ticket.spec.timeoutMs) {
          a.controller.abort();
          await serial(async () => { if (!has(journal, "timeout-intent", exec)) await journal.append("timeout-intent", { exec, call }); });
        }
        if (reached(totalUsage(journal.entries(), call), a.ticket.spec.budget)) a.controller.abort();
      };
      let checking = Promise.resolve();
      const timer = setInterval(() => { checking = checking.then(check); }, config.k?.trackerMs ?? 1000);
      try { await check(); result = await effects.beforeSeal(a.ticket, exec, result, { signal: a.controller.signal }); await check(); }
      catch (error) { result = buildCallResult({ key: result.key, gen: result.gen, status: "failed", output: result.output, error: String(error) }); }
      finally { clearInterval(timer); await checking; }
    }
    const value = await serial(async () => {
      const old = sealed(journal, call);
      if (old) return old;
      if (!seal({ sealed: false, exec: current(journal, call) ?? "" }, { exec })) throw new Error(`Stale seal: ${exec}`);
      if (!has(journal, JT.fenced, exec)) throw new Error(`Unfenced seal: ${exec}`);
      if (closed || active.get(call)?.suspended || journal.entries().some(e => e.type === "retired" && e.call === call)) throw shutdownError();
      if (entriesFor(journal, call).some(e => e.type === "stop-intent")) result = buildCallResult({ key: result.key, gen: result.gen, status: "stopped", output: "" });
      else if (has(journal, "timeout-intent", exec)) result = buildCallResult({ key: result.key, gen: result.gen, status: "timeout", output: "" });
      else if (a && reached(totalUsage(journal.entries(), call), a.ticket.spec.budget)) result = buildCallResult({ key: result.key, gen: result.gen, status: "budget", output: "" });
      result = { ...result, usage: totalUsage(journal.entries(), call) };
      await journal.append(JT.sealed, { call, exec, result });
      await retireForwards(journal, call);
      const selected = journal.entries().find(e => e.type === "selected" && e.exec === exec);
      if (selected?.pool && result.status === "ok") await orch.append("candidate-success", { pool: selected.pool, model: `${(selected.model as Model).provider}/${(selected.model as Model).id}`, exec });
      await retireAttention(journal, call);
      await unknownAttention(journal, call);
      return result;
    });
    await collectSealed(call).catch(error => console.error(`durable-subagents: inbox cleanup of ${call} failed: ${String(error)}`));
    await release(exec);
    if (a) await effects.afterSeal(a.ticket, value);
    return value;
  }
  const stopped = (a: Active) => a.stopped || entriesFor(a.ticket.journal, a.ticket.callId).some(e => e.type === "stop-intent");
  const interrupted = (a: Active) => closed || a.suspended || a.retired || stopped(a);
  async function acquire(a: Active, exec: string, models: Model[], pool?: string, continuation = false): Promise<Model | undefined> {
    for (;;) {
      let signal!: () => void;
      const changed = new Promise<void>(resolve => { signal = resolve; waiters.add(resolve); });
      const chosen = await serial(async () => {
        if (interrupted(a) || await workflowReached(a.ticket)) return;
        for (const model of models) {
          if (!continuation && pool && skipped(pool, model)) continue;
          const provider = model.provider;
          const holders = holdings().filter(e => e.pool === provider);
          const limit = config.providers?.[provider ?? ""]?.slots ?? Infinity;
          if (!capacity({ kind: "provider", holders: holders.length, capacity: limit })) continue;
          // A burst of dispatches all read the same MemAvailable before any child has grown: subtract the children
          // admitted in the last 30 s (their memory is not visible yet), so a burst cannot over-commit the headroom.
          const perChild = config.memory?.perChildMb ?? 300;
          const warming = holdings().filter(e => e.pool === "memory" && Date.now() - e.ts < MEM_WARMUP_MS).length;
          const measured = await (options.memory ?? availableMemory)(), available = measured - warming * perChild;
          const admitted = capacity({ kind: "memory", available, reserve: config.memory?.reserveMb ?? 2048, perChild });
          // F3: every admitted dispatch is recorded; repeated refusals at most once per 30 s per call.
          if (admitted || a.refusedAt === undefined || Date.now() - a.refusedAt >= MEM_RECORD_MS) {
            await orch.append("mem", { available, admitted, exec, ...(warming ? { measured, warming } : {}) }); a.refusedAt = admitted ? undefined : Date.now();
          }
          if (!admitted) return;
          const memory = holdings().filter(e => e.pool === "memory");
          let memorySlot = 0; while (memory.some(e => e.slot === memorySlot)) memorySlot++;
          await orch.append("hold", { pool: "memory", slot: memorySlot, exec });
          if (provider) {
            let slot = 0; while (holders.some(e => e.slot === slot)) slot++;
            await orch.append("hold", { pool: provider, slot, exec });
          }
          await a.ticket.journal.append("selected", { exec, model, ...(pool ? { pool } : {}) });
          return model;
        }
      });
      if (chosen || interrupted(a) || reached(totalUsage(a.ticket.journal.entries()), a.ticket.workflowBudget)) { waiters.delete(signal); return chosen; }
      const timer = setTimeout(signal, config.k?.trackerMs ?? 1000);
      try { await changed; } finally { clearTimeout(timer); waiters.delete(signal); }
    }
  }
  /** P13, C5, C8: Decide holdings and CLI model restoration from the same fenced session. */
  async function launchModel(t: CallTicket, entries: SessionEntry[], previous?: string) {
    const recorded = sessionModel(entries);
    const ownSegment = entries.some(e => e.type === "custom" && e.customType === CT.exec && typeof e.data?.exec === "string" && e.data.exec.startsWith(`${t.callId}#`));
    const freshFork = t.spec.context === "fork" && !t.continueFrom && !ownSegment;
    const raw = t.spec.model ?? t.agent.model ?? config.defaultModel ?? await defaultModel();
    const pool = raw && config.pools?.[raw] ? raw : undefined;
    const candidates = raw ? resolveModel(raw, config.pools) : [{ id: "" }];
    const candidate = recorded && candidates.some(m => m.provider === recorded.provider && m.id === recorded.id);
    const skip = previous && ownSegment && pool && candidate && skipped(pool, recorded!);
    if (recorded && !freshFork && !skip) return { candidates: [recorded], continuation: true, pool: candidate ? pool : undefined };
    return { candidates, continuation: false, pool };
  }
  async function questions(t: CallTicket, entries: SessionEntry[]) {
    await collectReceipts(t.callId, entries).catch(error => console.error(`durable-subagents: inbox cleanup of ${t.callId} failed: ${String(error)}`));
    await serial(async () => {
      await forwardsDelivered(t.journal, t.callId, entries);
      for (const e of entries) {
        if (e.type !== "custom" || e.customType !== CT.question || !e.data) continue;
        const { qid, rev, question } = e.data;
        if (typeof qid !== "string" || typeof rev !== "number") continue;
        const id = `q:${t.callId}:${qid}`;
        if (!t.journal.entries().some(r => r.type === JT.attention && (r.item as { id: string; rev: number }).id === id && (r.item as { rev: number }).rev === rev))
          await t.journal.append(JT.attention, { item: { id, rev, kind: "question", text: String(question), wid: t.wid, call: t.callId, qid, session: callSession(home, t.wid, t.key, t.gen) } });
        const answered = entries.some(r => {
          const details = r.message?.details ?? r.details;
          return details?.qid === qid && details?.rev === rev && receiptId(r) !== undefined;
        });
        if (answered && !t.journal.entries().some(r => r.type === JT.attentionResolved && r.id === id && r.rev === rev))
          await t.journal.append(JT.attentionResolved, { id, rev, resolution: "answered" });
      }
    });
  }
  async function switched(exec: string, event: Record<string, unknown>) {
    const provider = (event.message as { provider?: string } | undefined)?.provider;
    if (!provider) return;
    await serial(async () => {
      const target = holdings().find(h => h.exec === exec && h.pool === provider && h.reserved);
      if (!target) return;
      if (!folded().observed.has(`${exec}\n${target.rid}`)) {
        await orch.append("switch-observed", { exec, rid: target.rid, pool: provider });
        for (const h of holdings().filter(h => h.exec === exec && h.pool !== provider && h.pool !== "memory")) await orch.append("release", { pool: h.pool, slot: h.slot, exec });
      }
    });
    wake();
  }
  function pendingSwitch(exec: string) {
    return holdings().find(h => h.exec === exec && h.reserved && !folded().observed.has(`${exec}\n${h.rid}`));
  }
  async function execute(a: Active): Promise<CallResult> {
    const t = a.ticket, journal = t.journal;
    const session = callSession(home, t.wid, t.key, t.gen), dir = callDir(home, t.wid, t.key, t.gen);
    const makeResult = (status: CallResult["status"], output = "", error?: string) => buildCallResult({ key: t.key, gen: t.gen, status, output, ...(error ? { error } : {}) });
    let cwd = t.cwd;
    if (sealed(journal, t.callId)) { const result = sealed(journal, t.callId)!; await effects.afterSeal(t, result); return result; }
    try {
      await continueSession(home, t, session);
      cwd = (await effects.prepare(t, { sessionPath: session })).cwd;
    } catch (error) {
      const exec = current(journal, t.callId) ?? `${t.callId}#1.1`;
      if (!current(journal, t.callId)) await serial(() => journal.append(JT.exec, { call: t.callId, exec }));
      await fence(journal, exec, { park: a });
      return finish(journal, t.callId, exec, makeResult("failed", "", String(error)));
    }
    for (;;) {
      const old = sealed(journal, t.callId); if (old) return old;
      if (closed || a.suspended || a.retired || journal.entries().some(e => e.type === "retired" && e.call === t.callId)) throw shutdownError();
      let exec = current(journal, t.callId);
      let entries = await readCall(journal, t.callId);
      let dangling: string[] = [];
      let bound: Entry | undefined;
      const sleeping = hibernation(journal, t.callId);
      if (exec && sleeping?.exec === exec) {
        await fence(journal, exec, { park: a }); await release(exec);
        for (;;) {
          if (interrupted(a) || has(journal, "timeout-intent", exec) || t.spec.timeoutMs !== undefined && activeTotal(journal.entries(), t.callId) >= t.spec.timeoutMs) break;
          if (reached(totalUsage(journal.entries(), t.callId), t.spec.budget) || reached(totalUsage(journal.entries()), t.workflowBudget))
            return finish(journal, t.callId, exec, makeResult("budget"));
          bound = journal.entries().find(e => e.type === "answer-bound" && e.call === t.callId && e.qid === sleeping.qid && e.rev === sleeping.rev);
          if (bound) break;
          await new Promise<void>(resolve => { const timer = setTimeout(resolve, config.k?.trackerMs ?? 1000); a.wake = () => { clearTimeout(timer); resolve(); }; });
        }
      }
      const pendingAnswer = journal.entries().findLast(e => e.type === "answer-bound" && e.call === t.callId);
      if (!bound && pendingAnswer && !entries.some(e => receiptId(e) === pendingAnswer.rid2)) bound = pendingAnswer;
      if (exec) {
        await fence(journal, exec, { park: a });
        await questions(t, entries = await readCall(journal, t.callId));
        await recordUsage(t, sessionUsage(entries, t.callId));
        const ev = evidence(entries, exec); dangling = ev.dangling;
        if (closed || a.suspended || a.retired) throw shutdownError();
        if (stopped(a)) return finish(journal, t.callId, exec, makeResult("stopped"));
        if (has(journal, "timeout-intent", exec) || t.spec.timeoutMs !== undefined && activeTotal(journal.entries(), t.callId) >= t.spec.timeoutMs)
          return finish(journal, t.callId, exec, makeResult("timeout"));
        if (ev.budget || reached(totalUsage(journal.entries(), t.callId), t.spec.budget)) return finish(journal, t.callId, exec, makeResult("budget"));
        if (!bound) {
        if (ev.report) return finish(journal, t.callId, exec, buildCallResult({ key: t.key, gen: t.gen, status: ev.report.outcome as "ok" | "failed", output: ev.text, usage: ev.usage,
          ...(Object.hasOwn(ev.report, "data") ? { report: { data: ev.report.data } } : {}), ...(Array.isArray(ev.report.artifacts) ? { artifacts: ev.report.artifacts as string[] } : {}) }));
        if (t.spec.schema === undefined && has(journal, "settled", exec) && ev.text)
          return finish(journal, t.callId, exec, { ...makeResult("ok", ev.text), usage: ev.usage });
        if (t.spec.once && dangling.length) return finish(journal, t.callId, exec, makeResult("unknown", "", `Unknown tool outcomes: ${dangling.join(", ")}`));
        if (has(journal, "settled", exec) && !ev.text && ev.error && fatalProviderError(ev.error))
          return finish(journal, t.callId, exec, makeResult("failed", "", `Provider error: ${ev.error}`));
        await serial(async () => {
          if (!has(journal, "loss", exec!)) await journal.append("loss", { exec });
          await skipLostCandidate(journal, orch, exec!);
        });
        const losses = journal.entries().filter(e => e.type === "loss" && String(e.exec).startsWith(`${t.callId}#`)).length;
        if (losses >= (config.k?.lossBound ?? 5)) return finish(journal, t.callId, exec, makeResult("failed", "", `lost ×${losses}${ev.error ? `; last error: ${ev.error.slice(0, 300)}` : ""}`));
        await release(exec);
        }
      }
      const previous = exec;
      const epoch = previous ? Number(previous.split(".").at(-1)) + 1 : 1;
      exec = `${t.callId}#1.${epoch}`;
      await serial(() => journal.append(JT.exec, { exec, call: t.callId }));
      if (interrupted(a)) { await fence(journal, exec, { park: a }); return finish(journal, t.callId, exec, makeResult("stopped")); }
      if (await serial(() => workflowReached(t))) { await fence(journal, exec, { park: a }); return finish(journal, t.callId, exec, makeResult("failed", "", "workflow budget reached")); }
      let decision: Awaited<ReturnType<typeof launchModel>>;
      try {
        decision = await launchModel(t, entries, previous);
      } catch (error) {
        await fence(journal, exec, { park: a }); return finish(journal, t.callId, exec, makeResult("failed", "", String(error)));
      }
      const model = await acquire(a, exec, decision.candidates, decision.pool, decision.continuation);
      if (!model || interrupted(a)) {
        await fence(journal, exec, { park: a });
        return finish(journal, t.callId, exec, !interrupted(a) ? makeResult("failed", "", "workflow budget reached") : makeResult("stopped"));
      }
      await mkdir(dir, { recursive: true });
      const prompt = join(dir, "system.txt"), schema = join(dir, "schema.json");
      // These are derived launch inputs, reconstructed from the pinned ticket after a crash.
      await writeFile(prompt, t.agent.body);
      if (t.spec.schema !== undefined) await writeFile(schema, JSON.stringify(t.spec.schema));
      const sender = await outbox;
      if (bound) await serial(async () => {
        if (!journal.entries().some(e => e.type === "resumed" && e.call === t.callId && e.rid === bound!.rid)) await journal.append("resumed", { call: t.callId, rid: bound!.rid, exec });
      });
      // The answer uses its stable forwarded identity across every recovery incarnation.
      const unresolved = journal.entries().findLast(e => e.type === "answer-bound" && e.call === t.callId);
      const receipt = unresolved && entries.some(e => receiptId(e) === unresolved.rid2);
      const openingRid = t.opening && contentHash([t.opening.rid, "dispatch"]);
      const openingReceived = openingRid && entries.some(e => receiptId(e) === openingRid);
      // The task has one identity: the dispatch of the call's first execution. A later execution continues only once
      // the session holds that task; an execution interrupted before its child received it (still waiting for a
      // provider slot, say) leaves a session without a task, and "continue" would ask a fresh model to guess.
      const taskRid = contentHash([`${t.callId}#1.1`, "dispatch"]);
      const taskReceived = !openingRid && entries.some(e => receiptId(e) === taskRid);
      if (openingRid && !openingReceived) await sender.send(t.callId, "task", { message: t.opening!.message }, undefined, { rid: openingRid });
      else if (!openingRid && !taskReceived) await sender.send(t.callId, "task", { message: t.spec.task }, undefined, { rid: taskRid });
      else if (unresolved && !receipt) await sender.send(t.callId, "continue", { message: String(unresolved.message) }, { qid: String(unresolved.qid), rev: Number(unresolved.rev) }, { rid: String(unresolved.rid2) });
      else if (previous) await sender.send(t.callId, "continue", { message: `Continue the task. Tool calls whose outcomes are unknown: ${dangling.join(", ") || "none"}.` }, undefined, { rid: contentHash([exec, "dispatch"]) });
      else await sender.send(t.callId, "task", { message: t.opening?.message ?? t.spec.task }, undefined, { rid: contentHash([exec, "dispatch"]) });
      if (interrupted(a)) { await fence(journal, exec, { park: a }); return finish(journal, t.callId, exec, makeResult("stopped")); }
      let child: Spawned;
      try {
        child = await containment.spawn({ exec, command: "pi", args: [...buildPiArgs(t.agent, t.spec, { sessionPath: session, systemPromptPath: prompt, continuation: decision.continuation, controlTools: t.spec.schema === undefined ? ["ask"] : ["ask", "report"], ...(model.id ? { model } : {}) }), "-e", extension], cwd,
          env: { DSA_HOME: home, DSA_EXEC: exec, DSA_CALL: t.callId, DSA_INBOX: inbox(t.callId), DSA_JOURNAL: journal.path, ...(t.spec.schema !== undefined ? { DSA_SCHEMA: schema } : {}), ...(t.spec.budget ? { DSA_BUDGET: JSON.stringify(t.spec.budget) } : {}), ...(model.provider && model.id ? { DSA_MODEL: `${model.provider}/${model.id}` } : {}) } });
      } catch (error) {
        await fence(journal, exec, { park: a }); return finish(journal, t.callId, exec, makeResult("failed", "", `Spawn failed: ${String(error)}`));
      }
      try {
        await track(journal, exec, [{ pid: child.pid, start: child.start, ppid: process.pid }]);
        await observeExecution({ home, config, ticket: t, exec, child, serial, read: () => readCall(journal, t.callId),
          setWake: fn => { a.wake = fn; }, interrupted: () => !!interrupted(a),
          track: () => track(journal, exec!), fence: async () => { await fence(journal, exec!, { child, park: a }); },
          questions: async entries => {
            await questions(t, entries);
            const q = openQuestion(entries);
            const segment = entries.findLastIndex(e => e.type === "custom" && e.customType === CT.exec && e.data?.exec === exec);
            if (!q || interrupted(a) || segment < 0 || !entries.slice(segment + 1).some(e => e.customType === CT.question && e.data?.qid === q.qid) || journal.entries().some(e => e.type === "answer-bound" && e.call === t.callId && e.qid === q.qid && e.rev === q.rev)) return;
            await serial(async () => {
              const attention = journal.entries().find(e => e.type === JT.attention && (e.item as { qid?: string; call?: string; rev?: number }).qid === q.qid && (e.item as { call?: string }).call === t.callId && (e.item as { rev?: number }).rev === q.rev);
              if (attention && Date.now() - attention.ts >= (config.k?.hibernateMs ?? 120000) && !has(journal, JT.fenced, exec!) && hibernation(journal, t.callId)?.exec !== exec) {
                await journal.append("hibernated", { call: t.callId, exec, qid: q.qid, rev: q.rev }); a.wake();
              }
            });
          }, recordUsage: values => recordUsage(t, values),
          switched: event => switched(exec!, event), pendingSwitch: () => pendingSwitch(exec!),
        });
      } finally { await fence(journal, exec, { child, park: a }); }
    }
  }
  async function replayForward(e: Entry) {
    const envelope = e.envelope as Envelope;
    await (await outbox).send(envelope.to, envelope.kind, envelope.body, envelope.cond, { rid: String(e.rid2) });
  }
  return {
    run(ticket) {
      const existing = completed.get(ticket.callId); if (existing) return existing;
      if (closed || suspending) return Promise.reject(shutdownError());
      journals.set(ticket.wid, ticket.journal);
      const a: Active = { ticket, controller: new AbortController(), stopped: false, wake: () => {}, promise: undefined!, onPark: new Set() };
      active.set(ticket.callId, a);
      a.promise = execute(a).catch(error => {
        completed.delete(ticket.callId);
        if (a.retired || ticket.journal.entries().some(e => e.type === "retired" && e.call === ticket.callId)) return buildCallResult({ key: ticket.key, gen: ticket.gen, status: "stopped", output: "", error: "retired" });
        throw error;
      }).finally(async () => {
        const exec = current(ticket.journal, ticket.callId);
        try { if (exec && await fence(ticket.journal, exec)) await release(exec); }
        finally {
          active.delete(ticket.callId); collected.delete(ticket.callId); forgetSession(callSession(home, ticket.wid, ticket.key, ticket.gen)); wake();
        }
      });
      // Shutdown rejection is still delivered to callers, without an unhandled rejection during teardown.
      void a.promise.catch(() => {});
      completed.set(ticket.callId, a.promise);
      return a.promise;
    },
    async forward(req, ctx) {
      return serial(async () => {
        const dest = `${ctx.widRev}/${ctx.key}@${ctx.gen}`, hash = contentHash(req);
        journals.set(address(dest).wid, ctx.journal);
        if (ctx.journal.entries().some(e => e.type === "retired" && e.call === dest)) return { action: "reject", reason: req.kind === "send" && (req.body as SendBody).kind === "answer" ? "retired" : "stale-revision" } as const;
        const opening = active.get(dest)?.ticket.opening;
        if (opening && !sealed(ctx.journal, dest)) await (await outbox).send(dest, "task", { message: opening.message }, undefined, { rid: contentHash([opening.rid, "dispatch"]) });
        const prior = ctx.journal.entries().find(e => e.type === "forward" && e.rid === req.rid && e.dest === dest);
        if (prior) {
          if (prior.hash !== hash) return { action: "reject", reason: "identity-conflict" } as const;
          if (!ctx.journal.entries().some(e => e.type === "forward-retired" && e.rid2 === prior.rid2)) await replayForward(prior);
          return { action: "apply" } as const;
        }
        const boundRetry = ctx.journal.entries().find(e => e.type === "answer-bound" && e.call === dest && e.rid === req.rid);
        if (boundRetry) return boundRetry.hash === hash ? { action: "apply" } as const : { action: "reject", reason: "identity-conflict" } as const;
        if (sealed(ctx.journal, dest)) return { action: "reject", reason: req.kind === "send" && (req.body as SendBody).kind === "answer" ? "retired" : "call-sealed" } as const;
        if (req.kind === "send" && (req.body as SendBody).kind === "answer") {
          const sleeping = hibernation(ctx.journal, dest);
          const priorAnswer = ctx.journal.entries().find(e => e.type === "answer-bound" && e.call === dest && e.qid === req.cond?.qid && e.rev === req.cond?.rev);
          if (priorAnswer) return priorAnswer.rid === req.rid && priorAnswer.hash === hash ? { action: "apply" } as const : { action: "reject", reason: "already-answered" } as const;
          if (sleeping && current(ctx.journal, dest) === sleeping.exec) {
            if (sleeping.qid !== req.cond?.qid || sleeping.rev !== req.cond?.rev) return { action: "reject", reason: "stale-rev" } as const;
            const rid2 = forwardRid(req.rid, ctx.widRev, ctx.key, hash);
            const item = ctx.journal.entries().find(e => e.type === JT.attention && (e.item as { call?: string; qid?: string; rev?: number }).call === dest && (e.item as { qid?: string }).qid === sleeping.qid && (e.item as { rev?: number }).rev === sleeping.rev)?.item as { text?: string } | undefined;
            await ctx.journal.append("answer-bound", { call: dest, qid: sleeping.qid, rev: sleeping.rev, rid: req.rid, rid2, hash, message: `Question: ${item?.text ?? sleeping.qid}\nAnswer: ${(req.body as SendBody).message ?? ""}` });
            active.get(dest)?.wake(); wake();
            return { action: "apply" } as const;
          }
        }
        let kind: Request["kind"], body: unknown;
        if (req.kind === "withdraw") {
          kind = "withdraw";
          const targets = (req.body as WithdrawBody).rids;
          body = { rids: ctx.journal.entries().filter(e => e.type === "forward" && e.dest === dest && targets.includes(String(e.rid))).map(e => String(e.rid2)) };
        } else if (req.kind === "send") {
          const send = req.body as SendBody; kind = send.kind;
          if (kind === "model") {
            try { const m = parseModel(send.model ?? ""); if (!m.provider) throw new Error("Missing provider"); body = { provider: m.provider, model: m.id, ...(m.thinking ? { thinking: m.thinking } : {}) }; }
            catch { return { action: "reject", reason: "unknown-model" } as const; }
          } else body = { message: send.message ?? "" };
        } else return { action: "reject", reason: "unsupported" } as const;
        const cond = { ...req.cond }; delete cond.epoch;
        if (cond.after) {
          const dependency = ctx.journal.entries().find(e => e.type === "forward" && e.dest === dest && e.rid === cond.after);
          if (dependency) cond.after = String(dependency.rid2); else delete cond.after;
        }
        const envelope: Envelope = { to: dest, kind, body, ...(Object.keys(cond).length ? { cond } : {}) };
        const rid2 = forwardRid(req.rid, ctx.widRev, ctx.key, hash);
        if (kind === "model") {
          const exec = current(ctx.journal, dest), provider = (body as { provider: string }).provider;
          if (!exec || has(ctx.journal, JT.fenced, exec) || !has(ctx.journal, "tracked", exec)) return { action: "reject", reason: "call-not-running" } as const;
          if (pendingSwitch(exec)) return { action: "reject", reason: "switch-pending" } as const;
          const held = holdings().filter(h => h.exec === exec);
          if (!held.some(h => h.pool === provider)) {
            const target = holdings().filter(h => h.pool === provider);
            if (!capacity({ kind: "provider", holders: target.length, capacity: config.providers?.[provider]?.slots ?? Infinity }))
              return { action: "reject", reason: "provider-full" } as const;
            let slot = 0; while (target.some(h => h.slot === slot)) slot++;
            await orch.append("hold", { pool: provider, slot, exec, reserved: true, rid: req.rid });
          }
        }
        const entry = await ctx.journal.append("forward", { rid: req.rid, rid2, dest, hash, envelope });
        await replayForward(entry);
        if (kind === "withdraw") {
          const exec = current(ctx.journal, dest), reservation = exec && pendingSwitch(exec);
          if (reservation && (req.body as WithdrawBody).rids.includes(String(reservation.rid))) active.get(dest)?.wake();
        }
        return { action: "apply" } as const;
      });
    },
    async stop(target) {
      const journal = journals.get(target.wid); if (!journal) return;
      const calls = new Set(journal.entries().filter(e => e.type === JT.exec && (!target.callId || e.call === target.callId)).map(e => String(e.call)));
      for (const a of active.values()) if (a.ticket.wid === target.wid && (!target.callId || a.ticket.callId === target.callId)) calls.add(a.ticket.callId);
      for (const call of calls) { const a = active.get(call); if (a) { a.stopped = true; a.controller.abort(); } }
      await serial(async () => {
        for (const call of calls) if (!sealed(journal, call) && !entriesFor(journal, call).some(e => e.type === "stop-intent")) await journal.append("stop-intent", { call });
      });
      for (const call of calls) active.get(call)?.wake();
      wake();
      for (const call of calls) {
        const a = active.get(call);
        if (a) await settledOrParked(a);
        else {
          const exec = current(journal, call); if (!exec || sealed(journal, call)) continue;
          // F1: a stuck fence leaves the call unsealed; the sweep seals it stopped once the exec is retired.
          if (!await fence(journal, exec)) continue;
          const { key, gen } = address(call);
          await finish(journal, call, exec, buildCallResult({ key, gen, status: "stopped", output: "" }));
        }
      }
    },
    async recover(wid, journal) {
      journals.set(wid, journal);
      await effects.recover(journal);
      for (const e of journal.entries().filter(e => e.type === JT.exec)) {
        // F1: an exec whose fence fails stays unfenced and holding; its call parks until a sweep retires it.
        const exec = String(e.exec); if (await fence(journal, exec)) await release(exec);
      }
      const calls = new Set(journal.entries().filter(e => e.type === JT.exec).map(e => String(e.call)));
      for (const call of calls) {
        const session = await readCall(journal, call), values = sessionUsage(session, call);
        await serial(async () => {
          await forwardsDelivered(journal, call, session);
          const recorded = new Set(journal.entries().filter(e => e.type === "usage" && e.call === call).map(e => e.id));
          for (const u of values) if (!recorded.has(u.id)) await journal.append("usage", { call, ...u });
          if (sealed(journal, call) || journal.entries().some(e => e.type === "retired" && e.call === call)) {
            await retireForwards(journal, call); await retireAttention(journal, call); await unknownAttention(journal, call);
          }
        });
        if (!active.has(call)) { const a = address(call); forgetSession(callSession(home, a.wid, a.key, a.gen)); }
      }
      for (const e of journal.entries().filter(e => e.type === "forward" && !journal.entries().some(r => r.type === "forward-retired" && r.rid2 === e.rid2))) await replayForward(e);
      await (await outbox).republishPending();
      // E2: republication may restore envelopes of sealed calls; those are resolved by the seal.
      for (const call of calls) if (sealed(journal, call)) await collectSealed(call).catch(error => console.error(`durable-subagents: inbox cleanup of ${call} failed: ${String(error)}`));
    },
    async retire(widRev) {
      const journal = journals.get(widRev.slice(0, widRev.lastIndexOf("@"))); if (!journal) return;
      const calls = new Set(journal.entries().filter(e => e.type === JT.exec && String(e.call).startsWith(`${widRev}/`)).map(e => String(e.call)));
      for (const a of active.values()) if (a.ticket.widRev === widRev) { a.retired = true; a.controller.abort(); calls.add(a.ticket.callId); }
      await serial(async () => { for (const call of calls) if (!journal.entries().some(e => e.type === "retired" && e.call === call)) await journal.append("retired", { call }); });
      for (const call of calls) active.get(call)?.wake();
      wake();
      for (const call of calls) {
        const a = active.get(call); if (a) await settledOrParked(a);
        for (const e of journal.entries().filter(e => e.type === JT.exec && e.call === call)) if (await fence(journal, String(e.exec))) await release(String(e.exec));
        await serial(async () => { await retireForwards(journal, call); await retireAttention(journal, call); });
      }
    },
    busy: () => active.size > 0,
    suspend(only?: (wid: string) => boolean) {
      if (only) { // scoped (one session's quit, one workflow): other workflows keep running and dispatching
        const targets = [...active.values()].filter(a => only(a.ticket.wid));
        for (const a of targets) { a.suspended = true; a.controller.abort(); a.wake(); }
        wake();
        return (async () => {
          const results = await Promise.allSettled(targets.map(a => a.promise));
          await queue;
          const failed = results.find(r => r.status === "rejected" && r.reason?.name !== "ExecutorShutdown");
          if (failed?.status === "rejected") throw failed.reason;
        })();
      }
      if (suspending) return suspending;
      for (const a of active.values()) { a.suspended = true; a.controller.abort(); a.wake(); }
      wake();
      suspending = (async () => {
        const results = await Promise.allSettled([...active.values()].map(a => a.promise));
        await queue;
        const failed = results.find(r => r.status === "rejected" && r.reason?.name !== "ExecutorShutdown");
        if (failed?.status === "rejected") throw failed.reason;
      })().finally(() => { suspending = undefined; });
      return suspending;
    },
    async shutdown() {
      if (closed) return;
      closed = true; clearInterval(sweepTimer);
      try { await this.suspend(); await sweeping; }
      finally { await queue; await (await outbox).close(); }
    },
  };
}
