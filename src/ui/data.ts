import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { UiDeps } from "../agent/main.ts";
import { readJournalSnapshot } from "../kernel/journal.ts";
type Entry = ReturnType<typeof readJournalSnapshot>[number];
import { allWorkflows, type WorkflowSnapshot } from "../orchestrator/snapshot.ts";
import { callDir, callSession, journalPath, orchLedger } from "../paths.ts";
import { LIVE_FILE, type Live } from "../agent/child/live.ts";
import { JT } from "../types.ts";
import { SessionTail, sessionBranch, sessionFacts } from "./session.ts";
import type { Facts } from "./view.ts";

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
 *  final: a follow-up or a revision runs as a new generation with its own session. A session changed after that (by
 *  hand) shows in a new pi session only. */
const FINAL_MS = 10_000;
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
  private final = new Map<string, { endedAt: number; path: string; facts: Facts }>();
  /** The transcript of one final call last asked for (the open call view asks on every frame). Keeping every
   *  historical transcript parsed held hundreds of MB and made pi's garbage collection pause typing. */
  private opened?: { callId: string; entries: SessionEntry[] };
  private transcript(callId: string, sessions: LazyMap<readonly SessionEntry[]>): void {
    const final = this.final.get(callId);
    if (!final) return;
    if (this.opened?.callId !== callId) this.opened = { callId, entries: sessionBranch(new SessionTail().read(final.path)) };
    sessions.put(callId, this.opened.entries);
  }
  /** Branch and facts per call, reused while its session tail is unchanged: a finished call's session never grows, and
   *  re-deriving every historical call on each refresh blocked pi's main thread for over a second. */
  private derived = new Map<string, { source: readonly SessionEntry[]; length: number; entries: SessionEntry[]; facts: Facts }>();
  home: string;
  constructor(home: string) { this.home = home; }
  refresh() {
    const workflows = allWorkflows(this.home), known = new Set<string>(), deferred = new Map<string, () => void>();
    const facts = new LazyMap<Facts>(key => deferred.get(key)?.());
    const sessions = new LazyMap<readonly SessionEntry[]>(key => deferred.has(key) ? deferred.get(key)!() : this.transcript(key, sessions));
    for (const w of workflows) {
      let index: JournalIndex | undefined; // only calls still followed need it
      const journal = () => index ??= journalIndex(readJournalSnapshot(journalPath(this.home, w.wid)));
      for (const c of w.calls) {
        known.add(c.callId);
        const final = this.final.get(c.callId);
        if (final && c.phase === "sealed" && c.endedAt === final.endedAt) { facts.put(c.callId, final.facts); continue; }
        if (final) this.final.delete(c.callId);
        const load = () => {
          deferred.delete(c.callId);
          let tail = this.tails.get(c.callId);
          if (!tail) { tail = new SessionTail(); this.tails.set(c.callId, tail); }
          const source = tail.read(callSession(this.home, w.wid, c.key, c.gen));
          let cached = this.derived.get(c.callId);
          if (!cached || cached.source !== source || cached.length !== source.length) {
            const entries = sessionBranch(source);
            cached = { source, length: source.length, entries, facts: sessionFacts(entries, c.callId) };
            this.derived.set(c.callId, cached);
          }
          const value: Facts = { ...cached.facts, live: undefined };
          const proposal = journal().calls.get(`${c.key}\0${c.gen}`);
          value.task ||= String((proposal?.spec as { task?: string } | undefined)?.task ?? "");
          const loss = journal().losses.get(String(c.exec)) ?? -1;
          const launch = journal().execs.get(String(c.exec)) ?? -1;
          if (c.phase !== "sealed" && loss > launch) value.activity = "connection dropped, retrying";
          if (c.phase !== "sealed") value.live = readLive(join(callDir(this.home, w.wid, c.key, c.gen), LIVE_FILE));
          sessions.put(c.callId, cached.entries); facts.put(c.callId, value);
          // A call sealed a while ago writes nothing more (a follow-up opens a new generation and session), so its
          // session is not stat'ed again: polling every historical session twice a second kept pi's main thread busy.
          if (c.phase === "sealed" && c.endedAt !== undefined && Date.now() - c.endedAt > FINAL_MS) {
            this.final.set(c.callId, { endedAt: c.endedAt, path: callSession(this.home, w.wid, c.key, c.gen), facts: value });
            this.tails.delete(c.callId); this.derived.delete(c.callId);
          }
        };
        // A finished call never read before (history at startup) is read when first shown or by the idle warm-up below;
        // reading every historical session up front blocked pi's startup for seconds.
        if (c.phase === "sealed" && !this.tails.has(c.callId)) deferred.set(c.callId, load);
        else load();
      }
    }
    for (const key of this.tails.keys()) if (!known.has(key)) { this.tails.delete(key); this.derived.delete(key); }
    for (const key of this.final.keys()) if (!known.has(key)) this.final.delete(key);
    // Warm the history a slice at a time, so opening the list later finds it read without one long stall now.
    const until = performance.now() + this.warmMs;
    for (const load of [...deferred.values()]) { if (performance.now() >= until) break; load(); }
    this.workflows = workflows; this.facts = facts; this.sessions = sessions;
    // UI-only optional aliases; absence or invalid config must not break execution (P21).
    try {
      const config = JSON.parse(readFileSync(join(this.home, "config.json"), "utf8"));
      this.aliases = Object.fromEntries(Object.entries(config.ui?.modelAliases ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>;
      this.dock = ["auto", "line", "off"].includes(config.ui?.dock) ? config.ui.dock : "auto";
      this.dockAt = config.ui?.dockAt === "below" ? "below" : "above";
    } catch { this.aliases = {}; this.dock = "auto"; this.dockAt = "above"; }
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
    for (const e of readJournalSnapshot(orchLedger(this.deps.home))) {
      const note = this.pending.get(String(e.rid));
      if (!note) continue;
      if (e.type === JT.rejected) { latest = `${note}: ${String(e.reason)}`; this.deps.presentNote(`[user] ${latest}`); }
      if (e.type === JT.applied || e.type === JT.rejected) {
        this.resolutions.push({ rid: String(e.rid), applied: e.type === JT.applied, ...(e.type === JT.rejected ? { reason: String(e.reason) } : {}) });
        this.pending.delete(String(e.rid));
      }
    }
    return latest;
  }
}
