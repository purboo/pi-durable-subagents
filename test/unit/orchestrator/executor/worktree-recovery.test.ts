// Recovery of a sealed successful call whose worktree someone moved (another branch, or a detached HEAD): the call keeps
// its result, the worktree and the branch are kept with one durable note, and the start's recovery of that call finishes.
// Before this, the post-seal cleanup threw, so `Executor.run` — which `Engine.recover` awaits for a successful call with
// an unsettled worktree — rejected on every start.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { ulid } from "../../../../src/kernel/ids.ts";
import { journalPath, orchLedger } from "../../../../src/paths.ts";
import { JT, type CallResult, type Containment, type Entry, type ProcInfo } from "../../../../src/types.ts";
import type { CallTicket } from "../../../../src/orchestrator/contract.ts";
import createExecutor from "../../../../src/orchestrator/executor/index.ts";
import { countWorktrees, listedWorktrees, localPath } from "../worktree-list.ts";

const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)("git", args, { cwd, timeout: 10000, env: { ...process.env, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } })).stdout.trim();
/** No child ran here (the call is sealed): the fence finds nothing and the test never touches a real process. */
const containment: Containment = {
  async spawn() { const s = new PassThrough(); s.end(); return { pid: 0, start: "", stdin: new PassThrough(), stdout: s, stderr: s, exited: Promise.resolve({ code: 0, signal: null }) }; },
  async scan(known: ReadonlyMap<string, readonly ProcInfo[]>) { return new Map([...known.keys()].map(exec => [exec, []])); },
  async fence() {},
};

/** A sealed successful call with a worktree that someone then moved to another branch (or a detached HEAD). */
async function fixture(t: TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dsa-wt-recovery-"))), repo = join(home, "repo"), wid = ulid();
  const orch = await openJournal(orchLedger(home)), journal = await openJournal(journalPath(home, wid));
  const call = `${wid}@1/a@1`, exec = `${call}#1.1`, branch = `dsa/${wid}/a`, path = join(repo, ".dsa", wid, "a");
  const base = await (async () => {
    await mkdir(repo, { recursive: true });
    await git(repo, "init");
    await git(repo, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
    const head = await git(repo, "rev-parse", "HEAD");
    await mkdir(join(repo, ".dsa", wid), { recursive: true });
    await git(repo, "worktree", "add", "-b", branch, path, head);
    return head;
  })();
  await writeFile(join(path, "keep.txt"), "a person's work\n");
  const result: CallResult = { key: "a", gen: 1, status: "ok", ok: true, output: "complete\n" };
  await journal.append("call", { key: "a", gen: 1, pos: 0, spec: { agent: "test", task: "task", isolation: "worktree" } });
  await journal.append("wt-intent", { call, path, branch, base });
  await journal.append("wt-created", { call });
  await journal.append(JT.exec, { call, exec });
  await journal.append(JT.fenced, { exec });
  await journal.append(JT.sealed, { call, exec, result });
  const executors: ReturnType<typeof createExecutor>[] = [];
  t.after(async () => { for (const e of executors) await e.shutdown(); await journal.close(); await orch.close(); await rm(home, { recursive: true, force: true }); });
  /** One orchestrator start's recovery of this call (a fresh executor each time, as a restart makes one). */
  const recover = async () => {
    const executor = createExecutor({ home, orch, config: { k: { trackerMs: 20 } } }, { containment, memory: async () => 1e6, sweepMs: 60000 });
    executors.push(executor);
    const ticket: CallTicket = { wid, widRev: `${wid}@1`, key: "a", gen: 1, callId: call, cwd: repo, journal, spec: { agent: "test", task: "task", isolation: "worktree" },
      agent: { name: "test", description: "", body: "", source: "project", sourcePath: "", systemPromptMode: "append", inheritProjectContext: false, inheritSkills: false } };
    return { result: await executor.run(ticket), entries: journal.entries() };
  };
  const ofType = (entries: readonly Entry[], type: string) => entries.filter(e => e.type === type);
  return { home, repo, wid, journal, call, exec, branch, path, base, result, recover, ofType };
}

for (const moved of ["branch", "detached"] as const) test(`recovery keeps a moved worktree of a sealed call and still returns its result (${moved})`, async t => {
  const f = await fixture(t);
  if (moved === "branch") await git(f.path, "checkout", "-b", "moved");
  else await git(f.path, "checkout", "--detach", f.base);
  const first = await f.recover();
  // The sealed result stands: recovery of the call completes instead of rejecting the start.
  assert.deepEqual(first.result, f.result);
  const notes = f.ofType(first.entries, "attention");
  assert.equal(notes.length, 1);
  const text = String((notes[0] as unknown as { item: { text: string } }).item.text);
  for (const part of [f.call, f.wid, f.path, f.branch, moved === "branch" ? "moved at" : "a detached HEAD at"])
    assert.ok(text.includes(part), `${text} names ${part}`);
  assert.equal(f.ofType(first.entries, "wt-kept").filter(e => e.call === f.call).length, 1);
  assert.equal(f.ofType(first.entries, "wt-removed").length, 0);
  // Nothing was removed or moved to make the identities agree: the files, the worktree and its branch stay.
  assert.equal(await readFile(join(f.path, "keep.txt"), "utf8"), "a person's work\n");
  assert.equal(await git(f.repo, "rev-parse", f.branch), f.base);
  assert.equal(countWorktrees(await listedWorktrees(f.repo), localPath(f.path, 3)), 1);
  // A later start recovers the same call again: no new note, no new keep, the same result.
  const second = await f.recover();
  assert.deepEqual(second.result, f.result);
  assert.equal(f.ofType(second.entries, "attention").length, 1);
  assert.equal(f.ofType(second.entries, "wt-kept").length, 1);
  assert.equal(second.entries.length, first.entries.length, "a repeated recovery appends nothing");
});
