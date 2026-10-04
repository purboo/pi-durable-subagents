import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readlink, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fixture, crash } from "./helpers.ts";

for (const absolute of [false, true]) for (const window of ["normal", "intent", "effect", "record"]) test(`${absolute ? "absolute" : "relative"} output reconciles ${window}`, async ctx => {
  const f = await fixture(ctx); f.t.spec.output = absolute ? join(f.root, "out.txt") : "nested/out.txt";
  if (window !== "normal") {
    const type = window === "intent" ? "output-intent" : "output";
    await assert.rejects(f.before({ ...f.t, journal: crash(f.journal, type, window !== "effect") }), /crash:/);
  }
  const result = await f.before(), path = result.artifacts![0]!;
  assert.equal(await readFile(path, "utf8"), f.result.output);
  assert.deepEqual(await f.before(), result);
  assert.equal(f.journal.entries().filter(e => e.type === "output-intent").length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "output").length, 1);
  if (!absolute) {
    assert.equal(path, join(f.home, "w", "W", "artifacts", "task@1", "1-out.txt"));
    assert.equal(await readlink(join(dirname(path), "latest")), "1-out.txt");
    assert.deepEqual((await readdir(dirname(path))).sort(), ["1-out.txt", "latest"]);
  }
});
test("absolute outputs preserve foreign edits, keep attention stable, and allow our later writes", async ctx => {
  const f = await fixture(ctx); f.t.spec.output = join(f.root, "out.txt");
  await f.before();
  const second = { ...f.t, gen: 2, callId: "W@1/task@2" };
  await f.before(second, { ...f.result, gen: 2, output: "second" });
  assert.equal(await readFile(f.t.spec.output, "utf8"), "second");
  await writeFile(f.t.spec.output, "foreign");
  const third = { ...f.t, gen: 3, callId: "W@1/task@3" };
  assert.equal((await f.before(third)).artifacts, undefined);
  await f.before(third);
  assert.equal(await readFile(f.t.spec.output, "utf8"), "foreign");
  assert.equal(f.journal.entries().filter(e => e.type === "attention").length, 1);
});
test("first absolute write refuses an existing foreign file", async ctx => {
  const f = await fixture(ctx); f.t.spec.output = join(f.root, "out.txt"); await writeFile(f.t.spec.output, "foreign");
  assert.equal((await f.before()).artifacts, undefined);
  assert.equal(await readFile(f.t.spec.output, "utf8"), "foreign");
});
test("immutable artifacts reject conflicting bytes and result drift", async ctx => {
  const f = await fixture(ctx); f.t.spec.output = "out.txt";
  await assert.rejects(f.before({ ...f.t, journal: crash(f.journal, "output", false) }), /crash:/);
  const path = String(f.journal.entries().find(e => e.type === "output-intent")!.path);
  await writeFile(path, "foreign"); await assert.rejects(f.before(), /Artifact conflict/);
  await assert.rejects(f.before(f.t, { ...f.result, output: "changed" }), /content conflict/);
});
test("artifact recovery repairs a missing latest link after immutable publication", async ctx => {
  const f = await fixture(ctx); f.t.spec.output = "out.txt";
  await assert.rejects(f.before({ ...f.t, journal: crash(f.journal, "output") }), /crash:/);
  const path = String(f.journal.entries().find(e => e.type === "output-intent")!.path);
  await unlink(join(dirname(path), "latest"));
  await f.before(); assert.equal(await readlink(join(dirname(path), "latest")), "1-out.txt");
});
test("concurrent identical repeats publish once", async ctx => {
  const f = await fixture(ctx); f.t.spec.output = "out.txt"; f.t.spec.gate = "true";
  const effects = f.effects(), ctl = { signal: new AbortController().signal };
  const [a, b] = await Promise.all([effects.beforeSeal(f.t, "exec", f.result, ctl), effects.beforeSeal(f.t, "exec", f.result, ctl)]);
  assert.deepEqual(a, b);
  assert.equal(f.journal.entries().filter(e => e.type === "gate-intent").length, 1);
  assert.equal(f.journal.entries().filter(e => e.type === "output").length, 1);
});
