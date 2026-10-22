import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { configHash, configProblem, orchestratorSettings } from "../../../src/orchestrator/config.ts";
import * as providers from "../../../src/orchestrator/providers.ts";
import createExecutor from "../../../src/orchestrator/executor/index.ts";
import { openJournal } from "../../../src/kernel/journal.ts";
import { ulid } from "../../../src/kernel/ids.ts";
import { callDir, callSession, journalPath, orchLedger } from "../../../src/paths.ts";
import { CT, JT, type Containment, type SpawnSpec } from "../../../src/types.ts";
import type { CallEffects, CallTicket, OrchestratorConfig } from "../../../src/orchestrator/contract.ts";

const quota = "\u989d\u5ea6\u5df2\u4f7f\u7528\u5b8c\u6bd5";
const receiptType = "dsa-exhausted-text";

test("XP1 config accepts regex strings, preserves absence and hashes configured patterns", () => {
  const old = { providers: { qa: { slots: 2 } } };
  assert.equal(configProblem(old), undefined);
  assert.deepEqual(orchestratorSettings(old), old);
  const next = { providers: { qa: { slots: 2, exhaustedPatterns: [quota, "quota.*used"] } } };
  assert.equal(configProblem(next), undefined);
  assert.notEqual(configHash(next), configHash(old));
  assert.equal(configProblem({ providers: { qa: { slots: 1, exhaustedPatterns: [] } } }), undefined);
});

for (const value of ["quota", [1], [null], ["["]]) test(`XP1 invalid patterns name the provider: ${JSON.stringify(value)}`, () => {
  assert.match(configProblem({ providers: { qa: { slots: 1, exhaustedPatterns: value } } }) ?? "", /providers\.qa\.exhaustedPatterns/);
});

test("XP1 matching is case insensitive, text-only, assistant-only and excludes every tool-call message", () => {
  assert.equal(typeof providers.exhaustedText, "function");
  const patterns = [new RegExp("quota.*used", "i"), new RegExp(quota, "i")];
  const answer = { role: "assistant", content: [{ type: "text", text: "QUOTA was USED" }] };
  assert.equal(providers.exhaustedText(answer, patterns), "QUOTA was USED");
  assert.equal(providers.exhaustedText({ role: "assistant", content: quota }, patterns), quota);
  assert.equal(providers.exhaustedText({ role: "assistant", content: [{ type: "text", text: "quota " }, { type: "text", text: "used" }] }, patterns), "quota used");
  assert.equal(providers.exhaustedText({ ...answer, role: "user" }, patterns), undefined);
  assert.equal(providers.exhaustedText({ ...answer, role: "toolResult" }, patterns), undefined);
  assert.equal(providers.exhaustedText({ ...answer, content: [...answer.content, { type: "toolCall", name: "bash" }] }, patterns), undefined);
  assert.equal(providers.exhaustedText({ ...answer, content: [{ type: "thinking", text: quota }] }, patterns), undefined);
  assert.equal(providers.exhaustedText({ ...answer, content: "ordinary answer" }, patterns), undefined);
  assert.equal(providers.exhaustedText(answer, []), undefined);
});

const lines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const effects: CallEffects = { prepare: async t => ({ cwd: t.cwd }), beforeSeal: async (_t, _exec, result) => result, afterSeal: async () => {}, recover: async () => {} };

async function recovered(t: TestContext, pool: boolean, otherExhausted = false) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dsa-exhausted-"))), wid = ulid();
  const orch = await openJournal(orchLedger(home)), journal = await openJournal(journalPath(home, wid));
  const call = `${wid}@1/a@1`, exec = `${call}#1.1`, session = callSession(home, wid, "a", 1);
  const config: OrchestratorConfig = { writerLock: "off", k: { trackerMs: 10 }, pools: { top: ["qa/m", "qb/m"] },
    providers: { qa: { slots: 1, exhaustedPatterns: [quota] }, qb: { slots: 1 } } };
  const spec = { agent: "test", task: "work", model: pool ? "top" : "qa/m", once: true };
  const agent = { name: "test", description: "test", body: "test", sourcePath: "/fixture/test.md", source: "project" as const,
    systemPromptMode: "replace" as const, inheritProjectContext: false, inheritSkills: false };
  await mkdir(callDir(home, wid, "a", 1), { recursive: true });
  await journal.append("call", { key: "a", gen: 1, pos: 0, spec });
  await journal.append(JT.exec, { call, exec });
  await journal.append("selected", { exec, model: { provider: "qa", id: "m" }, ...(pool ? { pool: "top" } : {}) });
  await journal.append("settled", { exec });
  // Recover the refusal even if the observer never saw it. Include apparent success to ensure receipt wins.
  const text = quota + "x".repeat(250);
  await writeFile(session, lines([
    { type: "custom", customType: CT.exec, data: { exec } },
    { type: "message", message: { role: "assistant", provider: "qa", model: "m", content: text, stopReason: "stop" } },
    { type: "custom", customType: receiptType, data: { exec, provider: "qa", text } },
  ]));
  if (otherExhausted) await orch.append("provider-exhausted", { provider: "qb", exec: "other", since: Date.now(), nextTry: Date.now() + 60000, error: "used" });
  const launches: SpawnSpec[] = [];
  const containment: Containment = {
    async spawn(s) {
      launches.push(s);
      await appendFile(session, lines([
        { type: "custom", customType: CT.exec, data: { exec: s.exec } },
        { type: "message", message: { role: "assistant", provider: "qb", model: "m", content: "second answer", stopReason: "stop" } },
      ]));
      const stdout = new PassThrough(), stderr = new PassThrough(); stdout.end('{"type":"agent_settled"}\n'); stderr.end();
      return { pid: 0, start: "", stdin: new PassThrough(), stdout, stderr, exited: Promise.resolve({ code: 0, signal: null }) };
    },
    async scan(known) { return new Map([...known.keys()].map(id => [id, []])); }, async fence() {},
  };
  const executor = createExecutor({ home, orch, config }, { effects, containment, memory: async () => 1e6, sweepMs: 60000 });
  t.after(async () => { try { await executor.shutdown(); } finally { await journal.close(); await orch.close(); await rm(home, { recursive: true, force: true }); } });
  const ticket: CallTicket = { wid, widRev: `${wid}@1`, key: "a", gen: 1, callId: call, cwd: home, journal, spec, agent };
  await executor.recover(wid, journal);
  const result = await executor.run(ticket);
  return { result, launches, orch, journal, text, exec };
}

test("XP1 recovery marks provider exhausted once and continues a once-call on its pool without loss", { timeout: 15000 }, async t => {
  const f = await recovered(t, true);
  assert.equal(f.result.status, "ok"); assert.equal(f.result.output, "second answer");
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0]!.env.DSA_MODEL, "qb/m");
  assert.deepEqual(JSON.parse(f.launches[0]!.env.DSA_EXHAUSTED_PATTERNS!), { qa: [quota] });
  const exhausted = f.orch.entries().filter(e => e.type === "provider-exhausted" && e.provider === "qa");
  assert.equal(exhausted.length, 1); assert.equal(exhausted[0]!.error, f.text.slice(0, 200));
  assert.ok(Number(exhausted[0]!.nextTry) > Number(exhausted[0]!.since));
  assert.equal(f.journal.entries().filter(e => e.type === "loss").length, 0);
});

for (const pool of [false, true]) test(`XP1 no remaining model fails model-unavailable with bounded text (pool=${pool})`, { timeout: 15000 }, async t => {
  const f = await recovered(t, pool, pool);
  assert.equal(f.result.status, "failed"); assert.equal(f.result.output, "");
  assert.equal(f.result.error, `model-unavailable: ${f.text.slice(0, 200)}`);
  assert.equal(f.launches.length, 0);
  assert.equal(f.orch.entries().filter(e => e.type === "provider-exhausted" && e.provider === "qa").length, 1);
});
