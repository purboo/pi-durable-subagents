import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { UiDeps } from "../agent/main.ts";
import { crc32, readJournalSnapshot } from "../kernel/journal.ts";
type Entry = ReturnType<typeof readJournalSnapshot>[number];
import { readCache, writeCache } from "../kernel/cache.ts";
import { allWorkflows, isLive, ownWorkflows, releaseSettledJournals, SETTLED_RECHECK_MS, workflowDigest, workflowDigestChecked, type WorkflowSnapshot } from "../orchestrator/snapshot.ts";
import { readerLedger, readerLedgerIdentity } from "../orchestrator/reader-ledger.ts";
import { callDir, callSession, factsDir, journalPath } from "../paths.ts";
import { LIVE_FILE, type Live } from "../agent/child/live.ts";
import { JT } from "../types.ts";
import { SessionTail, sessionBranch, sessionFacts } from "./session.ts";
import { orderWorkflows, type Facts } from "./view.ts";

/** UI §3: The child's in-flight response, if fresh (a crashed child's last write must not look alive for long). */
function readLive(path: string): Live | undefined {
  try {
    const live = JSON.parse(readFileSync(path, "utf8")) as Live;
    return live.phase !== "idle" && Date.now() - live.at < 120_000 ? live : undefined;
  } catch { return undefined; }
}
type JournalIndex = { length: number; calls: Map<string, Entry>; losses: Map<string, number>; execs: Map<string, number> };
const indexes = new WeakMap<readonly Entry[], JournalIndex>();
/** The last call proposal per key/gen and the last loss and launch per execution, built once per journal snapshot
 *  instead of scanning the whole journal for every call on every refresh. */
function journalIndex(journal: readonly Entry[]): JournalIndex {
  const hit = indexes.get(journal);
  if (hit && hit.length === journal.length) return hit;
  const index: JournalIndex = { length: journal.length, calls: new Map(), losses: new Map(), execs: new Map() };
  journal.forEach((e, i) => {
    if (e.type === "call") index.calls.set(`${e.key}\0${e.gen}`, e);
    else if (e.type === "loss") index.losses.set(String(e.exec), i);
    else if (e.type === JT.exec) index.execs.set(String(e.exec), i);
  });
  indexes.set(journal, index);
  return index;
}
/** A map whose missing entries are produced on first `get`/`has`; iteration and `size` cover only produced entries. */
export class LazyMap<V> extends Map<string, V> {
  private produce: (key: string) => void;
  constructor(produce: (key: string) => void) { super(); this.produce = produce; }
  put(key: string, value: V) { super.set(key, value); }
  override get(key: string): V | undefined { if (!super.has(key)) this.produce(key); return super.get(key); }
  override has(key: string): boolean { return this.get(key) !== undefined; }
}
/** How long after its seal a call's session is still followed. A sealed execution has been fenced, so its session is
 *  final: a follow-up or a revision runs as a new generation with its own session. Final facts are rechecked by
 *  session identity at most SETTLED_RECHECK_MS apart, including edits made outside the engine. */
const FINAL_MS = 10_000;
// A final call's facts are kept on disk (DSA_HOME/cache/facts), keyed by its seal and its session file's identity: each
// pi start used to read every historical session again (gigabytes on a long history) to show the same lines. The key
// names the code that derives them (this module and session.ts), so changed code derives them again.
const FACTS_FORMAT = 1;
let factsCode: string | undefined;
function factsVersion(): string {
  if (factsCode === undefined) {
    try {
      const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
      factsCode = `${FACTS_FORMAT}.${crc32(Buffer.concat([new URL(import.meta.url), new URL(`./session.${ext}`, import.meta.url), new URL(`../types.${ext}`, import.meta.url)].map(u => readFileSync(fileURLToPath(u)))))}`;
    } catch { factsCode = ""; } // without its own code to name, nothing is stored
  }
  return factsCode;
}
type StoredFacts = { v: string; callId: string; endedAt: number; session: string; facts: Facts };
const sessionIdentity = (path: string) => { try { const s = statSync(path); return `${s.dev}:${s.ino}:${s.size}`; } catch { return "none"; } };
function factsPath(home: string, wid: string, key: string, gen: number): string { return join(factsDir(home), wid, `${encodeURIComponent(key)}@${gen}.json`); }
function storedFacts(path: string, callId: string, endedAt: number, session: string): Facts | undefined {
  const v = factsVersion();
  if (!v) return undefined;
  try {
    const stored = readCache(path) as StoredFacts | undefined;
    return stored?.v === v && stored.callId === callId && stored.endedAt === endedAt && stored.session === session &&
      typeof stored.facts?.task === "string" && typeof stored.facts.latest === "string" && Number.isFinite(stored.facts.tools) ? { ...stored.facts, model: stored.facts.model, thinking: stored.facts.thinking, activity: stored.facts.activity, live: undefined } : undefined;
  } catch { return undefined; }
}
function storeFacts(path: string, record: StoredFacts, journal: string): void {
  if (record.v) writeCache(path, record, journal);
}
/** A1, P25: Read the UI's data from durable workflow snapshots and native session tails only. */
export class UiData {
  workflows: WorkflowSnapshot[] = [];
  /** Facts and session branch per call id; a finished call's are read on first `get` (see refresh). */
  facts: Map<string, Facts> = new Map();
  sessions: Map<string, readonly SessionEntry[]> = new Map();
  aliases: Record<string, string> = {};
  /** UI §1: the dock above the editor — "auto" (live rows), "line" (one summary line) or "off". */
  dock: "auto" | "line" | "off" = "auto";
  /** Where the dock sits: below the editor (default; never splits an editor header such as a powerline bar) or above. */
  dockAt: "below" | "above" = "above";
  /** Per-refresh budget (ms) for reading not yet read finished sessions (history) in the background. */
  warmMs = 8;
  private tails = new Map<string, SessionTail>();
  /** Facts of calls sealed more than FINAL_MS ago, read once after their seal; their transcript is read when shown. */
  private final = new Map<string, { endedAt: number; path: string; facts: Facts; identity: string; checked: number }>();
  /** The transcript of one final call last asked for (the open call view asks on every frame). Keeping every
   *  historical transcript parsed held hundreds of MB and made pi's garbage collection pause typing. */
  private opened?: { callId: string; endedAt: number; entries: SessionEntry[] };
  private transcript(callId: string, sessions: LazyMap<readonly SessionEntry[]>): void {
    const final = this.final.get(callId);
    if (!final) return;
    if (this.opened?.callId !== callId || this.opened.endedAt !== final.endedAt)
      this.opened = { callId, endedAt: final.endedAt, entries: sessionBranch(new SessionTail().read(final.path)) };
    sessions.put(callId, this.opened.entries);
  }
  /** Branch and facts per call, reused while its session tail is unchanged: a finished call's session never grows, and
   *  re-deriving every historical call on each refresh blocked pi's main thread for over a second. */
  private derived = new Map<string, { source: readonly SessionEntry[]; length: number; entries: SessionEntry[]; facts: Facts }>();
  private source?: WorkflowSnapshot[];
  private revision: object = {};
  private quietUntil = 0;
  private configIdentity = "";
  home: string;
  constructor(home: string) { this.home = home; }
  private readConfig(): boolean {
    const path = join(this.home, "config.json");
    let identity = "none";
    try { const s = statSync(path); identity = `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; } catch { /* optional */ }
    if (identity === this.configIdentity) return false;
    this.configIdentity = identity;
    try {
      const config = JSON.parse(readFileSync(path, "utf8"));
      this.aliases = Object.fromEntries(Object.entries(config.ui?.modelAliases ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>;
      this.dock = ["auto", "line", "off"].includes(config.ui?.dock) ? config.ui.dock : "auto";
      this.dockAt = config.ui?.dockAt === "below" ? "below" : "above";
    } catch { this.aliases = {}; this.dock = "auto"; this.dockAt = "above"; }
    return true;
  }
  /** Read the workflows `own` ("main:<pi session id>") shows as its own (see ownWorkflows): the pi process reads only
   *  its own workflows, so other sessions' journals and call sessions are never opened, stat'ed or cached here. Without
   *  an owner every workflow is read (fixtures and tools that show them all). */
  refresh(own?: string): object {
    const workflows = own === undefined ? allWorkflows(this.home) : ownWorkflows(this.home, own), now = Date.now(), configChanged = this.readConfig();
    if (workflows === this.source && !configChanged && now >= this.quietUntil - SETTLED_RECHECK_MS && now < this.quietUntil) return this.revision;
    // The upstream workflow pass is checked before the view fast path; inherit digest expiry as well.
    let checked = now;
    const known = new Set<string>(), deferred = new Map<string, () => void>();
    const facts = new LazyMap<Facts>(key => deferred.get(key)?.());
    const sessions = new LazyMap<readonly SessionEntry[]>(key => { deferred.get(key)?.(); this.transcript(key, sessions); });
    for (const w of workflows) {
      checked = Math.min(checked, workflowDigestChecked(this.home, w.wid));
      let index: JournalIndex | undefined; // only calls still followed need it
      let fallback: ReturnType<typeof workflowDigest> | undefined;
      const taskDigest = () => fallback ??= workflowDigest(this.home, w.wid, readerLedgerIdentity(readerLedger(this.home)));
      const journal = () => index ??= journalIndex(readJournalSnapshot(journalPath(this.home, w.wid)));
      for (const c of w.calls) {
        known.add(c.callId);
        const final = this.final.get(c.callId);
        if (final && c.phase === "sealed" && c.endedAt === final.endedAt) {
          if (now >= final.checked && now - final.checked < SETTLED_RECHECK_MS) { facts.put(c.callId, final.facts); continue; }
          if (sessionIdentity(final.path) === final.identity) { final.checked = now; facts.put(c.callId, final.facts); continue; }
          if (this.opened?.callId === c.callId) this.opened = undefined;
        }
        if (final) this.final.delete(c.callId);
        const load = () => {
          deferred.delete(c.callId);
          const final = c.phase === "sealed" && c.endedAt !== undefined && Date.now() - c.endedAt > FINAL_MS;
          const sessionPath = callSession(this.home, w.wid, c.key, c.gen), stored = final ? factsPath(this.home, w.wid, c.key, c.gen) : "";
          // History read before, by this or another pi: its stored facts, without reading the session.
          const identity = final && !this.tails.has(c.callId) ? sessionIdentity(sessionPath) : "";
          const known = identity ? storedFacts(stored, c.callId, c.endedAt!, identity) : undefined;
          if (known) { facts.put(c.callId, known); this.final.set(c.callId, { endedAt: c.endedAt!, path: sessionPath, facts: known, identity, checked: now }); return; }
          let tail = this.tails.get(c.callId);
          if (!tail) { tail = new SessionTail(); this.tails.set(c.callId, tail); }
          const source = tail.read(sessionPath);
          let cached = this.derived.get(c.callId);
          if (!cached || cached.source !== source || cached.length !== source.length) {
            const entries = sessionBranch(source);
            cached = { source, length: source.length, entries, facts: sessionFacts(entries, c.callId) };
            this.derived.set(c.callId, cached);
          }
          const value: Facts = { ...cached.facts, live: undefined };
          // The journal only when the session does not say it: a settled workflow's journal is not kept in memory
          // (orchestrator/snapshot.ts digests), and reading it back for every historical call undid that.
          if (!value.task) {
            const settled = taskDigest().settled;
            value.task = settled ? settled.tasks[`${c.key}\0${c.gen}`] ?? "" : String((journal().calls.get(`${c.key}\0${c.gen}`)?.spec as { task?: string } | undefined)?.task ?? "");
          }
          if (c.phase !== "sealed") {
            const loss = journal().losses.get(String(c.exec)) ?? -1;
            const launch = journal().execs.get(String(c.exec)) ?? -1;
            if (loss > launch) value.activity = "connection dropped, retrying";
            value.live = readLive(join(callDir(this.home, w.wid, c.key, c.gen), LIVE_FILE));
          }
          facts.put(c.callId, value);
          const readIdentity = tail.snapshotIdentity;
          if (final && readIdentity !== undefined) {
            this.final.set(c.callId, { endedAt: c.endedAt!, path: sessionPath, facts: value, identity: readIdentity, checked: now });
            this.tails.delete(c.callId); this.derived.delete(c.callId);
            storeFacts(stored, { v: factsVersion(), callId: c.callId, endedAt: c.endedAt!, session: readIdentity, facts: value }, journalPath(this.home, w.wid));
          } else sessions.put(c.callId, cached.entries);
          releaseSettledJournals();
        };
        // A finished call never read before (history at startup) is read when first shown or by the idle warm-up below;
        // reading every historical session up front blocked pi's startup for seconds.
        if (c.phase === "sealed" && !this.tails.has(c.callId)) deferred.set(c.callId, load);
        else load();
      }
    }
    for (const key of this.tails.keys()) if (!known.has(key)) { this.tails.delete(key); this.derived.delete(key); }
    for (const key of this.final.keys()) if (!known.has(key)) this.final.delete(key);
    if (this.opened && !known.has(this.opened.callId)) this.opened = undefined;
    // Warm the history a slice at a time, so opening the list later finds it read without one long stall now.
    const until = performance.now() + this.warmMs;
    for (const load of [...deferred.values()]) { if (performance.now() >= until) break; load(); }
    const sameFacts = this.facts.size === facts.size && [...facts].every(([key, value]) => this.facts.get(key) === value);
    const quiet = known.size === this.final.size && !deferred.size && !this.tails.size && !workflows.some(isLive);
    this.quietUntil = quiet ? Math.min(checked + SETTLED_RECHECK_MS, ...[...this.final.values()].map(f => f.checked + SETTLED_RECHECK_MS)) : 0;
    if (this.source !== workflows || configChanged || !sameFacts || !quiet) {
      this.workflows = own === undefined ? workflows : orderWorkflows(workflows, own);
      this.facts = facts; this.sessions = sessions; this.revision = {};
    }
    this.source = workflows;
    return this.revision;
  }
}

/** P16, P25: Submit through M1's durable user path and report asynchronous rejection without waking it. */
export class UiActions {
  private deps: UiDeps;
  private pending = new Map<string, string>();
  readonly resolutions: { rid: string; applied: boolean; reason?: string }[] = [];
  constructor(deps: UiDeps) { this.deps = deps; }
  /** v12 §5: Expose the actual control receipt, not a successful submission as an application. */
  async send(args: Record<string, unknown>, note: string): Promise<{ state: "applied" | "submitted" | "rejected"; reason?: string; rid?: string }> {
    try {
      const result = await this.deps.submit(args) as { submitted?: { rid?: string }; applied?: boolean; reason?: string; rid?: string; error?: string } | undefined;
      if (result?.error) throw new Error(result.error);
      if (result?.submitted?.rid) this.pending.set(result.submitted.rid, note);
      if (result?.applied === false) {
        const reason = result.reason ?? "rejected";
        this.deps.presentNote(`[user] ${note}: ${reason}`);
        return { state: "rejected", reason, rid: result.rid };
      }
      this.deps.presentNote(`[user] ${note}`);
      return { state: result?.applied ? "applied" : "submitted", rid: result?.rid ?? result?.submitted?.rid };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.presentNote(`[user] ${note}: ${reason}`);
      return { state: "rejected", reason };
    }
  }
  /** v12 §5: Resolve deferred controls from the durable ledger without confusing submission with application. */
  reconcile(): string | undefined {
    let latest: string | undefined;
    if (!this.pending.size) return;
    const decisions = readerLedger(this.deps.home).state.resolutions;
    const ready = [...this.pending].filter(([rid]) => decisions.has(rid)).sort(([a], [b]) => decisions.get(a)!.seq - decisions.get(b)!.seq);
    for (const [rid, note] of ready) {
      const e = decisions.get(rid);
      if (!e) continue;
      if (e.type === JT.rejected) { latest = `${note}: ${String(e.reason)}`; this.deps.presentNote(`[user] ${latest}`); }
      this.resolutions.push({ rid, applied: e.type === JT.applied, ...(e.type === JT.rejected ? { reason: String(e.reason) } : {}) });
      this.pending.delete(rid);
    }
    return latest;
  }
}
