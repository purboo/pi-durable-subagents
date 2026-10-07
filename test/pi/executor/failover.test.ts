import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { FAUX, REPO, tempRoot } from "../../harness/pi.ts";
import { journalPath, orchLedger } from "../../../src/paths.ts";
import { openJournal } from "../../../src/kernel/journal.ts";
import { ulid } from "../../../src/kernel/ids.ts";
import type { CallTicket, OrchestratorConfig } from "../../../src/orchestrator/contract.ts";
import createExecutor from "../../../src/orchestrator/executor/index.ts";
import { slotsView } from "../../../src/orchestrator/snapshot.ts";

// Provider failover (todo 0b): a provider whose usage window is used up is avoided, then probed by one call.
const QUOTA = fileURLToPath(new URL("quota-providers.ts", import.meta.url));
const agent = { name: "test", description: "test", body: "Test agent", model: "qa/m", tools: ["bash"], systemPromptMode: "replace" as const, inheritProjectContext: false, inheritSkills: false, sourcePath: "/fixture/test.md", source: "project" as const };

async function until(predicate: () => boolean | Promise<boolean>, ms = 30000) {
  const deadline = Date.now() + ms;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error("Timed out waiting for failover evidence"); await delay(20); }
}

async function setup(t: TestContext, config: OrchestratorConfig) {
  const root = tempRoot("dsa-failover-"), home = join(root, "dsa"), cwd = join(root, "work");
  await mkdir(cwd, { recursive: true });
  const old = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PROBE_DIR: process.env.PROBE_DIR, PI_OFFLINE: process.env.PI_OFFLINE, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK };
  process.env.PATH = `${join(REPO, "node_modules/.bin")}:${process.env.PATH}`;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PROBE_DIR = root;
  process.env.PI_OFFLINE = "1"; process.env.PI_SKIP_VERSION_CHECK = "1";
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  // pi's own retries are off: the error a child settles with is what the executor classifies.
  await writeFile(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ extensions: [FAUX, QUOTA], defaultProvider: "qa", defaultModel: "m", retry: { enabled: false } }));
  const orch = await openJournal(orchLedger(home)), wid = ulid(), journal = await openJournal(journalPath(home, wid));
  const executor = createExecutor({ home, orch, config });
  const ticket = (key: string, model: string): CallTicket => ({ wid, widRev: `${wid}@1`, key, gen: 1, callId: `${wid}@1/${key}@1`, cwd, journal, spec: { agent: "test", task: "work", model }, agent });
  t.after(async () => {
    try { await executor.shutdown(); } finally {
      await journal.close(); await orch.close();
      for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      if (process.env.DSA_KEEP) console.error(`kept ${t.name}: ${root}`); else await rm(root, { recursive: true, force: true });
    }
  });
  const requests = async () => (await readFile(join(root, "quota.log"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  const exhaust = (on: boolean) => on ? writeFile(join(root, "qa-exhausted"), "") : unlink(join(root, "qa-exhausted"));
  return { home, orch, journal, executor, ticket, requests, exhaust };
}
const providersOf = (f: Awaited<ReturnType<typeof setup>>, key: string) =>
  f.journal.entries().filter(e => e.type === "selected" && String(e.exec).includes(`/${key}@`)).map(e => (e.model as { provider: string }).provider);

test("failover: a pool call on a used-up provider continues on the next candidate, and new calls avoid it", { timeout: 60000 }, async t => {
  const f = await setup(t, { pools: { top: ["qa/m", "qb/m"] } });
  await f.exhaust(true);
  const a = await f.executor.run(f.ticket("a", "top"));
  assert.equal(a.status, "ok"); assert.equal(a.output, "answered by qb");
  assert.deepEqual(providersOf(f, "a"), ["qa", "qb"], "the same call relaunched on qb");
  assert.equal(f.journal.entries().filter(e => e.type === "loss").length, 0, "a used-up window is not a lost execution");
  const exhausted = f.orch.entries().filter(e => e.type === "provider-exhausted");
  assert.deepEqual(exhausted.map(e => e.provider), ["qa"]); assert.match(String(exhausted[0]!.error), /No available accounts/);
  assert.match(String(slotsView(f.home).exhausted?.[0]), /^qa exhausted since \d+s ago \(503 .*No available accounts.*\), next try in \d+m/);

  const b = await f.executor.run(f.ticket("b", "top"));
  assert.equal(b.output, "answered by qb"); assert.deepEqual(providersOf(f, "b"), ["qb"], "a new call does not try qa before its next try");
  assert.deepEqual(await f.requests(), ["qa", "qb", "qb"]);
});

test("failover: a single-model call waits for its used-up provider and probes it after probeMs, one call at a time", { timeout: 60000 }, async t => {
  const f = await setup(t, { k: { probeMs: 1500 } });
  await f.exhaust(true);
  const a = f.executor.run(f.ticket("a", "qa/m"));
  await until(() => f.orch.entries().some(e => e.type === "provider-exhausted"));
  const b = f.executor.run(f.ticket("b", "qa/m"));
  await delay(500);
  assert.deepEqual(await f.requests(), ["qa"], "no request reaches qa before the next try");
  assert.match(String(slotsView(f.home).exhausted?.[0]), /^qa exhausted .*next try in \d+s$/);
  // The first probe is still refused: the next try moves on, and the call keeps waiting without a loss.
  await until(() => f.orch.entries().filter(e => e.type === "provider-exhausted").length === 2);
  assert.deepEqual(await f.requests(), ["qa", "qa"], "one probe at a time");
  await f.exhaust(false);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.output, "answered by qa"); assert.equal(rb.output, "answered by qa");
  assert.equal(f.journal.entries().filter(e => e.type === "loss").length, 0);
  assert.equal(f.orch.entries().filter(e => e.type === "provider-available").length, 1);
  assert.equal(slotsView(f.home).exhausted, undefined, "an answer from qa ends the exhaustion");
  assert.deepEqual(await f.requests(), ["qa", "qa", "qa", "qa"]);
});

test("failover: a pool call's next generation goes back to the preferred provider once its next try is due", { timeout: 60000 }, async t => {
  const f = await setup(t, { pools: { top: ["qa/m", "qb/m"] }, k: { probeMs: 1000 } });
  await f.exhaust(true);
  const first = f.ticket("a", "top");
  assert.equal((await f.executor.run(first)).output, "answered by qb");
  await f.exhaust(false);
  await delay(1100);
  const next: CallTicket = { ...first, gen: 2, callId: `${first.wid}@1/a@2`, continueFrom: first.callId, opening: { rid: "next", kind: "follow-up", message: "next turn" } };
  const result = await f.executor.run(next);
  assert.equal(result.output, "answered by qa", "the new generation probes qa and stays there");
  assert.deepEqual(providersOf(f, "a"), ["qa", "qb", "qa"]);
  assert.equal(f.orch.entries().filter(e => e.type === "provider-available").length, 1);
  assert.equal(slotsView(f.home).exhausted, undefined);
});

test("failover: a follow-up naming the model its call is on stays there, though the pool would go back", { timeout: 60000 }, async t => {
  const f = await setup(t, { pools: { top: ["qa/m", "qb/m"] }, k: { probeMs: 1000 } });
  await f.exhaust(true);
  const first = f.ticket("a", "top");
  assert.equal((await f.executor.run(first)).output, "answered by qb");
  await f.exhaust(false);
  await delay(1100);
  const next: CallTicket = { ...first, gen: 2, callId: `${first.wid}@1/a@2`, continueFrom: first.callId, opening: { rid: "next", kind: "follow-up", message: "next turn" }, model: "qb/m" };
  assert.equal((await f.executor.run(next)).output, "answered by qb");
  assert.deepEqual(providersOf(f, "a"), ["qa", "qb", "qb"]);
});
