// R2: the orchestrator's event pump. Derives events from the durable sources (workflow journals, the orchestrator
// ledger's `created`) after their appends and writes them to the event log with the watermarks of the sources derived
// (same fsync), so a restart re-derives only after them (at least once). It is also the EventSink other producers
// (R7 waiting/moving) emit through. One chain serializes passes, emits, compaction and close.
// Memory: per unpruned workflow one watermark and one cached identity; reads the journals' committed arrays from their
// watermark (no journal copies per tick).
import { eventsLog } from "../paths.ts";
import { JT, isEntry, type Entry, type JournalHandle, type Request } from "../types.ts";
import { requestId } from "../requests.ts";
import { deriveCreated, deriveEntry, labelsOf, type Identity } from "./derive.ts";
import { EventLog } from "./log.ts";
import { EVENT_RETENTION_MS, type EventDraft, type EventSink } from "./types.ts";

/** What the pump reads of the orchestrator's store: its unpruned workflows and a hook called after their appends. */
export interface PumpStore { workflows: ReadonlyMap<string, { journal: JournalHandle }>; appended?: (wid: string) => void }
export interface PumpOptions {
  home: string;
  orch: JournalHandle;
  store: PumpStore;
  /** Retention window (ms), read at each compaction (config.json reloads apply). */
  retentionMs?: () => number | undefined;
  /** Batching delay after an append (ms). */
  delayMs?: number;
}
const COMPACT_EVERY_MS = 3600_000;
const committed = (j: JournalHandle) => j.committed?.() ?? j.entries();

/** Retention: a workflow whose events may go once old: final (done/failed/stopped, not parked) in its current
 *  revision, no open question and no call of that revision without a seal (or retirement). */
export function quiet(wid: string, entries: readonly Entry[]): boolean {
  let revision = 1, done: Entry | undefined;
  const calls = new Set<string>(), ended = new Set<string>(), open = new Set<string>();
  for (const e of entries) {
    if (e.type === "revised") { revision = Number(e.revision); calls.clear(); done = undefined; }
    else if (e.type === JT.done) done = e;
    else if (e.type === "resumed" && !e.call) done = undefined;
    else if (e.type === "call") calls.add(`${wid}@${revision}/${String(e.key)}@${String(e.gen)}`);
    else if (e.type === "generation" && Number(e.revision) === revision) calls.add(`${wid}@${revision}/${String(e.key)}@${String(e.gen)}`);
    else if (e.type === JT.sealed || e.type === "retired") ended.add(String(e.call));
    else if (isEntry(e, JT.attention) && e.item.kind === "question") open.add(`${e.item.id}\0${e.item.rev}`);
    else if (isEntry(e, JT.attentionResolved)) open.delete(`${e.id}\0${e.rev}`);
  }
  if (!done || !["done", "failed", "stopped"].includes(String(done.status)) || open.size) return false;
  return [...calls].every(c => ended.has(c));
}

export class EventPump implements EventSink {
  private options: PumpOptions;
  private log?: EventLog;
  private chain: Promise<unknown> = Promise.resolve();
  private marks = new Map<string, number>();
  /** Sources whose watermark moved since the log last recorded it. */
  private unsaved = new Set<string>();
  private dirty = new Set<string>();
  private identities = new Map<string, Identity>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private compactedAt = 0;
  private reported?: string;
  private identityScan = -1;
  /** Set by open() when the log was created (or replaced after corruption) and everything on disk was derived. */
  backfilled = false;
  /** Resolves once open() (or close()) ran: emits wait for it. */
  private ready: Promise<void>;
  private isReady!: () => void;
  constructor(options: PumpOptions) {
    this.options = options;
    this.ready = new Promise(resolve => { this.isReady = resolve; });
    options.orch.onAppend = () => this.kick();
    options.store.appended = wid => this.kick(wid);
  }
  /** The log's epoch and head (after open). */
  get head(): { epoch: string; head: number; dropped: number } | undefined { return this.log && { epoch: this.log.epoch, head: this.log.head, dropped: this.log.dropped }; }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }
  /** Orchestrator start, after the store recovered its workflows: open (or create) the log, compact, then derive
   *  everything after the watermarks (on a new log: everything still on disk). */
  open(): Promise<void> {
    return this.serial(async () => {
      if (this.closed || this.log) return;
      const opened = await EventLog.open(eventsLog(this.options.home));
      if (opened.corrupt) console.error(`durable-subagents: ${opened.corrupt}; a new event log (epoch ${opened.log.epoch}) starts`);
      this.log = opened.log; this.backfilled = opened.created;
      // A source the store no longer has was pruned: its journal is gone and it is never derived again.
      for (const [source, seq] of opened.marks) if (source === "orch" || this.options.store.workflows.has(source)) this.marks.set(source, seq);
      await this.compact();
      for (const wid of this.options.store.workflows.keys()) this.dirty.add(wid);
      await this.pass();
    }).finally(() => this.isReady());
  }
  /** A source appended: derive soon (batched). */
  kick(wid?: string): void {
    if (wid !== undefined) this.dirty.add(wid);
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.serial(() => this.pass()); }, this.options.delayMs ?? 50);
    this.timer.unref?.();
  }
  /** Derive and log everything appended so far (prune calls it before the journal goes). */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    return this.serial(() => this.pass());
  }
  /** EventSink: append drafts (any type), echoing the workflow's request id and labels when the draft has none. */
  async emit(drafts: readonly EventDraft[]): Promise<void> {
    await this.ready;
    return this.serial(async () => {
      // After close (the orchestrator exits) nothing is logged: R7 state is derived again by the next orchestrator.
      if (!this.log || this.closed || !drafts.length) return;
      const filled = drafts.map(d => {
        const id = this.identity(d.wid);
        return { ...d, ...(d.request === undefined && id.request !== undefined ? { request: id.request } : {}), ...(d.labels === undefined && id.labels ? { labels: id.labels } : {}) } as EventDraft;
      });
      await this.log.append(filled);
    });
  }
  /** Orchestrator exit: derive what is left, record the watermarks, close the log. */
  close(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const done = this.serial(async () => {
      if (this.closed) return;
      const log = this.log;
      try {
        if (log) {
          await this.pass();
          if (this.unsaved.size) { await log.append([], this.saved()); this.unsaved.clear(); }
        }
      } finally { this.closed = true; await log?.close(); }
    }).finally(() => this.isReady());
    return done.catch(error => console.error(`durable-subagents: event log close failed: ${String(error)}`));
  }
  private saved(next?: ReadonlyMap<string, number>): Map<string, number> {
    const out = new Map<string, number>();
    for (const source of this.unsaved) { const seq = this.marks.get(source); if (seq !== undefined) out.set(source, seq); }
    for (const [source, seq] of next ?? []) out.set(source, seq);
    return out;
  }
  /** Request id and labels of a workflow's run request (cached while the workflow is not pruned). */
  private identity(wid: string): Identity {
    const cached = this.identities.get(wid);
    if (cached) return cached;
    const orch = committed(this.options.orch);
    // A miss rescans the ledger only after it grew (a journal may be derived before its `created` is appended).
    if (orch.length === this.identityScan) return {};
    this.identityScan = orch.length;
    // One scan resolves every workflow not cached yet (a backfill asks for all of them).
    const wanted = new Map<string, string>(), rids = new Map<string, string>();
    for (const e of orch) if (e.type === JT.created && this.options.store.workflows.has(String(e.wid)) && !this.identities.has(String(e.wid))) { wanted.set(String(e.wid), String(e.rid)); rids.set(String(e.rid), String(e.wid)); }
    const found = new Map<string, Identity>();
    for (const [w, rid] of wanted) found.set(w, requestId(rid) !== undefined ? { request: requestId(rid) } : {});
    for (const e of orch) {
      if (e.type !== "request") continue;
      const req = e.request as Request | undefined, w = req && req.kind === "run" ? rids.get(req.rid) : undefined;
      const labels = w !== undefined ? labelsOf(req!.body) : undefined;
      if (labels) found.set(w!, { ...found.get(w!), labels });
    }
    // Only workflows with a `created` entry are cached: an earlier pass may see a journal before its ledger entry.
    for (const [w, id] of found) this.identities.set(w, id);
    return this.identities.get(wid) ?? {};
  }
  /** One derivation pass over the orchestrator ledger and the workflows appended to since the last one. */
  private async pass(): Promise<void> {
    const log = this.log;
    if (!log || this.closed) return;
    const drafts: EventDraft[] = [], next = new Map<string, number>(), forgotten: string[] = [];
    const orch = committed(this.options.orch), from = this.marks.get("orch") ?? 0;
    const dirty = [...this.dirty]; this.dirty.clear();
    try {
      // The ledger first: a workflow's `submitted` precedes its journal's events.
      for (let i = from; i < orch.length; i++) {
        const e = orch[i]!;
        if (e.type === JT.created && this.options.store.workflows.has(String(e.wid))) drafts.push(deriveCreated(orch, i, this.identity(String(e.wid))));
        else if (e.type === "pruned") forgotten.push(String(e.wid));
      }
      if (orch.length > from) next.set("orch", orch.length);
      for (const wid of dirty) {
        const wf = this.options.store.workflows.get(wid);
        if (!wf) continue;
        const entries = committed(wf.journal), start = this.marks.get(wid) ?? 0;
        if (entries.length <= start) continue;
        const id = this.identity(wid);
        for (let i = start; i < entries.length; i++) drafts.push(...deriveEntry(wid, entries, i, orch, id));
        next.set(wid, entries.length);
      }
      if (drafts.length) await log.append(drafts, this.saved(next));
    } catch (error) {
      for (const wid of dirty) this.dirty.add(wid);
      const text = `durable-subagents: event log append failed (retrying): ${String(error)}`;
      if (this.reported !== text) { this.reported = text; console.error(text); }
      if (!this.closed && !this.timer) { this.timer = setTimeout(() => { this.timer = undefined; void this.serial(() => this.pass()); }, 1000); this.timer.unref?.(); }
      return;
    }
    for (const [source, seq] of next) { this.marks.set(source, seq); if (drafts.length) this.unsaved.delete(source); else this.unsaved.add(source); }
    if (drafts.length) this.unsaved.clear();
    for (const wid of forgotten) { this.marks.delete(wid); this.identities.delete(wid); this.unsaved.delete(wid); }
    if (Date.now() - this.compactedAt >= COMPACT_EVERY_MS) await this.compact();
  }
  /** Retention: drop events older than the window whose workflow is quiet (or pruned); at start and at most hourly. */
  private async compact(): Promise<void> {
    const log = this.log;
    if (!log) return;
    this.compactedAt = Date.now();
    const window = this.options.retentionMs?.() ?? EVENT_RETENTION_MS, cutoff = Date.now() - window;
    const pruned = new Set<string>(), orch = committed(this.options.orch);
    for (const e of orch) if (e.type === "pruned") pruned.add(String(e.wid));
    const verdicts = new Map<string, boolean>();
    const droppable = (wid: string) => {
      let v = verdicts.get(wid);
      if (v === undefined) {
        const wf = this.options.store.workflows.get(wid);
        v = wf ? quiet(wid, committed(wf.journal)) : pruned.has(wid);
        verdicts.set(wid, v);
      }
      return v;
    };
    try {
      // The watermarks written are the ones durable now plus those moved since (both are true of the derived log).
      const marks = new Map(this.marks);
      const dropped = await log.compact(r => r.at < cutoff && droppable(String(r.e.wid)), marks);
      if (dropped) this.unsaved.clear();
    } catch (error) { console.error(`durable-subagents: event log compaction failed: ${String(error)}`); }
  }
}
