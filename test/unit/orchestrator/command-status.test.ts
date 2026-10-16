// Status, describe and UI of command calls, from constructed journal records (command-intent / command-started / sealed):
// a running one shows its command, pid and elapsed time instead of a model; a finished one its status and exit code.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal } from "../../../src/kernel/journal.ts";
import { journalPath, orchLedger } from "../../../src/paths.ts";
import { commandText, compactWorkflow, queueWait, snapshotFromEntries, statusBrief, statusCompactDetail, statusView, workflowSnapshot, type CallSnapshot } from "../../../src/orchestrator/snapshot.ts";
import { emptyLedger, foldLedger } from "../../../src/orchestrator/ledger.ts";
import { renderStatus, renderView } from "../../../src/cli/main.ts";
import { describe, renderDescription } from "../../../src/cli/requests.ts";
import { foldWaits, waitsOf } from "../../../src/events/waiting.ts";
import { callLine, resultLines } from "../../../src/ui/tool.ts";
import { callName, dockLines, listRows, statusPhrase } from "../../../src/ui/view.ts";
import { JT, type Entry } from "../../../src/types.ts";

const { commandHead, commandTranscript } = await import("../../../src/ui/screen.ts");
const W = "01CMD";
const spec = { held: { command: ["sleep", "100"] }, done: { command: "make test; exit 3" }, wait: { command: ["npm", "run", "a b"], writer: true }, rerun: { command: ["true"], rerun: true } };
const id = (key: string, n = 1) => `command:${W}@1/${key}@1#${n}`;
/** Workflow journal records as the executor writes them (fields of the pinned contract); `at` offsets the timestamps. */
function records(dir: string): [number, string, Record<string, unknown>][] {
  return [
    [0, "wf-created", { revision: 1, origin: "main:me", cwd: "/w" }],
    [0, "call", { pos: 0, key: "held", gen: 1, spec: spec.held }],
    [1, "command-intent", { call: `${W}@1/held@1`, id: id("held"), n: 1 }],
    [2, "command-started", { id: id("held"), pid: 4242, start: "123", dir: join(dir, "held") }],
    [0, "call", { pos: 1, key: "done", gen: 1, spec: spec.done }],
    [1, "command-intent", { call: `${W}@1/done@1`, id: id("done"), n: 1 }],
    [2, "command-started", { id: id("done"), pid: 4343, start: "124", dir: join(dir, "done") }],
    [3, JT.sealed, { call: `${W}@1/done@1`, result: { key: "done", gen: 1, status: "failed", ok: false, error: "Command exited 3", output: "build ok\n3 tests failed\n",
      data: { exitCode: 3, signal: null, durationMs: 41_000 }, usage: { input: 0, output: 0, costUsd: 0 } } }],
    [0, "call", { pos: 2, key: "wait", gen: 1, spec: spec.wait }],
    [1, "writer-wait", { call: `${W}@1/wait@1`, root: "/w", holder: `${W}@1/held@1` }],
    [0, "call", { pos: 3, key: "rerun", gen: 1, spec: spec.rerun }],
    [1, "command-intent", { call: `${W}@1/rerun@1`, id: id("rerun"), n: 1 }],
    [1, "command-started", { id: id("rerun"), pid: 5000, start: "1", dir: join(dir, "rerun1") }],
    [2, "command-intent", { call: `${W}@1/rerun@1`, id: id("rerun", 2), n: 2 }],
    [3, "command-started", { id: id("rerun", 2), pid: 5001, start: "2", dir: join(dir, "rerun2") }],
  ];
}
const entries = (dir: string, base: number): Entry[] => records(dir).map(([at, type, fields], i) => ({ seq: i + 1, ts: base + at * 1000, type, ...fields }) as Entry);

test("snapshot: a command call runs from its intent, with pid, attempt and log from its latest start; no model or exec", () => {
  const base = 1_800_000_000_000, wf = snapshotFromEntries(W, entries("/a", base));
  const by = Object.fromEntries(wf.calls.map(c => [c.key, c])) as Record<string, CallSnapshot>;
  assert.deepEqual([by.held!.phase, by.held!.command, by.held!.agent, by.held!.model, by.held!.exec], ["running", "sleep 100", "", undefined, undefined]);
  assert.deepEqual(by.held!.commandRun, { attempt: 1, id: id("held"), pid: 4242, log: "/a/held/output.log" });
  assert.equal(by.held!.startedAt, base + 2000, "elapsed counts from command-started");
  assert.deepEqual([by.done!.phase, by.done!.result?.status, (by.done!.result?.data as { exitCode: number }).exitCode], ["sealed", "failed", 3]);
  assert.deepEqual([by.wait!.phase, by.wait!.command, by.wait!.writerWait], ["queued", "npm run 'a b'", { root: "/w", holder: `${W}/held` }]);
  assert.deepEqual(by.rerun!.commandRun, { attempt: 2, id: id("rerun", 2), pid: 5001, log: "/a/rerun2/output.log" });
  assert.equal(by.rerun!.startedAt, base + 3000);
  assert.deepEqual(wf.counts, { queued: 1, running: 2, asking: 0, sealed: 1 });
  assert.equal(commandText(["a", "it's", "$x", "-k=v"]), `a 'it'\\''s' '$x' -k=v`);
  // Compact status: the command in place of a model, the pid while it runs, the exit code after the seal.
  const compact = Object.fromEntries(compactWorkflow(wf).calls.map(c => [c.key, c]));
  assert.equal(compact.held!.command, "sleep 100"); assert.equal(compact.held!.pid, 4242); assert.equal(compact.held!.model, undefined);
  assert.deepEqual([compact.done!.status, compact.done!.exitCode, compact.done!.pid, compact.done!.lastLine], ["failed", 3, undefined, "3 tests failed"]);
  assert.equal(compact.rerun!.attempt, 2);
  // A queued command call takes no slot: a full default provider is not its reason, a writer lock is.
  const state = foldLedger(emptyLedger(), [{ seq: 1, ts: base, type: "config", hash: "h", config: { defaultModel: "p/m", providers: { p: { slots: 0 } } } } as Entry]);
  assert.equal(queueWait({ ...by.wait!, writerWait: undefined } as CallSnapshot, state, base), undefined);
  assert.equal(queueWait({ key: "x", gen: 1, callId: "x", agent: "a", phase: "queued" }, state, base)?.reason, "slot", "an agent call still waits for the full provider");
  assert.equal(queueWait(by.wait!, state, base)?.reason, "writer-lock");
  // Waits: a command call queued behind a writer lock waits for it; a running one does not wait for a slot.
  const waits = waitsOf(foldWaits(W, entries("/a", base)), { now: base + 60_000, ledger: state });
  assert.deepEqual([...waits.keys()], [`${W}@1/wait@1`]);
  assert.equal(waits.get(`${W}@1/wait@1`)!.reason, "writer-lock");
});

test("status, describe and the tool's rendering of a running and a finished command call", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-command-status-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const ledger = await openJournal(orchLedger(home));
  await ledger.append(JT.created, { rid: "r1", wid: W, origin: "main:me" });
  await ledger.close();
  const journal = await openJournal(journalPath(home, W));
  for (const [, type, fields] of records(join(home, "runs"))) await journal.append(type, fields);
  await journal.close();
  const started = workflowSnapshot(home, W).calls.find(c => c.key === "held")!.startedAt!, now = started + 125_000;

  const brief = statusBrief(home, { origin: "main:me", now });
  const calls = Object.fromEntries(brief.active[0]!.calls.map(c => [c.key, c]));
  assert.deepEqual(calls.held, { key: "held", agent: "", phase: "running", command: "sleep 100", pid: 4242, for: "2m" });
  assert.deepEqual(calls.done, { key: "done", agent: "", phase: "sealed", command: "make test; exit 3", exitCode: 3, status: "failed", error: "Command exited 3" });
  assert.equal(calls.wait!.command, "npm run 'a b'"); assert.equal(calls.wait!.pid, undefined); assert.equal(calls.wait!.tokens, undefined);

  const view = renderView(statusView(home));
  assert.match(view, /\n {2}held@1 running command: sleep 100 \(pid 4242, \d+[smh]\)\n/);
  assert.match(view, /\n {2}done@1 failed command: make test; exit 3 \(exit 3\) "3 tests failed"\n/);
  assert.match(view, /\n {2}wait@1 queued command: npm run 'a b' \(waiting for writer lock: \/w held by 01CMD\/held\)/);
  assert.match(view, /\n {2}rerun@1 running command: true \(pid 5001, attempt 2, /);
  assert.match(renderStatus(workflowSnapshot(home, W)), /\n {2}held@1 running command: sleep 100 \(pid 4242, /);
  const detail = statusCompactDetail(home, W).calls.find(c => c.key === "done")!;
  assert.deepEqual([detail.command, detail.exitCode, detail.output], ["make test; exit 3", 3, "build ok\n3 tests failed"]);

  const d = await describe(home, { wid: W }, now);
  const described = Object.fromEntries(d.calls!.map(c => [c.key, c]));
  assert.deepEqual(described.held, { key: "held", gen: 1, phase: "running", agent: "", command: "sleep 100", attempt: 1, pid: 4242, elapsed: "2m05s", log: join(home, "runs/held/output.log") });
  assert.equal(described.done!.pid, undefined); assert.equal(described.done!.elapsed, undefined);
  assert.deepEqual([described.done!.status, described.done!.error, described.done!.data], ["failed", "Command exited 3", { exitCode: 3, signal: null, durationMs: 41_000 }]);
  assert.equal(described.wait!.waiting?.reason, "writer-lock");
  const text = renderDescription(d);
  assert.match(text, /\n {2}held@1 command running \(pid 4242, attempt 1, 2m05s\)\n {4}command: sleep 100\n {4}log: .*\/runs\/held\/output\.log\n/);
  assert.match(text, /\n {2}done@1 command sealed failed \(attempt 1\) — Command exited 3\n {4}command: make test; exit 3\n {4}log: .*\n {4}data: \{"exitCode":3,"signal":null,"durationMs":41000\}\n {4}\| build ok/);

  assert.equal(callLine({ action: "run", command: ["npm", "run", "a b"] }), "run command: npm run 'a b'");
  assert.equal(callLine({ action: "run", chain: [{ command: "make" }, { agent: "reviewer", task: "t" }] }), "run chain of 2 (command → reviewer)");
  assert.deepEqual(resultLines({ wid: W, key: "held", phase: "running", command: "sleep 100" }), ["held · running · command: sleep 100"]);
});

test("UI: rows, dock and watch view show the command, pid and elapsed time instead of a model", () => {
  const base = 1_800_000_000_000, wf = snapshotFromEntries(W, entries("/a", base)), now = base + 65_000;
  const held = wf.calls.find(c => c.key === "held")!, done = wf.calls.find(c => c.key === "done")!;
  const name = () => assert.fail("a command call names no model") as never;
  assert.equal(statusPhrase(held, wf, undefined, now), "running · pid 4242 · 1m03s");
  assert.equal(statusPhrase(wf.calls.find(c => c.key === "rerun")!, wf, undefined, now), "running · pid 5001 · attempt 2 · 1m02s");
  const starting = snapshotFromEntries(W, entries("/a", base).filter(e => !(e.type === "command-started" && e.id === id("held")))).calls.find(c => c.key === "held")!;
  assert.equal(statusPhrase(starting, wf, undefined, now), "starting · 1m04s");
  assert.equal(statusPhrase(done, wf, undefined, now), "failed: Command exited 3");
  const rows = listRows([wf], { folded: new Set(), done: new Map([[W, 8]]), viewed: new Set(), finished: false }, new Map(), name, 140, now);
  const row = (key: string) => rows.find(r => r.call?.key === key)!.text;
  assert.match(row("held"), /held +command: sleep 100 +running · pid 4242 · 1m03s +1m03s$/);
  assert.match(row("done"), /done +command: make test; exit 3 +failed: Command exited 3/);
  const dock = dockLines([wf], new Map(), name, 140, now);
  assert.match(dock[0]!, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] held +command: sleep 100 +running · pid 4242/);
  // Generated keys of command steps go by "command".
  assert.equal(callName({ calls: [{ key: "tasks:0", agent: "" }, { key: "tasks:1", agent: "" }] as CallSnapshot[] }, { key: "tasks:1", gen: 1, agent: "", command: "make" }), "command 2");
  // Watch view: the command, its process and log; after the seal its status, exit code, duration and output.
  assert.equal(commandHead(held, wf, now), "running · pid 4242 · 1m03s · /a/held/output.log");
  assert.equal(commandHead(done, wf, now), "failed · exit 3 · 41s · /a/done/output.log");
  assert.deepEqual(commandTranscript(held, wf, now), ["$ sleep 100", "", "running · pid 4242 · 1m03s; output goes to /a/held/output.log"]);
  assert.deepEqual(commandTranscript(done, wf, now), ["$ make test; exit 3", "", "Command exited 3", "", "build ok", "3 tests failed"]);
});
