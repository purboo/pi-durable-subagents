import { test } from "node:test";
import assert from "node:assert/strict";
import { ActiveTime, activeTotal } from "../../../../src/orchestrator/executor/time.ts";
import { observation, messageUsage, totalUsage, reached } from "../../../../src/orchestrator/executor/usage.ts";
import { evidence } from "../../../../src/orchestrator/executor/session.ts";
import { CT, type Containment, type SpawnSpec } from "../../../../src/types.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { binDir, callDir, callSession, journalPath, orchLedger } from "../../../../src/paths.ts";
import type { CallTicket } from "../../../../src/orchestrator/contract.ts";
import createExecutor from "../../../../src/orchestrator/executor/index.ts";
import * as commands from "../../../../src/orchestrator/executor/command.ts";

test("P18 CPU progress advances an open silent tool; ask and unobserved tail never charge", () => {
  const clock = new ActiveTime(0);
  clock.event({ type: "tool_execution_start", toolCallId: "bash", toolName: "bash" }, 10);
  clock.scan([{ pid: 1, ppid: 0, start: "a", cpuMs: 10 }], 100);
  assert.equal(clock.active, 100);
  clock.scan([{ pid: 1, ppid: 0, start: "a", cpuMs: 10 }], 1000);
  assert.equal(clock.active, 100);
  clock.event({ type: "tool_execution_start", toolCallId: "ask", toolName: "ask" }, 1100);
  clock.scan([{ pid: 1, ppid: 0, start: "a", cpuMs: 500 }], 2000);
  clock.evidence(3000);
  clock.event({ type: "tool_execution_end", toolCallId: "ask" }, 4000);
  assert.equal(clock.active, 1100);
  clock.evidence(4100); assert.equal(clock.active, 1200);
  clock.evidence(4000); assert.equal(clock.active, 1200);
});

test("P18 recovery sums only last durable checkpoint of each execution", () => {
  const entries = [
    { exec: "c#1.1", active: 100 }, { exec: "c#1.1", active: 200 }, { exec: "c#1.2", active: 40 }, { exec: "other#1.1", active: 999 },
  ].map((e, seq) => ({ ...e, seq, ts: 0, type: "time" }));
  assert.equal(activeTotal(entries, "c"), 240);
});

test("P31 observations discard updates, arguments, text and tool results", () => {
  assert.equal(observation({ type: "tool_execution_update", partialResult: "secret" }), undefined);
  assert.deepEqual(observation({ type: "tool_execution_end", toolCallId: "t", toolName: "bash", result: "secret" }), { type: "tool_execution_end", toolCallId: "t", toolName: "bash" });
  assert.deepEqual(observation({ type: "message_start", message: { provider: "p", model: "m", content: "secret" } }), { type: "message_start", provider: "p", model: "m" });
  const m = { role: "assistant", id: "one", content: "secret", usage: { input: 1, output: 2, cacheRead: 3, cost: { total: 0.5 } } };
  assert.deepEqual(observation({ type: "message_end", message: m }), { type: "message_end", id: "one", usage: { input: 4, output: 2, costUsd: 0.5 } });
  const u = messageUsage(m)!;
  const entries = ["a", "a", "b"].map((call, seq) => ({ seq, ts: 0, type: "usage", call, ...u }));
  assert.equal(totalUsage(entries).input, 8);
  assert.equal(totalUsage(entries, "a").output, 2);
  assert.ok(reached(totalUsage(entries), { tokens: 12 }));
  assert.ok(!reached(totalUsage(entries), { tokens: 13 }));
  assert.ok(reached(totalUsage(entries), { costUsd: 1 }));
});

test("P31 child budget receipt belongs only to the current execution", () => {
  const entries = [{ type: "custom", customType: CT.exec, data: { exec: "old" } },
    { type: "custom", customType: CT.budget, data: { exec: "old" } },
    { type: "custom", customType: CT.exec, data: { exec: "new" } }];
  assert.equal(evidence(entries, "new").budget, false);
  entries.push({ type: "custom", customType: CT.budget, data: { exec: "new" } });
  assert.equal(evidence(entries, "new").budget, true);
});

// EX2 text is pinned independently of the implementation, including whitespace and punctuation.
const lifecycleNote = `Processes you start end when your turn ends: dsa stops every process of this call when it seals.
To run something that must outlive your turn (a long build, test suite or measurement), start it as a durable command call and end your turn:
  pi-durable-subagents run --request <unique id> --wake caller -- <program> [args…]
It keeps running after your turn; when it finishes you get a follow-up with its exit status and output tail.`;

for (const mode of ["append", "replace"] as const) test(`EX2 derived system.txt ends with the lifecycle note in ${mode} mode; pinned agent stays intact`, async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-lifecycle-")), wid = "life", body = "Pinned agent instructions\n";
  const orch = await openJournal(orchLedger(home)), journal = await openJournal(journalPath(home, wid));
  let launch: SpawnSpec | undefined;
  const containment: Containment = {
    async spawn(spec) {
      launch = spec;
      assert.equal(await readFile(join(callDir(home, wid, "a", 1), "system.txt"), "utf8"), `${body}\n\n${lifecycleNote}`);
      await writeFile(callSession(home, wid, "a", 1), [
        { type: "custom", customType: CT.exec, data: { exec: spec.exec } },
        { type: "custom", customType: CT.report, data: { exec: spec.exec, outcome: "ok" } },
      ].map(e => JSON.stringify(e)).join("\n") + "\n");
      const stdout = new PassThrough(), stderr = new PassThrough(); stdout.end('{"type":"agent_settled"}\n'); stderr.end();
      return { pid: 900_001, start: "", stdin: new PassThrough(), stdout, stderr, exited: Promise.resolve({ code: 0, signal: null }) };
    },
    scan: async known => new Map([...known.keys()].map(exec => [exec, []])), fence: async () => {},
  };
  const executor = createExecutor({ home, orch, config: { writerLock: "off", k: { trackerMs: 20 } } }, { containment, memory: async () => 1e6 });
  t.after(async () => { await executor.shutdown(); await journal.close(); await orch.close(); await rm(home, { recursive: true, force: true }); });
  const agent = Object.freeze({ name: "test", description: "", body, model: "probe/scripted", sourcePath: "/fixture/test.md", source: "project" as const,
    systemPromptMode: mode, inheritProjectContext: false, inheritSkills: false });
  const ticket: CallTicket = { wid, widRev: `${wid}@1`, key: "a", gen: 1, callId: `${wid}@1/a@1`, cwd: home, journal, spec: { agent: "test", task: "task" }, agent };
  assert.equal((await executor.run(ticket)).status, "ok");
  assert.equal(agent.body, body);
  assert.ok(journal.entries().some(e => e.type === "tracked" && e.pid === 900_001 && e.start === "" && e.child === true), "direct identity is durable even when it exited before start capture");
  assert.ok(launch!.args.includes(mode === "append" ? "--append-system-prompt" : "--system-prompt"));
  assert.equal(String(launch!.env.PATH).split(delimiter)[0], binDir(home), "agent PATH remains shim-first");
});

for (const scenario of ["custom", "inherited", "empty", "unset", "duplicate", "already-last"] as const) test(`EX3 command PATH ${scenario}: merged environment then shim last, no empty or duplicate entries`, t => {
  const home = join(tmpdir(), "dsa-path"), bin = binDir(home);
  const inherited = ["/orchestrator/a", "/orchestrator/b"].join(delimiter);
  const env: Record<string, string> = { EX3: "custom" };
  if (scenario === "custom") env.PATH = ["/custom/a", "/custom/b"].join(delimiter);
  if (scenario === "empty") env.PATH = "";
  if (scenario === "duplicate") env.PATH = [bin, "/custom", "", bin].join(delimiter);
  if (scenario === "already-last") env.PATH = ["/custom", bin].join(delimiter);
  const old = process.env.PATH;
  t.after(() => { if (old === undefined) delete process.env.PATH; else process.env.PATH = old; });
  if (scenario === "unset") delete process.env.PATH; else process.env.PATH = inherited;
  // Baseline graft: 1.0.45 merges env but has no shim-aware helper; exercise that old environment contract.
  const result = commands.commandEnvironment?.(home, "command:c#1", "c", env)
    ?? { ...process.env, ...env, DSA_HOME: home, DSA_EXEC: "command:c#1", DSA_CALL: "c" };
  const paths = String(result.PATH ?? "").split(delimiter);
  const expected = scenario === "custom" ? ["/custom/a", "/custom/b", bin] : scenario === "inherited" ? ["/orchestrator/a", "/orchestrator/b", bin]
    : scenario === "empty" || scenario === "unset" ? [bin] : ["/custom", bin];
  assert.deepEqual(paths, expected); assert.equal(paths.filter(p => p === bin).length, 1); assert.ok(!paths.includes(""));
  assert.equal(result.EX3, "custom"); assert.equal(result.DSA_HOME, home); assert.equal(result.DSA_EXEC, "command:c#1"); assert.equal(result.DSA_CALL, "c");
  assert.equal(env.EX3, "custom", "spec env not mutated");
});
