import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readCache, writeCache } from "../../../src/kernel/cache.ts";

test("cache publication cleans failed temporary files and loses to pruning", t => {
  const home = mkdtempSync(join(tmpdir(), "reader-cache-")), journal = join(home, "journal"), path = join(home, "cache", "wf", "facts.json");
  try {
    writeFileSync(journal, "journal");
    writeCache(path, { facts: "ok" }, journal);
    assert.deepEqual(readCache(path), { facts: "ok" });
    const rename = fs.renameSync;
    t.mock.method(fs, "renameSync", () => { throw new Error("publication failed"); });
    syncBuiltinESMExports();
    writeCache(path, { facts: "new" }, journal);
    assert.deepEqual(readdirSync(join(home, "cache", "wf")), ["facts.json"]);
    assert.deepEqual(readCache(path), { facts: "ok" });
    t.mock.restoreAll();
    t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      rmSync(journal); rename(from, to);
    });
    syncBuiltinESMExports();
    writeCache(path, { facts: "new" }, journal);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(join(home, "cache", "wf")), false, "late readers cannot recreate a pruned workflow's facts directory");
    writeFileSync(journal, "journal");
    mkdirSync(join(home, "unwritable")); writeFileSync(join(home, "unwritable", "file"), "file");
    assert.doesNotThrow(() => writeCache(join(home, "unwritable", "file", "facts"), {}, journal));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(home, { recursive: true, force: true }); }
});
