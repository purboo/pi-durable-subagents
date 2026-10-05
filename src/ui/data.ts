import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { UiDeps } from "../agent/main.ts";
import { readJournalSnapshot } from "../kernel/journal.ts";
import { allWorkflows, type WorkflowSnapshot } from "../orchestrator/snapshot.ts";
import { callSession, journalPath, orchLedger } from "../paths.ts";
import { JT } from "../types.ts";
import { SessionTail, sessionBranch, sessionFacts } from "./session.ts";
import type { Facts } from "./view.ts";

/** A1, P25: Read the UI's data from durable workflow snapshots and native session tails only. */
export class UiData {
  workflows: WorkflowSnapshot[] = [];
  facts = new Map<string, Facts>();
  sessions = new Map<string, readonly SessionEntry[]>();
  aliases: Record<string, string> = {};
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
        sessions.set(c.callId, entries); facts.set(c.callId, value);
      }
    }
    for (const key of this.tails.keys()) if (!sessions.has(key)) this.tails.delete(key);
    this.workflows = workflows; this.facts = facts; this.sessions = sessions;
    // UI-only optional aliases; absence or invalid config must not break execution (P21).
    try {
      const config = JSON.parse(readFileSync(join(this.home, "config.json"), "utf8"));
      this.aliases = Object.fromEntries(Object.entries(config.ui?.modelAliases ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    } catch { this.aliases = {}; }
  }
}

/** P16, P25: Submit through M1's durable user path and report asynchronous rejection without waking it. */
export class UiActions {
  private deps: UiDeps;
  private pending = new Map<string, string>();
  constructor(deps: UiDeps) { this.deps = deps; }
  async send(args: Record<string, unknown>, note: string): Promise<string | undefined> {
    try {
      const result = await this.deps.submit(args) as { submitted?: { rid?: string }; error?: string } | undefined;
      if (result?.error) throw new Error(result.error);
      if (result?.submitted?.rid) this.pending.set(result.submitted.rid, note);
      this.deps.presentNote(`[user] ${note}`);
      return undefined;
    } catch (error) {
      const text = `${note}: ${error instanceof Error ? error.message : String(error)}`;
      this.deps.presentNote(`[user] ${text}`); return text;
    }
  }
  reconcile(): string | undefined {
    let latest: string | undefined;
    if (!this.pending.size) return;
    for (const e of readJournalSnapshot(orchLedger(this.deps.home))) {
      const note = this.pending.get(String(e.rid));
      if (!note) continue;
      if (e.type === JT.rejected) { latest = `${note}: ${String(e.reason)}`; this.deps.presentNote(`[user] ${latest}`); }
      if (e.type === JT.applied || e.type === JT.rejected) this.pending.delete(String(e.rid));
    }
    return latest;
  }
}
