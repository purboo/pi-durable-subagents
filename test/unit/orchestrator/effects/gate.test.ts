import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { Containment } from "../../../../src/platform/containment.ts";
import { fixture, crash } from "./helpers.ts";

for (const [name, gate, status] of [
  ["string", "true", "ok"], ["nonzero", "exit 7", "gate-failed"],
  ["JSON", { command: "printf '{\"value\":3}'", output: "json", schema: { type: "object", required: ["value"] } }, "ok"],
  ["invalid JSON", { command: "echo invalid", output: "json" }, "gate-failed"],
  ["schema", { command: "echo '{}'", output: "json", schema: { required: ["value"] } }, "gate-failed"],
  ["false schema", { command: "echo null", output: "json", schema: false }, "gate-failed"],
  ["timeout", { command: "sleep 30", timeoutMs: 100 }, "gate-failed"],
] as const) test(`gate outcome: ${name}`, { timeout: 10000 }, async ctx => {
  const f = await fixture(ctx); f.t.spec.gate = gate;
  const result = await f.before(); assert.equal(result.status, status); assert.equal(result.ok, status === "ok");
  if (name === "JSON") assert.deepEqual(result.data, { gate: { value: 3 } });
  if (name === "timeout") assert.match(result.error!, /timeout/);
  assert.deepEqual(await f.before(), result);
  const entries = f.journal.entries(), intent = entries.find(e => e.type === "gate-intent")!, outcome = entries.find(e => e.type === "gate")!;
  assert.ok(intent.seq < outcome.seq); assert.equal(intent.id, `gate:${f.t.callId}#1`);
  assert.equal(entries.filter(e => e.type === "gate-intent").length, 1);
});
test("gate reads immutable result/output inputs in the call cwd", async ctx => {
  const f = await fixture(ctx);
  f.t.spec.gate = { command: 'test "$DSA_CALL" = "W@1/task@1" && test "$(cat "$DSA_OUTPUT")" = complete && cat "$DSA_RESULT"', output: "json" };
  const result = await f.before(); assert.deepEqual((result.data as any).gate, f.result);
});
for (const window of ["intent", "effect", "outcome"]) test(`gate crash at ${window} never reruns`, async ctx => {
  const f = await fixture(ctx), marker = join(f.cwd, "marker"); f.t.spec.gate = "echo ran >> marker";
  const type = window === "intent" ? "gate-intent" : "gate";
  await assert.rejects(f.before({ ...f.t, journal: crash(f.journal, type, window !== "effect") }), /crash:/);
  await f.effects().recover(f.journal); await f.effects().recover(f.journal);
  const result = await f.before(); assert.equal(result.status, window === "outcome" ? "ok" : "unknown");
  assert.deepEqual(await f.before(), result);
  if (window === "intent") await assert.rejects(access(marker)); else assert.equal(await readFile(marker, "utf8"), "ran\n");
  assert.equal(f.journal.entries().filter(e => e.type === "gate").length, 1);
});
test("recover fences a live gate and persists unknown only once", { timeout: 10000 }, async ctx => {
  const f = await fixture(ctx), id = `gate:${f.t.callId}#1`, containment = new Containment(); f.t.spec.gate = "echo must-not-run";
  await f.journal.append("gate-intent", { call: f.t.callId, id });
  const child = await containment.spawn({ command: "sh", args: ["-c", "sleep 30"], cwd: f.cwd, exec: id, env: {} });
  child.stdin.end(); child.stdout.resume(); child.stderr.resume(); ctx.after(() => containment.fence(id, []));
  await f.effects().recover(f.journal);
  await child.exited;
  assert.equal((await containment.scan(new Map([[id, []]]))).get(id)?.length ?? 0, 0);
  assert.equal((await f.before()).status, "unknown");
});
test("abort during gate fences descendants and preserves the original result", { timeout: 10000 }, async ctx => {
  const f = await fixture(ctx), ctl = new AbortController(); f.t.spec.gate = "sleep 30 & wait"; f.t.spec.output = "out.txt";
  const journal = { ...f.journal, append: async <T extends string>(type: T, fields: Record<string, unknown>) => {
    const entry = await f.journal.append(type, fields); if (type === "gate-tracked") ctl.abort(); return entry;
  } };
  assert.deepEqual(await f.before({ ...f.t, journal }, f.result, ctl.signal), f.result);
  const id = `gate:${f.t.callId}#1`;
  assert.equal((await new Containment().scan(new Map([[id, []]]))).get(id)?.length ?? 0, 0);
  assert.equal(f.journal.entries().find(e => e.type === "gate")!.aborted, true);
  assert.equal(f.journal.entries().filter(e => e.type === "output-intent").length, 0);
});
test("a gate that exits after starting a detached descendant fences that descendant", { timeout: 10000 }, async ctx => {
  const f = await fixture(ctx); f.t.spec.gate = "setsid sleep 30 >/dev/null 2>&1 &";
  assert.equal((await f.before()).status, "ok");
  const id = `gate:${f.t.callId}#1`;
  assert.equal((await new Containment().scan(new Map([[id, []]]))).get(id)?.length ?? 0, 0);
});
test("pre-abort and precedence outcomes skip all effects", async ctx => {
  const f = await fixture(ctx); f.t.spec.gate = "exit 9"; f.t.spec.output = "out.txt";
  const ctl = new AbortController(); ctl.abort(); assert.deepEqual(await f.before(f.t, f.result, ctl.signal), f.result);
  for (const status of ["stopped", "timeout", "budget"] as const) {
    const result = { ...f.result, status, ok: false }; assert.deepEqual(await f.before(f.t, result), result);
  }
  assert.equal(f.journal.entries().length, 0);
});
