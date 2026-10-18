import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { Containment } from "../../../../src/platform/containment.ts";
// A red run grafts these tests onto 1.0.45, which has no diagnostic module. Exercise its existing fence then,
// so the failure is missing journal behaviour rather than an import error before the tests can run.
const diagnostics = await import("../../../../src/orchestrator/executor/ended.ts").catch(error => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return undefined;
});
const fenceAgent: typeof import("../../../../src/orchestrator/executor/ended.ts")["fenceAgent"] = diagnostics?.fenceAgent
  ?? (async (containment, _journal, exec, tracked) => containment.fence(exec, tracked));
const cmdline = await import("../../../../src/platform/cmdline.ts").catch(error => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return undefined;
});
import { sweepExecutions } from "../../../../src/orchestrator/executor/sweep.ts";
import type { JournalHandle, ProcInfo } from "../../../../src/types.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dsa-ended-")), journal = await openJournal(join(root, "journal")), containment = new Containment();
  const exec = `w${process.pid}@1/k@1#${Date.now()}.1`;
  t.after(async () => { await containment.fence(exec, []); await journal.close(); await rm(root, { recursive: true, force: true }); });
  return { root, journal, containment, exec };
}

test("EX1 records a sleep grandchild's pid/argv before SIGKILL, not the direct child", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const child = await f.containment.spawn({ exec: f.exec, command: process.execPath,
    args: ["-e", 'const c=require("child_process").spawn("sleep",["300"],{stdio:"ignore"}); console.log(c.pid); setInterval(()=>{},1000)'], cwd: f.root, env: {} });
  const pid = await new Promise<number>(resolve => child.stdout.once("data", data => resolve(Number(String(data).trim()))));
  await f.journal.append("tracked", { exec: f.exec, pid: child.pid, start: child.start });
  const kills: number[] = [], beforeKill: ReturnType<JournalHandle["entries"]>[] = [], kill = process.kill.bind(process);
  t.mock.method(process, "kill", ((target: number, signal?: string | number) => {
    if (target === pid && signal === "SIGKILL") {
      kills.push(target); beforeKill.push(f.journal.entries().filter(e => e.type === "ended"));
    }
    return kill(target, signal as NodeJS.Signals);
  }) as typeof process.kill);
  await fenceAgent(f.containment, f.journal, f.exec, [{ pid: child.pid, ppid: process.pid, start: child.start }]);
  assert.deepEqual(kills, [pid]);
  const ended = beforeKill[0]!;
  assert.equal(ended.length, 1, "durable entry precedes signal");
  assert.equal(ended[0]!.exec, f.exec); assert.equal(ended[0]!.call, f.exec.split("#")[0]);
  assert.deepEqual(ended[0]!.procs, [{ pid, command: "sleep 300" }]);
  assert.ok(!(ended[0]!.procs as { pid: number }[]).some(p => p.pid === child.pid));
  await child.exited;
});

/** Fake identities with no start token only in this test: no operating-system process is ever signalled. */
async function simulated(t: TestContext, rounds: ProcInfo[][]) {
  const f = await fixture(t);
  let round = 0;
  const containment = new Containment({ list: async () => rounds[round++] ?? [] });
  const killed: number[] = [];
  t.mock.method(process, "kill", ((pid: number) => { killed.push(pid); return true; }) as typeof process.kill);
  return { ...f, containment, killed };
}
const row = (pid: number, exec: string, start = ""): ProcInfo => ({ pid, ppid: 0, start, tag: exec });

test("EX1 caps one entry per kill round at 20 with more; matches direct child by pid AND start", async t => {
  const f = await simulated(t, []);
  const rows = Array.from({ length: 24 }, (_, i) => row(900_000 + i, f.exec));
  let scan = 0;
  t.mock.method(f.containment, "scan", async () => new Map([[f.exec, scan++ === 0 ? rows : []]]));
  await fenceAgent(f.containment, f.journal, f.exec, [], { pid: rows[0]!.pid, start: "old" });
  const ended = f.journal.entries().filter(e => e.type === "ended");
  assert.equal(ended.length, 1);
  assert.deepEqual(ended[0]!.procs, rows.slice(0, 20).map(p => ({ pid: p.pid, command: "" })));
  assert.equal(ended[0]!.more, 4);
  assert.equal(f.killed.length, 24, "the cap only limits diagnostics");
});

test("EX1 produces one ended entry for each nonempty fence round", async t => {
  const f = await simulated(t, []);
  let scan = 0;
  t.mock.method(f.containment, "scan", async () => new Map([[f.exec, scan++ < 2 ? [row(900_001 + scan, f.exec)] : []]]));
  await fenceAgent(f.containment, f.journal, f.exec, [], { pid: 900_000, start: "direct" });
  assert.equal(f.journal.entries().filter(e => e.type === "ended").length, 2);
});

for (const directOnly of [false, true]) test(`EX1 writes nothing for ${directOnly ? "only the direct child" : "no targets"}`, async t => {
  const f = await simulated(t, []);
  let scan = 0;
  t.mock.method(f.containment, "scan", async () => new Map([[f.exec, directOnly && scan++ === 0 ? [row(900_001, f.exec)] : []]]));
  await fenceAgent(f.containment, f.journal, f.exec, [], { pid: 900_001, start: "" });
  assert.deepEqual(f.journal.entries(), []);
  assert.equal(f.killed.length, directOnly ? 1 : 0);
});

for (const failure of ["reject", "hang"] as const) test(`EX1 ${failure} recording never blocks the fence`, { timeout: 3000 }, async t => {
  const f = await simulated(t, []);
  let scan = 0, recorded = 0;
  t.mock.method(f.containment, "scan", async () => new Map([[f.exec, scan++ === 0 ? [row(900_001, f.exec)] : []]]));
  const journal: JournalHandle = { ...f.journal, append: async () => { recorded++; if (failure === "reject") throw new Error("disk failure"); return new Promise(() => {}); } };
  const before = performance.now();
  await fenceAgent(f.containment, journal, f.exec, [], { pid: 900_000, start: "direct" });
  assert.equal(recorded, 1); assert.deepEqual(f.killed, [900_001]);
  assert.ok(performance.now() - before < 800, "500 ms budget plus scan/scheduling overhead");
});

test("EX1 aborting slow argv reads prevents a stale append after fencing", { timeout: 3000,
  skip: process.platform !== "linux" ? "injects a stalled /proc/cmdline read; macOS uses bounded ps instead" : false }, async t => {
  const f = await simulated(t, []), fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const original = fs.readFile;
  let finish!: (value: string) => void, scan = 0;
  fs.readFile = ((...args: Parameters<typeof original>) => String(args[0]).endsWith("/cmdline") ? new Promise<string>(resolve => { finish = resolve; }) : original(...args)) as typeof original;
  syncBuiltinESMExports();
  try {
    t.mock.method(f.containment, "scan", async () => new Map([[f.exec, scan++ === 0 ? [row(900_001, f.exec)] : []]]));
    await fenceAgent(f.containment, f.journal, f.exec, [], { pid: 900_000, start: "direct" });
    assert.equal(typeof finish, "function", "the diagnostic read was started");
    finish("late argv"); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.journal.entries(), []); assert.deepEqual(f.killed, [900_001]);
  } finally { fs.readFile = original; syncBuiltinESMExports(); }
});

test("EX1 recovery/sweep excludes the direct child using persisted identity", async t => {
  const f = await simulated(t, []);
  await f.journal.append("exec", { exec: f.exec, call: f.exec.split("#")[0] });
  await f.journal.append("tracked", { exec: f.exec, pid: 900_001, start: "" });
  await f.journal.append("retired", { call: f.exec.split("#")[0] });
  let scan = 0;
  t.mock.method(f.containment, "scan", async () => new Map([[f.exec, scan++ < 2 ? [row(900_001, f.exec), row(900_002, f.exec)] : []]]));
  await sweepExecutions([f.journal], f.containment);
  assert.deepEqual(f.journal.entries().find(e => e.type === "ended")?.procs, [{ pid: 900_002, command: "" }]);
});

test("EX1 recovery prefers the explicit direct-child token even when a tracker entry came first", async t => {
  const f = await simulated(t, []);
  await f.journal.append("tracked", { exec: f.exec, pid: 900_002, start: "" });
  await f.journal.append("tracked", { exec: f.exec, pid: 900_001, start: "", child: true });
  let scan = 0;
  t.mock.method(f.containment, "scan", async () => new Map([[f.exec, scan++ === 0 ? [row(900_001, f.exec), row(900_002, f.exec)] : []]]));
  await fenceAgent(f.containment, f.journal, f.exec, []);
  assert.deepEqual(f.journal.entries().find(e => e.type === "ended")?.procs, [{ pid: 900_002, command: "" }]);
});

for (const descendant of [false, true]) test(`EX1 R-11-3 crash before tracked: ${descendant ? "only the tagged grandchild is listed" : "a lone direct child is never listed"}`, async t => {
  const f = await simulated(t, []);
  await f.journal.append("exec", { exec: f.exec, call: f.exec.split("#")[0] });
  // Direct pi belongs to the orchestrator; orphaned descendants belong to init/a subreaper. Both are roots.
  const direct = { ...row(900_001, f.exec), ppid: process.pid };
  const grandchild = { ...row(900_002, f.exec), ppid: direct.pid };
  const orphan = { ...row(900_003, f.exec), ppid: 1 };
  const targets = descendant ? [direct, grandchild, orphan] : [direct];
  let scan = 0;
  t.mock.method(f.containment, "scan", async () => new Map([[f.exec, scan++ === 0 ? targets : []]]));
  await fenceAgent(f.containment, f.journal, f.exec, []);
  assert.ok(!f.journal.entries().some(e => e.type === "tracked"), "exec committed without a persisted child identity");
  const ended = f.journal.entries().filter(e => e.type === "ended");
  if (descendant) {
    assert.equal(ended.length, 1);
    assert.deepEqual(ended[0]!.procs, [{ pid: grandchild.pid, command: "" }]);
    assert.equal(ended[0]!.more, undefined, "omitted roots do not count as additional listed processes");
  } else assert.deepEqual(ended, []);
  assert.deepEqual(f.killed, targets.map(p => p.pid), "diagnostic under-reporting does not change containment");
});

// Reproduce the reviewer's real-process probe: only exec is durable, then a fresh containment recovers the tag.
for (const descendant of [false, true]) test(`EX1 R-11-3 real-process crash cut with ${descendant ? "a tagged sleep grandchild" : "only the direct child"}`, { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await f.journal.append("exec", { exec: f.exec, call: f.exec.split("#")[0] });
  const source = descendant
    ? 'const c=require("child_process").spawn("sleep",["300"],{stdio:"ignore"}); console.log(c.pid); setInterval(()=>{},1000)'
    : 'console.log(0); setInterval(()=>{},1000)';
  const child = await f.containment.spawn({ exec: f.exec, command: process.execPath, args: ["-e", source], cwd: f.root, env: {} });
  const pid = await new Promise<number>(resolve => child.stdout.once("data", data => resolve(Number(String(data).trim()))));
  const recovered = new Containment();
  await fenceAgent(recovered, f.journal, f.exec, []);
  await child.exited;
  assert.ok(!f.journal.entries().some(e => e.type === "tracked"));
  const ended = f.journal.entries().filter(e => e.type === "ended");
  const procs = ended.flatMap(e => e.procs as { pid: number; command: string }[]);
  assert.ok(!procs.some(p => p.pid === child.pid), "the unpersisted direct child is never listed");
  if (descendant) assert.deepEqual(procs, [{ pid, command: "sleep 300" }]);
  else assert.deepEqual(ended, []);
  assert.equal((await recovered.scan(new Map([[f.exec, []]]), { fresh: true })).get(f.exec)?.length ?? 0, 0);
});

test("EX1 command and gate fences have no ended recording hook", async t => {
  const f = await simulated(t, []);
  let scan = 0;
  t.mock.method(f.containment, "scan", async () => new Map([[f.exec, scan++ === 0 ? [row(900_001, f.exec)] : []]]));
  await f.containment.fence(f.exec, []);
  assert.deepEqual(f.journal.entries(), []); assert.deepEqual(f.killed, [900_001]);
});

test("EX1 command-line diagnostics are bounded and unreadable means empty", async t => {
  const f = await fixture(t);
  const child = await f.containment.spawn({ exec: f.exec, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)", "x".repeat(400)], cwd: f.root, env: {} });
  assert.ok(cmdline, "the bounded command-line diagnostic is implemented");
  const command = await cmdline.commandLine(child.pid);
  assert.equal(command.length, 200); assert.ok(!command.includes("\0"));
  assert.equal(await cmdline.commandLine(999_999_999), "");
});
