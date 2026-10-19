import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { publishRequest } from "../../../../src/kernel/mailbox.ts";
import { callDir, callSession, orchInbox, orchLedger } from "../../../../src/paths.ts";
import { Engine } from "../../../../src/orchestrator/engine.ts";
import { Store } from "../../../../src/orchestrator/store.ts";
import createExecutor from "../../../../src/orchestrator/executor/index.ts";
import { snapshotFromEntries } from "../../../../src/orchestrator/snapshot.ts";
import { CT, JT, type Containment, type Request, type RunBody } from "../../../../src/types.ts";
import type { CallEffects, Ledgers } from "../../../../src/orchestrator/contract.ts";

async function until<T>(fn: () => T | Promise<T>): Promise<NonNullable<T>> {
  const end = Date.now() + 10000;
  for (;;) { const value = await fn(); if (value) return value as NonNullable<T>; if (Date.now() > end) throw new Error("Timed out"); await delay(5); }
}
const containment: Containment = {
  async spawn() { throw new Error("unit fixture: no child"); },
  async scan(known) { return new Map([...known.keys()].map(exec => [exec, []])); },
  async fence() {},
};
const effects: CallEffects = { prepare: async t => ({ cwd: t.cwd }), beforeSeal: async (_t, _exec, result) => result, afterSeal: async () => {}, recover: async () => {} };

async function fixture(t: TestContext, status: "done" | "stopped" | "running" = "done") {
  const root = await mkdtemp(join(tmpdir(), "dsa-sticky-")), home = join(root, "state"), cwd = join(root, "project");
  await mkdir(join(cwd, ".pi/agents"), { recursive: true });
  await writeFile(join(cwd, ".pi/agents/test.md"), "---\nname: test\ndescription: test\nmodel: p/a\n---\nTest.");
  const ledgers: Ledgers = { home, orch: await openJournal(orchLedger(home)), config: { writerLock: "off", pools: { pool: ["p/a", "q/b"], alt: ["q/b", "p/a"] }, k: { trackerMs: 10 } } };
  await ledgers.orch.append("config", { hash: "test", config: ledgers.config });
  const discovery = { home: root, agentDir: join(root, "agent"), globalNpmRoot: null };
  const store = new Store(ledgers), request: Request<RunBody> = { rid: "run", from: "main:test", to: "orch", kind: "run", sseq: 1, body: { cwd, source: "return 1;" } };
  await store.stage(request, discovery); const wf = await store.create(request), wid = wf.wid, call = `${wid}@1/a@1`;
  await wf.journal.append("call", { pos: 0, key: "a", gen: 1, spec: { agent: "test", task: "test", model: "pool", writer: false } });
  await wf.journal.append(JT.exec, { call, exec: `${call}#1.1` });
  await wf.journal.append("selected", { exec: `${call}#1.1`, model: { provider: "p", id: "a" }, pool: "pool" });
  await wf.journal.append(JT.fenced, { exec: `${call}#1.1` });
  await mkdir(callDir(home, wid, "a", 1), { recursive: true });
  await writeFile(callSession(home, wid, "a", 1), JSON.stringify({ type: "custom", customType: CT.exec, data: { exec: `${call}#1.1` } }) + "\n" + JSON.stringify({ type: "model_change", provider: "q", modelId: "b" }) + "\n");
  await wf.journal.append(JT.sealed, { call, exec: `${call}#1.1`, result: { key: "a", gen: 1, status: "ok", ok: true, output: "first" } });
  if (status !== "running") await wf.journal.append(JT.done, { status });
  await store.close();
  let current: { engine: Engine; executor: ReturnType<typeof createExecutor> } | undefined;
  const attempts = new Set<string>();
  const start = async () => {
    const executor = createExecutor(ledgers, { containment, effects, memory: async () => 1e6, attempted: exec => { attempts.add(exec); } });
    const engine = new Engine(ledgers, executor, { discovery, evaluator: { start: async () => {}, send() {}, close: async () => {} } });
    current = { engine, executor }; await engine.recover();
  };
  const stop = async () => { await current?.engine.close(); current = undefined; };
  t.after(async () => { await stop(); await ledgers.orch.close(); await rm(root, { recursive: true, force: true }); });
  await start();
  const journal = () => current!.engine.store.workflows.get(wid)!.journal;
  let sseq = 0;
  const requests = new Map<string, Request>();
  const send = async (body: Record<string, unknown>, rid = `send-${sseq + 1}`) => {
    const request = requests.get(rid) ?? { rid, from: "main:test", to: "orch", sseq: ++sseq, kind: "send" as const, body: { to: `${wid}/a`, ...body } };
    requests.set(rid, request);
    await publishRequest(orchInbox(home), request);
    return until(async () => { await current!.engine.intake(); return ledgers.orch.entries().find(e => [JT.applied, JT.rejected].includes(e.type as never) && e.rid === rid); });
  };
  const follow = async (gen: number, model?: string) => {
    const decision = await send({ kind: "follow-up", message: "again", ...(model ? { model } : {}) });
    assert.equal(decision.type, JT.applied);
    await until(() => journal().entries().some(e => e.type === JT.sealed && e.call === `${wid}@1/a@${gen}`));
    return journal().entries().findLast(e => e.type === "selected")!;
  };
  return { home, wid, call, ledgers, journal, send, follow, start, stop, attempts, get executor() { return current!.executor; } };
}

for (const state of ["done", "running", "stopped"] as const) test(`MP2/MP3: sealed call in ${state} workflow records a choice without launching, survives restart and retry`, async t => {
  const f = await fixture(t, state), before = f.journal().entries().length, holds = f.ledgers.orch.entries().filter(e => e.type === "hold").length;
  assert.equal((await f.send({ kind: "model", model: "q/b" }, "switch")).type, JT.applied);
  assert.deepEqual(f.ledgers.orch.entries().filter(e => e.type === "send-note").map(e => [e.model, e.effect]), [["q/b", "next-generation"]]);
  assert.equal(f.journal().entries().filter(e => e.type === JT.exec).length, 1);
  assert.equal(f.ledgers.orch.entries().filter(e => e.type === "hold").length, holds);
  assert.ok(f.journal().entries().length > before, "choice is durable before reply");
  const snap = snapshotFromEntries(f.wid, f.journal().entries()).calls[0]!;
  assert.equal(snap.model, "p/a"); assert.equal(snap.switching, "q/b");
  await f.stop(); await f.start();
  const count = f.journal().entries().length;
  assert.equal((await f.send({ kind: "model", model: "q/b" }, "switch")).type, JT.applied);
  assert.equal(f.journal().entries().length, count, "retry records no second choice");
  assert.deepEqual((await f.follow(2)).model, { provider: "q", id: "b" });
  assert.deepEqual((await f.follow(3)).model, { provider: "q", id: "b" });
  assert.equal(snapshotFromEntries(f.wid, f.journal().entries()).calls.at(-1)!.switching, undefined);
});

test("MP1: manual pool switch stays a pool, resolved at every generation; explicit follow-up replaces it", async t => {
  const f = await fixture(t);
  assert.equal((await f.send({ kind: "model", model: "alt" })).type, JT.applied);
  assert.deepEqual((await f.follow(2)).model, { provider: "q", id: "b" });
  await f.executor.reconfigure!(async () => { f.ledgers.config.pools!.alt = ["p/a", "q/b"]; await f.ledgers.orch.append("config", { hash: "reordered", config: f.ledgers.config }); });
  assert.deepEqual((await f.follow(3)).model, { provider: "p", id: "a" });
  const gen = f.journal().entries().findLast(e => e.type === "generation")!;
  assert.equal((gen.spec as { model: string }).model, "alt"); assert.equal(gen.model, undefined);
  assert.deepEqual((await f.follow(4, "q/b")).model, { provider: "q", id: "b" });
  assert.deepEqual((await f.follow(5)).model, { provider: "q", id: "b" });
});

for (const outcome of ["accepted", "refused", "withdrawn", "replaced", "failover", "legacy"] as const) test(`MP1: ${outcome} live model request across g+1 and g+2`, async t => {
  const f = await fixture(t), journal = f.journal();
  // Native live-send records, including the new optional choice intent. Legacy forwards retain their old meaning.
  await journal.append("forward", { rid: "live", rid2: "live-2", dest: f.call, envelope: { kind: "model", body: { provider: "q", model: "b" } }, ...(outcome !== "legacy" ? { choice: "q/b" } : {}), ...(outcome === "failover" ? { failover: "p" } : {}) });
  if (outcome === "accepted" || outcome === "refused") await journal.append("forward-delivered", { call: f.call, rid2: "live-2", ...(outcome === "refused" ? { reason: "unknown-model" } : {}) });
  if (outcome === "withdrawn" || outcome === "replaced") await journal.append("forward", { rid: "withdraw", rid2: "withdraw-2", dest: f.call, envelope: { kind: "withdraw", body: { rids: ["live-2"] } } });
  if (outcome === "replaced") await journal.append("forward", { rid: "replacement", rid2: "replacement-2", dest: f.call, choice: "p/a", envelope: { kind: "model", body: { provider: "p", model: "a" } } });
  const expected = outcome === "accepted" ? { provider: "q", id: "b" } : { provider: "p", id: "a" };
  assert.deepEqual((await f.follow(2)).model, expected);
  assert.deepEqual((await f.follow(3)).model, expected);
});

test("MP3: a sealed choice committed before reply is replayed once after restart", async t => {
  const f = await fixture(t);
  await f.journal().append("model-choice", { rid: "interrupted", call: f.call, model: "q/b" });
  await f.stop(); await f.start();
  assert.equal((await f.send({ kind: "model", model: "q/b" }, "interrupted")).type, JT.applied);
  assert.equal(f.journal().entries().filter(e => e.type === "model-choice").length, 1);
  assert.equal(f.ledgers.orch.entries().find(e => e.type === "send-note" && e.rid === "interrupted")?.effect, "next-generation");
  assert.equal((await f.send({ kind: "model", model: "p/a" })).type, JT.applied);
  assert.deepEqual((await f.follow(2)).model, { provider: "p", id: "a" });
  assert.deepEqual((await f.follow(3)).model, { provider: "p", id: "a" });
});

for (const refused of [false, true]) test(`MP3: a live forward committed before reply stays ${refused ? "refused" : "accepted"} after sealing and restart`, async t => {
  const f = await fixture(t);
  await f.journal().append("forward", { rid: "interrupted-live", rid2: "interrupted-live-2", dest: f.call, choice: "q/b", envelope: { kind: "model", body: { provider: "q", model: "b" } } });
  await f.journal().append("forward-delivered", { call: f.call, rid2: "interrupted-live-2", ...(refused ? { reason: "unknown-model" } : {}) });
  await f.stop(); await f.start();
  assert.equal((await f.send({ kind: "model", model: "q/b" }, "interrupted-live")).type, JT.applied);
  assert.equal(f.journal().entries().filter(e => e.type === "model-choice").length, 0, "replay does not create a fresh sealed choice");
  const expected = refused ? { provider: "p", id: "a" } : { provider: "q", id: "b" };
  assert.deepEqual((await f.follow(2)).model, expected);
  assert.deepEqual((await f.follow(3)).model, expected);
});

test("MP2: invalid model leaves the sealed call's choice unchanged", async t => {
  const f = await fixture(t);
  assert.equal((await f.send({ kind: "model", model: "q/b" })).type, JT.applied);
  const before = f.journal().entries().length;
  const invalid = await f.send({ kind: "model", model: "no-provider" });
  assert.equal(invalid.type, JT.rejected); assert.equal(invalid.reason, "unknown-model");
  assert.equal(f.journal().entries().length, before);
  assert.deepEqual((await f.follow(2)).model, { provider: "q", id: "b" });
});

test("MP1: a concrete choice waits for its exhausted provider using the explicit-model path", async t => {
  const f = await fixture(t);
  await f.ledgers.orch.append("provider-exhausted", { provider: "q", exec: "other", since: Date.now(), nextTry: Date.now() + 60000, error: "quota" });
  assert.equal((await f.send({ kind: "model", model: "q/b" })).type, JT.applied);
  assert.equal((await f.send({ kind: "follow-up", message: "again" })).type, JT.applied);
  await until(() => f.attempts.has(`${f.wid}@1/a@2#1.1`));
  assert.equal(f.journal().entries().filter(e => e.type === "selected").length, 1, "no fallback into the former pool");
  await f.executor.reconfigure!(async () => { await f.ledgers.orch.append("provider-available", { provider: "q", exec: "probe" }); });
  await until(() => f.journal().entries().some(e => e.type === JT.sealed && e.call === `${f.wid}@1/a@2`));
  assert.deepEqual(f.journal().entries().findLast(e => e.type === "selected")!.model, { provider: "q", id: "b" });
});

test("MP1: a pool choice skips an exhausted provider without sticking to that failover", async t => {
  const f = await fixture(t);
  await f.ledgers.orch.append("provider-exhausted", { provider: "q", exec: "other", since: Date.now(), nextTry: Date.now() + 60000, error: "quota" });
  assert.equal((await f.send({ kind: "model", model: "alt" })).type, JT.applied);
  assert.deepEqual((await f.follow(2)).model, { provider: "p", id: "a" });
  await f.executor.reconfigure!(async () => { await f.ledgers.orch.append("provider-available", { provider: "q", exec: "probe" }); });
  assert.deepEqual((await f.follow(3)).model, { provider: "q", id: "b" });
});
