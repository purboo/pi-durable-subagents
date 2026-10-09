// Why a call is not moving. One pure decision (`whyWaiting`) from one
// unsealed call's observable state; `describe` (CLI, from disk snapshots) and the orchestrator's collector (from its
// in-memory journals) both build that state with the same fold (`foldWaits`) and the same inputs (`waitsOf`), so they
// agree. The tracker turns the per-tick waits into `waiting`/`moving` event drafts for the log's EventSink; `startWaiting`
// runs it on a timer. No durable state of its own: the log holds what was emitted, and seeds the tracker after a start.
//
// Sources, per reason (precedence WAIT_REASONS, first wins):
//   unconfirmed-stop   an open `fence:<exec|gate:…>` attention item (kind unknown, sweep.ts recordFenceFailure): the
//                      processes of an execution or gate did not exit after SIGKILL. The other `unknown` items
//                      (`unknown:<call>`, prepare.ts `worktree:`/`output:`) accompany a seal: not a wait.
//   provider-exhausted the provider of a running call, or every candidate provider of a queued call (a pool's), is
//                      used up (ledger provider-exhausted; a queued call only while it cannot be admitted: before the
//                      next try or while another call probes it; a running call unless it is the probe itself).
//   writer-lock        a queued call's journal `writer-wait` (cleared by `writer-acquired`).
//   lease              a running call's waiting lease ticket (`pi-durable-subagents hold`, platform/lease.ts).
//   slot               a queued call: `exec` appended, no `selected` yet (provider slot or memory headroom) — at once
//                      when every candidate provider is full, else after SLOT_GRACE_MS: every launch passes through this
//                      state while it prepares (a worktree, a fork) and is admitted, which is no wait.
//   silent             an open `stall:`/`noprogress:` attention item (kind stall; its text names the running command) of
//                      the current execution while it works (selected, not fenced): a drained call is not waiting.
// An asking call is not waiting, a sealed one never. Asking = an open question raised in the call's current execution
// (the call's latest `exec` before the question's attention entry is its current one), hibernated or not; once the
// answer is bound the executor appends a new exec, and the call's waits count again although the item stays open until
// the new execution reads it (describe's `state: "asking"` still follows the open item).
import { JT, type AttentionItem, type Entry, type JournalHandle, type Request, type RunBody } from "../types.ts";
import { EVENT_SEQ_SKIP, WAIT_REASONS, type EventDraft, type EventSink, type WaitReason } from "./types.ts";
import { emptyLedger, foldLedger, settingsOf, type LedgerState } from "../orchestrator/ledger.ts";
import type { Exhaustion } from "../orchestrator/providers.ts";
import type { OrchestratorConfig } from "../orchestrator/contract.ts";
import { exhaustedLine, slotLine } from "../orchestrator/snapshot.ts";
import { parseModel, resolveModel } from "../compat/model.ts";
import { leaseCalls, leaseState } from "../platform/lease.ts";
import { requestId } from "../requests.ts";

/** A queued call whose providers have a free slot (or are unknown) counts as waiting for a slot only after this long. */
export const SLOT_GRACE_MS = 3000;
/** Why one call waits: the cause, the status line that explains it, and when that cause started (ms). */
export interface Wait { reason: WaitReason; detail: string; since: number }

/** One unsealed call's observable state: everything `whyWaiting` decides from. */
export interface WaitInput {
  sealed?: boolean;
  /** An open question raised in the current execution (hibernated or not). */
  asking?: boolean;
  /** The current execution while it is live (not fenced): queued for its slot until `selected`, then running. */
  exec?: { id: string; since: number; selected: boolean };
  /** A running call's provider; a queued call's candidate providers (a pool's, in order). */
  providers?: readonly string[];
  /** Used-up providers (ledger providers.ts). */
  exhausted?: ReadonlyMap<string, Exhaustion>;
  writerWait?: { root: string; holder: string; since: number };
  /** A waiting lease ticket of the call: its status line and the earliest ticket time. */
  lease?: { detail: string; since: number };
  /** Open attention items of the call (question, stall, unknown kinds); `exec`: the execution it was raised in. */
  attention?: readonly { id: string; kind: string; text: string; since: number; exec?: string }[];
  /** The slot lines of the providers a queued call waits for ("probe 1/1"), and whether all of them are full. */
  slot?: string; full?: boolean;
}

/** Why the call does not move, or undefined when it moves (or is asking or sealed). Pure. */
export function whyWaiting(c: WaitInput, now: number): Wait | undefined {
  if (c.sealed || c.asking) return undefined;
  const open = c.attention ?? [], exec = c.exec, queued = !!exec && !exec.selected;
  const checks: Record<WaitReason, () => Omit<Wait, "reason"> | undefined> = {
    "unconfirmed-stop": () => { const a = open.find(a => a.kind === "unknown" && a.id.startsWith("fence:")); return a && { detail: a.text, since: a.since }; },
    "provider-exhausted": () => exhaustedWait(c, now),
    "writer-lock": () => queued && c.writerWait ? { detail: `waits for the writer lock of ${c.writerWait.root}: ${c.writerWait.holder} holds it or is ahead in the queue`, since: c.writerWait.since } : undefined,
    lease: () => exec?.selected && c.lease ? { ...c.lease } : undefined,
    slot: () => queued && (c.full || now - exec!.since >= SLOT_GRACE_MS) ? { detail: `waiting for a slot${c.slot ? `: ${c.slot}` : ""}`, since: exec!.since } : undefined,
    silent: () => { const a = exec?.selected && open.find(a => a.kind === "stall" && (a.exec === undefined || a.exec === exec.id)); return a ? { detail: a.text, since: a.since } : undefined; },
  };
  for (const reason of WAIT_REASONS) { const found = checks[reason](); if (found) return { reason, ...found }; }
  return undefined;
}
function exhaustedWait(c: WaitInput, now: number): Omit<Wait, "reason"> | undefined {
  const exec = c.exec, used = c.exhausted, providers = [...new Set(c.providers ?? [])];
  if (!exec || !used?.size || !providers.length) return undefined;
  if (exec.selected) {
    const x = used.get(providers[0]!);
    return x && x.probe !== exec.id ? { detail: exhaustedLine(providers[0]!, x, now), since: x.since } : undefined;
  }
  // Admission skips a used-up provider before its next try and while another call probes it (executor `unavailable`).
  const all = providers.map(p => [p, used.get(p)] as const);
  if (!all.every(([, x]) => x && (now < x.nextTry || x.probe !== undefined))) return undefined;
  return { detail: all.map(([p, x]) => exhaustedLine(p, x!, now)).join("; "), since: Math.max(...all.map(([, x]) => x!.since)) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The fold: one workflow journal → the facts of its unsealed calls. Incremental (extended as the journal grows), small
// (sealed calls and resolved items are dropped), shared by describe and the collector.
// ---------------------------------------------------------------------------------------------------------------------
export interface CallFacts {
  call: string; key: string; gen: number; generation: boolean; agent?: string;
  /** The model the call asked for (a follow-up's model, else its spec's): a model or a pool name. */
  wanted?: string;
  /** The model of its latest `selected`/`model-used` ("provider/id"). */
  model?: string;
  exec?: string; selected?: boolean; fenced?: boolean;
  /** Since when the current execution waits for its slot: its `exec`, or a later `writer-acquired`. */
  queued?: number;
  writer?: { root: string; holder: string; since: number };
}
export interface WaitFold {
  wid: string; seen: number; last?: Entry; rev: number;
  /** The current revision's terminal entry is a workflow-done: only follow-up generations are live. */
  done: boolean;
  calls: Map<string, CallFacts>;
  /** Open attention items (question, stall, unknown) of unsealed calls, by item id; `exec`: the call's execution when
   *  it was raised (a stall entry names it, else the call's latest exec then). */
  items: Map<string, { call: string; kind: string; text: string; since: number; rev: number; exec?: string }>;
}
const ITEM_KINDS = new Set(["question", "stall", "unknown"]);
const modelName = (m: unknown) => { const v = m as { provider?: string; id?: string } | undefined; return v?.id ? (v.provider ? `${v.provider}/${v.id}` : v.id) : undefined; };
const holderName = (holder: string) => holder.includes("/") ? `${holder.split("@")[0]}/${holder.split("/")[1]!.split("@")[0]}` : holder;
function ofExec(f: WaitFold, exec: unknown): CallFacts | undefined {
  const id = String(exec), c = f.calls.get(id.slice(0, id.lastIndexOf("#")));
  return c?.exec === id ? c : undefined;
}
function applyWait(f: WaitFold, e: Entry): void {
  switch (e.type) {
    case "wf-created": f.rev = Number(e.revision) || 1; break;
    case "revised": f.rev = Number(e.revision) || f.rev; f.calls.clear(); f.items.clear(); f.done = false; break;
    case JT.done: f.done = true; break;
    case "resumed": if (!e.call) f.done = false; break;
    case "call": case "generation": {
      const key = String(e.key), gen = Number(e.gen) || 1, call = `${f.wid}@${f.rev}/${key}@${gen}`, spec = e.spec as { agent?: unknown; model?: unknown } | undefined;
      const wanted = typeof e.model === "string" && e.model ? e.model : typeof spec?.model === "string" && spec.model ? spec.model : undefined;
      f.calls.set(call, { call, key, gen, generation: e.type === "generation", ...(typeof spec?.agent === "string" ? { agent: spec.agent } : {}), ...(wanted ? { wanted } : {}) });
      break;
    }
    case JT.exec: { const c = f.calls.get(String(e.call)); if (c) { c.exec = String(e.exec); c.queued = e.ts; c.selected = false; c.fenced = false; } break; }
    case "selected": case "model-used": {
      const c = ofExec(f, e.exec), model = modelName(e.model);
      if (c && model) c.model = model;
      if (c && e.type === "selected") c.selected = true;
      break;
    }
    case JT.fenced: { const c = ofExec(f, e.exec); if (c) c.fenced = true; break; }
    case "writer-wait": {
      const c = f.calls.get(String(e.call)); if (!c) break;
      c.writer = { root: String(e.root), holder: holderName(String(e.holder ?? "")), since: c.writer?.since ?? e.ts };
      break;
    }
    case "writer-acquired": {
      const c = f.calls.get(String(e.call)); if (!c) break;
      delete c.writer; if (c.exec && !c.selected && !c.fenced) c.queued = Math.max(c.queued ?? 0, e.ts);
      break;
    }
    case JT.sealed: case "retired": {
      const call = String(e.call);
      if (f.calls.delete(call)) for (const [id, item] of f.items) if (item.call === call) f.items.delete(id);
      break;
    }
    case JT.attention: {
      const item = e.item as AttentionItem | undefined;
      const c = item?.call ? f.calls.get(item.call) : undefined, exec = typeof e.exec === "string" ? e.exec : c?.exec;
      if (item?.call && c && ITEM_KINDS.has(item.kind)) f.items.set(item.id, { call: item.call, kind: item.kind, text: item.text, since: e.ts, rev: item.rev, ...(exec !== undefined ? { exec } : {}) });
      break;
    }
    case JT.attentionResolved: { const item = f.items.get(String(e.id)); if (item && item.rev === Number(e.rev)) f.items.delete(String(e.id)); break; }
  }
}
/** Fold a workflow journal, extending `prior` when `entries` extends what it folded (journal entries keep their
 *  identity as a journal grows); anything else is folded from the start. */
export function foldWaits(wid: string, entries: readonly Entry[], prior?: WaitFold): WaitFold {
  let f = prior;
  if (!f || f.wid !== wid || f.seen > entries.length || (f.seen && entries[f.seen - 1] !== f.last)) f = { wid, seen: 0, rev: 1, done: false, calls: new Map(), items: new Map() };
  for (; f.seen < entries.length; f.seen++) applyWait(f, entries[f.seen]!);
  f.last = entries[f.seen - 1];
  return f;
}

/** What the waits depend on beyond one journal. */
export interface WaitEnv {
  now: number;
  /** The orchestrator ledger, folded (slots held, used-up providers, the settings in effect). */
  ledger: LedgerState;
  /** Settings when the ledger records none (an embedded orchestrator). */
  config?: OrchestratorConfig;
  /** Per call id: its waiting lease tickets (`leaseWaits`). Read only for running calls (a getter can defer it). */
  readonly leases?: ReadonlyMap<string, { detail: string; since: number }>;
}
/** Per call id: the status line of its leases ("waiting for lease machine 3m") and its earliest waiting ticket. */
export function leaseWaits(state: ReturnType<typeof leaseState>, now: number): Map<string, { detail: string; since: number }> {
  const lines = leaseCalls(state, now), out = new Map<string, { detail: string; since: number }>();
  for (const { waiters } of state) for (const t of waiters) if (t.call) out.set(t.call, { detail: lines.get(t.call) ?? "", since: Math.min(out.get(t.call)?.since ?? Infinity, t.since) });
  return out;
}
const providerOf = (model?: string) => { if (!model) return undefined; try { return parseModel(model).provider; } catch { return undefined; } };
/** The call's state as `whyWaiting` reads it. `agentModel` names the model of a pinned agent (for a call naming none). */
export function waitInput(f: WaitFold, c: CallFacts, env: WaitEnv, agentModel?: (agent: string) => string | undefined): WaitInput {
  const settings = settingsOf(env.ledger, env.config ?? {}), live = c.exec && !c.fenced;
  const attention: { id: string; kind: string; text: string; since: number; exec?: string }[] = [];
  let asking = false;
  for (const [id, item] of f.items) if (item.call === c.call) {
    attention.push({ id, kind: item.kind, text: item.text, since: item.since, ...(item.exec !== undefined ? { exec: item.exec } : {}) });
    if (item.kind === "question" && item.exec === c.exec) asking = true;
  }
  let providers: string[] = [];
  if (live && c.selected) { const p = providerOf(c.model); if (p) providers = [p]; }
  else if (live) {
    // A pool call may launch on any of its pool's models; anything else continues on the model it ran on, or the one
    // it asks for (its spec, its agent's, the configured default). A model pi's own settings choose is not known here.
    const pools = settings.pools ?? {}, raw = c.wanted ?? (c.agent ? agentModel?.(c.agent) : undefined) ?? settings.defaultModel;
    if (raw && Object.hasOwn(pools, raw)) { try { providers = [...new Set(resolveModel(raw, pools).map(m => m.provider).filter((p): p is string => !!p))]; } catch { /* an invalid pool: unknown */ } }
    else { const p = providerOf(c.model ?? raw); if (p) providers = [p]; }
  }
  let full = live && !c.selected && providers.length > 0;
  const slot = live && !c.selected && providers.length ? providers.map(p => {
    let held = 0; for (const h of env.ledger.held.values()) if (h.pool === p) held++;
    const limit = settings.providers?.[p]?.slots;
    if (limit === undefined || held < limit) full = false;
    return slotLine(p, held, limit);
  }).join(", ") : undefined;
  const lease = live && c.selected ? env.leases?.get(c.call) : undefined;
  return {
    asking,
    ...(live ? { exec: { id: c.exec!, since: c.queued ?? 0, selected: !!c.selected } } : {}),
    ...(providers.length ? { providers } : {}), exhausted: env.ledger.exhausted,
    ...(c.writer ? { writerWait: c.writer } : {}), ...(lease ? { lease } : {}),
    ...(attention.length ? { attention } : {}), ...(slot ? { slot } : {}), ...(full ? { full } : {}),
  };
}
/** The live calls of a folded workflow: every unsealed call of a running one, else its open follow-up generations. */
export function liveWaitCalls(f: WaitFold): CallFacts[] {
  return [...f.calls.values()].filter(c => !f.done || c.generation);
}
/** The waits of a folded workflow's live calls (calls that move are absent). */
export function waitsOf(f: WaitFold, env: WaitEnv, agentModel?: (agent: string) => string | undefined): Map<string, Wait> {
  const out = new Map<string, Wait>();
  if (!f.calls.size) return out;
  for (const c of liveWaitCalls(f)) { const w = whyWaiting(waitInput(f, c, env, agentModel), env.now); if (w) out.set(c.call, w); }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tracker: per-tick waits → `waiting`/`moving` drafts.
// ---------------------------------------------------------------------------------------------------------------------
/** What a draft of one call carries besides its waiting fields (as every event of the workflow does). */
export interface WaitMeta { wid: string; key: string; gen: number; call: string; request?: string; labels?: Record<string, string> }
/** A latest `waiting`/`moving` event of a call, as the log has it (seed). */
export type WaitSeed = { type: string; reason?: WaitReason; detail?: string; since?: number; wid: string; key?: string; gen?: number; call?: string; request?: string; labels?: Record<string, string> };
const base = (m: WaitMeta) => ({ wid: m.wid, ...(m.request ? { request: m.request } : {}), key: m.key, gen: m.gen, call: m.call, ...(m.labels ? { labels: m.labels } : {}) });

/** Holds the last reason emitted per call. `waiting` when a reason appears or changes, `moving{after}` when it clears
 *  (also when the call seals or disappears while waiting); a change of detail or age alone emits nothing. Ids carry the
 *  observing tick: the same cause can recur with the same `since` (a used-up provider whose probe is refused again keeps
 *  its first `since`), and a reader deduplicating on the id must still see it. A draft that failed to log is retried with
 *  its id (startWaiting), and the seed keeps a restarted tracker from repeating a logged transition. */
export class WaitTracker {
  private last = new Map<string, { wait: Wait; meta: WaitMeta }>();
  /** Start from the latest `waiting`/`moving` per call id (the log's view at an orchestrator start). */
  seed(latest: ReadonlyMap<string, WaitSeed>): void {
    for (const [call, e] of latest) {
      if (e.type === "waiting" && e.reason && WAIT_REASONS.includes(e.reason))
        this.last.set(call, { wait: { reason: e.reason, detail: e.detail ?? "", since: Number(e.since) }, meta: { wid: e.wid, key: String(e.key ?? ""), gen: Number(e.gen ?? 0), call, ...(e.request ? { request: e.request } : {}), ...(e.labels ? { labels: e.labels } : {}) } });
      else this.last.delete(call);
    }
  }
  /** Calls with a `waiting` emitted and not yet followed by `moving`. */
  /** Forget every emitted state (a new log epoch: its readers start from nothing, so current waits are emitted again). */
  reset(): void { this.last.clear(); }
  waiting(): ReadonlyMap<string, Wait> { return new Map([...this.last].map(([call, v]) => [call, v.wait])); }
  /** Drafts for the transitions from the last state to `current` (calls absent from it move). */
  diff(now: number, current: ReadonlyMap<string, Wait | undefined>, meta: ReadonlyMap<string, WaitMeta>): EventDraft[] {
    const out: EventDraft[] = [];
    for (const [call, prev] of this.last) {
      if (current.get(call)) continue;
      out.push({ id: `${call}:moving:${prev.wait.reason}:${now}`, ts: now, type: "moving", ...base(prev.meta), after: prev.wait.reason });
      this.last.delete(call);
    }
    for (const [call, wait] of current) {
      const prev = this.last.get(call), m = meta.get(call) ?? prev?.meta;
      if (!wait || !m || prev?.wait.reason === wait.reason) continue;
      // ts is when it was observed (retention and ordering read it); `since` keeps when the cause started.
      out.push({ id: `${call}:waiting:${wait.reason}:${now}`, ts: now, type: "waiting", ...base(m), reason: wait.reason, detail: wait.detail, since: wait.since });
      this.last.set(call, { wait, meta: m });
    }
    return out;
  }
}

export interface WaitsCollected { current: ReadonlyMap<string, Wait | undefined>; meta: ReadonlyMap<string, WaitMeta> }
/** Every `intervalMs` (k.waitCheckMs, default 5000): collect, diff, emit. Never overlaps itself; an emit failure is logged and
 *  its drafts are emitted first on the next tick (in order, same ids), so no transition is lost. `tick()` runs one now
 *  (or joins the one running). */
export function startWaiting(options: { collect: () => WaitsCollected | Promise<WaitsCollected>; sink: EventSink; intervalMs?: number; tracker?: WaitTracker; now?: () => number; log?: (line: string) => void;
  /** The sink's log epoch: when it changes (a broken log reopened as a new one), the tracker resets, so the new log gets
   *  every current wait again. */
  epoch?: () => string | undefined }): { stop(): Promise<void>; tick(): Promise<void> } {
  const tracker = options.tracker ?? new WaitTracker(), now = options.now ?? Date.now, log = options.log ?? (line => console.error(line));
  let pending: EventDraft[] = [], running: Promise<void> | undefined, stopped = false, timer: ReturnType<typeof setTimeout> | undefined, epoch = options.epoch?.();
  const once = async () => {
    try {
      const at = now(), { current, meta } = await options.collect(), seen = options.epoch?.();
      if (seen !== epoch) { epoch = seen; tracker.reset(); }
      pending.push(...tracker.diff(at, current, meta));
    }
    catch (error) { log(`durable-subagents: wait collection failed: ${String(error)}`); }
    while (pending.length) {
      const batch = pending.slice(0, EVENT_SEQ_SKIP);
      try { await options.sink.emit(batch); pending = pending.slice(batch.length); }
      catch (error) { log(`durable-subagents: ${pending.length} waiting/moving event(s) not logged, retried next tick: ${String(error)}`); return; }
    }
  };
  const tick = () => running ??= once().finally(() => { running = undefined; });
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => { void tick().then(schedule); }, options.intervalMs ?? 5000);
    timer.unref?.();
  };
  schedule();
  return { tick, async stop() { stopped = true; clearTimeout(timer); await running; } };
}

// ---------------------------------------------------------------------------------------------------------------------
// The orchestrator's collector.
// ---------------------------------------------------------------------------------------------------------------------
/** A workflow as the orchestrator holds it (Store `Workflow`): its in-memory journal and pinned agents. */
export interface WaitWorkflow { wid: string; journal: Pick<JournalHandle, "entries">; pins?: { agents?: readonly { name: string; model?: string }[] } }
export interface WaitSources {
  home: string;
  /** The workflows in memory, e.g. `() => engine.store.workflows.values()`. */
  workflows: () => Iterable<WaitWorkflow>;
  /** The orchestrator ledger (Ledgers.orch). */
  orch: Pick<JournalHandle, "entries">;
  /** The settings the orchestrator was given (Ledgers.config), when its ledger records none. */
  config?: OrchestratorConfig;
  /** Lease state; default `leaseState(home)`, read only when a running call is live. */
  leases?: () => ReturnType<typeof leaseState>;
}
/** The waits of the orchestrator's live calls, for `startWaiting`'s `collect`:
 *    const collect = waitCollector({ home, workflows: () => engine.store.workflows.values(), orch: ledgers.orch, config: ledgers.config });
 *    startWaiting({ collect: () => collect(), sink, intervalMs: config.k?.waitCheckMs, tracker });
 *  Per tick: one `entries()` per workflow (a cached view unless it was appended to), each changed journal folded only
 *  past what was folded before; a workflow without unsealed calls costs a map lookup. The ledger is folded the same way
 *  (slots, used-up providers, settings, and each workflow's request id and labels). Call it from one place at a time. */
export function waitCollector(src: WaitSources): (now?: number) => WaitsCollected {
  const folds = new Map<string, { entries: readonly Entry[]; fold: WaitFold }>();
  const ledger = emptyLedger();
  // Run requests not yet created (rid → labels) and the request id and labels of each workflow: bounded by the
  // workflows not pruned, plus requests awaiting their decision.
  const runs = { seen: 0, last: undefined as Entry | undefined, pending: new Map<string, Record<string, string> | undefined>(), meta: new Map<string, { request?: string; labels?: Record<string, string> }>() };
  const foldRuns = (entries: readonly Entry[]) => {
    if (runs.seen && (runs.seen > entries.length || entries[runs.seen - 1] !== runs.last)) { runs.seen = 0; runs.pending.clear(); runs.meta.clear(); }
    for (; runs.seen < entries.length; runs.seen++) {
      const e = entries[runs.seen]!;
      if (e.type === "request") {
        const r = e.request as Request | undefined, labels = r?.kind === "run" ? (r.body as RunBody | undefined)?.labels : undefined;
        if (r?.kind === "run") runs.pending.set(r.rid, labels && typeof labels === "object" && Object.keys(labels).length ? labels : undefined);
      } else if (e.type === JT.created) {
        const rid = String(e.rid), id = requestId(rid), labels = runs.pending.get(rid);
        if (!runs.meta.has(String(e.wid))) runs.meta.set(String(e.wid), { ...(id ? { request: id } : {}), ...(labels ? { labels } : {}) });
        runs.pending.delete(rid);
      } else if (e.type === JT.rejected) runs.pending.delete(String(e.rid));
      else if (e.type === JT.withdrawn) for (const rid of Array.isArray(e.rids) ? e.rids : []) runs.pending.delete(String(rid));
      else if (e.type === "pruned") runs.meta.delete(String(e.wid));
    }
    runs.last = entries[runs.seen - 1];
  };
  return (now = Date.now()) => {
    const orch = src.orch.entries();
    foldLedger(ledger, orch); foldRuns(orch);
    let leases: ReadonlyMap<string, { detail: string; since: number }> | undefined;
    const env: WaitEnv = { now, ledger, ...(src.config ? { config: src.config } : {}), get leases() { return leases ??= leaseWaits((src.leases ?? (() => leaseState(src.home)))(), now); } };
    const current = new Map<string, Wait>(), meta = new Map<string, WaitMeta>(), present = new Set<string>();
    for (const wf of src.workflows()) {
      present.add(wf.wid);
      const entries = wf.journal.entries();
      let hit = folds.get(wf.wid);
      if (hit?.entries !== entries) { hit = { entries, fold: foldWaits(wf.wid, entries, hit?.fold) }; folds.set(wf.wid, hit); }
      if (!hit.fold.calls.size) continue;
      const agents = wf.pins?.agents;
      for (const [call, wait] of waitsOf(hit.fold, env, agents ? name => agents.find(a => a.name === name)?.model : undefined)) {
        const c = hit.fold.calls.get(call)!, m = runs.meta.get(wf.wid);
        current.set(call, wait);
        meta.set(call, { wid: wf.wid, key: c.key, gen: c.gen, call, ...(m?.request ? { request: m.request } : {}), ...(m?.labels ? { labels: m.labels } : {}) });
      }
    }
    for (const wid of folds.keys()) if (!present.has(wid)) folds.delete(wid);
    return { current, meta };
  };
}
