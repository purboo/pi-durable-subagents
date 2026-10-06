import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { UiDeps } from "../agent/main.ts";
import { readJournalSnapshot } from "../kernel/journal.ts";
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
/** A1, P25: Read the UI's data from durable workflow snapshots and native session tails only. */
export class UiData {
  workflows: WorkflowSnapshot[] = [];
  facts = new Map<string, Facts>();
  sessions = new Map<string, readonly SessionEntry[]>();
  aliases: Record<string, string> = {};
  /** UI §1: the dock above the editor — "auto" (live rows), "line" (one summary line) or "off". */
  dock: "auto" | "line" | "off" = "auto";
  /** Where the dock sits: below the editor (default; never splits an editor header such as a powerline bar) or above. */
  dockAt: "below" | "above" = "above";
  private tails = new Map<string, SessionTail>();
  home: string;
  constructor(home: string) { this.home = home; }
  refresh() {
    const workflows = allWorkflows(this.home), facts = new Map<string, Facts>(), sessions = new Map<string, readonly SessionEntry[]>();
    for (const w of workflows) {
      const journal = readJournalSnapshot(journalPath(this.home, w.wid));
      for (const c of w.calls) {
        let tail = this.tails.get(c.callId);
        if (!tail) { tail = new SessionTail(); this.tails.set(c.callId, tail); }
        const entries = sessionBranch(tail.read(callSession(this.home, w.wid, c.key, c.gen)));
        const value = sessionFacts(entries, c.callId);
        const proposal = journal.findLast(e => e.type === "call" && e.key === c.key && e.gen === c.gen);
        value.task ||= String((proposal?.spec as { task?: string } | undefined)?.task ?? "");
        const loss = journal.findLastIndex(e => e.type === "loss" && e.exec === c.exec);
        const launch = journal.findLastIndex(e => e.type === JT.exec && e.exec === c.exec);
        if (c.phase !== "sealed" && loss > launch) value.activity = "connection dropped, retrying";
        if (c.phase !== "sealed") value.live = readLive(join(callDir(this.home, w.wid, c.key, c.gen), LIVE_FILE));
        sessions.set(c.callId, entries); facts.set(c.callId, value);
      }
    }
    for (const key of this.tails.keys()) if (!sessions.has(key)) this.tails.delete(key);
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
