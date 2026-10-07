import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeRoots } from "../../../../src/orchestrator/executor/worktree.ts";

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
