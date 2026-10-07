import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { toolPath, worktreeRoots } from "../../../../src/orchestrator/executor/worktree.ts";

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
