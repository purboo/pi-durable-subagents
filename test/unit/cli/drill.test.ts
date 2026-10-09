import assert from "node:assert/strict";
import { test } from "node:test";
import { drill, parseDrill } from "../../../src/cli/drill/index.ts";
import { HELP, main } from "../../../src/cli/main.ts";

test("drill options reject unknown drills and flags before allocating a root", async () => {
  assert.deepEqual(parseDrill(["failover"]), { keep: false, json: false });
  assert.deepEqual(parseDrill(["failover", "--json", "--keep"]), { keep: true, json: true });
  for (const args of [[], ["chaos"], ["failover", "--json", "--json"], ["failover", "--scenario", "1"], ["--json", "failover"]])
    assert.throws(() => parseDrill(args));
  await assert.rejects(main(["drill", "nope"]), /Invalid drill/);
  assert.match(HELP, /drill failover \[--keep\] \[--json\]/);
});
test("a drill that cannot run pi fails at step 1, reports the later steps as not run and keeps no evidence", { timeout: 60_000 }, async () => {
  let output = "";
  const code = await drill(["failover", "--json"], { PATH: "/nonexistent-drill-path" }, text => { output = text; });
  const report = JSON.parse(output);
  assert.equal(code, 1); assert.equal(report.passed, false); assert.equal(report.steps.length, 5);
  assert.equal(report.steps[0].ok, false); assert.ok(report.steps[0].detail.length > 0);
  for (const s of report.steps.slice(1)) assert.match(s.detail, /^not run/);
  assert.equal(report.evidence, undefined);
});
