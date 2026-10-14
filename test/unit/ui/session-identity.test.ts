import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionTail } from "../../../src/ui/session.ts";

test("a session's cache identity describes only bytes actually read", t => {
  const home = mkdtempSync(join(tmpdir(), "session-identity-")), path = join(home, "session.jsonl");
  try {
    writeFileSync(path, '{"type":"test"}\n');
    t.mock.method(fs, "readSync", () => 0);
    syncBuiltinESMExports();
    const tail = new SessionTail();
    assert.deepEqual(tail.read(path), []);
    assert.equal(tail.snapshotIdentity, undefined, "a premature EOF cannot publish final facts under the unread file's size");
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal(tail.read(path).length, 1);
    const stat = fs.statSync(path);
    assert.equal(tail.snapshotIdentity, `${stat.dev}:${stat.ino}:${stat.size}`);
    writeFileSync(path, "");
    assert.deepEqual(tail.read(path), []);
    assert.equal(tail.snapshotIdentity, `${stat.dev}:${stat.ino}:0`);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(home, { recursive: true, force: true }); }
});
