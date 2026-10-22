// EX2, EX3, EX5, EX6: the orchestrator's side of the exact fork: the pinned capture, the launch decision, the
// fallback reasons and the report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import { writeCapture, type Capture } from "../../../src/agent/exact/capture.ts";
import { registerExactChild } from "../../../src/agent/exact/child.ts";
import { exactDecision, modelConfigured } from "../../../src/orchestrator/exact.ts";
import { prepareRun } from "../../../src/orchestrator/store.ts";
import { snapshotFromEntries, exactLine } from "../../../src/orchestrator/snapshot.ts";
import { validateCallSpec } from "../../../src/compat/spec.ts";
import { runCommand } from "../../../src/cli/requests.ts";
import createExecutor from "../../../src/orchestrator/executor/index.ts";
import { openJournal } from "../../../src/kernel/journal.ts";
import { ulid } from "../../../src/kernel/ids.ts";
import { callDir, callSession, journalPath, orchLedger } from "../../../src/paths.ts";
import { CT, ENV, JT, type Containment, type SpawnSpec, type Entry, type RunBody } from "../../../src/types.ts";
import type { CallTicket } from "../../../src/orchestrator/contract.ts";

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

test("EX5 the configuration is read as a whole: a provider of a pool or of the default model is configured", () => {
  // The providers map does not hide the pools and the default model.
  assert.equal(modelConfigured({ providers: { other: { slots: 1 } }, pools: { top: ["qa/m"] } }, "qa", "m"), true);
  assert.equal(modelConfigured({ providers: { other: { slots: 1 } }, defaultModel: "qa/m" }, "qa", "m"), true);
  assert.equal(modelConfigured({ providers: { other: { slots: 1 } }, pools: { top: ["qb/m"] }, defaultModel: "qb/m" }, "qa", "m"), false);
  // A pool entry may name its model as an object.
  assert.equal(modelConfigured({ pools: { top: [{ model: "qa/m", afterMs: 1000 }] } }, "qa", "m"), true);
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

test("EX2 the exact context is read from the specs of a run, not from a word in its source", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-exact-admission-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeCapture(home, capture({ sessionId: "parent" }));
  const session = await sessionFile(home, "parent");
  // A task that happens to name the word is not an exact call: the run pins no capture and needs no origin.
  const worded = { cwd: home, call: { agent: "worker", task: 'make it "exact"' },
    origin: { sessionFile: session, sessionId: "parent" } } as unknown as RunBody;
  const pins = await prepareRun(worded, undefined, [], home);
  assert.equal(pins.exact, undefined, "a word in a task is not an exact context");
  assert.equal(pins.exactFacts, undefined);
  // A step of a task list that asks for the exact context is one.
  const stepped = { cwd: home, tasks: [{ key: "a", agent: "worker", task: "t" }, { key: "b", agent: "worker", task: "t", context: "exact" }],
    origin: { sessionFile: session, sessionId: "parent" } } as unknown as RunBody;
  const steppedPins = await prepareRun(stepped, undefined, [], home);
  assert.ok(steppedPins.exact, "the step's exact context is read from its spec");
  assert.equal(steppedPins.exactFacts?.provider, "qa");
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
  assert.equal(exactLine(call.exact), "exact: cache 97% (148.2K/152.6K) · $0.035 · age 41s");
});

test("EX6 a rebuilt call shows its reason", () => {
  const entries = [
    { type: "call", key: "w", gen: 1, agent: "worker", call: "w@1/w@1", spec: { agent: "worker" } },
    { type: "exact-mode", call: "w@1/w@1", mode: "rebuilt", reason: "no-capture" },
  ] as unknown as Entry[];
  const call = snapshotFromEntries("w", entries).calls[0]!;
  assert.equal(call.exact?.mode, "rebuilt"); assert.equal(call.exact?.reason, "no-capture");
  assert.equal(exactLine(call.exact), "exact: rebuilt (no-capture)");
});

test("EX6 a rebuilt call shows what it cost", () => {
  const entries = [
    { type: "call", key: "w", gen: 1, agent: "worker", call: "w@1/w@1", spec: { agent: "worker" } },
    { type: "exact-mode", call: "w@1/w@1", mode: "rebuilt", reason: "no-capture" },
    { type: "exact-usage", call: "w@1/w@1", exec: "w#1.1", input: 120, cacheRead: 0, cacheWrite: 0, output: 30, costUsd: 0.012 },
  ] as unknown as Entry[];
  const call = snapshotFromEntries("w", entries).calls[0]!;
  assert.equal(call.exact?.requests.length, 1, "the usage of a rebuilt call is recorded too");
  assert.equal(exactLine(call.exact), "exact: rebuilt (no-capture) · $0.012");
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

// ---------------------------------------------------------------------------------------------------------------------
// The executor: an exact call launches on the captured model and refuses a call that names one.
// ---------------------------------------------------------------------------------------------------------------------
const agent = { name: "test", description: "test", body: "test", model: "probe/scripted", sourcePath: "/fixture/test.md",
  source: "project" as const, systemPromptMode: "replace" as const, inheritProjectContext: false, inheritSkills: false };
const effects = { prepare: async (t: CallTicket) => ({ cwd: t.cwd }), beforeSeal: async (_t: CallTicket, _e: string, r: never) => r,
  afterSeal: async () => {}, recover: async () => {} };

async function executorFixture(t: any, options: { spec: Record<string, unknown>; capture?: { path: string; facts: Record<string, unknown> };
  config?: Record<string, unknown>; child?: "report" | "mismatch" | "rebuilt" }) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dsa-exact-exec-"))), wid = ulid();
  const orch = await openJournal(orchLedger(home)), journal = await openJournal(journalPath(home, wid));
  const call = `${wid}@1/a@1`, session = callSession(home, wid, "a", 1);
  await mkdir(callDir(home, wid, "a", 1), { recursive: true });
  await journal.append("call", { key: "a", gen: 1, spec: { agent: "test", task: "task", ...options.spec } });
  const launches: SpawnSpec[] = [], receipts: string[] = [];
  // The child's receipts go to stdout as well as to the session: capture them instead of writing them into the report.
  t.mock.method(fs, "writeSync", ((_fd: number, chunk: string) => { receipts.push(chunk); return chunk.length; }) as never);
  const lines = (rows: unknown[]) => rows.map(l => JSON.stringify(l)).join("\n") + "\n";
  const containment: Containment = {
    async spawn(spec: SpawnSpec) {
      launches.push(spec);
      const rows: unknown[] = [{ type: "custom", customType: CT.exec, data: { exec: spec.exec } }];
      if (options.child === "mismatch" || options.child === "rebuilt") {
        // The real child: its receipt is written by the child's own code, in the shape it has in the session.
        const before = process.env[ENV.exec];
        process.env[ENV.exec] = spec.exec;
        const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>(), entries: unknown[] = [];
        registerExactChild({ on: (name: string, fn: unknown) => hooks.set(name, fn as never),
          appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
          getActiveTools: () => ["bash", "ask"] } as never, { capture: Promise.resolve(capture()), allow: ["bash", "ask"] });
        if (options.child === "mismatch") await hooks.get("context")!({ type: "context" },
          { model: { provider: "other", id: "other", api: "anthropic-messages" }, abort() {} } as never);
        else await hooks.get("message_end")!({ message: { role: "assistant" } }, {} as never);
        process.env[ENV.exec] = before;
        rows.push(...entries);
      } else rows.push({ type: "custom", customType: CT.report, data: { exec: spec.exec, outcome: "ok", data: {} } });
      await writeFile(session, lines(rows));
      const stdout = new PassThrough(), stderr = new PassThrough();
      stdout.end('{"type":"agent_settled"}\n'); stderr.end();
      return { pid: 0, start: "", stdin: new PassThrough(), stdout, stderr, exited: Promise.resolve({ code: 0, signal: null }) };
    },
    async scan(known: ReadonlyMap<string, readonly any[]>) { return new Map([...known.keys()].map(exec => [exec, []])); },
    async fence() {},
  };
  const executor = createExecutor({ home, orch, config: { k: { trackerMs: 20 }, writerLock: "off", ...(options.config ?? {}) } },
    { effects, containment, memory: async () => 1e6, sweepMs: 60000 });
  t.after(async () => { try { await executor.shutdown(); } finally { await journal.close(); await orch.close(); await rm(home, { recursive: true, force: true }); } });
  const ticket: CallTicket = { wid, widRev: `${wid}@1`, key: "a", gen: 1, callId: call, cwd: home, journal,
    spec: { agent: "test", task: "task", ...options.spec } as never, agent,
    ...(options.capture ? { exactCapture: { path: options.capture.path, facts: options.capture.facts } } : {}) } as CallTicket;
  return { executor, journal, launches, receipts, ticket, home, call };
}

test("EX3 an exact call launches on the captured model and hands the child the pinned capture", { timeout: 15000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-exact-exec-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const pinned = join(home, "exact.json");
  await writeFile(pinned, JSON.stringify(capture()));
  const facts = { sha256: "a".repeat(64), bytes: 10, at: Date.now(), provider: "qa", model: "m", api: "anthropic-messages" };
  const f = await executorFixture(t, { spec: { context: "exact" }, capture: { path: pinned, facts }, config: { providers: { qa: { slots: 2 } } } });
  await f.executor.recover((f.ticket as CallTicket).wid, f.journal);
  await f.executor.run(f.ticket);
  assert.equal(f.launches.length, 1, "the exact call launches a child");
  const args = f.launches[0]!.args;
  assert.ok(args.includes("--model"), "the child runs on the captured model");
  assert.equal(args[args.indexOf("--model") + 1], "qa/m");
  assert.equal(f.launches[0]!.env?.DSA_EXACT_CAPTURE, pinned, "the child splices the pinned capture");
  assert.deepEqual(JSON.parse(f.launches[0]!.env?.DSA_EXACT_TOOLS ?? "[]"), ["read", "bash", "edit", "write", "ask"]);
  const mode = f.journal.entries().find(e => e.type === "exact-mode");
  assert.equal(mode?.mode, "exact", "the call is exact");
});

test("EX2 an exact call that names a model is refused before a child starts", { timeout: 15000 }, async t => {
  const f = await executorFixture(t, { spec: { context: "exact", model: "qa/m" } });
  await f.executor.recover((f.ticket as CallTicket).wid, f.journal);
  const result = await f.executor.run(f.ticket);
  assert.equal(result.status, "failed");
  assert.equal(result.error, 'context "exact" runs on the origin model; remove model');
  assert.equal(f.launches.length, 0, "no child starts");
});

test("EX4 an exact call whose child refused the request fails with the mismatch, not as a lost call", { timeout: 15000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-exact-exec-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const pinned = join(home, "exact.json");
  await writeFile(pinned, JSON.stringify(capture()));
  const facts = { sha256: "a".repeat(64), bytes: 10, at: Date.now(), provider: "qa", model: "m", api: "anthropic-messages" };
  const f = await executorFixture(t, { spec: { context: "exact" }, capture: { path: pinned, facts },
    config: { providers: { qa: { slots: 2 } } }, child: "mismatch" });
  await f.executor.recover((f.ticket as CallTicket).wid, f.journal);
  const result = await f.executor.run(f.ticket);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /^exact-mismatch: /, "the child's own receipt ends the call");
  assert.ok(!/lost/.test(result.error ?? ""), "the call is not lost: the receipt names its execution");
  const receipt = f.receipts.find(line => line.includes(CT.exactMismatch));
  assert.ok(receipt, "the child writes its receipt to stdout as well");
  const parsed = JSON.parse(receipt!) as { type: string; exec: string; error: string };
  assert.equal(parsed.exec, f.launches[0]!.exec, "the receipt names the execution");
});

test("EX5 an exact call whose transport never offered the payload hook is rebuilt as a fork", { timeout: 15000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-exact-exec-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const pinned = join(home, "exact.json");
  await writeFile(pinned, JSON.stringify(capture()));
  const facts = { sha256: "a".repeat(64), bytes: 10, at: Date.now(), provider: "qa", model: "m", api: "anthropic-messages" };
  const f = await executorFixture(t, { spec: { context: "exact" }, capture: { path: pinned, facts },
    config: { providers: { qa: { slots: 2 } } }, child: "rebuilt" });
  await f.executor.recover((f.ticket as CallTicket).wid, f.journal);
  await f.executor.run(f.ticket);
  const modes = f.journal.entries().filter(e => e.type === "exact-mode").map(e => (e as unknown as { mode: string }).mode);
  assert.deepEqual(modes, ["exact", "rebuilt"], "the call is rebuilt after the child's receipt");
  const rebuilt = f.journal.entries().findLast(e => e.type === "exact-mode" && (e as unknown as { mode: string }).mode === "rebuilt") as unknown as { reason?: string } | undefined;
  assert.equal(rebuilt?.reason, "no-payload-hook");
});
