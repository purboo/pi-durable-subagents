import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { orchLedger } from "../../../src/paths.ts";
import { main } from "../../../src/orchestrator/main.ts";
import { emptyLedger, foldLedger } from "../../../src/orchestrator/ledger.ts";
import { orchestratorView, runningOrchestrator, versionNote, type StatusView } from "../../../src/orchestrator/snapshot.ts";
import { renderView } from "../../../src/cli/main.ts";
import { packageVersion } from "../../../src/version.ts";
import { captureStart } from "../../../src/platform/proctable.ts";
import type { Entry } from "../../../src/types.ts";
import { fakeExecutor } from "./engine/fake.ts";

const entries = (...items: [string, Record<string, unknown>][]) => items.map(([type, fields], i) => ({ type, seq: i + 1, ts: 1000 + i, ...fields })) as unknown as Entry[];

test("the orchestrator records its package version while it holds the lock, and its exit", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-version-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const controller = new AbortController();
  const run = main({ home, signal: controller.signal, config: { k: { idleExitMs: 60_000 } }, executor: ledgers => fakeExecutor(ledgers),
    discovery: { home, agentDir: join(home, "config"), globalNpmRoot: null } });
  for (let i = 0; i < 200 && !readJournalSnapshot(orchLedger(home)).some(e => e.type === "orchestrator"); i++) await delay(10);
  const started = readJournalSnapshot(orchLedger(home)).find(e => e.type === "orchestrator")!;
  assert.equal(started.version, packageVersion()); assert.equal(started.pid, process.pid);
  assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
  // Subagents reach `pi-durable-subagents hold` through the shim the orchestrator writes at start.
  assert.match(readFileSync(join(home, "bin", "pi-durable-subagents"), "utf8"), /src\/cli\/main\.ts' "\$@"/);
  assert.deepEqual(runningOrchestrator(home), { orchestrator: `${packageVersion()} (pid ${process.pid})` }, "the same version: no note");
  controller.abort(); await run;
  assert.equal(readJournalSnapshot(orchLedger(home)).at(-1)!.type, "orchestrator-exit");
  assert.deepEqual(runningOrchestrator(home), {}, "an orchestrator that exited is not shown");
});

test("a running orchestrator of another version is shown with a note; a dead one is not", async () => {
  const older = foldLedger(emptyLedger(), entries(["orchestrator", { version: "1.0.9", pid: process.pid }]));
  const view = orchestratorView(older, "1.0.13");
  assert.equal(view.orchestrator, `1.0.9 (pid ${process.pid})`);
  assert.match(String(view.versionNote), /^the orchestrator runs durable-subagents 1\.0\.9, this pi loaded 1\.0\.13: running work stays on 1\.0\.9\. .*restart/);
  assert.match(String(orchestratorView(older, "1.0.8").versionNote), /^this pi session loaded durable-subagents 1\.0\.8, older than the running orchestrator 1\.0\.9; start a new pi session/);
  assert.match(versionNote("1.0.10", "1.0.9"), /^this pi session loaded .* 1\.0\.9, older than/, "versions compare by number, not text");
  const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
  assert.deepEqual(orchestratorView(foldLedger(emptyLedger(), entries(["orchestrator", { version: "1.0.9", pid: dead }])), "1.0.13"), {});
  const exited = foldLedger(emptyLedger(), entries(["orchestrator", { version: "1.0.9", pid: process.pid }], ["orchestrator-exit", { pid: process.pid }]));
  assert.deepEqual(orchestratorView(exited, "1.0.13"), {});
  const restarted = foldLedger(emptyLedger(), entries(["orchestrator", { version: "1.0.9", pid: 1 }], ["orchestrator", { version: "1.0.13", pid: process.pid }], ["orchestrator-exit", { pid: 1 }]));
  assert.deepEqual(orchestratorView(restarted, "1.0.13"), { orchestrator: `1.0.13 (pid ${process.pid})` }, "an earlier process's exit does not hide the running one");

  if (process.platform === "linux") {
    const start = await captureStart(process.pid);
    const same = foldLedger(emptyLedger(), entries(["orchestrator", { version: "1.0.9", pid: process.pid, start }]));
    assert.equal(orchestratorView(same, "1.0.9").orchestrator, `1.0.9 (pid ${process.pid})`);
    const reused = foldLedger(emptyLedger(), entries(["orchestrator", { version: "1.0.9", pid: process.pid, start: String(Number(start) - 1) }]));
    assert.deepEqual(orchestratorView(reused, "1.0.13"), {}, "a later process given the same pid is not the orchestrator");
  }
});

test("the CLI footer shows the orchestrator version and the note", () => {
  assert.equal(renderView({ workflows: [], orchestrator: "1.0.9 (pid 7)", versionNote: "n" } as unknown as StatusView), "No workflows\norchestrator: 1.0.9 (pid 7)\nnote: n");
});

test("a pi session says once when the running orchestrator is another version than it loaded", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-version-main-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { openJournal } = await import("../../../src/kernel/journal.ts");
  const orch = await openJournal(orchLedger(home));
  await orch.append("orchestrator", { version: "0.0.1", pid: process.pid }); await orch.close();
  const { registerMain } = await import("../../../src/agent/main.ts");
  const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>(), notices: [string, string?][] = [];
  const old = process.env.DSA_HOME; process.env.DSA_HOME = home;
  try { registerMain({ on: (name: string, fn: never) => hooks.set(name, fn), registerTool() {}, sendMessage() {} } as unknown as Parameters<typeof registerMain>[0]); }
  finally { if (old === undefined) delete process.env.DSA_HOME; else process.env.DSA_HOME = old; }
  const ctx = { hasUI: true, ui: { notify: (text: string, type?: string) => notices.push([text, type]) }, isIdle: () => false,
    sessionManager: { getSessionId: () => "s1", getEntries: () => [], getBranch: () => [] } };
  await hooks.get("session_start")!({}, ctx);
  t.after(() => hooks.get("session_shutdown")!({ reason: "quit" }, ctx));
  assert.equal(notices.length, 1);
  assert.match(notices[0]![0], new RegExp(`^Durable Subagents: the orchestrator runs durable-subagents 0\\.0\\.1, this pi loaded ${packageVersion().replaceAll(".", "\\.")}: `));
  assert.equal(notices[0]![1], "warning");
});

test("status shows who forced the latest restart and why for 24 hours, on one line; old restart records still fold", () => {
  const forced = (initiator: Record<string, unknown> | undefined, reason?: string) => foldLedger(emptyLedger(), entries(
    ["orchestrator", { version: "1.0.20", pid: 1 }],
    ["restart", { rid: "r1", force: true, ...(reason === undefined ? {} : { reason }), ...(initiator ? { initiator } : {}), from: "cli:abc", live: ["w@1/a@1#1.1"] }],
    ["orchestrator", { version: "1.0.21", pid: process.pid, restart: true }]));
  const ts = 1002, hour = 3_600_000;
  const view = orchestratorView(forced({ origin: "main:s1" }, "upgrade\nafter approval"), "1.0.21", ts + 5 * 60_000);
  assert.equal(view.orchestrator, `1.0.21 (pid ${process.pid}); restarted by force 5m ago by main:s1: upgrade after approval`);
  const cli = orchestratorView(forced({ cli: { user: "u", host: "h", ppid: 7, parent: "bash -c x" } }, "fix"), "1.0.21", ts + 1000);
  assert.equal(cli.orchestrator, `1.0.21 (pid ${process.pid}); restarted by force 1s ago by cli:u@h: fix`);
  const rendered = renderView({ workflows: [], ...view } as StatusView);
  assert.equal(rendered.split("\n").filter(l => l.startsWith("orchestrator: ")).length, 1);
  assert.ok(!rendered.includes("upgrade\nafter"), "the reason is one line");
  assert.equal(orchestratorView(forced({ origin: "main:s1" }, "upgrade"), "1.0.21", ts + 24 * hour + 1).orchestrator, `1.0.21 (pid ${process.pid})`, "hidden after 24 hours");
  // A 1.0.20 record has no reason, initiator or from fields; a non-force restart notes nothing.
  const old = foldLedger(emptyLedger(), entries(["restart", { rid: "r1", force: true, live: [] }], ["orchestrator", { version: "1.0.21", pid: process.pid, restart: true }]));
  assert.equal(orchestratorView(old, "1.0.21", 1001 + 60_000).orchestrator, `1.0.21 (pid ${process.pid}); restarted by force 1m ago by unknown: no reason recorded`);
  const plain = foldLedger(emptyLedger(), entries(["restart", { rid: "r1", force: false, live: [] }], ["orchestrator", { version: "1.0.21", pid: process.pid, restart: true }]));
  assert.equal(orchestratorView(plain, "1.0.21", 2000).orchestrator, `1.0.21 (pid ${process.pid})`);
  // Only the start that followed the force restart carries it.
  const later = foldLedger(emptyLedger(), [...entries(["restart", { rid: "r1", force: true, reason: "x", live: [] }], ["orchestrator", { version: "1.0.21", pid: 1, restart: true }]), ...entries(["orchestrator", { version: "1.0.21", pid: process.pid }]).map(e => ({ ...e, seq: 3, ts: 1003 }))]);
  assert.equal(orchestratorView(later, "1.0.21", 2000).orchestrator, `1.0.21 (pid ${process.pid})`);
});
