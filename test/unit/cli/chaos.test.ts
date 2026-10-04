import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChaos, chaos } from "../../../src/cli/chaos/index.ts";
import { main } from "../../../src/cli/main.ts";

test("chaos options reject ambiguous input before allocating a root", async () => {
  assert.deepEqual(parseChaos([]), { keep: false, json: false });
  assert.deepEqual(parseChaos(["--scenario", "9", "--json", "--keep"]), { keep: true, json: true, scenario: 9 });
  for (const args of [["--scenario"], ["--scenario", "0"], ["--scenario", "10"], ["--scenario", "1.0"], ["--json", "--json"], ["--keep", "--keep"], ["unknown"], ["--scenario", "1", "--scenario", "2"]])
    assert.throws(() => parseChaos(args));
  await assert.rejects(main(["chaos", "--scenario", "0"]), /Invalid chaos argument/);
});
test("missing pi reports scenario, failed invariant and retained evidence with a nonzero exit", { timeout: 10_000 }, async t => {
  let output = "";
  const code = await chaos(["--scenario", "3", "--json"], { PATH: "/nonexistent-chaos-path" }, text => { output = text; });
  const report = JSON.parse(output);
  assert.equal(code, 1); assert.equal(report.passed, false); assert.equal(report.failure.scenario, 3);
  assert.match(report.failure.invariant, /ENOENT/); assert.ok(report.failure.evidence.length >= 3);
  t.diagnostic(`failure evidence: ${report.evidence}`);
});
