// Deterministic barrier regression tests for durable Windows Job Object gate ownership:
// - Normal Windows gate execution (env inputs, JSON + schema, nonzero exit, timeout, abort) drains surviving detached
//   grandchildren before returning.
// - Hard-kill / crash mid-launch BEFORE `group` record (helper-begin only, zero user action) and AFTER `group` record
//   (before `gate-tracked`, with live detached grandchild) recover via durable `gate-intent.jobDir`, fence only verified
//   Job Object identities (never boot-orphan or reused-PID decoys), kill surviving grandchildren, and seal `unknown`
//   without replaying side-effecting gates.
// - Fence timeout during recovery leaves the gate parked and `sweepExecutions` retries with `jobDir` identities until
//   retirement, resolving the attention item and recording `unknown` once.
// - `spawned.uncertain` adoption still tracks, fences, and never replays.
// Runs on Linux via a /proc-backed Job Object stand-in; native Win32 Job Objects are covered in gate.test.ts on Windows.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { Containment } from "../../../../src/platform/containment.ts";
import { winTag, type WinProcessIdentity, type WinProcessRow } from "../../../../src/platform/windows.ts";
import createEffects from "../../../../src/orchestrator/executor/effects/index.ts";
import { gateRetired } from "../../../../src/orchestrator/executor/effects/gate.ts";
import { sweepExecutions } from "../../../../src/orchestrator/executor/sweep.ts";
import type { CallTicket } from "../../../../src/orchestrator/contract.ts";
import { JT, type CallResult, type ProcInfo } from "../../../../src/types.ts";

const linuxOnly = process.platform === "linux" ? false : "the Job Object stand-in uses Linux /proc to track detached descendants";

const T_BOOT = "639000000100000000";
const T_BASE = 639000000500000000n;
const T_REUSED = "639000000900000000";
const T_REUSED_CHILD = "639000000950000000";

const ticksForPid = (pid: number): string => String(T_BASE + BigInt(pid) * 1000n);

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 15_000): Promise<T> {
  const end = performance.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (performance.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await delay(15);
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (existsSync(`/proc/${pid}/stat`)) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      return state !== "Z" && state !== "X";
    } catch { return false; }
  }
  return true;
}

/** Kill any stray test process referencing `root` so a failed assertion cannot leak processes or hold pipes. */
function cleanupRootProcesses(root: string): void {
  if (!existsSync("/proc")) return;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    const pid = Number(name);
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const env = readFileSync(`/proc/${pid}/environ`, "utf8");
      if (cmd.includes(root) || env.includes(root)) process.kill(pid, "SIGKILL");
    } catch { /* vanished or foreign */ }
  }
}

/** Build a real-process fake `csc.exe` whose compiled `DsaJob.exe` implements the `job.ts` file protocol (`helper-begin`,
 *  UTF-16LE base64 `job.json`, `group` written BEFORE resuming the child, `DrainJob` terminating the job group + any
 *  tagged descendants on child exit or owner termination/SIGKILL via a kernel pipe-EOF watchdog, and `group-end`). */
async function createJobStandIn(root: string): Promise<{ compiler: string; ownerScript: string }> {
  const ownerScript = join(root, "fake-dsajob.mjs");
  const compiler = join(root, "fake-csc");
  await writeFile(ownerScript, [
    `#!${process.execPath}`,
    `import { spawn } from "node:child_process";`,
    `import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";`,
    `import { join } from "node:path";`,
    `const T_BASE = 639000000500000000n;`,
    `const ticks = pid => String(T_BASE + BigInt(pid) * 1000n);`,
    `const writeAtomic = (p, text) => { writeFileSync(p + ".tmp", text); renameSync(p + ".tmp", p); };`,
    `const dir = process.argv[2];`,
    `if (!dir) process.exit(126);`,
    `const ownerIdentity = { pid: process.pid, start: ticks(process.pid) };`,
    `writeAtomic(join(dir, "helper-begin"), JSON.stringify(ownerIdentity));`,
    `const lines = readFileSync(join(dir, "job.json"), "ascii").split("\\n");`,
    `if (lines.at(-1) === "") lines.pop();`,
    `let at = 1;`,
    `const dec = () => Buffer.from(lines[at++], "base64").toString("utf16le");`,
    `const exe = dec(), cwd = dec(), logPath = dec();`,
    `const argc = Number(lines[at++]); const args = Array.from({ length: argc }, dec);`,
    `const envc = Number(lines[at++]); const envPairs = Array.from({ length: envc }, dec);`,
    `try { unlinkSync(join(dir, "job.json")); } catch {}`,
    `const env = {};`,
    `for (const pair of envPairs) { const eq = pair.indexOf("="); if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1); }`,
    // Optional pre-group barrier: pauses BEFORE creating/resuming wrapper.mjs or writing `group`.
    `if (process.env.GATE_TEST_PRE_GROUP_ENTERED) {`,
    `  writeFileSync(process.env.GATE_TEST_PRE_GROUP_ENTERED, String(process.pid));`,
    `  while (process.env.GATE_TEST_PRE_GROUP_RELEASE && !existsSync(process.env.GATE_TEST_PRE_GROUP_RELEASE)) {`,
    `    await new Promise(r => setTimeout(r, 10));`,
    `  }`,
    `}`,
    // Gate wrapper before user code runs so `group` is durably written BEFORE any gate command can execute.
    `const gateFile = join(dir, ".resume-child");`,
    `const wrappedArgs = ["-e", \`const fs=require("node:fs");while(!fs.existsSync(\${JSON.stringify(gateFile)})){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}const {spawnSync}=require("node:child_process");const r=spawnSync(\${JSON.stringify(exe)},\${JSON.stringify(args)},{stdio:"inherit",env:process.env,cwd:\${JSON.stringify(cwd)}});process.exit(r.status??1);\`` + `];`,
    `const child = spawn(process.execPath, wrappedArgs, { cwd, env, detached: true, stdio: logPath ? "ignore" : ["ignore", "inherit", "inherit"] });`,
    `const childPgid = child.pid;`,
    // Track the job's unique `DSA_EXEC=<id>` from gate.json so detached grandchildren that called setsid() are still
    // killed when the Job Object handle closes (modelling Win32 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE).
    `let execMarker = "";`,
    `try { const gs = JSON.parse(readFileSync(join(dir, "gate.json"), "utf8")); if (gs?.env?.DSA_EXEC) execMarker = "DSA_EXEC=" + gs.env.DSA_EXEC; } catch {}`,
    `const drainScript = [`,
    `  "const { existsSync, readdirSync, readFileSync } = require('node:fs');",`,
    `  "const pgid = Number(process.argv[1]), ownerPid = Number(process.argv[2]), marker = process.argv[3] ? Buffer.from(process.argv[3], 'base64').toString('utf8') : '';",`,
    `  "const sweep = () => {",`,
    `  "  if (pgid) { try { process.kill(-pgid, 'SIGKILL'); } catch {} }",`,
    `  "  if (marker && existsSync('/proc')) {",`,
    `  "    for (const n of readdirSync('/proc')) {",`,
    `  "      const p = Number(n);",`,
    `  "      if (!p || p === process.pid || p === ownerPid) continue;",`,
    `  "      try { if (readFileSync('/proc/' + p + '/environ', 'utf8').split('\\\\0').includes(marker)) process.kill(p, 'SIGKILL'); } catch {}",`,
    `  "    }",`,
    `  "  }",`,
    `  "};",`,
    `  "process.stdin.resume();",`,
    `  "process.stdin.once('end', () => { sweep(); setTimeout(() => { sweep(); process.exit(0); }, 15); });",`,
    `].join("");`,
    `const reaper = spawn(process.execPath, ["-e", drainScript, String(childPgid), String(process.pid), execMarker ? Buffer.from(execMarker).toString("base64") : ""], { detached: true, stdio: ["pipe", "ignore", "ignore"] });`,
    `reaper.stdin.on("error", () => {});`,
    `reaper.unref();`,
    `const drainJob = () => {`,
    `  if (childPgid) { try { process.kill(-childPgid, "SIGKILL"); } catch {} }`,
    `  if (execMarker && existsSync("/proc")) {`,
    `    for (const n of readdirSync("/proc")) {`,
    `      if (!/^\\d+$/.test(n) || Number(n) === process.pid || Number(n) === reaper.pid) continue;`,
    `      try { if (readFileSync(\`/proc/\${n}/environ\`, "utf8").split("\\0").includes(execMarker)) process.kill(Number(n), "SIGKILL"); } catch {}`,
    `    }`,
    `  }`,
    `};`,
    `const nonZombieJobAlive = () => {`,
    `  if (existsSync("/proc")) {`,
    `    for (const n of readdirSync("/proc")) {`,
    `      if (!/^\\d+$/.test(n) || Number(n) === process.pid || Number(n) === reaper.pid) continue;`,
    `      try {`,
    `        const r = readFileSync(\`/proc/\${n}/stat\`, "utf8").split(") ")[1].split(" ");`,
    `        if (r[0] === "Z" || r[0] === "X") continue;`,
    `        if (Number(r[2]) === childPgid) return true;`,
    `        if (execMarker && readFileSync(\`/proc/\${n}/environ\`, "utf8").split("\\0").includes(execMarker)) return true;`,
    `      } catch {}`,
    `    }`,
    `    return false;`,
    `  }`,
    `  try { process.kill(-childPgid, 0); return true; } catch { return false; }`,
    `};`,
    `for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { drainJob(); process.exit(1); });`,
    `await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });`,
    `writeAtomic(join(dir, "group"), JSON.stringify({ pid: child.pid, start: ticks(child.pid), group: ownerIdentity }));`,
    `writeFileSync(gateFile, "go");`,
    `const code = await new Promise(resolve => child.once("exit", c => resolve(c ?? 1)));`,
    `drainJob();`,
    `for (let i = 0; i < 100; i++) {`,
    `  if (!nonZombieJobAlive()) break;`,
    `  await new Promise(r => setTimeout(r, 10));`,
    `}`,
    `writeAtomic(join(dir, "group-end"), JSON.stringify({ status: code >>> 0 }));`,
    `try { process.kill(reaper.pid, "SIGKILL"); } catch {}`,
    `process.exit(code >>> 0);`,
  ].join("\n"));
  chmodSync(ownerScript, 0o755);

  await writeFile(compiler, [
    `#!${process.execPath}`,
    `import { chmodSync, writeFileSync } from "node:fs";`,
    `const out = process.argv.slice(2).find(a => a.startsWith("/out:"))?.slice(5);`,
    `writeFileSync(out, "#!/bin/sh\\nexec " + ${JSON.stringify(JSON.stringify(process.execPath))} + " " + ${JSON.stringify(JSON.stringify(ownerScript))} + ' "$@"\\n');`,
    `chmodSync(out, 0o755);`,
  ].join("\n"));
  chmodSync(compiler, 0o755);
  return { compiler, ownerScript };
}

/** Read live /proc rows as `WinProcessRow`s plus optional boot-orphan / PID-reuse decoys. */
function procRows(decoys: readonly WinProcessRow[] = []): WinProcessRow[] {
  const rows: WinProcessRow[] = [...decoys];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (rest[0] === "Z" || rest[0] === "X") continue;
      const ppid = Number(rest[1]);
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      rows.push({ pid, ppid, start: ticksForPid(pid), command: cmd });
    } catch { /* vanished */ }
  }
  return rows;
}

/** Build a simulated Windows `Containment` backed by live `/proc` rows + hostile decoys, killing only verified targets. */
function makeWinContainment(opts: {
  decoys?: () => readonly WinProcessRow[];
  killed?: WinProcessIdentity[][];
  stuck?: Set<string>;
} = {}) {
  const decoys = opts.decoys ?? (() => []);
  const killed = opts.killed ?? [];
  const stuck = opts.stuck ?? new Set<string>();
  const base = new Containment({
    async list(knownExecs = new Set()) {
      const out: ProcInfo[] = [];
      for (const row of procRows(decoys())) {
        const tag = winTag(row.command, "DSA_EXEC");
        out.push({
          pid: row.pid,
          ppid: row.ppid,
          start: row.start,
          ...(tag && knownExecs.has(tag) ? { tag } : {}),
        });
      }
      return out;
    },
  }, {
    platform: "win32",
    captureStart: async pid => ticksForPid(pid),
    fenceTimeoutMs: 5000,
    killWindows: async targets => {
      killed.push(targets.map(t => ({ ...t })));
      for (const target of targets) {
        if (decoys().some(d => d.pid === target.pid)) throw new Error(`Targeted decoy pid ${target.pid}!`);
        if (ticksForPid(target.pid) !== target.start) continue;
        try { process.kill(target.pid, "SIGKILL"); } catch { /* gone */ }
      }
    },
    killPosix: pid => assert.fail(`Windows containment must never send POSIX signal to pid ${pid}`),
  });
  return {
    spawn: base.spawn.bind(base),
    scan: base.scan.bind(base),
    async fence(exec: string, tracked: readonly ProcInfo[], fenceOpts?: Parameters<Containment["fence"]>[2]) {
      if (stuck.has(exec)) throw new Error(`Fence timeout: ${exec}`);
      return base.fence(exec, tracked, fenceOpts);
    },
  };
}

async function setupEnv(t: test.TestContext, wid: string) {
  const root = await mkdtemp(join(tmpdir(), "dsa-win-gate-")), cwd = join(root, "repo"), home = join(root, "state");
  await mkdir(cwd, { recursive: true });
  const journalPath = join(home, "w", wid, "journal.jsonl");
  const journal = await openJournal(journalPath);
  const orch = await openJournal(join(home, "orchestrator.jsonl"));
  t.after(async () => {
    cleanupRootProcesses(root);
    await journal.close().catch(() => {});
    await orch.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const ticket: CallTicket = {
    wid, widRev: `${wid}@1`, key: "task", gen: 1, callId: `${wid}@1/task@1`,
    spec: { agent: "test", task: "task" }, cwd, journal,
    agent: { name: "test", description: "", body: "", source: "project", sourcePath: "", systemPromptMode: "append", inheritProjectContext: false, inheritSkills: false },
  };
  const result: CallResult = { key: ticket.key, gen: 1, status: "ok", ok: true, output: "complete\n" };
  return { root, cwd, home, journalPath, journal, orch, ticket, result, ledgers: { home, orch, config: {} } };
}

/** Write a separate Node orchestrator runner that runs `beforeSeal` on the given journal so tests can hard-kill it (`SIGKILL`)
 *  mid-launch without killing this test runner. */
async function writeGateRunner(root: string, compiler: string): Promise<string> {
  const journalUrl = new URL("../../../../src/kernel/journal.ts", import.meta.url).href;
  const effectsUrl = new URL("../../../../src/orchestrator/executor/effects/index.ts", import.meta.url).href;
  const containmentUrl = new URL("../../../../src/platform/containment.ts", import.meta.url).href;
  const windowsUrl = new URL("../../../../src/platform/windows.ts", import.meta.url).href;
  const runner = join(root, "run-win-gate.mjs");
  await writeFile(runner, [
    `import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";`,
    `import { openJournal } from ${JSON.stringify(journalUrl)};`,
    `import createEffects from ${JSON.stringify(effectsUrl)};`,
    `import { Containment } from ${JSON.stringify(containmentUrl)};`,
    `import { winTag } from ${JSON.stringify(windowsUrl)};`,
    `const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));`,
    `const T_BASE = 639000000500000000n;`,
    `const ticks = pid => String(T_BASE + BigInt(pid) * 1000n);`,
    `function rows() {`,
    `  const out = [];`,
    `  for (const n of readdirSync("/proc")) {`,
    `    if (!/^\\d+$/.test(n)) continue;`,
    `    const pid = Number(n);`,
    `    try {`,
    `      const st = readFileSync(\`/proc/\${pid}/stat\`, "utf8");`,
    `      const r = st.slice(st.lastIndexOf(")") + 2).split(" ");`,
    `      if (r[0] === "Z" || r[0] === "X") continue;`,
    `      const cmd = readFileSync(\`/proc/\${pid}/cmdline\`, "utf8").split("\\0").filter(Boolean).join(" ");`,
    `      out.push({ pid, ppid: Number(r[1]), start: ticks(pid), command: cmd });`,
    `    } catch {}`,
    `  }`,
    `  return out;`,
    `}`,
    `const containment = new Containment({`,
    `  async list(knownExecs = new Set()) {`,
    `    return rows().map(r => { const tag = winTag(r.command, "DSA_EXEC"); return { pid: r.pid, ppid: r.ppid, start: r.start, ...(tag && knownExecs.has(tag) ? { tag } : {}) }; });`,
    `  },`,
    `}, {`,
    `  platform: "win32",`,
    `  captureStart: async pid => ticks(pid),`,
    `  killWindows: async targets => { for (const t of targets) { if (ticks(t.pid) === t.start) { try { process.kill(t.pid, "SIGKILL"); } catch {} } } },`,
    `});`,
    `const journal = await openJournal(cfg.journalPath);`,
    `const orch = await openJournal(cfg.orchPath);`,
    `const effects = createEffects({ home: cfg.home, orch, config: {} }, containment, {`,
    `  platform: "win32",`,
    `  job: { compiler: ${JSON.stringify(compiler)}, observe: async () => rows() },`,
    `  beforeRecordTracked: async () => {`,
    `    if (process.env.GATE_TEST_TRACK_ENTERED) writeFileSync(process.env.GATE_TEST_TRACK_ENTERED, "1");`,
    `    while (process.env.GATE_TEST_TRACK_RELEASE && !existsSync(process.env.GATE_TEST_TRACK_RELEASE)) {`,
    `      await new Promise(r => setTimeout(r, 10));`,
    `    }`,
    `  },`,
    `});`,
    `const ticket = { ...cfg.ticket, journal };`,
    `await effects.beforeSeal(ticket, cfg.exec, cfg.result, { signal: new AbortController().signal });`,
    `await journal.close();`,
    `await orch.close();`,
  ].join("\n"));
  return runner;
}

test("Windows job gate: normal execution drains detached grandchildren, validates JSON/inputs, and honors nonzero/timeout/abort", { skip: linuxOnly, timeout: 30_000 }, async t => {
  const f = await setupEnv(t, "WINGATE1");
  const { compiler } = await createJobStandIn(f.root);
  const killed: WinProcessIdentity[][] = [];
  const decoys = (): WinProcessRow[] => [
    { pid: 6160, ppid: process.pid, start: T_BOOT, command: "csrss.exe" },
    { pid: 5000, ppid: 4, start: T_REUSED, command: "svchost.exe" },
    { pid: 5004, ppid: 5000, start: T_REUSED_CHILD, command: "dllhost.exe" },
  ];
  const containment = makeWinContainment({ decoys, killed });
  const gateOpts = {
    platform: "win32" as const,
    job: { compiler, observe: async () => procRows(decoys()) },
  };
  const effects = () => createEffects(f.ledgers, containment, gateOpts);

  // 1. Normal exit with JSON output + DSA_RESULT/DSA_OUTPUT/DSA_CALL verification + surviving detached grandchild drained.
  const grandPidFile = join(f.root, "normal-grand.pid");
  f.ticket.spec.gate = {
    command: `"${process.execPath}" -e ${JSON.stringify([
      "const { spawn } = require('node:child_process'), { readFileSync, writeFileSync } = require('node:fs');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });",
      "g.unref();",
      `writeFileSync(${JSON.stringify(grandPidFile)}, String(g.pid));`,
      "const res = JSON.parse(readFileSync(process.env.DSA_RESULT, 'utf8'));",
      "const out = readFileSync(process.env.DSA_OUTPUT, 'utf8').trim();",
      "process.stdout.write(JSON.stringify({ call: process.env.DSA_CALL, output: out, key: res.key }));",
    ].join(""))}`,
    output: "json",
    schema: { type: "object", required: ["call", "output", "key"] },
  };
  const ok = await effects().beforeSeal(f.ticket, `${f.ticket.callId}#1.1`, f.result, { signal: new AbortController().signal });
  assert.equal(ok.status, "ok");
  assert.deepEqual(ok.data, { gate: { call: f.ticket.callId, output: "complete", key: "task" } });
  const grandPid = Number(readFileSync(grandPidFile, "utf8").trim());
  assert.equal(pidAlive(grandPid), false, "detached grandchild ended with the gate Job Object before beforeSeal returned");
  const intent = f.journal.entries().find(e => e.type === "gate-intent")!;
  assert.equal(typeof intent.jobDir, "string");
  assert.ok(String(intent.jobDir).endsWith("job"), "gate-intent persists durable jobDir");
  assert.equal(killed.length, 0, "clean job exit needed no fence kill and never touched decoys");
  // Replay is idempotent and does not re-run the gate.
  assert.deepEqual(await effects().beforeSeal(f.ticket, `${f.ticket.callId}#1.1`, f.result, { signal: new AbortController().signal }), ok);
  assert.equal(f.journal.entries().filter(e => e.type === "gate-intent").length, 1);

  // 2. Nonzero exit drains surviving detached grandchild and records gate-failed with exit status.
  const fNz = await setupEnv(t, "WINGATENZ");
  const nzGrandFile = join(fNz.root, "nz-grand.pid");
  fNz.ticket.spec.gate = `"${process.execPath}" -e ${JSON.stringify([
    "const { spawn } = require('node:child_process'), { writeFileSync } = require('node:fs');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });",
    "g.unref();",
    `writeFileSync(${JSON.stringify(nzGrandFile)}, String(g.pid));`,
    "process.exit(7);",
  ].join(""))}`;
  const nz = await createEffects(fNz.ledgers, containment, gateOpts).beforeSeal(fNz.ticket, `${fNz.ticket.callId}#1.1`, fNz.result, { signal: new AbortController().signal });
  assert.equal(nz.status, "gate-failed");
  assert.match(nz.error!, /Gate exited 7/);
  assert.equal(pidAlive(Number(readFileSync(nzGrandFile, "utf8").trim())), false);
  assert.equal(killed.length, 0, "clean nonzero job exit also drained its grandchild without fence kills");

  // 3. Timeout terminates job owner + detached grandchild and records gate-failed.
  const f2 = await setupEnv(t, "WINGATE2");
  const toGrandFile = join(f2.root, "timeout-grand.pid");
  const toEffects = () => createEffects(f2.ledgers, containment, gateOpts);
  f2.ticket.spec.gate = {
    command: `"${process.execPath}" -e ${JSON.stringify([
      "const { spawn } = require('node:child_process'), { writeFileSync } = require('node:fs');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });",
      "g.unref();",
      `writeFileSync(${JSON.stringify(toGrandFile)}, String(g.pid));`,
      "setInterval(() => {}, 1000);",
    ].join(""))}`,
    timeoutMs: 250,
  };
  const timedOut = await toEffects().beforeSeal(f2.ticket, `${f2.ticket.callId}#1.1`, f2.result, { signal: new AbortController().signal });
  assert.equal(timedOut.status, "gate-failed");
  assert.match(timedOut.error!, /Gate timeout/);
  if (existsSync(toGrandFile)) {
    const toGrandPid = Number(readFileSync(toGrandFile, "utf8").trim());
    await until(() => !pidAlive(toGrandPid), "timed-out gate grandchild to exit", 5000);
    assert.equal(pidAlive(toGrandPid), false);
  }

  // 3. Abort terminates job owner + detached grandchild, preserves original result, skips output publication.
  const f3 = await setupEnv(t, "WINGATE3");
  const abGrandFile = join(f3.root, "abort-grand.pid");
  const ctl = new AbortController();
  f3.ticket.spec.output = "out.txt";
  f3.ticket.spec.gate = `"${process.execPath}" -e ${JSON.stringify([
    "const { spawn } = require('node:child_process'), { writeFileSync } = require('node:fs');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });",
    "g.unref();",
    `writeFileSync(${JSON.stringify(abGrandFile)}, String(g.pid));`,
    "setInterval(() => {}, 1000);",
  ].join(""))}`;
  const abEffects = createEffects(f3.ledgers, containment, gateOpts);
  const abPromise = abEffects.beforeSeal(f3.ticket, `${f3.ticket.callId}#1.1`, f3.result, { signal: ctl.signal });
  await until(() => existsSync(abGrandFile), "aborted gate grandchild spawned");
  const abGrandPid = Number(readFileSync(abGrandFile, "utf8").trim());
  ctl.abort();
  const abRes = await abPromise;
  assert.deepEqual(abRes, f3.result);
  await until(() => !pidAlive(abGrandPid), "aborted gate grandchild to exit", 5000);
  assert.equal(pidAlive(abGrandPid), false);
  assert.equal(f3.journal.entries().find(e => e.type === "gate")!.aborted, true);
  assert.equal(f3.journal.entries().filter(e => e.type === "output-intent").length, 0);
});

test("Windows job gate: hard-kill BEFORE group record leaves zero user action; recover fences verified owner and never replays", { skip: linuxOnly, timeout: 30_000 }, async t => {
  const f = await setupEnv(t, "WINPREGRP");
  const { compiler } = await createJobStandIn(f.root);
  const runner = await writeGateRunner(f.root, compiler);
  const preGroupEntered = join(f.root, "pre-group-entered");
  const preGroupRelease = join(f.root, "pre-group-release");
  const actionLog = join(f.root, "actions.log");

  const gateCmd = `"${process.execPath}" -e ${JSON.stringify(`require('node:fs').appendFileSync(${JSON.stringify(actionLog)}, 'ran\\n')`)}`;
  f.ticket.spec.gate = gateCmd;
  await f.journal.close();
  await f.orch.close();

  const cfgPath = join(f.root, "cfg.json");
  await writeFile(cfgPath, JSON.stringify({
    home: f.home, journalPath: f.journalPath, orchPath: join(f.home, "orchestrator.jsonl"),
    exec: `${f.ticket.callId}#1.1`, result: f.result,
    ticket: { wid: f.ticket.wid, widRev: f.ticket.widRev, key: f.ticket.key, gen: f.ticket.gen, callId: f.ticket.callId, spec: f.ticket.spec, cwd: f.cwd, agent: f.ticket.agent },
  }));

  const orchProc = spawn(process.execPath, [runner, cfgPath], {
    env: { ...process.env, GATE_TEST_PRE_GROUP_ENTERED: preGroupEntered, GATE_TEST_PRE_GROUP_RELEASE: preGroupRelease },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const orchExit = new Promise<void>(resolve => orchProc.once("exit", () => resolve()));

  // Barrier: owner started and wrote helper-begin, BEFORE writing `group` or running user code.
  const ownerPid = Number(await until(() => existsSync(preGroupEntered) && readFileSync(preGroupEntered, "utf8").trim(), "owner pre-group barrier"));
  t.after(() => { try { process.kill(ownerPid, "SIGKILL"); } catch {} });

  // Hard-kill the orchestrator mid-launch!
  orchProc.kill("SIGKILL");
  await orchExit;

  const reopened = await openJournal(f.journalPath);
  const reopenedOrch = await openJournal(join(f.home, "orchestrator.jsonl"));
  t.after(async () => { await reopened.close(); await reopenedOrch.close(); });

  const intent = reopened.entries().find(e => e.type === "gate-intent")!;
  assert.ok(intent?.jobDir, "gate-intent persisted jobDir before owner spawned");
  assert.equal(reopened.entries().filter(e => e.type === "gate-tracked").length, 0, "orchestrator died before gate-tracked");
  assert.equal(reopened.entries().filter(e => e.type === "gate").length, 0);
  assert.equal(existsSync(actionLog), false, "zero user actions executed before group record");
  assert.equal(pidAlive(ownerPid), true, "job owner is still alive before recovery");

  const killed: WinProcessIdentity[][] = [];
  const decoys = (): WinProcessRow[] => [
    { pid: 6160, ppid: ownerPid, start: T_BOOT, command: "csrss.exe" },
    { pid: 5000, ppid: 4, start: T_REUSED, command: "svchost.exe" },
    { pid: 5004, ppid: 5000, start: T_REUSED_CHILD, command: "dllhost.exe" },
  ];
  const containment = makeWinContainment({ decoys, killed });
  const effects = createEffects({ home: f.home, orch: reopenedOrch, config: {} }, containment, {
    platform: "win32", job: { compiler, observe: async () => procRows(decoys()) },
  });

  await effects.recover(reopened);
  await effects.recover(reopened); // idempotent
  assert.equal(pidAlive(ownerPid), false, "recoverGates terminated the pre-group job owner");
  assert.deepEqual(killed, [[{ pid: ownerPid, start: ticksForPid(ownerPid) }]], "targeted only the verified owner, never decoys");
  assert.equal(reopened.entries().filter(e => e.type === "gate").length, 1);
  assert.equal(reopened.entries().find(e => e.type === "gate")!.unknown, true);
  assert.equal(existsSync(actionLog), false, "still zero user actions after recovery");

  // Re-entering beforeSeal after recovery returns unknown and NEVER replays the gate.
  const after = await effects.beforeSeal({ ...f.ticket, journal: reopened }, `${f.ticket.callId}#1.1`, f.result, { signal: new AbortController().signal });
  assert.equal(after.status, "unknown");
  assert.equal(existsSync(actionLog), false);
  assert.equal(reopened.entries().filter(e => e.type === "gate-intent").length, 1);
});

test("Windows job gate: hard-kill AFTER group record (before gate-tracked) recovers via jobDir, ends detached grandchild, and never replays", { skip: linuxOnly, timeout: 30_000 }, async t => {
  const f = await setupEnv(t, "WINPOSTGRP");
  const { compiler } = await createJobStandIn(f.root);
  const runner = await writeGateRunner(f.root, compiler);
  const trackEntered = join(f.root, "track-entered");
  const trackRelease = join(f.root, "track-release");
  const actionLog = join(f.root, "actions.log");
  const grandPidFile = join(f.root, "grand.pid");

  f.ticket.spec.gate = `"${process.execPath}" -e ${JSON.stringify([
    "const { spawn } = require('node:child_process'), { appendFileSync, writeFileSync } = require('node:fs');",
    `appendFileSync(${JSON.stringify(actionLog)}, 'ran\\n');`,
    "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });",
    "g.unref();",
    `writeFileSync(${JSON.stringify(grandPidFile)}, String(g.pid));`,
    "setInterval(() => {}, 1000);",
  ].join(""))}`;
  await f.journal.close();
  await f.orch.close();

  const cfgPath = join(f.root, "cfg.json");
  await writeFile(cfgPath, JSON.stringify({
    home: f.home, journalPath: f.journalPath, orchPath: join(f.home, "orchestrator.jsonl"),
    exec: `${f.ticket.callId}#1.1`, result: f.result,
    ticket: { wid: f.ticket.wid, widRev: f.ticket.widRev, key: f.ticket.key, gen: f.ticket.gen, callId: f.ticket.callId, spec: f.ticket.spec, cwd: f.cwd, agent: f.ticket.agent },
  }));

  const orchProc = spawn(process.execPath, [runner, cfgPath], {
    env: { ...process.env, GATE_TEST_TRACK_ENTERED: trackEntered, GATE_TEST_TRACK_RELEASE: trackRelease },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const orchExit = new Promise<void>(resolve => orchProc.once("exit", () => resolve()));

  // Barrier: orchestrator is paused BEFORE appending `gate-tracked`, AND gate command already ran + spawned detached grandchild.
  await until(() => existsSync(trackEntered) && existsSync(grandPidFile), "paused pre-tracked barrier + detached grandchild");
  const grandPid = Number(readFileSync(grandPidFile, "utf8").trim());
  t.after(() => { try { process.kill(grandPid, "SIGKILL"); } catch {} });

  // Hard-kill the orchestrator before `gate-tracked` is journaled!
  orchProc.kill("SIGKILL");
  await orchExit;

  const reopened = await openJournal(f.journalPath);
  const reopenedOrch = await openJournal(join(f.home, "orchestrator.jsonl"));
  t.after(async () => { await reopened.close(); await reopenedOrch.close(); });

  const intent = reopened.entries().find(e => e.type === "gate-intent")!;
  assert.ok(intent?.jobDir);
  assert.equal(reopened.entries().filter(e => e.type === "gate-tracked").length, 0, "no gate-tracked entry survived hard-kill");
  assert.equal(pidAlive(grandPid), true, "detached grandchild is still running before recovery");

  const killed: WinProcessIdentity[][] = [];
  const decoys = (): WinProcessRow[] => [
    { pid: 6160, ppid: orchProc.pid!, start: T_BOOT, command: "csrss.exe" },
    { pid: 5000, ppid: 4, start: T_REUSED, command: "svchost.exe" },
  ];
  const containment = makeWinContainment({ decoys, killed });
  const effects = createEffects({ home: f.home, orch: reopenedOrch, config: {} }, containment, {
    platform: "win32", job: { compiler, observe: async () => procRows(decoys()) },
  });

  await effects.recover(reopened);
  await until(() => !pidAlive(grandPid), "detached grandchild to exit after Job Object owner fence", 5000);
  assert.equal(pidAlive(grandPid), false, "recoverGates closed the Job Object and ended the detached grandchild");
  assert.ok(killed.length >= 1, "fence terminated verified Job Object process(es)");
  assert.equal(reopened.entries().filter(e => e.type === "gate").length, 1);
  assert.equal(reopened.entries().find(e => e.type === "gate")!.unknown, true);

  // Re-entering beforeSeal returns unknown and NEVER replays the side-effecting gate.
  const after = await effects.beforeSeal({ ...f.ticket, journal: reopened }, `${f.ticket.callId}#1.1`, f.result, { signal: new AbortController().signal });
  assert.equal(after.status, "unknown");
  assert.equal((await readFile(actionLog, "utf8")).trim(), "ran", "side-effecting gate ran exactly once");
});

test("Windows job gate: fence timeout during recovery parks gate and sweepExecutions retries via durable jobDir", { skip: linuxOnly, timeout: 30_000 }, async t => {
  const f = await setupEnv(t, "WINSWEEP");
  const { compiler } = await createJobStandIn(f.root);
  const runner = await writeGateRunner(f.root, compiler);
  const trackEntered = join(f.root, "track-entered");
  const trackRelease = join(f.root, "track-release");
  const actionLog = join(f.root, "actions.log");
  const grandPidFile = join(f.root, "grand.pid");

  f.ticket.spec.gate = `"${process.execPath}" -e ${JSON.stringify([
    "const { spawn } = require('node:child_process'), { appendFileSync, writeFileSync } = require('node:fs');",
    `appendFileSync(${JSON.stringify(actionLog)}, 'ran\\n');`,
    "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });",
    "g.unref();",
    `writeFileSync(${JSON.stringify(grandPidFile)}, String(g.pid));`,
    "setInterval(() => {}, 1000);",
  ].join(""))}`;
  await f.journal.close();
  await f.orch.close();

  const cfgPath = join(f.root, "cfg.json");
  await writeFile(cfgPath, JSON.stringify({
    home: f.home, journalPath: f.journalPath, orchPath: join(f.home, "orchestrator.jsonl"),
    exec: `${f.ticket.callId}#1.1`, result: f.result,
    ticket: { wid: f.ticket.wid, widRev: f.ticket.widRev, key: f.ticket.key, gen: f.ticket.gen, callId: f.ticket.callId, spec: f.ticket.spec, cwd: f.cwd, agent: f.ticket.agent },
  }));

  const orchProc = spawn(process.execPath, [runner, cfgPath], {
    env: { ...process.env, GATE_TEST_TRACK_ENTERED: trackEntered, GATE_TEST_TRACK_RELEASE: trackRelease },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const orchExit = new Promise<void>(resolve => orchProc.once("exit", () => resolve()));
  await until(() => existsSync(trackEntered) && existsSync(grandPidFile), "paused pre-tracked barrier + grandchild");
  const grandPid = Number(readFileSync(grandPidFile, "utf8").trim());
  t.after(() => { try { process.kill(grandPid, "SIGKILL"); } catch {} });

  orchProc.kill("SIGKILL");
  await orchExit;

  const reopened = await openJournal(f.journalPath);
  const reopenedOrch = await openJournal(join(f.home, "orchestrator.jsonl"));
  t.after(async () => { await reopened.close(); await reopenedOrch.close(); });

  const gid = `gate:${f.ticket.callId}#1`;
  const stuck = new Set<string>([gid]);
  const killed: WinProcessIdentity[][] = [];
  const decoys = (): WinProcessRow[] => [{ pid: 6160, ppid: orchProc.pid!, start: T_BOOT, command: "csrss.exe" }];
  const containment = makeWinContainment({ decoys, killed, stuck });
  const effects = createEffects({ home: f.home, orch: reopenedOrch, config: {} }, containment, {
    platform: "win32", job: { compiler, observe: async () => procRows(decoys()) },
  });

  // 1. Recovery fence times out -> fence-failed + unknown attention recorded, no `gate` outcome yet, grandchild still alive.
  await effects.recover(reopened);
  assert.equal(reopened.entries().filter(e => e.type === "gate-tracked").length, 0);
  assert.equal(reopened.entries().filter(e => e.type === "fence-failed" && e.exec === gid).length, 1);
  assert.equal(reopened.entries().filter(e => e.type === JT.attention && (e.item as { id: string }).id === `fence:${gid}`).length, 1);
  assert.equal(reopened.entries().filter(e => e.type === "gate").length, 0);
  assert.equal(pidAlive(grandPid), true);

  // 2. Call parks in beforeSeal while gate remains unfenced; sweep retries with jobDir identities once unstuck!
  const parked = effects.beforeSeal({ ...f.ticket, journal: reopened }, `${f.ticket.callId}#1.1`, f.result, { signal: new AbortController().signal });
  await delay(60);
  assert.equal(reopened.entries().filter(e => e.type === "gate").length, 0, "call stays parked until sweep fences the gate");

  stuck.delete(gid);
  await sweepExecutions([reopened], containment, {
    fenced: async (j, id) => { if (id.startsWith("gate:")) await gateRetired(j, id); },
  });

  const outcome = await parked;
  assert.equal(outcome.status, "unknown");
  await until(() => !pidAlive(grandPid), "grandchild to exit after sweep fence", 5000);
  assert.equal(pidAlive(grandPid), false);
  assert.ok(killed.length >= 1, "sweep used durable jobDir identities to kill the Job Object");
  assert.ok(reopened.entries().some(e => e.type === JT.attentionResolved && e.id === `fence:${gid}` && e.resolution === "fenced"));
  assert.equal((await readFile(actionLog, "utf8")).trim(), "ran", "never replayed");
});

test("Windows job gate: uncertain owner adoption still tracks, fences, and never replays", { skip: linuxOnly, timeout: 30_000 }, async t => {
  const f = await setupEnv(t, "WINADOPT");
  const { compiler } = await createJobStandIn(f.root);
  const actionLog = join(f.root, "actions.log");
  const grandPidFile = join(f.root, "adopt-grand.pid");
  const killed: WinProcessIdentity[][] = [];
  const containment = makeWinContainment({ killed });

  f.ticket.spec.gate = `"${process.execPath}" -e ${JSON.stringify([
    "const { spawn } = require('node:child_process'), { appendFileSync, writeFileSync } = require('node:fs');",
    `appendFileSync(${JSON.stringify(actionLog)}, 'ran\\n');`,
    "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });",
    "g.unref();",
    `writeFileSync(${JSON.stringify(grandPidFile)}, String(g.pid));`,
    "setInterval(() => {}, 1000);",
  ].join(""))}`;

  const effects = createEffects(f.ledgers, containment, {
    platform: "win32",
    job: {
      compiler,
      observeMs: 40,
      endMs: 40,
      observe: async () => { throw new Error("cim unavailable"); },
      endHelper: async () => { throw new Error("kill denied"); },
    },
  });

  const res = await effects.beforeSeal(f.ticket, `${f.ticket.callId}#1.1`, f.result, { signal: new AbortController().signal });
  assert.equal(res.status, "gate-failed");
  assert.match(res.error!, /could not be observed/);
  assert.ok(f.journal.entries().some(e => e.type === "gate-tracked"), "adopted owner/job identities were journaled");
  if (existsSync(grandPidFile)) {
    const gpid = Number(readFileSync(grandPidFile, "utf8").trim());
    await until(() => !pidAlive(gpid), "adopted gate grandchild to exit", 5000);
    assert.equal(pidAlive(gpid), false);
  }
  // Never replays on second call.
  const second = await effects.beforeSeal(f.ticket, `${f.ticket.callId}#1.1`, f.result, { signal: new AbortController().signal });
  assert.deepEqual(second, res);
  assert.equal(f.journal.entries().filter(e => e.type === "gate-intent").length, 1);
  if (existsSync(actionLog)) assert.equal((await readFile(actionLog, "utf8")).trim(), "ran");
});
