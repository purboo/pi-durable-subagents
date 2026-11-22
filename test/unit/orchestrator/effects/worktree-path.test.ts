// P32: the worktree spelling rules that decide what a Win32 run may create. These are pure functions of the key and the
// platform, so every Windows decision is checked here on any platform: which keys are names and which are paths, which
// names Win32 cannot spell, and that the encoded namespace is disjoint from every literal spelling (also where the file
// system ignores case). The identity helpers are exercised against a real file system at the end.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash } from "../../../../src/kernel/ids.ts";
import { checkKey, encodedDir, inside, insidePath, keyBranch, keyDir, literalKey, nativePath, sameWorktree, win32Name, win32Spelling } from "../../../../src/orchestrator/executor/effects/worktree-path.ts";

test("a key is an opaque name inside its workflow: a path-like spelling is refused, a name is not", () => {
  // Names, including every spelling the fan-out compiler generates and the ones Win32 cannot create (encoded later).
  for (const key of ["task", "tasks-0", "tasks%3A0", "tasks:0", "a:0", "chain:0", "nested/key", "nested/deep/key", "CON", "x.", "a*b", "a b", encodedDir, `${encodedDir}/x`])
    assert.doesNotThrow(() => checkKey(key), key);
  // Paths: a Win32 separator, traversal, an empty part, absolute or UNC, drive-qualified absolute, or a bare drive.
  for (const key of ["", ".", "..", "a/../b", "a/./b", "a//b", "/abs", "/C:/x", "//server/share/x", "a\\b", "a/b\\c", "\\outside",
    "C:\\x", "C:/x", "c:/x", "C:", "D:", "\\\\server\\share\\x"])
    assert.throws(() => checkKey(key), /Invalid worktree key/, JSON.stringify(key));
});

test("Win32 names: no reserved character, no trailing dot or space, no device name", () => {
  for (const name of ["task", "tasks-0", "tasks%3A0", encodedDir, "a.b", "COM10", "LPT0", "console", "nulify"])
    assert.equal(win32Name(name), true, name);
  for (const name of ["", ".", "..", "tasks:0", "a*b", "a?b", "a<b", "a>b", "a|b", 'a"b', "a\tb", "x.", "x ", "x. ",
    "CON", "con", "con.txt", "NUL", "AUX", "PRN", "COM1", "COM9", "LPT1", "LPT9", "nul.tar", "nul.tar.gz"])
    assert.equal(win32Name(name), false, JSON.stringify(name));
});

test("a key Win32 cannot spell takes the encoded namespace, which no literal spelling can name", () => {
  // POSIX keeps every literal spelling, so its journals name what they always named.
  for (const key of ["task", "tasks:0", "tasks%3A0", "CON", "x.", `${encodedDir}/x`]) {
    assert.equal(literalKey(key, "linux"), true, key);
    assert.equal(keyDir(key, "linux"), key, key);
  }
  for (const key of ["task", "tasks-0", "tasks%3A0", "nested/task", ".dsa"])
    assert.equal(keyDir(key, "win32"), key, key);
  const encoded = ["tasks:0", "a:0", "chain:0", "CON", "con.txt", "x.", "x ", "a*b", encodedDir, `${encodedDir}/x`, `${encodedDir.toUpperCase()}/x`, "nested/CON"];
  for (const key of encoded) {
    assert.equal(literalKey(key, "win32"), false, key);
    const dir = keyDir(key, "win32");
    assert.equal(dir, `${encodedDir}/${contentHash(key)}`, key);
    // Nothing a literal key may spell is this path: the path itself, and every other case of it, is encoded again.
    assert.equal(literalKey(dir, "win32"), false, dir);
    assert.equal(literalKey(dir.toUpperCase(), "win32"), false, dir);
    assert.equal(keyDir(dir, "win32"), `${encodedDir}/${contentHash(dir)}`, dir);
  }
  // One-to-one: two different keys never share an encoded directory, in any case.
  const dirs = new Set(encoded.map(key => keyDir(key, "win32").toLowerCase()));
  assert.equal(dirs.size, encoded.length);
  // The default is the running platform's rule.
  assert.equal(keyDir("tasks:0"), process.platform === "win32" ? keyDir("tasks:0", "win32") : "tasks:0");
});

test("branches: the hashed namespace for a key a ref cannot spell or whose path is encoded", () => {
  const wid = "W0123456789ab";
  // Existing behaviour on every platform: a colon key never spells a ref, so it already used the hashed namespace.
  assert.equal(keyBranch(wid, "tasks:0", "linux"), `dsa-colon/${wid}/${contentHash("tasks:0")}`);
  assert.equal(keyBranch(wid, "tasks:0", "win32"), `dsa-colon/${wid}/${contentHash("tasks:0")}`);
  // Literal keys keep their own branch names where the platform keeps their paths.
  assert.equal(keyBranch(wid, "task", "linux"), `dsa/${wid}/task`);
  assert.equal(keyBranch(wid, "task", "win32"), `dsa/${wid}/task`);
  assert.equal(keyBranch(wid, "tasks%3A0", "win32"), `dsa/${wid}/tasks%3A0`);
  assert.equal(keyBranch(wid, "CON", "linux"), `dsa/${wid}/CON`);
  // An encoded path gets the hashed namespace too: a ref cannot spell `CON`-style trailing-dot keys either, and the
  // key's branch then follows its path (Windows only, so no POSIX name changes).
  assert.equal(keyBranch(wid, "CON", "win32"), `dsa-colon/${wid}/${contentHash("CON")}`);
  assert.equal(keyBranch(wid, "x.", "win32"), `dsa-colon/${wid}/${contentHash("x.")}`);
  assert.equal(keyBranch(wid, "x.", "linux"), `dsa/${wid}/x.`);
  assert.throws(() => keyBranch(wid, "C:\\x"), /Invalid worktree key/);
});

test("one path spelled as Win32 spells it: case, separators, long and UNC prefixes, trailing separator", () => {
  assert.equal(win32Spelling("C:\\Users\\RUNNER~1\\repo\\task"), win32Spelling("c:/users/runner~1/repo/task"));
  assert.equal(win32Spelling("\\\\?\\C:\\repo\\task"), win32Spelling("C:\\repo\\task"));
  assert.equal(win32Spelling("\\\\?\\UNC\\server\\share\\task"), win32Spelling("\\\\server\\share\\task"));
  assert.equal(win32Spelling("\\\\server\\share\\task"), win32Spelling("//server/share/task"));
  assert.equal(win32Spelling("C:\\repo\\a\\\\b\\"), win32Spelling("C:/repo/a/b"));
  assert.equal(win32Spelling("C:\\repo\\.\\b"), win32Spelling("C:\\repo\\b"));
  assert.equal(win32Spelling("C:\\"), "c:\\");
  // Different paths stay different, including across drives and shares.
  assert.notEqual(win32Spelling("C:\\repo\\task"), win32Spelling("D:\\repo\\task"));
  assert.notEqual(win32Spelling("C:\\repo\\task"), win32Spelling("C:\\repo\\Task2"));
  assert.notEqual(win32Spelling("\\\\server\\share\\task"), win32Spelling("\\\\server\\other\\task"));
  assert.notEqual(win32Spelling("\\\\?\\UNC\\server\\share\\task"), win32Spelling("\\\\server\\share\\other"));
});

/** A directory link: a junction on Windows (no privilege needed) and a symbolic link elsewhere. */
async function linkDirectory(target: string, path: string) {
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

test("containment: a nested path is inside, its parent, a sibling and another drive or share are not", () => {
  // Checked for both platforms anywhere, so a Windows runner's rule is pinned by the Linux and macOS runs too.
  for (const [base, target, expected] of [
    ["C:\\repo\\.dsa\\W1", "C:\\repo\\.dsa\\W1\\task", true],
    ["C:\\repo\\.dsa\\W1", "C:\\repo\\.dsa\\W1\\.keys\\abc", true],
    ["C:\\repo\\.dsa\\W1", "C:\\repo\\.dsa\\W1\\nested\\deep\\task", true],
    ["C:\\repo\\.dsa\\W1", "C:\\repo\\.dsa\\W1", false],
    ["C:\\repo\\.dsa\\W1", "C:\\repo\\.dsa\\W10\\task", false],
    ["C:\\repo\\.dsa\\W1", "C:\\repo\\.dsa\\W1\\..\\..\\outside", false],
    ["C:\\repo\\.dsa\\W1", "c:/repo/.dsa/w1/task", true],
    ["C:\\repo\\.dsa\\W1", "\\\\?\\C:\\repo\\.dsa\\W1\\.keys\\task", true],
    ["\\\\?\\UNC\\server\\share\\W1", "//server/share/w1/task", true],
    // Win32 `relative` yields the whole target for another drive or share, which is absolute and so never inside.
    ["C:\\repo\\.dsa\\W1", "D:\\outside", false],
    ["C:\\repo\\.dsa\\W1", "D:outside", false],
    ["C:\\repo\\.dsa\\W1", "\\\\server\\share\\task", false],
    // A missing drive or share must not make the check throw either.
    ["C:\\repo\\.dsa\\W1", "Z:\\outside", false],
  ] as const) assert.equal(insidePath(base, target, "win32"), expected, `${target} inside ${base}?`);
  for (const [base, target, expected] of [
    ["/repo/.dsa/W1", "/repo/.dsa/W1/task", true],
    ["/repo/.dsa/W1", "/repo/.dsa/W1/nested/task", true],
    ["/repo/.dsa/W1", "/repo/.dsa/W1", false],
    ["/repo/.dsa/W1", "/repo/.dsa/W10/task", false],
    ["/repo/.dsa/W1", "/repo/.dsa/W1/../../outside", false],
    ["/repo/.dsa/W1", "/outside", false],
  ] as const) assert.equal(insidePath(base, target, "linux"), expected, `${target} inside ${base}?`);
});

test("the identity of a path is the file system's: a link, a missing tail and containment by identity", async t => {
  const root = await mkdtemp(join(tmpdir(), "dsa-wt-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), link = join(root, "link"), outside = join(root, "outside");
  await mkdir(join(repo, ".dsa", "W1"), { recursive: true });
  await mkdir(outside);
  await linkDirectory(repo, link);
  // One directory under two spellings, including a path below a part that does not exist yet (Git has not created it).
  assert.equal(sameWorktree(link, repo), true);
  assert.equal(sameWorktree(join(link, ".dsa", "W1", "task"), join(repo, ".dsa", "W1", "task")), true);
  assert.equal(sameWorktree(join(repo, ".dsa", "W1", "task"), join(repo, ".dsa", "W1", "other")), false);
  assert.equal(nativePath(join(link, ".dsa", "W1", "task")), join(nativePath(repo), ".dsa", "W1", "task"));
  // Containment is identity too: through the link is inside, a sibling or parent is not.
  assert.equal(inside(join(repo, ".dsa", "W1"), join(link, ".dsa", "W1", "task")), true);
  assert.equal(inside(join(link, ".dsa", "W1"), join(repo, ".dsa", "W1", "task")), true);
  assert.equal(inside(join(repo, ".dsa", "W1"), join(repo, ".dsa", "W1")), false);
  assert.equal(inside(join(repo, ".dsa", "W1"), join(repo, ".dsa", "W10", "task")), false);
  assert.equal(inside(join(repo, ".dsa", "W1"), join(repo, ".dsa", "W1", "..", "..", "outside")), false);
  assert.equal(inside(join(repo, ".dsa", "W1"), outside), false);
  // On Windows a drive-qualified absolute path is not inside any directory on this drive: `relative` yields one.
  if (process.platform === "win32") {
    assert.equal(inside(join(repo, ".dsa", "W1"), "C:\\outside"), false);
    assert.equal(inside(join(repo, ".dsa", "W1"), "\\\\server\\share\\task"), false);
  }
});
