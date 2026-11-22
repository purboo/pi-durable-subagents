// Reading a node --test log for the CI rerun (scripts/lib/ci-log.mjs): the spec reporter's "test at" lines and TAP's
// "location:", in the form each platform prints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(import.meta.dirname, "../../..");
const log = await import(pathToFileURL(join(REPO, "scripts/lib/ci-log.mjs")).href) as {
  stripAnsi: (text: string) => string;
  failingTestFiles: (output: string, cwd: string, platform?: string) => string[];
};

test("failing test files come from the spec reporter and from TAP, without ANSI colors", () => {
  const output = [
    "\x1b[31m✖ fails\x1b[39m",
    "  \x1b[90mtest at test/unit/kernel/journal.test.ts:12:3\x1b[39m",
    "  nested",
    "    test at test/unit/kernel/mm.test.ts:5:1",
    // A non-test module named by an error is not a rerun target.
    "  test at test/harness/pi.ts:10:2",
    "not ok 1 - fails",
    "  location: 'test/unit/kernel/lease.test.ts:7:9'",
    "",
  ].join("\n");
  assert.deepEqual(log.failingTestFiles(output, "/repo"), [
    "test/unit/kernel/journal.test.ts",
    "test/unit/kernel/mm.test.ts",
    "test/unit/kernel/lease.test.ts",
  ]);
});

test("Windows path forms: backslashes, drive letters, and case-insensitive cwd matching", () => {
  const output = [
    String.raw`test at test\unit\cli\run.test.ts:4:2`,
    String.raw`location: 'C:\Work\repo\test\unit\cli\start.test.ts:9:1'`,
    String.raw`test at c:\work\repo\test\unit\kernel\io.test.ts:1:1`,
  ].join("\n");
  // Under cwd: the cwd-relative form node --test accepted on the command line (spec lines first, then TAP).
  assert.deepEqual(log.failingTestFiles(output, String.raw`C:\Work\repo`, "win32"), [
    String.raw`test\unit\cli\run.test.ts`,
    String.raw`test\unit\kernel\io.test.ts`,
    String.raw`test\unit\cli\start.test.ts`,
  ]);
  // A path outside cwd keeps the absolute form and the log's own spelling.
  assert.deepEqual(log.failingTestFiles(String.raw`test at D:\other\test\x.test.ts:2:2`, String.raw`C:\Work\repo`, "win32"),
    [String.raw`D:\other\test\x.test.ts`]);
});

test("a POSIX path outside cwd stays absolute, and each file is listed once", () => {
  const output = [
    "test at /build/test/unit/a.test.ts:1:1",
    "test at /build/test/unit/a.test.ts:2:1",
    "  location: '/build/test/unit/a.test.ts:3:1'",
  ].join("\n");
  assert.deepEqual(log.failingTestFiles(output, "/build"), ["test/unit/a.test.ts"]);
  assert.deepEqual(log.failingTestFiles(output, "/elsewhere"), ["/build/test/unit/a.test.ts"]);
});

test("a run without a failing test file yields nothing", () => {
  assert.deepEqual(log.failingTestFiles("not ok 1 - no location here\n", "/repo"), []);
  assert.equal(log.stripAnsi("\x1b[1mbold\x1b[0m"), "bold");
});
