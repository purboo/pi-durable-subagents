import test from "node:test";
import assert from "node:assert/strict";
import { access, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, git, crash } from "./helpers.ts";

for (const window of ["normal", "intent", "branch", "effect", "created"]) test(`worktree creation reconciles ${window}`, async ctx => {
  const f = await fixture(ctx); f.t.spec.isolation = "worktree";
  await git(f.cwd, "init"); await git(f.cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "base");
  const base = await git(f.cwd, "rev-parse", "HEAD");
  if (window !== "normal") {
    const type = ["intent", "branch"].includes(window) ? "wt-intent" : "wt-created";
    await assert.rejects(f.effects().prepare({ ...f.t, journal: crash(f.journal, type, window !== "effect") }, { sessionPath: f.sessionPath }), /crash:/);
    if (window === "branch") await git(f.cwd, "branch", `dsa/${f.t.wid}/task`, base);
    if (window === "intent") await git(f.cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "new HEAD after intent");
  }
  const prepared = await f.effects().prepare(f.t, { sessionPath: f.sessionPath });
  assert.equal(prepared.cwd, join(f.cwd, ".dsa", f.t.wid, "task"));
  assert.equal(await git(prepared.cwd, "rev-parse", "HEAD"), base);
  assert.deepEqual(await f.effects().prepare(f.t, { sessionPath: f.sessionPath }), prepared);
  assert.equal(f.journal.entries().filter(e => e.type === "wt-intent").length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "wt-created").length, 1);
  await f.effects().afterSeal(f.t, { ...f.result, status: "failed", ok: false });
  await access(prepared.cwd);
  await f.effects().afterSeal(f.t, f.result); await f.effects().afterSeal(f.t, f.result);
  await assert.rejects(access(prepared.cwd));
  assert.equal(await git(f.cwd, "rev-parse", `dsa/${f.t.wid}/task`), base);
  assert.equal(f.journal.entries().filter(e => e.type === "wt-removed").length, 1);
});
for (const window of ["intent", "effect"]) test(`worktree removal reconciles ${window}`, async ctx => {
  const f = await fixture(ctx); f.t.spec.isolation = "worktree";
  await git(f.cwd, "init"); await git(f.cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  const { cwd } = await f.effects().prepare(f.t, { sessionPath: f.sessionPath });
  await assert.rejects(f.effects().afterSeal({ ...f.t, journal: crash(f.journal, window === "intent" ? "wt-remove-intent" : "wt-removed", window === "intent") }, f.result), /crash:/);
  await f.effects().afterSeal(f.t, f.result);
  await assert.rejects(access(cwd));
  assert.equal(f.journal.entries().filter(e => e.type === "wt-removed").length, 1);
});
test("dirty worktree is retained with deduplicated attention and reused by the next generation", { skip: process.platform === "win32" ? "uses a POSIX shell gate and unescaped Windows paths in a RegExp" : false }, async ctx => {
  const f = await fixture(ctx); f.t.spec.isolation = "worktree";
  await git(f.cwd, "init"); await git(f.cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  const { cwd } = await f.effects().prepare(f.t, { sessionPath: f.sessionPath });
  await writeFile(join(cwd, "dirty"), "user work");
  f.t.spec.gate = "test -f dirty";
  assert.equal((await f.before()).status, "ok");
  await f.effects().afterSeal(f.t, f.result); await f.effects().afterSeal(f.t, f.result);
  assert.equal(await readFile(join(cwd, "dirty"), "utf8"), "user work");
  const items = f.journal.entries().filter(e => e.type === "attention");
  assert.equal(items.length, 1); assert.match(JSON.stringify(items[0]), new RegExp(cwd));
  assert.equal(f.journal.entries().filter(e => e.type === "wt-kept" && e.call === f.t.callId).length, 1);
  assert.deepEqual(await f.effects().prepare({ ...f.t, gen: 2, callId: `${f.t.widRev}/task@2`, continueFrom: f.t.callId }, { sessionPath: f.sessionPath }), { cwd });
});
for (const moved of ["branch", "detached"] as const) test(`a moved worktree fails only this call at preparation, naming both identities (${moved})`, async ctx => {
  const f = await fixture(ctx); f.t.spec.isolation = "worktree";
  await git(f.cwd, "init"); await git(f.cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  const base = await git(f.cwd, "rev-parse", "HEAD");
  const { cwd } = await f.effects().prepare(f.t, { sessionPath: f.sessionPath });
  await writeFile(join(cwd, "keep"), "someone's work");
  if (moved === "branch") await git(cwd, "checkout", "-b", "moved");
  else await git(cwd, "checkout", "--detach", base);
  const branch = `dsa/${f.t.wid}/task`, parts = ["Worktree identity conflict", f.t.callId, f.t.wid, cwd, branch];
  await assert.rejects(f.effects().prepare(f.t, { sessionPath: f.sessionPath }),
    (error: Error) => parts.every(part => error.message.includes(part)) &&
      (moved === "branch" ? /moved at [0-9a-f]{7,}/.test(error.message) : /a detached HEAD at [0-9a-f]{7,}/.test(error.message)),
    "the failure names the call, the workflow, the path and both identities");
  // The refused preparation changed nothing: the branch, the worktree and what it holds are as they were.
  assert.equal(await git(f.cwd, "rev-parse", branch), base);
  assert.equal(await readFile(join(cwd, "keep"), "utf8"), "someone's work");
  assert.equal(f.journal.entries().filter(e => ["wt-kept", "wt-removed", "wt-remove-intent", "attention"].includes(e.type)).length, 0);
});
for (const moved of ["branch", "detached"] as const) test(`a sealed call keeps a moved worktree with one conflict note and the result stands (${moved})`, async ctx => {
  const f = await fixture(ctx); f.t.spec.isolation = "worktree";
  await git(f.cwd, "init"); await git(f.cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  const base = await git(f.cwd, "rev-parse", "HEAD");
  const { cwd } = await f.effects().prepare(f.t, { sessionPath: f.sessionPath });
  await writeFile(join(cwd, "keep"), "someone's work");
  if (moved === "branch") await git(cwd, "checkout", "-b", "moved");
  else await git(cwd, "checkout", "--detach", base);
  // Repeated recovery of the same sealed call: no throw (its result is final), one note, one durable keep.
  await f.effects().afterSeal(f.t, f.result); await f.effects().afterSeal(f.t, f.result);
  const notes = f.journal.entries().filter(e => e.type === "attention");
  assert.equal(notes.length, 1);
  const text = String((notes[0] as unknown as { item: { text: string } }).item.text);
  for (const part of [f.t.callId, f.t.wid, cwd, `dsa/${f.t.wid}/task`, moved === "branch" ? "moved at" : "a detached HEAD at"])
    assert.ok(text.includes(part), `${text} names ${part}`);
  assert.equal(f.journal.entries().filter(e => e.type === "wt-kept" && e.call === f.t.callId).length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "wt-removed").length, 0);
  // Nothing was removed or moved to make the identities agree, and the call's result is unchanged.
  assert.equal(await readFile(join(cwd, "keep"), "utf8"), "someone's work");
  assert.equal(await git(f.cwd, "rev-parse", `dsa/${f.t.wid}/task`), base);
  assert.ok((await git(f.cwd, "worktree", "list", "--porcelain")).includes(cwd));
  assert.deepEqual(f.result, { key: "task", gen: 1, status: "ok", ok: true, output: "complete\n" });
});
test("a worktree that cannot be inspected still fails the cleanup: unrelated Git errors are not swallowed", async ctx => {
  const f = await fixture(ctx); f.t.spec.isolation = "worktree";
  const path = join(f.cwd, ".dsa", f.t.wid, "task");
  await f.journal.append("wt-intent", { call: f.t.callId, path, branch: `dsa/${f.t.wid}/task`, base: "0".repeat(40) });
  await f.journal.append("wt-created", { call: f.t.callId });
  // cwd is no repository: Git fails and the cleanup fails with it, rather than reporting a kept worktree it never saw.
  await assert.rejects(f.effects().afterSeal(f.t, f.result), /git worktree list/);
  assert.equal(f.journal.entries().filter(e => ["wt-kept", "attention"].includes(e.type)).length, 0);
});
test("non-git cwd and foreign branches refuse isolation", async ctx => {
  const f = await fixture(ctx); f.t.spec.isolation = "worktree";
  await assert.rejects(f.effects().prepare(f.t, { sessionPath: f.sessionPath }));
  assert.equal(f.journal.entries().length, 0);
  await git(f.cwd, "init"); await git(f.cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  await git(f.cwd, "branch", `dsa/${f.t.wid}/task`);
  await assert.rejects(f.effects().prepare(f.t, { sessionPath: f.sessionPath }), /already exists/);
});
test("colon fan-out keys and their literal spellings use distinct worktrees and branches", async ctx => {
  const f = await fixture(ctx); f.t.spec.isolation = "worktree";
  await git(f.cwd, "init"); await git(f.cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  const branches = new Set<string>();
  for (const key of ["tasks:0", "tasks-0", "tasks%3A0", "chain:0"]) {
    const t = { ...f.t, key, callId: `${f.t.wid}@1/${key}@1` };
    const prepared = await f.effects().prepare(t, { sessionPath: f.sessionPath });
    assert.equal(prepared.cwd, join(f.cwd, ".dsa", f.t.wid, key));
    const branch = await git(prepared.cwd, "symbolic-ref", "--short", "HEAD");
    if (!key.includes(":")) assert.equal(branch, `dsa/${f.t.wid}/${key}`);
    assert.ok(!branches.has(branch)); branches.add(branch);
  }
});

/** Another spelling of one absolute path: the first letter after a separator, other case. Git holds a drive letter and
 *  directory names in one form, while a Windows path may carry another; on a case-sensitive file system the other
 *  spelling is a different directory, and the test says so. */
function recase(path: string): string {
  return path.replace(/(^|[\\/])([^\\/])/, (_all, lead: string, first: string) =>
    lead + (first === first.toUpperCase() ? first.toLowerCase() : first.toUpperCase()));
}
/** A journal whose call already has an intent for another spelling of its worktree, committed before the creation
 *  intent a real earlier attempt would have written (entries are in append order, oldest first). */
async function earlierIntent(f: Awaited<ReturnType<typeof fixture>>, entry: { path: string; branch: string; base: string }) {
  await f.journal.append("wt-intent", { call: f.t.callId, ...entry });
  const entries = f.journal.entries(), intent = entries.findLast(e => e.type === "wt-intent" && e.call === f.t.callId)!;
  // Reordered only in what a reader sees; a later append still goes to the real journal.
  return { ...f.journal, entries: () => [intent, ...entries.filter(e => e !== intent)] };
}

/** Whether the file system ignores case, which is where two spellings of one path matter (Windows; macOS usually). */
async function caseInsensitive(path: string): Promise<boolean> {
  try { await access(recase(path)); return true; } catch { return false; }
}

test("a case-only spelling of a created worktree is the same worktree, not a second one", async ctx => {
  const f = await fixture(ctx); f.t.spec.isolation = "worktree";
  await git(f.cwd, "init"); await git(f.cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  if (!await caseInsensitive(f.cwd)) return; // a case-sensitive file system: the other spelling names no directory
  const base = await git(f.cwd, "rev-parse", "HEAD"), path = join(f.cwd, ".dsa", f.t.wid, "task");
  // The earlier intent was written for the other spelling, as a Windows path may carry it; Git registered the first.
  const journal = await earlierIntent(f, { path: path.replace(/([\\/])task$/, "$1Task"), branch: `dsa/${f.t.wid}/task`, base });
  const prepared = await f.effects().prepare({ ...f.t, journal }, { sessionPath: f.sessionPath });
  // Git registers the worktree once; a lookup that missed it would create a second under the other spelling, or fail
  // because its own directory is in the way.
  assert.equal(prepared.cwd, path);
  assert.equal(await git(prepared.cwd, "rev-parse", "HEAD"), base);
  assert.equal((await git(f.cwd, "worktree", "list", "--porcelain")).split("\n").filter(line => line === `worktree ${path}`).length, 1);
  if (process.platform === "win32") {
    // The identity Git keys its registry by is recorded, so the cleanup and every recovery find the same working directory.
    const recorded = f.journal.entries().filter(e => e.type === "wt-path" && e.call === f.t.callId);
    assert.equal(recorded.length, 1);
    assert.equal(String(recorded[0]!.path), path);
  }
});

test("a key that would leave its workflow's directory is refused", async ctx => {
  const f = await fixture(ctx); f.t.spec.isolation = "worktree";
  await git(f.cwd, "init"); await git(f.cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  const root = join(f.cwd, ".dsa", f.t.wid);
  // A nested key stays a nested path, as it always was.
  assert.equal((await f.effects().prepare({ ...f.t, key: "tasks/nested", callId: `${f.t.wid}@1/tasks/nested@1` }, { sessionPath: f.sessionPath })).cwd,
    join(root, "tasks", "nested"));
  // `..` and an absolute or drive-qualified key, which `resolve` lets replace the root itself, name no worktree of this call.
  for (const key of ["..", "a/../../b", f.cwd, join(f.cwd, "outside"), ...(process.platform === "win32" ? ["C:\\outside"] : [])]) {
    const t = { ...f.t, key, callId: `${f.t.wid}@1/${key}@1` };
    await assert.rejects(f.effects().prepare(t, { sessionPath: f.sessionPath }), /Invalid worktree key/, key);
    assert.equal(f.journal.entries().some(e => e.type === "wt-intent" && e.call === t.callId), false, `${key}: no intent was recorded`);
  }
  assert.equal((await f.effects().prepare(f.t, { sessionPath: f.sessionPath })).cwd, join(root, "task"), "its own call still prepares");
});

test("a moved worktree is named through another spelling of its path instead of being re-created", async ctx => {
  const f = await fixture(ctx); f.t.spec.isolation = "worktree";
  await git(f.cwd, "init"); await git(f.cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  const prepared = await f.effects().prepare(f.t, { sessionPath: f.sessionPath }), branch = `dsa/${f.t.wid}/task`;
  // Someone moved the worktree to a detached HEAD: the conflict is recognised through the other spelling of the same
  // directory too, so the call fails naming both identities instead of creating a second worktree under it.
  await git(prepared.cwd, "checkout", "--detach");
  const moved = await git(f.cwd, "worktree", "list", "--porcelain"), head = /HEAD ([0-9a-f]+)/.exec(moved.slice(moved.indexOf(`worktree ${prepared.cwd}`)))![1]!;
  if (!await caseInsensitive(prepared.cwd)) return; // a case-sensitive file system: the other spelling names no directory
  const journal = await earlierIntent(f, { path: recase(prepared.cwd.replace(/task$/, "Task")), branch, base: head });
  await assert.rejects(f.effects().prepare({ ...f.t, journal }, { sessionPath: f.sessionPath }), error => {
    const message = String(error);
    return /Worktree identity conflict/.test(message) && message.includes(prepared.cwd) && message.includes("a detached HEAD") && message.includes(branch);
  });
});
