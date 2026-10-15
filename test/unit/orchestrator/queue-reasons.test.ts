// Why a queued call does not start: the orchestrator still recovering (starting), and the reasons the orchestrator
// ledger records (used-up provider, writer lock, full providers). No reason known: plain "queued", never a slot claim.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal } from "../../../src/kernel/journal.ts";
import { journalPath, orchLedger } from "../../../src/paths.ts";
import { allWorkflows, orchestratorStarting, orchestratorView, queueWait, statusBrief, statusView, workflowSnapshot, type CallSnapshot, type WorkflowSnapshot } from "../../../src/orchestrator/snapshot.ts";
import { emptyLedger, foldLedger } from "../../../src/orchestrator/ledger.ts";
import { packageVersion } from "../../../src/version.ts";
import { main } from "../../../src/cli/main.ts";
import { resultLines } from "../../../src/ui/tool.ts";
import { dockLines, mainLine, queuedPhrase, statusPhrase, summaryText } from "../../../src/ui/view.ts";
import type { Entry } from "../../../src/types.ts";

const NOW = 1_800_000_000_000;
let seq = 0;
const entry = (type: string, fields: Record<string, unknown> = {}, ts = NOW - 12_000): Entry => ({ seq: ++seq, ts, type, ...fields }) as Entry;
const ledger = (...entries: Entry[]) => foldLedger(emptyLedger(), entries);
/** A pid no process has: a child that has exited (and was reaped). */
const deadPid = (() => { const r = spawnSync(process.execPath, ["-e", ""]); return r.pid!; })();
const start = (pid: number, extra: Record<string, unknown> = {}) => entry("orchestrator", { version: packageVersion(), pid, ...extra });

test("starting: a recovery start entry, its process alive, and no recovered entry of that pid", () => {
  const me = process.pid;
  assert.deepEqual(orchestratorStarting(ledger(start(me, { recovery: true }))), { pid: me, since: NOW - 12_000 });
  assert.equal(orchestratorStarting(ledger(start(me))), undefined, "an orchestrator that does not say it recovers (older) never starts");
  assert.equal(orchestratorStarting(ledger(start(me, { recovery: true }), entry("recovered", { pid: me, ms: 5, workflows: 1, calls: 2, skipped: 0 }))), undefined);
  assert.ok(orchestratorStarting(ledger(start(me, { recovery: true }), entry("recovered", { pid: deadPid, ms: 5, workflows: 1, calls: 2, skipped: 0 }))), "another pid's recovered does not end it");
  assert.equal(orchestratorStarting(ledger(start(deadPid, { recovery: true }))), undefined, "a dead process is not starting");
  assert.equal(orchestratorStarting(ledger(start(me, { recovery: true }), entry("orchestrator-exit", { pid: me, reason: "error" }))), undefined);
  // A recovered of an earlier orchestrator with the same pid does not end a later start.
  assert.ok(orchestratorStarting(ledger(start(me, { recovery: true }), entry("recovered", { pid: me, ms: 5, workflows: 0, calls: 0, skipped: 0 }), start(me, { recovery: true }))));
});

test("the orchestrator line says starting while it recovers", () => {
  const me = process.pid;
  assert.equal(orchestratorView(ledger(start(me, { recovery: true })), packageVersion(), NOW).orchestrator, `${packageVersion()} (pid ${me}, starting 12s)`);
  assert.equal(orchestratorView(ledger(start(me, { recovery: true }), entry("recovered", { pid: me, ms: 5, workflows: 0, calls: 0, skipped: 0 })), packageVersion(), NOW).orchestrator, `${packageVersion()} (pid ${me})`);
  assert.equal(orchestratorView(ledger(start(me)), packageVersion(), NOW).orchestrator, `${packageVersion()} (pid ${me})`);
});

const queued = (extra: Partial<CallSnapshot> = {}): CallSnapshot => ({ key: "a", gen: 1, callId: "w@1/a@1", agent: "worker", phase: "queued", exec: "w@1/a@1#1.1", model: "p/m", ...extra });
const config = (settings: Record<string, unknown>) => entry("config", { hash: "h", config: settings });
const hold = (pool: string, slot: number) => entry("hold", { pool, slot, exec: `other@1/x@1#${pool}${slot}` });
const exhausted = (provider: string, nextTry: number) => entry("provider-exhausted", { provider, exec: "other@1/x@1#1.1", since: NOW - 60_000, nextTry, error: "quota" });

test("each queued reason maps to its phrase; the slot phrase only with full providers", () => {
  const full = ledger(config({ providers: { p: { slots: 2 }, q: { slots: 1 } }, pools: { both: ["p/m", "q/n"] } }), hold("p", 0), hold("p", 1));
  const reason = (c: CallSnapshot, state = full) => queueWait(c, state, NOW);
  assert.deepEqual(reason(queued()), { reason: "slot", detail: "waiting for a free slot (p 2/2)" });
  assert.equal(reason(queued({ model: "q/n" })), undefined, "q has a free slot: no claim");
  assert.equal(reason(queued({ model: "r/x" })), undefined, "no limit: never full");
  assert.equal(reason(queued({ model: undefined })), undefined, "unknown model (an agent's own): no claim");
  assert.equal(reason(queued({ model: "both" })), undefined, "a pool with a free provider");
  assert.deepEqual(reason(queued({ model: "both" }), ledger(config({ providers: { p: { slots: 2 }, q: { slots: 1 } }, pools: { both: ["p/m", "q/n"] } }), hold("p", 0), hold("p", 1), hold("q", 0))),
    { reason: "slot", detail: "waiting for a free slot (p 2/2, q 1/1)" });
  assert.deepEqual(reason(queued({ model: undefined }), ledger(config({ defaultModel: "p/m", providers: { p: { slots: 1 } } }), hold("p", 0))),
    { reason: "slot", detail: "waiting for a free slot (p 1/1)" }, "the configured default model");
  assert.deepEqual(reason(queued({ model: "q/n", poolWait: { since: NOW, model: "p/m", free: [] } })), { reason: "slot", detail: "waiting for a free slot (p 2/2)" }, "a resume waits for its pinned provider");
  assert.deepEqual(reason(queued({ writerWait: { root: "/repo", holder: "w/b" } })), { reason: "writer-lock", detail: "waiting for the writer lock of /repo" });
  const used = ledger(config({ providers: { p: { slots: 2 } } }), exhausted("p", NOW + 60_000));
  assert.deepEqual(reason(queued({ writerWait: { root: "/repo", holder: "w/b" } }), used), { reason: "provider-exhausted", detail: "p usage window used up" });
  assert.equal(reason(queued(), ledger(config({ providers: { p: { slots: 2 } } }), exhausted("p", NOW - 1))), undefined, "past its next try a call probes it: not a wait");
  assert.equal(reason(queued({ phase: "running" })), undefined, "only queued calls");
  const starting = ledger(start(process.pid, { recovery: true }), config({ providers: { p: { slots: 2 } } }), hold("p", 0), hold("p", 1));
  assert.deepEqual(reason(queued({ writerWait: { root: "/repo", holder: "w/b" } }), starting), { reason: "starting", detail: "orchestrator starting", since: NOW - 12_000 }, "starting comes first");
});

test("view phrases: starting, recorded reasons, answered, paused and plain queued", () => {
  const wf = (c: CallSnapshot, extra: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot => ({ wid: "w", rev: 1, status: "running", calls: [c], attention: [], counts: { queued: 1, running: 0, asking: 0, sealed: 0 }, ...extra });
  const phrase = (extra: Partial<CallSnapshot>, w: Partial<WorkflowSnapshot> = {}) => { const c = queued(extra); return statusPhrase(c, wf(c, w), undefined, NOW); };
  const starting = { reason: "starting" as const, detail: "orchestrator starting", since: NOW - 75_000 };
  assert.equal(phrase({ queuedFor: starting }), "queued: orchestrator starting (1m15s)");
  assert.equal(phrase({ queuedFor: starting, answered: "q1" }), "queued: orchestrator starting (1m15s)");
  assert.equal(phrase({ queuedFor: starting }, { paused: true }), "paused · r resumes");
  assert.equal(phrase({ queuedFor: { reason: "writer-lock", detail: "waiting for the writer lock of /repo" } }), "queued: waiting for the writer lock of /repo");
  assert.equal(phrase({ queuedFor: { reason: "slot", detail: "waiting for a free slot (p 2/2)" } }), "queued: waiting for a free slot (p 2/2)");
  assert.equal(phrase({ queuedFor: { reason: "provider-exhausted", detail: "p usage window used up" } }), "queued: p usage window used up");
  assert.equal(phrase({}), "queued");
  assert.equal(phrase({ answered: "q1" }), "queued (answered, waiting for a slot)");
  assert.equal(queuedPhrase({ answered: "q1", queuedFor: { reason: "writer-lock", detail: "waiting for the writer lock of /repo" } }, NOW), "queued (answered): waiting for the writer lock of /repo");
  // The summary line (dock and footer) says it once.
  const a = queued({ queuedFor: starting }), b = queued({ key: "b", callId: "w@1/b@1", queuedFor: starting }), w = wf(a, { calls: [a, b], counts: { queued: 2, running: 0, asking: 0, sealed: 0 } });
  assert.equal(summaryText([w], NOW), "2 queued: orchestrator starting (1m15s) · 0/2+ done");
  assert.equal(mainLine([w], NOW), "2 queued: orchestrator starting (1m15s) · 0/2+ done · ↓ subagents");
  const dock = dockLines([w], new Map(), () => "M", 120, NOW);
  assert.match(dock[0]!, /queued: orchestrator starting \(1m15s\)/); assert.match(dock.at(-1)!, /^2 queued: orchestrator starting/);
  assert.equal(summaryText([wf(queued())], NOW), "1 queued · 0/1+ done");
});

test("CLI status, tool status and pi readers say starting, then the recorded reason, from fixture ledgers", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-queue-reasons-")), wid = "W", call = `${wid}@1/a@1`, exec = `${call}#1.1`;
  t.after(() => rm(home, { recursive: true, force: true }));
  const orch = await openJournal(orchLedger(home)), journal = await openJournal(journalPath(home, wid));
  t.after(async () => { await orch.close(); await journal.close(); });
  await orch.append("config", { hash: "h", config: { providers: { p: { slots: 1 } } } });
  await orch.append("hold", { pool: "p", slot: 0, exec: "other@1/x@1#1.1" });
  await orch.append("orchestrator", { version: packageVersion(), pid: process.pid, recovery: true });
  await orch.append("created", { wid, rid: "run", origin: "main:test" });
  for (const [type, fields] of [["wf-created", { revision: 1, origin: "main:test" }], ["call", { key: "a", gen: 1, spec: { agent: "worker", model: "p/m" } }], ["exec", { call, exec }]] as const)
    await journal.append(type, fields);
  const status = async (...args: string[]) => { const out: string[] = []; assert.equal(await main(["status", ...args], { env: { DSA_HOME: home }, write: l => out.push(l) }), 0); return out.join("\n"); };

  let text = await status();
  assert.match(text, new RegExp(`orchestrator: ${packageVersion().replaceAll(".", "\\.")} \\(pid ${process.pid}, starting \\d+s\\)`));
  assert.match(text, /a@1 queued: orchestrator starting \(\d+s\)/);
  assert.match(await status(wid), /a@1 queued: orchestrator starting \(\d+s\)/);
  assert.match(await status(wid, "--tail", "1"), /a@1 queued: orchestrator starting \(\d+s\)/);
  const brief = statusBrief(home);
  assert.match(brief.orchestrator!, /, starting \d+s\)$/); assert.match(brief.active[0]!.calls[0]!.queued!, /^orchestrator starting \(\d+s\)$/);
  assert.match(resultLines(brief).join("\n"), /^orchestrator starting \(\d+s\)$/m);
  assert.match(statusView(home).workflows[0]!.calls[0]!.queued!, /^orchestrator starting/);
  const ui = allWorkflows(home)[0]!;
  assert.match(statusPhrase(ui.calls[0]!, ui, undefined, Date.now()), /^queued: orchestrator starting \(\d+s\)$/);
  assert.match(resultLines({ wid, ...workflowSnapshot(home, wid).calls[0]! })[0]!, /a · queued: orchestrator starting/);

  // Recovery ends: the call names the recorded reason (its provider is full).
  await orch.append("recovered", { pid: process.pid, ms: 1234, workflows: 1, calls: 1, skipped: 0 });
  text = await status();
  assert.match(text, new RegExp(`orchestrator: ${packageVersion().replaceAll(".", "\\.")} \\(pid ${process.pid}\\)`));
  assert.doesNotMatch(text, /starting/);
  assert.match(text, /a@1 queued: waiting for a free slot \(p 1\/1\)/);
  const after = allWorkflows(home)[0]!;
  assert.equal(statusPhrase(after.calls[0]!, after, undefined, Date.now()), "queued: waiting for a free slot (p 1/1)");
  assert.equal(statusBrief(home).active[0]!.calls[0]!.queued, "waiting for a free slot (p 1/1)");
  assert.doesNotMatch(resultLines(statusBrief(home)).join("\n"), /starting/);

  // The slot frees: nothing recorded, so the call is just queued.
  await orch.append("release", { pool: "p", slot: 0, exec: "other@1/x@1#1.1" });
  text = await status();
  assert.match(text, /a@1 queued p\/m/); assert.doesNotMatch(text, /free slot/);
  const free = allWorkflows(home)[0]!;
  assert.equal(statusPhrase(free.calls[0]!, free, undefined, Date.now()), "queued");
  assert.equal(statusBrief(home).active[0]!.calls[0]!.queued, undefined);

  // A writer lock the journal records.
  await journal.append("writer-wait", { call, root: "/repo", holder: `${wid}@1/b@1` });
  const writer = allWorkflows(home)[0]!;
  assert.equal(statusPhrase(writer.calls[0]!, writer, undefined, Date.now()), "queued: waiting for the writer lock of /repo");
  assert.match(await status(), /a@1 queued p\/m .*\(waiting for writer lock: \/repo held by W\/b\)/, "the CLI keeps its own writer-lock suffix");
});
