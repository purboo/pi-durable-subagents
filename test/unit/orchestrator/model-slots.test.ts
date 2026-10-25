// providers.<p>.models: config validation and hash, and what the readers show (status slots text/JSON, why a queued
// call waits, a resumed pool call's wait, the waiting event text) when a model's own limit is the blocker.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal } from "../../../src/kernel/journal.ts";
import { orchLedger } from "../../../src/paths.ts";
import { configHash, configProblem } from "../../../src/orchestrator/config.ts";
import { candidateSlots, queueWait, slotsView, type CallSnapshot } from "../../../src/orchestrator/snapshot.ts";
import { emptyLedger, foldLedger } from "../../../src/orchestrator/ledger.ts";
import { foldWaits, waitsOf } from "../../../src/events/waiting.ts";
import type { Entry } from "../../../src/types.ts";

const NOW = 1_800_000_000_000;
let seq = 0;
const entry = (type: string, fields: Record<string, unknown> = {}, ts = NOW - 12_000): Entry => ({ seq: ++seq, ts, type, ...fields }) as Entry;
const GATEWAY = { slots: 10, models: { "deepseek-v4.1-flash": { slots: 6 }, "MiniMax-M3.1-Flash": { slots: 6 }, "gemini-4-argon": { slots: 4 } } };

test("configProblem: models map ids to { slots }; slots may be omitted only with models", () => {
  assert.equal(configProblem({ providers: { "gateway-cli": { ...GATEWAY, exhaustedPatterns: ["quota"] } } }), undefined);
  assert.equal(configProblem({ providers: { c: { models: { a: { slots: 0 }, "gateway-cli/gemini": { slots: 2 } } } } }), undefined, "no provider-wide limit");
  assert.equal(configProblem({ providers: { c: {} } }), "providers.c.slots must be a nonnegative integer", "neither slots nor models");
  assert.equal(configProblem({ providers: { c: { exhaustedPatterns: [] } } }), "providers.c.slots must be a nonnegative integer");
  assert.equal(configProblem({ providers: { c: { slots: -1, models: {} } } }), "providers.c.slots must be a nonnegative integer", "a given slots is still checked");
  assert.equal(configProblem({ providers: { c: { slots: 1, models: [] } } }), "providers.c.models must map model ids to { slots }");
  assert.equal(configProblem({ providers: { c: { slots: 1, models: { a: 3 } } } }), "providers.c.models.a.slots must be a nonnegative integer");
  assert.equal(configProblem({ providers: { c: { slots: 1, models: { a: { slots: 1.5 } } } } }), "providers.c.models.a.slots must be a nonnegative integer");
  assert.equal(configProblem({ providers: { c: { slots: 1, models: { a: { slots: -1 } } } } }), "providers.c.models.a.slots must be a nonnegative integer");
  assert.equal(configProblem({ providers: { c: { slots: 1, models: { a: {} } } } }), "providers.c.models.a.slots must be a nonnegative integer");
  assert.equal(configProblem({ providers: { c: { slots: 1, models: { a: { slots: 1, limit: 2 } } } } }), "providers.c.models.a.limit is not a model entry key (slots)");
});

test("the config hash is unchanged without models and covers them", () => {
  const plain = { providers: { a: { slots: 2, exhaustedPatterns: ["quota"] } }, pools: { p: ["a/b"] } };
  assert.equal(configHash(plain), "4f9307c9be18", "the 1.3.2 hash of these settings");
  assert.notEqual(configHash({ ...plain, providers: { a: { ...plain.providers.a, models: { b: { slots: 1 } } } } }), configHash(plain));
  assert.notEqual(configHash({ providers: { a: { slots: 2, models: { b: { slots: 1 } } } } }), configHash({ providers: { a: { slots: 2, models: { b: { slots: 2 } } } } }));
});

test("status: a provider with models shows its models' holdings; JSON adds modelSlots", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-model-slots-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const orch = await openJournal(orchLedger(home));
  t.after(() => orch.close());
  await orch.append("config", { hash: "abc", config: { providers: { "gateway-cli": GATEWAY, relay: { slots: 3 }, free: { models: { m: { slots: 1 } } } } } });
  await orch.append("created", { rid: "r1", wid: "W1", origin: "cli:alice@host" });
  await orch.append("created", { rid: "r2", wid: "W2", origin: "main:01a11a3b-5c6d-4e7f" });
  const calls: [string, string][] = [["deepseek-v4.1-flash", "W1"], ["deepseek-v4.1-flash", "W1"], ["deepseek-v4.1-flash", "W1"],
    ["MiniMax-M3.1-Flash", "W2"], ["MiniMax-M3.1-Flash", "W2"], ["gemini-4-argon", "W2"], ["gemini-4-argon", "W2"]];
  const counts = new Map<string, number>();
  for (const [i, [model, wid]] of calls.entries()) {
    const exec = `${wid}@1/k${i}@1#1.1`, n = counts.get(model) ?? 0; counts.set(model, n + 1);
    await orch.append("hold", { pool: "memory", slot: i, exec });
    await orch.append("hold", { pool: "gateway-cli", slot: i, exec });
    await orch.append("hold", { pool: `gateway-cli/${model}`, slot: n, exec });
  }
  await orch.append("hold", { pool: "relay", slot: 0, exec: "W1@1/s@1#1.1" });
  const view = slotsView(home);
  assert.deepEqual(view.slots, [
    "free 0 (no limit) (m 0/1)",
    "gateway-cli 7/10 (deepseek-v4.1-flash 3/6, MiniMax-M3.1-Flash 2/6, gemini-4-argon 2/4) (4 session 01a11a3b, 3 cli:alice@host)",
    "relay 1/3",
  ]);
  assert.deepEqual(view.modelSlots, {
    "gateway-cli": { "deepseek-v4.1-flash": { held: 3, slots: 6 }, "MiniMax-M3.1-Flash": { held: 2, slots: 6 }, "gemini-4-argon": { held: 2, slots: 4 } },
    free: { m: { held: 0, slots: 1 } },
  });
});

test("status without models is unchanged: no modelSlots, model pools never show as providers", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-model-slots-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const orch = await openJournal(orchLedger(home));
  t.after(() => orch.close());
  await orch.append("config", { hash: "abc", config: { providers: { a: { slots: 2 } } } });
  await orch.append("hold", { pool: "a", slot: 0, exec: "x#1.1" });
  // A model slot held under limits a reload has since removed stays held, and stays out of the provider lines.
  await orch.append("hold", { pool: "a/m", slot: 0, exec: "x#1.1" });
  const view = slotsView(home);
  assert.deepEqual(view.slots, ["a 1/2"]);
  assert.equal("modelSlots" in view, false);
});

const queued = (extra: Partial<CallSnapshot> = {}): CallSnapshot => ({ key: "a", gen: 1, callId: "w@1/a@1", agent: "worker", phase: "queued", exec: "w@1/a@1#1.1", model: "c/a", ...extra });
const hold = (pool: string, slot: number) => entry("hold", { pool, slot, exec: `other@1/x@1#${pool}${slot}` });

test("queued: the reason names the full model when the model, not the provider, is the blocker", () => {
  const settings = { providers: { c: { slots: 5, models: { a: { slots: 1 }, b: { slots: 1 } } }, d: { slots: 1 } }, pools: { ab: ["c/a:high", "c/b"], cross: ["c/a", "d/x"] } };
  const state = foldLedger(emptyLedger(), [entry("config", { hash: "h", config: settings }), hold("c", 0), hold("c/a", 0)]);
  assert.deepEqual(queueWait(queued(), state, NOW), { reason: "slot", detail: "waiting for a free slot (c/a 1/1)" });
  assert.equal(queueWait(queued({ model: "c/b" }), state, NOW), undefined, "b has room");
  assert.equal(queueWait(queued({ model: "c/other" }), state, NOW), undefined, "a model without an entry: only the provider");
  assert.equal(queueWait(queued({ model: "ab" }), state, NOW), undefined, "a pool with a model that has room");
  const both = foldLedger(emptyLedger(), [entry("config", { hash: "h", config: settings }), hold("c", 0), hold("c/a", 0), hold("c", 1), hold("c/b", 0), hold("d", 0)]);
  assert.deepEqual(queueWait(queued({ model: "ab" }), both, NOW), { reason: "slot", detail: "waiting for a free slot (c/a 1/1, c/b 1/1)" });
  assert.deepEqual(queueWait(queued({ model: "cross" }), both, NOW), { reason: "slot", detail: "waiting for a free slot (c/a 1/1, d 1/1)" });
  // The provider full: its line, as before.
  const full = foldLedger(emptyLedger(), [entry("config", { hash: "h", config: { providers: { c: { slots: 1, models: { a: { slots: 1 } } } } } }), hold("c", 0), hold("c/a", 0)]);
  assert.deepEqual(queueWait(queued(), full, NOW), { reason: "slot", detail: "waiting for a free slot (c 1/1)" });
  assert.deepEqual(candidateSlots([{ provider: "c", id: "a" }], [], { c: { slots: 1 } }), { full: false, lines: ["c 0/1"] });
});

test("waiting: the slot wait of a queued call names the full model", () => {
  const wid = "W", a = `${wid}@1/a@1`;
  const journal = [entry("wf-created", { revision: 1 }), entry("call", { pos: 0, key: "a", gen: 1, spec: { agent: "worker", model: "c/a" } }), entry("exec", { exec: `${a}#1.1`, call: a })];
  const ledger = foldLedger(emptyLedger(), [entry("config", { hash: "h", config: { providers: { c: { slots: 5, models: { a: { slots: 1 } } } } } }), hold("c", 0), hold("c/a", 0)]);
  const wait = waitsOf(foldWaits(wid, journal), { now: NOW, ledger }).get(a);
  assert.equal(wait?.reason, "slot");
  assert.equal(wait?.detail, "waiting for a slot: c/a 1/1");
  const free = foldLedger(emptyLedger(), [entry("config", { hash: "h", config: { providers: { c: { slots: 5, models: { a: { slots: 1 } } } } } }), hold("c", 0)]);
  assert.equal(waitsOf(foldWaits(wid, journal), { now: NOW, ledger: free }).get(a)?.detail, "waiting for a slot: c 1/5");
});
