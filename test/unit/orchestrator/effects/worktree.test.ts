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
    if (window === "branch") await git(f.cwd, "branch", "dsa/W/task", base);
    if (window === "intent") await git(f.cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "new HEAD after intent");
  }
  const prepared = await f.effects().prepare(f.t, { sessionPath: f.sessionPath });
  assert.equal(prepared.cwd, join(f.cwd, ".dsa", "W", "task"));
  assert.equal(await git(prepared.cwd, "rev-parse", "HEAD"), base);
  assert.deepEqual(await f.effects().prepare(f.t, { sessionPath: f.sessionPath }), prepared);
  assert.equal(f.journal.entries().filter(e => e.type === "wt-intent").length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "wt-created").length, 1);
  await f.effects().afterSeal(f.t, { ...f.result, status: "failed", ok: false });
  await access(prepared.cwd);
  await f.effects().afterSeal(f.t, f.result); await f.effects().afterSeal(f.t, f.result);
  await assert.rejects(access(prepared.cwd));
  assert.equal(await git(f.cwd, "rev-parse", "dsa/W/task"), base);
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
test("dirty worktree is retained with deduplicated attention and reused by the next generation", async ctx => {
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
  assert.deepEqual(await f.effects().prepare({ ...f.t, gen: 2, callId: "W@1/task@2", continueFrom: f.t.callId }, { sessionPath: f.sessionPath }), { cwd });
});
test("non-git cwd and foreign branches refuse isolation", async ctx => {
  const f = await fixture(ctx); f.t.spec.isolation = "worktree";
  await assert.rejects(f.effects().prepare(f.t, { sessionPath: f.sessionPath }));
  assert.equal(f.journal.entries().length, 0);
  await git(f.cwd, "init"); await git(f.cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  await git(f.cwd, "branch", "dsa/W/task");
  await assert.rejects(f.effects().prepare(f.t, { sessionPath: f.sessionPath }), /already exists/);
});
