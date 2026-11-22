// The import check resolves the repository from its own location, so `node scripts/check-imports.mjs` means the same
// thing from any working directory (a CI step that starts elsewhere, or a Windows runner whose cwd differs in case).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../../..");
const SCRIPT = join(REPO, "scripts/check-imports.mjs");

function elsewhere(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "dsa-imports-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("check-imports passes from an unrelated working directory", t => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: elsewhere(t), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "imports ok");
});

test("check-imports passes from the repository root", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "imports ok");
});
