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
