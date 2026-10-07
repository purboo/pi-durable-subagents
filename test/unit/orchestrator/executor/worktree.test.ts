import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { WorktreeIndex, toolPath, worktreeRoots } from "../../../../src/orchestrator/executor/worktree.ts";

test("worktree roots: git directories, linked worktree files, nested and nonexistent paths, realpaths and non-git", async t => {
  const dir = await mkdtemp(join(tmpdir(), "dsa-roots-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo"), linked = join(dir, "linked"), root = worktreeRoots();
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, "nested", "deep"), { recursive: true });
  await mkdir(linked);
  await writeFile(join(linked, ".git"), "gitdir: ../repo/.git/worktrees/linked\n");
  await symlink(repo, join(dir, "alias"));
  assert.equal(await root(repo, "file.txt"), repo);
  assert.equal(await root(repo, "nested/deep/file.txt"), repo);
  assert.equal(await root(repo, "not/yet/created/file.txt"), repo);
  assert.equal(await root(dir, "alias/nested/new/file.txt"), repo);
  assert.equal(await root(dir, join(linked, "missing", "file.txt")), linked);
  assert.equal(await root(dir, "outside/file.txt"), undefined);
  // The nearest .git entry wins, even if an enclosing repository has been cached.
  await mkdir(join(repo, "inner"));
  await writeFile(join(repo, "inner", ".git"), "gitdir: elsewhere\n");
  assert.equal(await root(repo, "inner/file.txt"), join(repo, "inner"));
});

test("toolPath resolves as pi's edit/write tools do", () => {
  assert.equal(toolPath("/w", "a/b.txt"), "/w/a/b.txt");
  assert.equal(toolPath("/w", "@/x/b.txt"), "/x/b.txt");
  assert.equal(toolPath("/w", "@rel.txt"), "/w/rel.txt");
  assert.equal(toolPath("/w", "~/b.txt"), join(homedir(), "b.txt"));
  assert.equal(toolPath("/w", "~"), homedir());
  assert.equal(toolPath("/w", pathToFileURL("/x/c d.txt").href), "/x/c d.txt");
  assert.equal(toolPath("/w", "a\u00A0b.txt"), "/w/a b.txt");
});

test("worktree roots follow a repository created inside another after a lookup", async t => {
  const dir = await mkdtemp(join(tmpdir(), "dsa-roots-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = worktreeRoots();
  await mkdir(join(dir, ".git")); await mkdir(join(dir, "inner"));
  assert.equal(await root(dir, "inner/file.txt"), dir);
  await mkdir(join(dir, "inner", ".git"));
  assert.equal(await root(dir, "inner/file.txt"), join(dir, "inner"));
});

test("the worktree index keeps only roots with writers that have not ended, and reads each entry once", () => {
  let reads = 0;
  const journal = (entries: object[]) => { const list = entries.map((e, i) => ({ seq: i + 1, ts: 0, ...e })); return { entries: () => { reads++; return list; } } as never; };
  const journals = Array.from({ length: 2000 }, (_, i) => journal([
    { type: "wrote", exec: `w${i}@1/a@1#1.1`, root: `/r${i}` }, { type: "sealed", call: `w${i}@1/a@1` }]));
  const index = new WorktreeIndex().scan(journals);
  assert.deepEqual(index.contested(), []); assert.deepEqual(index.live("/r1"), []);
  assert.equal(reads, 2000);
  const x = journal([{ type: "wrote", exec: "x@1/a@1#1.1", root: "/s" }]), y = journal([{ type: "wrote", exec: "y@1/b@1#1.1", root: "/s", after: ["x@1/a@1"] }]);
  index.scan([x, y]);
  assert.deepEqual(index.contested(), ["/s"]);
  const [first, second] = WorktreeIndex.order(...(index.live("/s") as [never, never]));
  assert.equal((first as { call: string }).call, "x@1/a@1"); assert.equal((second as { call: string }).call, "y@1/b@1");
  assert.equal(index.has("w5@1/a@1#1.1", "/r5"), true, "a write stays known after its call ended");
});
