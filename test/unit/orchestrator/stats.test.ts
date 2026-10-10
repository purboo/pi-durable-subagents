import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readBytes } from "../../../src/orchestrator/stats.ts";

const processRchar = () => Number(/^rchar:\s*(\d+)$/m.exec(readFileSync("/proc/self/io", "utf8"))![1]);

test("readBytes counts the orchestrator's own reads, not what its reaped children read", { skip: process.platform !== "linux" }, () => {
  const before = readBytes()!, total = processRchar();
  // A child that reads 64 MB; Linux adds it to this process's /proc/self/io once the child is reaped.
  const child = spawnSync("dd", ["if=/dev/zero", "of=/dev/null", "bs=1M", "count=64"], { stdio: "ignore" });
  assert.equal(child.status, 0);
  assert.ok(processRchar() - total >= 64 * 2 ** 20, "the process total includes the reaped child");
  assert.ok(readBytes()! - before < 16 * 2 ** 20, `own reads grew by ${readBytes()! - before}`);
  readFileSync("/proc/self/status");
  assert.ok(readBytes()! > before, "own reads are counted");
});
