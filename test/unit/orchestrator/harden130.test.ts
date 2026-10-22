// 1.3 hardening: the four review findings deferred from the 1.3 leaves.
//   H1: a pool that does not resolve (a cycle, an empty list) seals its call failed with a clear error naming the
//       pool; the error never leaves the executor and never affects another call.
//   H2: XP1 pins the pool step: a pool whose next model sits on a used-up provider fails the call at once with
//       `model-unavailable:` and the matched text (the quota path waits for that provider's probe instead).
//   H3: an invalid exhausted pattern is rejected at config load (the provider is named) and is never compiled or
//       applied in the child: the child skips it without throwing.
//   H4: the origin pin drops a dsa receipt on every branch (one shared predicate).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import { openJournal } from "../../../src/kernel/journal.ts";
import { publishRequest } from "../../../src/kernel/mailbox.ts";
import { ulid } from "../../../src/kernel/ids.ts";
import { callDir, callSession, journalPath, orchLedger } from "../../../src/paths.ts";
import { CT, JT, type Containment, type SpawnSpec } from "../../../src/types.ts";
import type { CallEffects, CallTicket, OrchestratorConfig } from "../../../src/orchestrator/contract.ts";
import createExecutor from "../../../src/orchestrator/executor/index.ts";
import { configProblem } from "../../../src/orchestrator/config.ts";
import { exhaustedPatterns } from "../../../src/orchestrator/providers.ts";
import { effectiveBranch, forkEntry, type OriginEntry } from "../../../src/orchestrator/origin.ts";
import { registerChild } from "../../../src/agent/child.ts";

const quota = "\u989d\u5ea6\u5df2\u4f7f\u7528\u5b8c\u6bd5";
const lines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const effects: CallEffects = {
  prepare: async t => ({ cwd: t.cwd }), beforeSeal: async (_t, _e, result) => result,
  afterSeal: async () => {}, recover: async () => {},
};
const agent = {
  name: "test", description: "test", body: "test", sourcePath: "/fixture/test.md", source: "project" as const,
  systemPromptMode: "replace" as const, inheritProjectContext: false, inheritSkills: false,
};

/** An executor over a fake child: the child answers on the session of the call it was launched for. */
async function executor(t: TestContext, config: OrchestratorConfig) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dsa-harden-"))), wid = ulid();
  const orch = await openJournal(orchLedger(home)), journal = await openJournal(journalPath(home, wid));
  const launches: SpawnSpec[] = [];
  const containment: Containment = {
    async spawn(s) {
      launches.push(s);
      const key = String(s.env?.DSA_CALL ?? "").split("/")[1]?.split("@")[0] ?? "a";
      await appendFile(callSession(home, wid, key, 1), lines([
        { type: "custom", customType: CT.exec, data: { exec: s.exec } },
        { type: "message", message: { role: "assistant", provider: "qa", model: "m", content: "answered", stopReason: "stop" } },
      ]));
      const stdout = new PassThrough(), stderr = new PassThrough();
      stdout.end('{"type":"agent_settled"}\n'); stderr.end();
      return { pid: 0, start: "", stdin: new PassThrough(), stdout, stderr, exited: Promise.resolve({ code: 0, signal: null }) };
    },
    async scan(known) { return new Map([...known.keys()].map(id => [id, []])); }, async fence() {},
  };
  const ex = createExecutor({ home, orch, config }, { effects, containment, memory: async () => 1e6, sweepMs: 60000 });
  t.after(async () => {
    try { await ex.shutdown(); } finally { await journal.close(); await orch.close(); await rm(home, { recursive: true, force: true }); }
  });
  const ticket = (key: string, model: string): CallTicket => ({
    wid, widRev: `${wid}@1`, key, gen: 1, callId: `${wid}@1/${key}@1`, cwd: home, journal,
    spec: { agent: "test", task: "work", model, once: true }, agent,
  });
  return { home, wid, orch, journal, executor: ex, launches, ticket };
}

test("H1 a pool that does not resolve seals its call failed with a clear error naming the pool", { timeout: 20000 }, async t => {
  const f = await executor(t, { writerLock: "off", k: { trackerMs: 10 }, pools: { top: ["qa/m", "top"] }, providers: { qa: { slots: 1 } } });
  await mkdir(callDir(f.home, f.wid, "a", 1), { recursive: true });
  await f.journal.append("call", { key: "a", gen: 1, pos: 0, spec: { agent: "test", task: "work", model: "top", once: true } });
  const result = await f.executor.run(f.ticket("a", "top"));
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.match(String(result.error), /model-unavailable/, "the failure names the model that is not available");
  assert.match(String(result.error), /pool "top"/, "the failure names the pool");
  assert.match(String(result.error), /does not resolve/);
  assert.match(String(result.error), /Cyclic model pool/);
  assert.equal(f.launches.length, 0, "no child is launched for a pool that does not resolve");
  // The executor keeps serving the other calls.
  await mkdir(callDir(f.home, f.wid, "b", 1), { recursive: true });
  await f.journal.append("call", { key: "b", gen: 1, pos: 1, spec: { agent: "test", task: "work", model: "qa/m", once: true } });
  const other = await f.executor.run(f.ticket("b", "qa/m"));
  assert.equal(other.status, "ok", JSON.stringify(other));
});

test("H1 a pool that stops resolving mid-call seals the call failed instead of throwing out of the executor", { timeout: 20000 }, async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dsa-harden-"))), wid = ulid();
  const orch = await openJournal(orchLedger(home)), journal = await openJournal(journalPath(home, wid));
  const call = `${wid}@1/a@1`, exec = `${call}#1.1`, session = callSession(home, wid, "a", 1);
  // The pool resolved when the call was launched and cycles now: the pool step must not throw out of the executor.
  const config: OrchestratorConfig = { writerLock: "off", k: { trackerMs: 10 }, pools: { top: ["qa/m", "top"] }, providers: { qa: { slots: 1, exhaustedPatterns: [quota] } } };
  await mkdir(callDir(home, wid, "a", 1), { recursive: true });
  await journal.append("call", { key: "a", gen: 1, pos: 0, spec: { agent: "test", task: "work", model: "top", once: true } });
  await journal.append(JT.exec, { call, exec });
  await journal.append("selected", { exec, model: { provider: "qa", id: "m" }, pool: "top" });
  await journal.append("settled", { exec });
  const text = quota + "x".repeat(250);
  await writeFile(session, lines([
    { type: "custom", customType: CT.exec, data: { exec } },
    { type: "message", message: { role: "assistant", provider: "qa", model: "m", content: text, stopReason: "stop" } },
    { type: "custom", customType: CT.exhausted, data: { exec, provider: "qa", text } },
  ]));
  const containment: Containment = {
    async spawn() { throw new Error("no child may be launched"); },
    async scan(known) { return new Map([...known.keys()].map(id => [id, []])); }, async fence() {},
  };
  const ex = createExecutor({ home, orch, config }, { effects, containment, memory: async () => 1e6, sweepMs: 60000 });
  t.after(async () => {
    try { await ex.shutdown(); } finally { await journal.close(); await orch.close(); await rm(home, { recursive: true, force: true }); }
  });
  const ticket: CallTicket = {
    wid, widRev: `${wid}@1`, key: "a", gen: 1, callId: call, cwd: home, journal,
    spec: { agent: "test", task: "work", model: "top", once: true }, agent,
  };
  const result = await ex.run(ticket);
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.match(String(result.error), /pool "top"/);
  assert.match(String(result.error), /does not resolve/);
  assert.match(String(result.error), /quota notice/, "the notice the provider answered with is reported too");
  assert.match(String(result.error), new RegExp(text.slice(0, 40)), "the matched text is reported");
});

test("H2 a pool whose next model sits on a used-up provider fails the call at once with model-unavailable", { timeout: 20000 }, async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dsa-harden-"))), wid = ulid();
  const orch = await openJournal(orchLedger(home)), journal = await openJournal(journalPath(home, wid));
  const call = `${wid}@1/a@1`, exec = `${call}#1.1`, session = callSession(home, wid, "a", 1);
  const config: OrchestratorConfig = { writerLock: "off", k: { trackerMs: 10 }, pools: { top: ["qa/m", "qb/m"] },
    providers: { qa: { slots: 1, exhaustedPatterns: [quota] }, qb: { slots: 1 } } };
  await mkdir(callDir(home, wid, "a", 1), { recursive: true });
  await journal.append("call", { key: "a", gen: 1, pos: 0, spec: { agent: "test", task: "work", model: "top", once: true } });
  await journal.append(JT.exec, { call, exec });
  await journal.append("selected", { exec, model: { provider: "qa", id: "m" }, pool: "top" });
  await journal.append("settled", { exec });
  const text = quota + "y".repeat(250);
  await writeFile(session, lines([
    { type: "custom", customType: CT.exec, data: { exec } },
    { type: "message", message: { role: "assistant", provider: "qa", model: "m", content: text, stopReason: "stop" } },
    { type: "custom", customType: CT.exhausted, data: { exec, provider: "qa", text } },
  ]));
  // The pool's next model sits on a provider whose window is used up: the call fails at once, it does not wait.
  await orch.append("provider-exhausted", { provider: "qb", exec: "other", since: Date.now(), nextTry: Date.now() + 600000, error: "used" });
  const launches: SpawnSpec[] = [];
  const containment: Containment = {
    async spawn(s) { launches.push(s); throw new Error("no child may be launched"); },
    async scan(known) { return new Map([...known.keys()].map(id => [id, []])); }, async fence() {},
  };
  const ex = createExecutor({ home, orch, config }, { effects, containment, memory: async () => 1e6, sweepMs: 60000 });
  t.after(async () => {
    try { await ex.shutdown(); } finally { await journal.close(); await orch.close(); await rm(home, { recursive: true, force: true }); }
  });
  const ticket: CallTicket = {
    wid, widRev: `${wid}@1`, key: "a", gen: 1, callId: call, cwd: home, journal,
    spec: { agent: "test", task: "work", model: "top", once: true }, agent,
  };
  const result = await ex.run(ticket);
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(result.error, `model-unavailable: ${text.slice(0, 200)}`, "the matched text, clipped to 200 characters");
  assert.equal(launches.length, 0, "the call does not wait for the used-up provider's probe");
  const exhausted = orch.entries().filter(e => e.type === "provider-exhausted" && e.provider === "qa");
  assert.equal(exhausted.length, 1);
  assert.ok(Number(exhausted[0]!.nextTry) > Date.now(), "the provider itself is avoided until its probe, as a quota error does");
});

test("H3 an invalid exhausted pattern is rejected at config load, never handed to a child and skipped by the child", async t => {
  // The config load names the provider.
  assert.match(configProblem({ providers: { qa: { slots: 1, exhaustedPatterns: ["["] } } }) ?? "", /providers\.qa\.exhaustedPatterns/);
  // The orchestrator hands a child only the patterns that compile.
  assert.deepEqual(exhaustedPatterns({ qa: { slots: 1, exhaustedPatterns: ["[", quota] } }), { qa: [quota] });
  // The child skips an invalid pattern without throwing and keeps the valid one working.
  const home = await mkdtemp(join(tmpdir(), "dsa-harden-child-")), inbox = join(home, "inbox"), path = join(home, "journal");
  await mkdir(inbox);
  const log = await openJournal(path); await log.append("exec", { call: "call", exec: "call#1.1" }); await log.close();
  const env: Record<string, string> = { DSA_EXEC: "call#1.1", DSA_CALL: "call", DSA_INBOX: inbox, DSA_JOURNAL: path, DSA_MODEL: "p/m",
    DSA_EXHAUSTED_PATTERNS: JSON.stringify({ p: ["[", quota] }) };
  const keys = [...Object.keys(env), "DSA_BUDGET", "DSA_SCHEMA"], before = { ...process.env };
  for (const key of ["DSA_BUDGET", "DSA_SCHEMA", "DSA_EXHAUSTED_PATTERNS"]) delete process.env[key];
  Object.assign(process.env, env);
  const hooks = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>(), history: any[] = [];
  const model = { provider: "p", id: "m", name: "m" };
  const ctx = { model, isIdle: () => true, shutdown() {}, sessionManager: { getEntries: () => history, getSessionFile: () => undefined },
    modelRegistry: { refresh: async () => ({ aborted: false, errors: new Map() }), find: () => model, getAll: () => [model] } };
  t.mock.method(fs, "writeSync", (_fd: number, chunk: string) => chunk.length);
  t.mock.method(process.stdout, "write", () => true);
  t.mock.method(console, "error", () => {});
  registerChild({ on: (name: string, fn: any) => hooks.set(name, [...hooks.get(name) ?? [], fn]), registerTool() {},
    appendEntry: (customType: string, data: unknown) => history.push({ type: "custom", customType, data }),
    sendMessage() {}, setModel: async () => true } as unknown as Parameters<typeof registerChild>[0]);
  t.after(async () => {
    for (const fn of hooks.get("session_shutdown") ?? []) await fn({}, ctx);
    for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
    await rm(home, { recursive: true, force: true });
  });
  await publishRequest(inbox, { rid: "task", from: "orch", to: "call", kind: "task", sseq: 1, body: { message: "work" } });
  for (const fn of hooks.get("session_start") ?? []) await fn({}, ctx);
  const fire = async (name: string, event: unknown) => { const out = []; for (const fn of hooks.get(name) ?? []) out.push(await fn(event, ctx)); return out.filter(r => r !== undefined); };
  const answer = { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: `${quota} now` }], stopReason: "stop" };
  const [replaced] = await fire("message_end", { type: "message_end", message: answer }) as { message: any }[];
  assert.deepEqual([replaced!.message.content, replaced!.message.stopReason], [[], "aborted"], "the valid pattern still refuses the quota answer");
  assert.deepEqual(history.filter(e => e.customType === CT.exhausted).map(e => e.data), [{ exec: "call#1.1", provider: "p", text: `${quota} now` }]);
});

test("H4 the origin pin drops a dsa receipt on every branch (one shared predicate)", () => {
  // A message entry that carries a dsa custom type at the entry level is a receipt everywhere.
  const entry: OriginEntry = { type: "message", id: "r", customType: "dsa-note", message: { role: "assistant" } };
  assert.equal(forkEntry(entry), false, "the fork session publication drops it");
  assert.deepEqual(effectiveBranch([entry]), [], "an uncompacted branch does not pin it");
  assert.deepEqual(effectiveBranch([{ type: "compaction", id: "c", firstKeptEntryId: "r" }, entry]).map(e => e.id), ["c"],
    "a compacted branch does not pin it either");
  // An ordinary message is still pinned.
  const plain: OriginEntry = { type: "message", id: "m", message: { role: "user" } };
  assert.equal(forkEntry(plain), true);
  assert.deepEqual(effectiveBranch([plain]).map(e => e.id), ["m"]);
});
