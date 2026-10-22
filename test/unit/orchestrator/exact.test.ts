// EX2, EX3, EX5, EX6: the orchestrator's side of the exact fork: the pinned capture, the launch decision, the
// fallback reasons and the report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCapture, type Capture } from "../../../src/agent/exact/capture.ts";
import { exactDecision, modelConfigured } from "../../../src/orchestrator/exact.ts";
import { prepareRun } from "../../../src/orchestrator/store.ts";
import { snapshotFromEntries } from "../../../src/orchestrator/snapshot.ts";
import { validateCallSpec } from "../../../src/compat/spec.ts";
import { runCommand } from "../../../src/cli/requests.ts";
import type { Entry, RunBody } from "../../../src/types.ts";

const capture = (over: Partial<Capture> = {}): Capture => ({
  sessionId: "s1", provider: "qa", model: "m", api: "anthropic-messages", thinking: "off", at: 1_700_000_000_000,
  payload: { model: "m", max_tokens: 4096, stream: true, messages: [{ role: "user", content: "parent question" }] },
  ...over,
});

/** A pi session file with one message: the origin a run pins. */
async function sessionFile(home: string, id: string): Promise<string> {
  const path = join(home, `${id}.jsonl`);
  await writeFile(path, JSON.stringify({ type: "session", id }) + "\n" +
    JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "parent question" } }) + "\n");
  return path;
}

test("EX5 the launch decision: no capture, an unsupported api, an unknown model, or exact", () => {
  assert.deepEqual(exactDecision({ capture: undefined, configured: false }), { mode: "rebuilt", reason: "no-capture" });
  assert.deepEqual(exactDecision({ capture: capture({ api: "openai-completions" }), configured: true }),
    { mode: "rebuilt", reason: "api:openai-completions" });
  assert.deepEqual(exactDecision({ capture: capture(), configured: false }), { mode: "rebuilt", reason: "model-unknown" });
  assert.deepEqual(exactDecision({ capture: capture(), configured: true }), { mode: "exact" });
});

test("EX5 a captured provider is configured when the configuration names it", () => {
  assert.equal(modelConfigured({ providers: { qa: { slots: 2 } } }, "qa", "m"), true);
  assert.equal(modelConfigured({ providers: { qa: { slots: 2 } } }, "qb", "m"), false);
  assert.equal(modelConfigured({ pools: { top: ["qa/m"] } }, "qa", "m"), true);
  assert.equal(modelConfigured({ pools: { top: ["qa/m"] } }, "qb", "m"), false);
  assert.equal(modelConfigured({ defaultModel: "qa/m" }, "qa", "m"), true);
  assert.equal(modelConfigured({}, "qa", "m"), true, "a configuration that names no provider configures every provider");
  assert.equal(modelConfigured({ providers: { qa: { slots: 2 } } }, "qa", ""), false);
});

test("EX2 the context \"exact\" is a valid call context", () => {
  assert.deepEqual(validateCallSpec({ agent: "worker", task: "t", context: "exact" }, { agent: "worker" } as never), []);
  assert.ok(validateCallSpec({ agent: "worker", task: "t", context: "fresh" }, { agent: "worker" } as never).length === 0);
  assert.ok(validateCallSpec({ agent: "worker", task: "t", context: "other" }, { agent: "worker" } as never).length > 0);
});

test("EX2 an exact call that names a model is refused at admission", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsa-exact-admission-"));
  try {
    const body = { cwd: home, call: { agent: "worker", task: "t", context: "exact", model: "qa/m" } } as unknown as RunBody;
    await assert.rejects(prepareRun(body, undefined, [], home), /context "exact" runs on the origin model; remove model/);
    const ok = { cwd: home, call: { agent: "worker", task: "t", context: "exact" },
      origin: { sessionFile: await sessionFile(home, "parent"), sessionId: "parent" } } as unknown as RunBody;
    const pins = await prepareRun(ok, undefined, [], home);
    assert.equal(pins.exact, undefined, "no capture yet: nothing is pinned");
    // The exact context needs an origin: its capture comes from the origin session.
    const orphan = { cwd: home, call: { agent: "worker", task: "t", context: "exact" } } as unknown as RunBody;
    await assert.rejects(prepareRun(orphan, undefined, [], home), /context "exact" needs an origin session/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("EX2 an exact run pins the capture of its origin session at admission", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-exact-admission-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeCapture(home, capture({ sessionId: "parent" }));
  // The origin branch is pinned with the capture (a rebuilt exact call runs as a fork): the session file is the
  // parent's pi session.
  const session = await sessionFile(home, "parent");
  const body = { cwd: home, call: { agent: "worker", task: "t", context: "exact" }, origin: { sessionFile: session, sessionId: "parent" } } as unknown as RunBody;
  const pins = await prepareRun(body, undefined, [], home);
  assert.ok(pins.exact, "the capture bytes are pinned with the run");
  assert.deepEqual(JSON.parse(pins.exact!).payload, capture().payload);
  assert.equal(pins.exactFacts?.provider, "qa"); assert.equal(pins.exactFacts?.model, "m");
  assert.equal(pins.exactFacts?.api, "anthropic-messages"); assert.equal(pins.exactFacts?.at, 1_700_000_000_000);
  assert.match(pins.exactFacts!.sha256, /^[0-9a-f]{64}$/);
  // A later capture never changes a pinned run: the pinned bytes are the ones the child splices.
  await writeCapture(home, capture({ sessionId: "parent", payload: { model: "m", messages: [{ role: "user", content: "later" }] } }));
  assert.deepEqual(JSON.parse(pins.exact!).payload, capture().payload, "the pinned run keeps the capture it admitted");
});

test("EX2 a run that does not ask for the exact context pins no capture", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-exact-admission-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeCapture(home, capture({ sessionId: "parent" }));
  const body = { cwd: home, call: { agent: "worker", task: "t" }, origin: { sessionFile: join(home, "session.jsonl"), sessionId: "parent" } } as unknown as RunBody;
  const pins = await prepareRun(body, undefined, [], home);
  assert.equal(pins.exact, undefined);
  assert.equal(pins.exactFacts, undefined);
});

test("EX6 the report of an exact call: the capture, the age and the usage of every request", () => {
  const entries = [
    { type: "call", key: "w", gen: 1, agent: "worker", call: "w@1/w@1", spec: { agent: "worker" } },
    { type: "exact-mode", call: "w@1/w@1", mode: "exact", capture: { sha256: "a".repeat(64), bytes: 120, at: 1000, provider: "qa", model: "m", api: "anthropic-messages" } },
    { type: "exact-launch", call: "w@1/w@1", exec: "w#1.1", ageMs: 41000 },
    { type: "exact-usage", call: "w@1/w@1", exec: "w#1.1", input: 4400, cacheRead: 148200, cacheWrite: 0, output: 120, costUsd: 0.031 },
    { type: "exact-usage", call: "w@1/w@1", exec: "w#1.1", input: 500, cacheRead: 148700, cacheWrite: 0, output: 80, costUsd: 0.004 },
  ] as unknown as Entry[];
  const snap = snapshotFromEntries("w", entries), call = snap.calls[0]!;
  assert.equal(call.exact?.mode, "exact");
  assert.equal(call.exact?.captureSha256, "a".repeat(64));
  assert.equal(call.exact?.provider, "qa"); assert.equal(call.exact?.model, "m");
  assert.equal(call.exact?.ageMsAtLaunch, 41000);
  assert.equal(call.exact?.requests.length, 2);
  assert.equal(call.exact?.input, 4900); assert.equal(call.exact?.cacheRead, 296900); assert.equal(call.exact?.output, 200);
  assert.equal(call.exact?.costUsd, 0.035);
  assert.ok(Math.abs((call.exact?.firstCacheRatio ?? 0) - 148200 / 152600) < 1e-9, "the cache share of the first request");
});

test("EX6 a rebuilt call shows its reason", () => {
  const entries = [
    { type: "call", key: "w", gen: 1, agent: "worker", call: "w@1/w@1", spec: { agent: "worker" } },
    { type: "exact-mode", call: "w@1/w@1", mode: "rebuilt", reason: "no-capture" },
  ] as unknown as Entry[];
  const call = snapshotFromEntries("w", entries).calls[0]!;
  assert.equal(call.exact?.mode, "rebuilt"); assert.equal(call.exact?.reason, "no-capture");
});

test("EX2 the CLI names the origin session of an exact run", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-exact-cli-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const spec = join(home, "spec.json");
  await writeFile(spec, JSON.stringify({ agent: "worker", task: "t", context: "fresh" }));
  const written: string[] = [];
  const code = await runCommand(["--request", "r1", "--spec", spec, "--origin-session", "sess", "--json"], {
    home, env: { ...process.env, HOME: home }, write: line => written.push(line),
  });
  assert.equal(code, 1, "the flag is only for exact calls");
  assert.match(written.join("\n"), /--origin-session is only for context/);
});
