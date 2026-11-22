import test from "node:test";
import assert from "node:assert/strict";
import { access, writeFile, readFile, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fixture, git, crash } from "./helpers.ts";
import { countWorktrees, listedWorktrees, localPath } from "../worktree-list.ts";

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
  assert.equal(countWorktrees(await listedWorktrees(f.cwd), localPath(cwd, 3)), 1);
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
/** A directory link to `target`: a junction on Windows (no privilege needed) and a symbolic link elsewhere. It names one
 *  directory under a second spelling, which is what an 8.3 alias, another case or a symlinked `/var` does on a real
 *  machine: the call's recorded path and the path Git lists then differ while naming one worktree. */
async function linkDirectory(target: string, path: string) {
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

test("colon keys and other names Win32 cannot spell use their own worktrees and branches", async ctx => {
  const f = await fixture(ctx); f.t.spec.isolation = "worktree";
  await git(f.cwd, "init"); await git(f.cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  const base = await git(f.cwd, "rev-parse", "HEAD"), root = join(f.cwd, ".dsa", f.t.wid), branches = new Set<string>(), paths = new Set<string>();
  for (const key of ["tasks:0", "tasks-0", "tasks%3A0", "chain:0", "CON"]) {
    const t = { ...f.t, key, callId: `${f.t.wid}@1/${key}@1` };
    const prepared = await f.effects().prepare(t, { sessionPath: f.sessionPath });
    // POSIX keeps every key's literal path, so its journals and branches are unchanged. Win32 cannot create a colon or a
    // reserved device name, so there the key lives in the encoded namespace under the workflow.
    const encoded = process.platform === "win32" && (key.includes(":") || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(key));
    assert.equal(prepared.cwd, encoded ? join(root, ".keys", basename(prepared.cwd)) : join(root, key), key);
    if (encoded) assert.match(basename(prepared.cwd), /^[0-9a-f]{64}$/, `${key}: the key's hash names its directory`);
    assert.equal(await git(prepared.cwd, "rev-parse", "HEAD"), base, `${key}: its own worktree exists`);
    assert.equal(countWorktrees(await listedWorktrees(f.cwd), localPath(prepared.cwd, 3)), 1, `${key}: one registration`);
    assert.ok(!paths.has(prepared.cwd), `${key}: not a path another key uses`); paths.add(prepared.cwd);
    const branch = await git(prepared.cwd, "symbolic-ref", "--short", "HEAD");
    if (encoded || key.includes(":")) assert.ok(branch.startsWith(`dsa-colon/${f.t.wid}/`) && branch !== `dsa/${f.t.wid}/${key}`,
      `${key}: a key no ref can spell uses the hashed namespace, never a literal branch`);
    else assert.equal(branch, `dsa/${f.t.wid}/${key}`, `${key}: a literal key keeps its branch`);
    assert.ok(!branches.has(branch), `${key}: not a branch another key uses`); branches.add(branch);
  }
  assert.equal(paths.size, 5); assert.equal(branches.size, 5);
});

test("a key Win32 cannot spell is encoded inside the workflow; elsewhere Git's ref rules still apply", async ctx => {
  const f = await fixture(ctx); f.t.spec.isolation = "worktree";
  await git(f.cwd, "init"); await git(f.cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  const root = join(f.cwd, ".dsa", f.t.wid);
  for (const key of ["x.", "a*b"]) {
    const t = { ...f.t, key, callId: `${f.t.wid}@1/${key}@1` };
    if (process.platform === "win32") {
      // Win32 drops a trailing dot and forbids `*`: the worktree is created in the encoded namespace instead.
      const prepared = await f.effects().prepare(t, { sessionPath: f.sessionPath });
      assert.equal(dirname(prepared.cwd), join(root, ".keys"), key);
      assert.match(basename(prepared.cwd), /^[0-9a-f]{64}$/, key);
    } else {
      // Unchanged elsewhere: the literal path is possible, and the literal branch a ref cannot spell still fails.
      await assert.rejects(f.effects().prepare(t, { sessionPath: f.sessionPath }), /check-ref-format/, key);
      assert.equal(f.journal.entries().some(e => e.type === "wt-intent"), false, `${key}: no intent was recorded`);
    }
  }
});

test("a worktree recorded through another spelling is one worktree: not created twice, and cleaned through it", async ctx => {
  const f = await fixture(ctx); f.t.spec.isolation = "worktree";
  await git(f.cwd, "init"); await git(f.cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  const base = await git(f.cwd, "rev-parse", "HEAD"), via = join(f.root, "via"), suffix = `.dsa/${f.t.wid}/task`;
  await linkDirectory(f.cwd, via);
  // The call runs in the linked spelling, so its intent records that spelling while Git lists the directory it names.
  const ticket = { ...f.t, cwd: via };
  const prepared = await f.effects().prepare(ticket, { sessionPath: f.sessionPath });
  assert.equal(prepared.cwd, join(via, ".dsa", f.t.wid, "task"), "the call gets the spelling its journal records");
  assert.equal(await git(prepared.cwd, "rev-parse", "HEAD"), base);
  // One worktree is registered, not a second one under the listed spelling (which would fail on its own directory).
  assert.equal(countWorktrees(await listedWorktrees(f.cwd), suffix), 1);
  // The fixture is not a no-op: Git names the directory by the path it resolves, not by the recorded alias.
  assert.ok((await listedWorktrees(f.cwd)).every(path => path !== prepared.cwd), "Git lists another spelling of the path");
  // A repeat prepares the same path and appends nothing: the identity is reconciled, not recorded again.
  const recorded = f.journal.entries().length;
  assert.deepEqual(await f.effects().prepare(ticket, { sessionPath: f.sessionPath }), prepared);
  assert.equal(f.journal.entries().length, recorded);
  // The cleanup removes that worktree through the recorded spelling and keeps its branch.
  await f.effects().afterSeal(ticket, f.result);
  await assert.rejects(access(prepared.cwd));
  assert.equal(countWorktrees(await listedWorktrees(f.cwd), suffix), 0);
  assert.equal(await git(f.cwd, "rev-parse", `dsa/${f.t.wid}/task`), base);
});

test("a moved worktree is named by the recorded spelling even where Git lists another", async ctx => {
  const f = await fixture(ctx); f.t.spec.isolation = "worktree";
  await git(f.cwd, "init"); await git(f.cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  const via = join(f.root, "via");
  await linkDirectory(f.cwd, via);
  const ticket = { ...f.t, cwd: via }, branch = `dsa/${f.t.wid}/task`;
  const prepared = await f.effects().prepare(ticket, { sessionPath: f.sessionPath });
  // The person moved the worktree to a detached HEAD. Preparation recognises the conflict through the other spelling and
  // fails this call only, naming the path the journal records, so the message and the path agree.
  await git(prepared.cwd, "checkout", "--detach");
  await assert.rejects(f.effects().prepare(ticket, { sessionPath: f.sessionPath }), (error: Error) => {
    const message = String(error);
    return /Worktree identity conflict/.test(message) && message.includes(prepared.cwd) &&
      message.includes("a detached HEAD") && message.includes(branch);
  }, "the failure names the recorded path, not the listed one");
  assert.equal(countWorktrees(await listedWorktrees(f.cwd), localPath(prepared.cwd, 3)), 1, "nothing was re-created");
});

test("a key that would leave its workflow's directory is refused, and nothing is recorded", async ctx => {
  const f = await fixture(ctx); f.t.spec.isolation = "worktree";
  await git(f.cwd, "init"); await git(f.cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  const root = join(f.cwd, ".dsa", f.t.wid);
  // A nested key stays a nested path, as it always was.
  assert.equal((await f.effects().prepare({ ...f.t, key: "tasks/nested", callId: `${f.t.wid}@1/tasks/nested@1` }, { sessionPath: f.sessionPath })).cwd,
    join(root, "tasks", "nested"));
  // Traversal, a Win32 separator, an absolute path, a drive-qualified or UNC spelling: none is a name inside the workflow.
  // The Win32 forms are refused on every platform, so a POSIX run pins the same rule the Windows run applies.
  const keys = ["..", "a/../../b", "a/./b", "a\\b", "\\outside", f.cwd, join(f.cwd, "outside"), "C:\\outside", "C:/outside", "//server/share/x", "\\\\server\\share\\x"];
  for (const key of keys) {
    const t = { ...f.t, key, callId: `${f.t.wid}@1/${key}@1` };
    await assert.rejects(f.effects().prepare(t, { sessionPath: f.sessionPath }), /Invalid worktree key/, key);
    assert.equal(f.journal.entries().some(e => e.type === "wt-intent" && e.call === t.callId), false, `${key}: no intent was recorded`);
  }
  await assert.rejects(access(join(f.cwd, "outside")));
  assert.equal((await f.effects().prepare(f.t, { sessionPath: f.sessionPath })).cwd, join(root, "task"), "its own call still prepares");
});

test("an old intent outside its workflow creates nothing and is kept, never removed", async ctx => {
  const f = await fixture(ctx); f.t.spec.isolation = "worktree";
  await git(f.cwd, "init"); await git(f.cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  // A journal from a version that let an absolute key replace the root: its intent names a directory outside the workflow.
  const outside = join(f.root, "outside");
  await writeFile(outside, "not a worktree");
  await f.journal.append("wt-intent", { call: f.t.callId, path: outside, branch: `dsa/${f.t.wid}/task`, base: "0".repeat(40) });
  // Preparation refuses before any Git call (the cwd is not a repository either) and records nothing new.
  const recorded = f.journal.entries().length;
  await assert.rejects(f.effects().prepare(f.t, { sessionPath: f.sessionPath }), /Invalid worktree key/);
  assert.equal(f.journal.entries().length, recorded);
  // The cleanup does not inspect or remove it: the keep is recorded once with one note naming the recorded path.
  await f.journal.append("wt-created", { call: f.t.callId });
  await f.effects().afterSeal(f.t, f.result); await f.effects().afterSeal(f.t, f.result);
  const notes = f.journal.entries().filter(e => e.type === "attention");
  assert.equal(notes.length, 1);
  assert.match(String((notes[0] as unknown as { item: { text: string } }).item.text), new RegExp("not inside"));
  assert.equal(f.journal.entries().filter(e => e.type === "wt-kept" && e.call === f.t.callId).length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "wt-removed").length, 0);
  assert.equal(await readFile(outside, "utf8"), "not a worktree");
});
