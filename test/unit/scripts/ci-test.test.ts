// scripts/ci-test.mjs end to end: a suite where one file fails and passes when rerun alone ends green with a visible
// flaky warning, and the log keeps both runs. This is the CI path that decides a job's result.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../../..");
const SCRIPT = join(REPO, "scripts/ci-test.mjs");

function suite(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "dsa-ci-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Fails on its first run in this directory, passes from the second: exactly the flaky file rerun is for.
  writeFileSync(join(dir, "flaky.test.mjs"), [
    `import { test } from "node:test";`,
    `import assert from "node:assert/strict";`,
    `import { existsSync, writeFileSync } from "node:fs";`,
    `test("flaky", () => {`,
    `  if (!existsSync("first-run-done")) { writeFileSync("first-run-done", ""); assert.fail("fails once"); }`,
    `});`,
    ``,
  ].join("\n"));
  writeFileSync(join(dir, "ok.test.mjs"), `import { test } from "node:test";\ntest("ok", () => {});\n`);
  return dir;
}

/** A CI-like environment for the run: this test file is itself a node:test child, and NODE_TEST_CONTEXT would make the
 *  nested `node --test` refuse to run anything. */
function ciEnv() {
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  return env;
}

test("a file that fails once and passes when rerun is a warning, not a failed job", t => {
  const dir = suite(t);
  const result = spawnSync(process.execPath, [SCRIPT, "ci.log", "flaky.test.mjs", "ok.test.mjs"], { cwd: dir, env: ciEnv(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /=== rerunning 1 failing file\(s\) once: flaky\.test\.mjs ===/);
  assert.match(result.stdout, /::warning title=flaky test file::flaky\.test\.mjs failed once and passed when rerun alone/);
  // The log holds the failing run and the rerun, so ci-annotate still sees the failure.
  const log = readFileSync(join(dir, "ci.log"), "utf8");
  assert.match(log, /not ok 1 - flaky|✖ fails once|fails once/);
  assert.match(log, /=== rerun of flaky\.test\.mjs ===/);
});

test("a file that fails twice fails the job", t => {
  const dir = suite(t);
  writeFileSync(join(dir, "always.test.mjs"), `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("bad", () => assert.fail("always"));\n`);
  const result = spawnSync(process.execPath, [SCRIPT, "ci.log", "--test-force-exit", "always.test.mjs"], { cwd: dir, env: ciEnv(), encoding: "utf8" });
  assert.equal(result.status, 1, result.stdout);
  assert.doesNotMatch(result.stdout, /::warning title=flaky/);
  assert.match(result.stdout, /=== rerunning 1 failing file\(s\) once: always\.test\.mjs ===/);
});
