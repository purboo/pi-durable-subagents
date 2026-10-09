import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { TestContext } from "node:test";
import { openJournal } from "../../../../src/kernel/journal.ts";
import createEffects from "../../../../src/orchestrator/executor/effects/index.ts";
import type { CallTicket } from "../../../../src/orchestrator/contract.ts";
import type { CallResult, JournalHandle } from "../../../../src/types.ts";

/** P32: Run real Git with temporary, isolated user configuration. */
export async function git(cwd: string, ...args: string[]) {
  return (await promisify(execFile)("git", args, { cwd, timeout: 10000, env: { ...process.env, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } })).stdout.trim();
}
/** A1: Inject one crash immediately before or after a durable record. */
export function crash(journal: JournalHandle, type: string, after = false): JournalHandle {
  let armed = true;
  return { path: journal.path, entries: () => journal.entries(), close: () => journal.close(), append: async (kind, fields) => {
    if (armed && kind === type) { armed = false; if (after) await journal.append(kind, fields); throw new Error(`crash:${type}`); }
    return journal.append(kind, fields);
  } };
}
/** P19–P33: Build an isolated ledger and ticket; cleanup never reaches the real HOME. The workflow id is unique per
 *  fixture: a gate's processes are tagged with its call id (DSA_EXEC) and fenced by scanning every process on the
 *  machine, so test files running in parallel must never share one (a shared id let one file fence or count another's
 *  gate). */
export async function fixture(test: TestContext) {
  const wid = `W${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const root = await mkdtemp(join(tmpdir(), "dsa-effects-")), cwd = join(root, "repo"), home = join(root, "state");
  const isolated = { HOME: root, XDG_CONFIG_HOME: join(root, "config"), PI_CODING_AGENT_DIR: join(root, "pi"), DSA_HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const old = Object.fromEntries(Object.keys(isolated).map(key => [key, process.env[key]]));
  Object.assign(process.env, isolated);
  test.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  await mkdir(cwd); const journal = await openJournal(join(home, "w", wid, "journal.jsonl"));
  const orch = await openJournal(join(home, "orchestrator.jsonl"));
  test.after(async () => { await journal.close(); await orch.close(); await rm(root, { recursive: true, force: true }); });
  const t: CallTicket = { wid, widRev: `${wid}@1`, key: "task", gen: 1, callId: `${wid}@1/task@1`, spec: { agent: "test", task: "task" }, cwd, journal,
    agent: { name: "test", description: "", body: "", source: "project", sourcePath: "", systemPromptMode: "append", inheritProjectContext: false, inheritSkills: false } };
  const ledgers = { home, orch, config: {} }, result: CallResult = { key: t.key, gen: 1, status: "ok", ok: true, output: "complete\n" };
  const effects = () => createEffects(ledgers), sessionPath = join(home, "session.jsonl");
  const before = (ticket = t, value = result, signal = new AbortController().signal) => effects().beforeSeal(ticket, `${ticket.callId}#1.1`, value, { signal });
  return { root, cwd, home, t, journal, effects, sessionPath, before, result };
}
