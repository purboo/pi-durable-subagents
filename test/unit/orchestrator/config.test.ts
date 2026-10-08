import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile as write } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openJournal } from "../../../src/kernel/journal.ts";
import { orchLedger } from "../../../src/paths.ts";
import { configHash, configProblem, configStamp, recordConfig, watchConfig } from "../../../src/orchestrator/config.ts";
import { slotsView, type StatusView } from "../../../src/orchestrator/snapshot.ts";
import { renderView } from "../../../src/cli/main.ts";
import type { OrchestratorConfig } from "../../../src/orchestrator/contract.ts";

// Each version is written whole, as an editor saving by rename does: a watcher check can otherwise read the file
// truncated and half-written, which is reported as invalid JSON until the next check.
async function writeFile(path: string, text: string) { await write(`${path}.tmp`, text); await rename(`${path}.tmp`, path); }

test("configProblem accepts pi-side keys and names the first invalid orchestrator setting", () => {
  assert.equal(configProblem({ ui: { dock: "line" }, onQuit: "pause", providers: { a: { slots: 0 } }, pools: { p: ["a/b:low"] }, k: { trackerMs: 50, lossBound: 0 }, memory: { reserveMb: 0 } }), undefined);
  assert.equal(configProblem([]), "config.json must be a JSON object");
  assert.equal(configProblem({ writerLock: "off" }), undefined);
  assert.equal(configProblem({ writerLock: "block" }), 'writerLock must be "queue" or "off"');
  assert.equal(configProblem({ providers: { a: { slots: -1 } } }), "providers.a.slots must be a nonnegative integer");
  assert.equal(configProblem({ providers: { a: 3 } }), "providers.a.slots must be a nonnegative integer");
  assert.equal(configProblem({ pools: { p: [] } }), 'pools.p must be a nonempty list of "provider/id[:thinking]"');
  assert.equal(configProblem({ k: { trackerMs: 0 } }), "k.trackerMs must be a positive number");
  assert.match(String(configProblem({ k: { tracker: 1 } })), /^k\.tracker is not a K-parameter/);
  assert.equal(configProblem({ defaultModel: 1 }), "defaultModel must be a string");
  // Only the orchestrator's keys identify its settings: a ui change is not a new config.
  assert.equal(configHash({ providers: { a: { slots: 1 } } }), configHash({ providers: { a: { slots: 1 } }, ui: { dock: "off" } } as OrchestratorConfig));
});

test("watchConfig applies a valid change in place, records it once, and rejects an invalid one without applying it", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-config-")), path = join(home, "config.json");
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path, JSON.stringify({ providers: { probe: { slots: 1 } }, ui: { dock: "line" } }));
  const orch = await openJournal(orchLedger(home));
  t.after(() => orch.close());
  const stamp = await configStamp(path);
  const config: OrchestratorConfig = { providers: { probe: { slots: 1 } }, ...{ ui: { dock: "line" } } };
  const held = config; // readers keep the object, so the change must be in place
  await recordConfig(orch, config);
  await recordConfig(orch, config); // a restart with the same settings records nothing new
  assert.equal(orch.entries().filter(e => e.type === "config").length, 1);
  let applied = 0;
  const watcher = watchConfig({ path, stamp, config, orch, intervalMs: 20, onApplied: () => applied++ });
  t.after(() => watcher.stop());
  const configs = () => orch.entries().filter(e => e.type === "config");
  const until = async (p: () => boolean) => { for (let i = 0; i < 200 && !p(); i++) await delay(20); assert.ok(p()); };

  await writeFile(path, JSON.stringify({ providers: { probe: { slots: 0 } }, k: { trackerMs: 30 } }));
  await until(() => configs().length === 2);
  assert.equal(held.providers?.probe?.slots, 0); assert.equal(held.k?.trackerMs, 30);
  assert.deepEqual((held as Record<string, unknown>).ui, { dock: "line" }, "pi-side keys of the start object are left alone");
  assert.equal(configs()[1]!.hash, configHash(held)); assert.equal(applied, 1);

  await writeFile(path, JSON.stringify({ providers: { probe: { slots: "two" } } }));
  await until(() => orch.entries().some(e => e.type === "config-rejected"));
  assert.equal(held.providers?.probe?.slots, 0, "an invalid change keeps the settings in effect");
  assert.equal(orch.entries().findLast(e => e.type === "config-rejected")!.error, "providers.probe.slots must be a nonnegative integer");
  assert.match(String(slotsView(home).configRejected), /^providers\.probe\.slots must be a nonnegative integer \(\d+s ago\); [0-9a-f]{12} stay in effect$/);

  await writeFile(path, "{ not json");
  await until(() => orch.entries().filter(e => e.type === "config-rejected").length === 2);
  assert.match(String(orch.entries().findLast(e => e.type === "config-rejected")!.error), /^config\.json is not valid JSON/);

  await writeFile(path, JSON.stringify({ providers: { probe: { slots: 2 } } }));
  await until(() => configs().length === 3);
  assert.equal(held.providers?.probe?.slots, 2); assert.equal(held.k, undefined, "a removed key is removed");
  assert.equal(slotsView(home).configRejected, undefined, "an applied change clears the rejection");
  await delay(100);
  assert.equal(configs().length, 3, "an unchanged file records nothing");

  // Back to the settings in effect after a rejection: confirmed, so the rejection no longer shows.
  await writeFile(path, JSON.stringify({ providers: { probe: { slots: -2 } } }));
  await until(() => slotsView(home).configRejected !== undefined);
  await writeFile(path, JSON.stringify({ providers: { probe: { slots: 2 } }, ui: { dock: "off" } }));
  await until(() => configs().length === 4);
  assert.equal(slotsView(home).configRejected, undefined); assert.equal(applied, 2, "nothing changed in effect");
});

test("watchConfig validates before comparing, and applies through the given section", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-config-")), path = join(home, "config.json");
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path, "{}");
  const orch = await openJournal(orchLedger(home));
  t.after(() => orch.close());
  const config: OrchestratorConfig = {}, stamp = await configStamp(path);
  await recordConfig(orch, config);
  let sections = 0;
  const watcher = watchConfig({ path, stamp, config, orch, intervalMs: 20, apply: async change => { sections++; await change(); } });
  t.after(() => watcher.stop());
  const until = async (p: () => boolean) => { for (let i = 0; i < 200 && !p(); i++) await delay(20); assert.ok(p()); };
  await writeFile(path, "[]"); // projects to the same (empty) settings, but is not a config object
  await until(() => orch.entries().some(e => e.type === "config-rejected"));
  assert.equal(orch.entries().findLast(e => e.type === "config-rejected")!.error, "config.json must be a JSON object");
  assert.equal(sections, 0);
  await writeFile(path, JSON.stringify({ providers: { a: { slots: 1 } } }));
  await until(() => config.providers?.a?.slots === 1);
  assert.equal(sections, 1);
});

test("renderView shows slots and a rejected config even without workflows", () => {
  assert.equal(renderView({ workflows: [], slots: ["a 0/1"], configRejected: "bad (1s ago); abc stay in effect" } as unknown as StatusView),
    "No workflows\nslots: a 0/1\nconfig.json rejected: bad (1s ago); abc stay in effect");
  assert.equal(renderView({ workflows: [] } as unknown as StatusView), "No workflows");
});

test("slotsView counts held provider slots against the limits in effect, without memory", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-slots-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const orch = await openJournal(orchLedger(home));
  t.after(() => orch.close());
  await orch.append("config", { hash: "abc", config: { providers: { a: { slots: 2 }, c: { slots: 1 } } } });
  await orch.append("hold", { pool: "memory", slot: 0, exec: "x#1.1" });
  await orch.append("hold", { pool: "a", slot: 0, exec: "x#1.1" });
  await orch.append("hold", { pool: "a", slot: 1, exec: "y#1.1" });
  await orch.append("hold", { pool: "b", slot: 0, exec: "z#1.1" });
  await orch.append("release", { pool: "a", slot: 1, exec: "y#1.1" });
  await orch.append("release", { pool: "a", slot: 0, exec: "other#1.1" }); // not the holder's release
  const view = slotsView(home);
  assert.deepEqual(view.slots, ["a 1/2", "b 1 (no limit)", "c 0/1"]);
  assert.match(String(view.config), /^abc since \d+s ago$/);
});
