// Deterministic barrier regression tests for Windows Job Object `hold` ownership across mid-launch wrapper hard-kills,
// post-command grandchild cleanup, dead-parent PID reuse / boot-orphan immunity, stdio/exit/yield/signals, and 127 errors.
// Runs on Linux using a /proc-backed Job Object stand-in (native csc.exe + Win32 Job Objects run in
// hold-windows.test.ts on Windows). Every harmful window is held open with explicit file barriers -- never arbitrary sleeps.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hold, parseHold, resolveWinHoldTarget } from "../../../src/cli/hold.ts";
import { endLeaseProcesses, enqueue, leaseDir, leaseJobDir, live, liveTickets, orphaned, readTickets, type EndLeaseOptions, type LeaseTicket } from "../../../src/platform/lease.ts";
import type { WinProcessIdentity, WinProcessRow } from "../../../src/platform/windows.ts";

const posixOnly = process.platform === "linux" ? false : "the stand-in uses Linux /proc to track detached descendants";

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

/** Kill any stray test process referencing `home` so a failed assertion can never leak processes or hold test pipes. */
function cleanupHomeProcesses(home: string): void {
  if (existsSync("/proc")) {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      const pid = Number(name);
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        const env = readFileSync(`/proc/${pid}/environ`, "utf8");
        if (cmd.includes(home) || env.includes(`DSA_HOME=${home}`)) process.kill(pid, "SIGKILL");
      } catch { /* gone or foreign */ }
    }
    return;
  }
  try {
    const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m && Number(m[1]) !== process.pid && m[2]!.includes(home)) {
        try { process.kill(Number(m[1]), "SIGKILL"); } catch { /* gone */ }
      }
    }
  } catch { /* ignore */ }
}

/** Build a real-process fake `csc.exe` whose compiled `DsaJob.exe` implements the exact `job.ts` file protocol (`helper-begin`,
 *  `job.json` UTF-16LE base64 spec, `group` written BEFORE spawning the child, `DrainJob` killing the child's process group on
 *  child exit or owner SIGTERM/exit, `group-end` and `start-error`). */
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
    // Optional pre-group barrier: pauses BEFORE creating/resuming the user command or writing `group`.
    `if (env.HOLD_TEST_PRE_GROUP_ENTERED) {`,
    `  writeFileSync(env.HOLD_TEST_PRE_GROUP_ENTERED, String(process.pid));`,
    `  while (env.HOLD_TEST_PRE_GROUP_RELEASE && !existsSync(env.HOLD_TEST_PRE_GROUP_RELEASE)) {`,
    `    await new Promise(r => setTimeout(r, 10));`,
    `  }`,
    `}`,
    `if (!existsSync(exe)) {`,
    `  writeFileSync(join(dir, "start-error"), \`CreateProcess \${exe} failed (error 2)\`);`,
    `  process.exit(125);`,
    `}`,
    // Gate child before user code runs so `group` is durably written BEFORE any user action executes.
    `const gateFile = join(dir, ".resume-child");`,
    `const wrappedArgs = ["-e", \`const fs=require("node:fs");while(!fs.existsSync(\${JSON.stringify(gateFile)})){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}const {spawnSync}=require("node:child_process");const r=spawnSync(\${JSON.stringify(exe)},\${JSON.stringify(args)},{stdio:"inherit",env:process.env,cwd:\${JSON.stringify(cwd)}});process.exit(r.status??1);\`` + `];`,
    `const child = spawn(process.execPath, wrappedArgs, { cwd, env, detached: true, stdio: logPath ? "ignore" : "inherit" });`,
    `const childPgid = child.pid;`,
    `const holdMarker = env.DSA_HOLD ? \`DSA_HOLD=\${env.DSA_HOLD}\` : "";`,
    `const homeMarker = env.DSA_HOME ? \`DSA_HOME=\${env.DSA_HOME}\` : "";`,
    `const drainScript = [`,
    `  "const { existsSync, readdirSync, readFileSync } = require('node:fs');",`,
    `  "const pgid = Number(process.argv[1]), ownerPid = Number(process.argv[2]), marker = process.argv[3], homeMarker = process.argv[4];",`,
    `  "const sweep = () => {",`,
    `  "  if (pgid) { try { process.kill(-pgid, 'SIGKILL'); } catch {} }",`,
    `  "  if (marker && existsSync('/proc')) {",`,
    `  "    for (const n of readdirSync('/proc')) {",`,
    `  "      const p = Number(n);",`,
    `  "      if (!p || p === process.pid || p === ownerPid) continue;",`,
    `  "      try {",`,
    `  "        const entries = readFileSync('/proc/' + p + '/environ', 'utf8').split('\\\\0');",`,
    `  "        if (entries.includes(marker) && (!homeMarker || entries.includes(homeMarker))) process.kill(p, 'SIGKILL');",`,
    `  "      } catch {}",`,
    `  "    }",`,
    `  "  }",`,
    `  "};",`,
    `  "process.stdin.resume();",`,
    `  "process.stdin.once('end', () => { sweep(); setTimeout(() => { sweep(); process.exit(0); }, 15); });",`,
    `].join("");`,
    // Kernel pipe-EOF watchdog: models Win32 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE even when this owner receives SIGKILL.
    `const reaper = spawn(process.execPath, ["-e", drainScript, String(childPgid), String(process.pid), holdMarker, homeMarker], { detached: true, stdio: ["pipe", "ignore", "ignore"] });`,
    `reaper.stdin.on("error", () => {});`,
    `reaper.unref();`,
    `const drainJob = () => {`,
    `  if (childPgid) { try { process.kill(-childPgid, "SIGKILL"); } catch {} }`,
    `  if (holdMarker && existsSync("/proc")) {`,
    `    for (const n of readdirSync("/proc")) {`,
    `      if (!/^\\d+$/.test(n) || Number(n) === process.pid || Number(n) === reaper.pid) continue;`,
    `      try {`,
    `        const entries = readFileSync(\`/proc/\${n}/environ\`, "utf8").split("\\0");`,
    `        if (entries.includes(holdMarker) && (!homeMarker || entries.includes(homeMarker))) process.kill(Number(n), "SIGKILL");`,
    `      } catch {}`,
    `    }`,
    `  }`,
    `};`,
    `const nonZombieGroupAlive = pgid => {`,
    `  try { process.kill(-pgid, 0); } catch { return false; }`,
    `  if (!existsSync("/proc")) return true;`,
    `  for (const n of readdirSync("/proc")) {`,
    `    if (!/^\\d+$/.test(n)) continue;`,
    `    try {`,
    `      const r = readFileSync(\`/proc/\${n}/stat\`, "utf8").split(") ")[1].split(" ");`,
    `      if (Number(r[2]) === pgid && r[0] !== "Z" && r[0] !== "X") return true;`,
    `    } catch {}`,
    `  }`,
    `  return false;`,
    `};`,
    `for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { drainJob(); process.exit(1); });`,
    `await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });`,
    `writeAtomic(join(dir, "group"), JSON.stringify({ pid: child.pid, start: ticks(child.pid), group: ownerIdentity }));`,
    `writeFileSync(gateFile, "go");`,
    `const stopPath = join(dir, "stop");`,
    `const outcome = await new Promise(resolve => {`,
    `  let settled = false;`,
    `  const finish = result => { if (settled) return; settled = true; clearInterval(iv); resolve(result); };`,
    `  child.once("exit", c => finish({ stopped: false, code: c ?? 1 }));`,
    `  const iv = setInterval(() => {`,
    `    if (env.HOLD_TEST_IGNORE_STOP !== "1" && existsSync(stopPath)) finish({ stopped: true, code: 1 });`,
    `  }, 15);`,
    `});`,
    `if (outcome.stopped && env.HOLD_TEST_STOP_OBSERVED) writeFileSync(env.HOLD_TEST_STOP_OBSERVED, "1");`,
    `drainJob();`,
    `for (let i = 0; i < 100; i++) {`,
    `  if (!nonZombieGroupAlive(childPgid)) break;`,
    `  await new Promise(r => setTimeout(r, 10));`,
    `}`,
    `if (!outcome.stopped) writeAtomic(join(dir, "group-end"), JSON.stringify({ status: outcome.code >>> 0 }));`,
    `process.exit(outcome.code >>> 0);`,
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

/** Read live host processes into `WinProcessRow` entries plus injected boot-orphan / PID-reuse decoys. */
function procSnapshot(decoys: readonly WinProcessRow[] = []): Map<number, WinProcessRow> {
  const map = new Map<number, WinProcessRow>();
  for (const d of decoys) map.set(d.pid, d);
  if (existsSync("/proc")) {
    for (const name of readdirSync("/proc").filter(n => /^\d+$/.test(n))) {
      const pid = Number(name);
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (rest[0] === "Z" || rest[0] === "X") continue;
        const ppid = Number(rest[1]);
        const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
        map.set(pid, { pid, ppid, start: ticksForPid(pid), command: cmd });
      } catch { /* vanished */ }
    }
    return map;
  }
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,state=,command="], { encoding: "utf8" });
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m || m[3]!.startsWith("Z")) continue;
    const pid = Number(m[1]), ppid = Number(m[2]);
    map.set(pid, { pid, ppid, start: ticksForPid(pid), command: m[4]! });
  }
  return map;
}

/** Spawn a real separate Node holder process running `hold(..., { platform: "win32", ... })` so we can hard-kill (`SIGKILL`)
 *  the wrapper mid-launch without killing this test runner. */
async function writeHolderRunner(root: string, compiler: string): Promise<string> {
  const holdUrl = new URL("../../../src/cli/hold.ts", import.meta.url).href;
  const runner = join(root, "run-win-hold.mjs");
  await writeFile(runner, [
    `import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";`,
    `import { execFileSync } from "node:child_process";`,
    `import { hold, parseHold } from ${JSON.stringify(holdUrl)};`,
    `const T_BASE = 639000000500000000n;`,
    `const ticks = pid => String(T_BASE + BigInt(pid) * 1000n);`,
    `function snap() {`,
    `  const m = new Map();`,
    `  if (existsSync("/proc")) {`,
    `    for (const n of readdirSync("/proc")) {`,
    `      if (!/^\\d+$/.test(n)) continue;`,
    `      const pid = Number(n);`,
    `      try {`,
    `        const st = readFileSync(\`/proc/\${pid}/stat\`, "utf8");`,
    `        const r = st.slice(st.lastIndexOf(")") + 2).split(" ");`,
    `        if (r[0] === "Z" || r[0] === "X") continue;`,
    `        const cmd = readFileSync(\`/proc/\${pid}/cmdline\`, "utf8").split("\\0").filter(Boolean).join(" ");`,
    `        m.set(pid, { pid, ppid: Number(r[1]), start: ticks(pid), command: cmd });`,
    `      } catch {}`,
    `    }`,
    `    return m;`,
    `  }`,
    `  const out = execFileSync("ps", ["-axo", "pid=,ppid=,state=,command="], { encoding: "utf8" });`,
    `  for (const l of out.split(/\\r?\\n/)) {`,
    `    const x = /^\\s*(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(.*)$/.exec(l);`,
    `    if (x && !x[3].startsWith("Z")) m.set(Number(x[1]), { pid: Number(x[1]), ppid: Number(x[2]), start: ticks(Number(x[1])), command: x[4] });`,
    `  }`,
    `  return m;`,
    `}`,
    `const lease = {`,
    `  platform: "win32",`,
    `  snapshotWin: () => snap(),`,
    `  startWinSync: pid => snap().get(pid)?.start ?? "",`,
    `  killOwnerWinSync: targets => { for (const t of targets) { try { process.kill(t.pid, "SIGTERM"); } catch {} } },`,
    `};`,
    `const code = await hold(parseHold(process.argv.slice(2)), {`,
    `  platform: "win32",`,
    `  pollMs: 25,`,
    `  graceMs: 100,`,
    `  captureWrapperStart: async pid => ticks(pid),`,
    `  lease,`,
    `  job: { compiler: ${JSON.stringify(compiler)}, observe: async () => [...snap().values()] },`,
    `  beforeRecordCommand: async () => {`,
    `    if (process.env.HOLD_TEST_RECORD_ENTERED) writeFileSync(process.env.HOLD_TEST_RECORD_ENTERED, "1");`,
    `    while (process.env.HOLD_TEST_RECORD_RELEASE && !existsSync(process.env.HOLD_TEST_RECORD_RELEASE)) {`,
    `      await new Promise(r => setTimeout(r, 10));`,
    `    }`,
    `  },`,
    `});`,
    `process.exitCode = code;`,
  ].join("\n"));
  return runner;
}

function makeWinLeaseSeam(decoys: () => readonly WinProcessRow[] = () => [], killed: WinProcessIdentity[][] = []): EndLeaseOptions {
  return {
    platform: "win32",
    snapshotWin: () => procSnapshot(decoys()),
    startWinSync: pid => procSnapshot(decoys()).get(pid)?.start ?? "",
    processAlive: pid => decoys().some(d => d.pid === pid) || pidAlive(pid),
    killOwnerWinSync: targets => {
      killed.push(targets.map(t => ({ ...t })));
      for (const target of targets) {
        if (decoys().some(d => d.pid === target.pid)) throw new Error(`Targeted decoy pid ${target.pid}!`);
        try { process.kill(target.pid, "SIGTERM"); } catch { /* gone */ }
      }
    },
  };
}

test("Windows job hold: mid-launch hard-kill BEFORE group record leaves zero user action, blocks no-wait and reclaims verified owner", { skip: posixOnly, timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-win-job-m1-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { compiler } = await createJobStandIn(home);
  const runner = await writeHolderRunner(home, compiler);

  const preGroupEntered = join(home, "pre-group-entered");
  const preGroupRelease = join(home, "pre-group-release");
  const actionLog = join(home, "actions.log");

  const holderA = spawn(process.execPath, [runner, "machine", "--", process.execPath, "-e",
    `require('node:fs').appendFileSync(${JSON.stringify(actionLog)}, 'a-ran\\n')`], {
    env: {
      ...process.env,
      DSA_HOME: home,
      DSA_CALL: undefined,
      DSA_EXEC: undefined,
      HOLD_TEST_PRE_GROUP_ENTERED: preGroupEntered,
      HOLD_TEST_PRE_GROUP_RELEASE: preGroupRelease,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const holderAExit = new Promise<void>(resolve => holderA.once("exit", () => resolve()));

  // Barrier: DsaJob owner has started, BEFORE writing `group` and BEFORE starting user command.
  const ownerPid = Number(await until(() => existsSync(preGroupEntered) && readFileSync(preGroupEntered, "utf8").trim(), "owner pre-group barrier"));
  t.after(() => { try { process.kill(ownerPid, "SIGKILL"); } catch {} });

  // Hard-kill wrapper A mid-launch!
  holderA.kill("SIGKILL");
  await holderAExit;

  const ticketsAfterKill = readTickets(home, "machine");
  assert.equal(ticketsAfterKill.length, 1);
  const savedA = ticketsAfterKill[0]!;
  assert.ok(savedA.jobDir, "jobDir was durably persisted before spawning the owner");
  assert.equal(savedA.command, undefined, "wrapper died before ticket.command could be written");
  assert.equal(savedA.group, undefined, "wrapper died before ticket.group could be written");
  assert.equal(existsSync(actionLog), false, "zero user actions executed before group record");

  // Inject hostile decoys sharing dead wrapper A's PID as ppid (boot orphan 6160) plus recycled PID 5000.
  const killedTargets: WinProcessIdentity[][] = [];
  const decoys = (): WinProcessRow[] => [
    { pid: 6160, ppid: holderA.pid!, start: T_BOOT, command: "csrss.exe" },
    { pid: 5000, ppid: 4, start: T_REUSED, command: "svchost.exe" },
    { pid: 5004, ppid: 5000, start: T_REUSED_CHILD, command: "dllhost.exe" },
  ];
  const seam = makeWinLeaseSeam(decoys, killedTargets);

  // Ticket A stays live (blocks --no-wait!) and is classified orphaned so a queued waiter reclaims the stalled owner.
  assert.equal(live(savedA, seam), true);
  assert.equal(orphaned(savedA, seam), true);

  const noWaitStderr: string[] = [];
  const noWaitCode = await hold(parseHold(["machine", "--no-wait", "--", process.execPath, "-e",
    `require('node:fs').appendFileSync(${JSON.stringify(actionLog)}, 'nowait-ran\\n')`]), {
    env: { ...process.env, DSA_HOME: home },
    platform: "win32",
    captureWrapperStart: async pid => ticksForPid(pid),
    lease: seam,
    job: { compiler, observe: async () => [...procSnapshot(decoys()).values()] },
    stderr: l => noWaitStderr.push(l),
  });
  assert.equal(noWaitCode, 75, "--no-wait must not overlap with a mid-launch owner");
  assert.match(noWaitStderr.join("\n"), /not free now/);
  assert.equal(existsSync(actionLog), false);

  // Queued waiter B reclaims orphaned owner by verified (ownerPid, ownerStart), waits for it to exit, then runs exclusively.
  const waiterStderr: string[] = [];
  const waiterCode = await hold(parseHold(["machine", "--", process.execPath, "-e",
    `require('node:fs').appendFileSync(${JSON.stringify(actionLog)}, 'b-ran\\n')`]), {
    env: { ...process.env, DSA_HOME: home },
    platform: "win32",
    pollMs: 25,
    graceMs: 100,
    captureWrapperStart: async pid => ticksForPid(pid),
    lease: seam,
    job: { compiler, observe: async () => [...procSnapshot(decoys()).values()] },
    stderr: l => waiterStderr.push(l),
  });
  assert.equal(waiterCode, 0);
  assert.match(waiterStderr.join("\n"), /ending processes left by/);
  assert.deepEqual(killedTargets, [[{ pid: ownerPid, start: ticksForPid(ownerPid) }]], "terminates only the verified job owner");
  assert.equal(pidAlive(ownerPid), false, "owner is confirmed gone before B ran");
  assert.deepEqual((await readFile(actionLog, "utf8")).trim().split("\n"), ["b-ran"]);
  assert.deepEqual(liveTickets(home, "machine", seam), []);
});

test("Windows job hold: mid-launch hard-kill AFTER group record (before ticket.command JSON) keeps running work holding lease and drains grandchildren", { skip: posixOnly, timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-win-job-m2-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { compiler } = await createJobStandIn(home);
  const runner = await writeHolderRunner(home, compiler);

  const recordEntered = join(home, "record-entered");
  const recordRelease = join(home, "record-release");
  const cmdStarted = join(home, "cmd-started");
  const cmdFinish = join(home, "cmd-finish");
  const grandPidFile = join(home, "grand.pid");
  const logFile = join(home, "order.log");

  // Holder A's command spawns a detached grandchild, writes `a-start`, and waits on `cmdFinish` before writing `a-end` and exiting 0.
  const holderA = spawn(process.execPath, [
    runner, "machine", "--", process.execPath, "-e",
    [
      "const { spawn } = require('node:child_process');",
      "const { appendFileSync, existsSync, writeFileSync } = require('node:fs');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });",
      "g.unref();",
      "writeFileSync(process.argv[1], String(g.pid));",
      "appendFileSync(process.argv[2], 'a-start\\n');",
      "writeFileSync(process.argv[3], '1');",
      "const iv = setInterval(() => { if (existsSync(process.argv[4])) { clearInterval(iv); appendFileSync(process.argv[2], 'a-end\\n'); process.exit(0); } }, 15);",
    ].join(""),
    grandPidFile, logFile, cmdStarted, cmdFinish,
  ], {
    env: {
      ...process.env,
      DSA_HOME: home,
      DSA_CALL: undefined,
      DSA_EXEC: undefined,
      HOLD_TEST_RECORD_ENTERED: recordEntered,
      HOLD_TEST_RECORD_RELEASE: recordRelease,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const holderAExit = new Promise<void>(resolve => holderA.once("exit", () => resolve()));

  // Wait until BOTH: wrapper A is paused BEFORE recording `ticket.command`, AND command A has already started & spawned its grandchild.
  await until(() => existsSync(recordEntered) && existsSync(cmdStarted) && existsSync(grandPidFile), "paused pre-record window + running command");
  const grandPid = Number(readFileSync(grandPidFile, "utf8").trim());
  t.after(() => { try { process.kill(grandPid, "SIGKILL"); } catch {} });

  // Hard-kill wrapper A while `ticket.command` is still undefined in 000000000001.json!
  holderA.kill("SIGKILL");
  await holderAExit;

  const savedA = readTickets(home, "machine")[0]!;
  assert.equal(savedA.command, undefined, "000000000001.json still lacks command");
  const seam = makeWinLeaseSeam();

  // Recovery from `savedA.jobDir/group`: command is live and NOT orphaned -> waiters must wait, never kill A!
  assert.equal(live(savedA, seam), true);
  assert.equal(orphaned(savedA, seam), false);

  const waiterDone = hold(parseHold(["machine", "--", process.execPath, "-e", [
    "const { appendFileSync, readFileSync } = require('node:fs');",
    "const gpid = Number(readFileSync(process.argv[1], 'utf8'));",
    "let gAlive = true; try { process.kill(gpid, 0); } catch { gAlive = false; }",
    "appendFileSync(process.argv[2], gAlive ? 'b-saw-grand-alive\\n' : 'b-start\\n');",
  ].join(""), grandPidFile, logFile]), {
    env: { ...process.env, DSA_HOME: home },
    platform: "win32",
    pollMs: 25,
    graceMs: 100,
    captureWrapperStart: async pid => ticksForPid(pid),
    lease: seam,
    job: { compiler, observe: async () => [...procSnapshot().values()] },
  });

  // Barrier: Waiter B is durably queued behind A while A's command is still running!
  await until(() => readTickets(home, "machine").some(x => x.seq > savedA.seq && x.grantedAt === undefined), "waiter B queued");
  assert.equal(readFileSync(logFile, "utf8"), "a-start\n", "B has not overlapped with running A");
  assert.equal(pidAlive(grandPid), true, "A's grandchild is still running while A runs");

  // Release A's command so A's root exits -> Job Object drains surviving grandchild -> B acquires lease and runs.
  await writeFile(cmdFinish, "go");
  assert.equal(await waiterDone, 0);
  assert.equal(pidAlive(grandPid), false, "surviving detached grandchild ended before B ran");
  assert.deepEqual(readFileSync(logFile, "utf8").trim().split("\n"), ["a-start", "a-end", "b-start"]);
  assert.deepEqual(await readdir(leaseDir(home, "machine")).then(n => n.filter(x => x.endsWith(".json") || x === ".jobs")), []);
});

test("Windows job hold: normal exit drains surviving grandchildren without dead-parent PID inference; preserves exit, yield, signal and 127", { skip: posixOnly, timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-win-job-contracts-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { compiler } = await createJobStandIn(home);

  const killedTargets: WinProcessIdentity[][] = [];
  const decoys = (): WinProcessRow[] => [
    { pid: 6160, ppid: process.pid, start: T_BOOT, command: "csrss.exe" },
    { pid: 5000, ppid: 4, start: T_REUSED, command: "svchost.exe" },
    { pid: 5004, ppid: 5000, start: T_REUSED_CHILD, command: "dllhost.exe" },
  ];
  const seam = makeWinLeaseSeam(decoys, killedTargets);

  // 1. Normal exit with surviving detached grandchild + non-zero exit status (23): grandchild is ended before hold resolves.
  const grandPidFile = join(home, "norm-grand.pid");
  const code23 = await hold(parseHold(["machine", "--", process.execPath, "-e", [
    "const { spawn } = require('node:child_process'), { writeFileSync } = require('node:fs');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });",
    "g.unref(); writeFileSync(process.argv[1], String(g.pid));",
    "process.exit(23);",
  ].join(""), grandPidFile]), {
    env: { ...process.env, DSA_HOME: home },
    platform: "win32",
    pollMs: 25,
    graceMs: 100,
    captureWrapperStart: async pid => ticksForPid(pid),
    lease: seam,
    job: { compiler, observe: async () => [...procSnapshot(decoys()).values()] },
  });
  assert.equal(code23, 23);
  const normGrandPid = Number(readFileSync(grandPidFile, "utf8").trim());
  assert.equal(pidAlive(normGrandPid), false, "detached grandchild ended with the job before hold returned");
  assert.equal(killedTargets.length, 0, "normal job completion never needed process-table tree kill or touched decoys");

  // 2. --yield stops the Job Object owner (ending both command and detached grandchild) and exits 75 before waiter runs.
  const yieldGrandFile = join(home, "yield-grand.pid"), yieldStderr: string[] = [];
  const yielding = hold(parseHold(["machine", "--yield", "--", process.execPath, "-e", [
    "const { spawn } = require('node:child_process'), { writeFileSync } = require('node:fs');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });",
    "g.unref(); writeFileSync(process.argv[1], String(g.pid));",
    "setInterval(() => {}, 1000);",
  ].join(""), yieldGrandFile]), {
    env: { ...process.env, DSA_HOME: home },
    platform: "win32",
    pollMs: 25,
    graceMs: 100,
    captureWrapperStart: async pid => ticksForPid(pid),
    lease: seam,
    job: { compiler, observe: async () => [...procSnapshot(decoys()).values()] },
    stderr: l => yieldStderr.push(l),
  });
  await until(() => existsSync(yieldGrandFile) && readTickets(home, "machine").some(x => x.command !== undefined), "yielding command running");
  const yieldGrandPid = Number(readFileSync(yieldGrandFile, "utf8").trim());
  t.after(() => { try { process.kill(yieldGrandPid, "SIGKILL"); } catch {} });

  const afterYieldCheck = join(home, "after-yield");
  const waiter = hold(parseHold(["machine", "--", process.execPath, "-e", [
    "const { readFileSync, writeFileSync } = require('node:fs');",
    "const pid = Number(readFileSync(process.argv[1], 'utf8'));",
    "let alive = true; try { process.kill(pid, 0); } catch { alive = false; }",
    "writeFileSync(process.argv[2], alive ? 'alive' : 'dead');",
  ].join(""), yieldGrandFile, afterYieldCheck]), {
    env: { ...process.env, DSA_HOME: home },
    platform: "win32",
    pollMs: 25,
    graceMs: 100,
    captureWrapperStart: async pid => ticksForPid(pid),
    lease: seam,
    job: { compiler, observe: async () => [...procSnapshot(decoys()).values()] },
  });
  assert.deepEqual(await Promise.all([yielding, waiter]), [75, 0]);
  assert.match(yieldStderr.join("\n"), /^hold: yielded machine to .+ \(exit 75\)$/m);
  assert.equal(await readFile(afterYieldCheck, "utf8"), "dead", "yielded job's grandchild is dead before waiter runs");
  assert.equal(killedTargets.length, 0, "controlled stop drained the job without pre-killing or falling back to killOwner");

  // 3. Signal forwarded to wrapper terminates the job (including detached grandchild), releases ticket, and returns 143.
  const runner = await writeHolderRunner(home, compiler);
  const sigGrandFile = join(home, "sig-grand.pid");
  const sigHolder = spawn(process.execPath, [runner, "machine", "--", process.execPath, "-e", [
    "const { spawn } = require('node:child_process'), { writeFileSync } = require('node:fs');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });",
    "g.unref(); writeFileSync(process.argv[1], String(g.pid));",
    "setInterval(() => {}, 1000);",
  ].join(""), sigGrandFile], {
    env: { ...process.env, DSA_HOME: home, DSA_CALL: undefined, DSA_EXEC: undefined },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sigExit = new Promise<number | null>(resolve => sigHolder.once("exit", code => resolve(code)));
  await until(() => existsSync(sigGrandFile) && readTickets(home, "machine").some(x => x.command !== undefined), "signal holder running");
  const sigGrandPid = Number(readFileSync(sigGrandFile, "utf8").trim());
  t.after(() => { try { process.kill(sigGrandPid, "SIGKILL"); } catch {} });
  sigHolder.kill("SIGTERM");
  assert.equal(await sigExit, 143);
  assert.equal(pidAlive(sigGrandPid), false, "forwarded SIGTERM closed the job and ended detached grandchild");
  assert.deepEqual(readTickets(home, "machine"), []);

  // 4. Missing executable returns 127, prints `hold: cannot run ...` and releases its granted ticket and `.jobs` dir.
  const missingErr: string[] = [];
  const missingCode = await hold(parseHold(["machine", "--", join(home, "nonexistent-win-cmd.exe")]), {
    env: { ...process.env, DSA_HOME: home },
    platform: "win32",
    pollMs: 25,
    graceMs: 100,
    captureWrapperStart: async pid => ticksForPid(pid),
    lease: seam,
    job: { compiler, observe: async () => [...procSnapshot(decoys()).values()] },
    stderr: l => missingErr.push(l),
  });
  assert.equal(missingCode, 127);
  assert.match(missingErr[0] ?? "", /^hold: cannot run .*nonexistent-win-cmd\.exe:/);
  assert.deepEqual(readTickets(home, "machine"), []);
  assert.deepEqual(await readdir(leaseDir(home, "machine")).then(n => n.filter(x => x.endsWith(".json") || x === ".jobs")), []);
});

test("resolveWinHoldTarget completes PATHEXT on extensionless absolute and relative Windows paths", async t => {
  const dir = await mkdtemp(join(tmpdir(), "dsa-win-target-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dottedDir = join(dir, "nodejs.v22");
  mkdirSync(dottedDir);
  const toolExe = join(dir, "tool.exe");
  const nodeExe = join(dottedDir, "node.exe");
  const shimScript = join(dir, "cli.mjs");
  const shimCmd = join(dir, "mycli.cmd");
  writeFileSync(toolExe, "MZ");
  writeFileSync(nodeExe, "MZ");
  writeFileSync(shimScript, "console.log('ok');\n");
  writeFileSync(shimCmd, `@echo off\r\n"%dp0%/cli.mjs" %*\r\n`);

  const env: NodeJS.ProcessEnv = { PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
  // Extensionless absolute path resolves to .exe.
  assert.deepEqual(resolveWinHoldTarget(join(dir, "tool"), ["--version"], dir, env), { command: toolExe, args: ["--version"] });
  // Extensionless absolute path under a parent directory containing a dot still detects no extension and resolves to .exe.
  assert.deepEqual(resolveWinHoldTarget(join(dottedDir, "node"), ["-v"], dir, env), { command: nodeExe, args: ["-v"] });
  // Extensionless absolute path resolving to a .cmd shim unwraps its node script cleanly.
  assert.deepEqual(resolveWinHoldTarget(join(dir, "mycli"), ["arg1"], dir, env), { command: process.execPath, args: [shimScript, "arg1"] });
  // Already-extensioned absolute path stays unchanged.
  assert.deepEqual(resolveWinHoldTarget(toolExe, ["x"], dir, env), { command: toolExe, args: ["x"] });
  // Relative path with separator still resolves against cwd + PATHEXT.
  assert.deepEqual(resolveWinHoldTarget("./tool", ["y"], dir, env), { command: toolExe, args: ["y"] });
  // Nonexistent Windows drive path falls back to execTarget without throwing.
  assert.deepEqual(resolveWinHoldTarget("C:\\Program Files\\nodejs\\missing-node", ["-v"], dir, env), {
    command: "C:\\Program Files\\nodejs\\missing-node",
    args: ["-v"],
  });
});

test("Windows job hold: --yield with already-settled fast command returns command exit code (not 75)", { skip: posixOnly, timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-win-job-fast-yield-"));
  t.after(() => { cleanupHomeProcesses(home); return rm(home, { recursive: true, force: true }); });
  const { compiler } = await createJobStandIn(home);
  const seam = makeWinLeaseSeam();
  const stderrLines: string[] = [];

  const code = await hold(parseHold(["machine", "--yield", "--", process.execPath, "-e", "process.exit(17)"]), {
    env: { ...process.env, DSA_HOME: home },
    platform: "win32",
    pollMs: 25,
    graceMs: 100,
    captureWrapperStart: async pid => ticksForPid(pid),
    lease: seam,
    job: { compiler, observe: async () => [...procSnapshot().values()] },
    stderr: l => stderrLines.push(l),
    beforeRecordCommand: async () => {
      // Hold right before ticket.command is written until the fast command AND its DsaJob owner have both exited
      // (so `spawned.exited` is already settled), and enqueue a live waiter before hold enters its yield loop.
      const jobDir = leaseJobDir(home, "machine", 1);
      await until(() => existsSync(join(jobDir, "group-end")) && existsSync(join(jobDir, "host-exit")), "fast command and job host settled");
      const group = JSON.parse(readFileSync(join(jobDir, "group"), "utf8")) as { group: { pid: number } };
      await until(() => !pidAlive(group.group.pid), "job owner exited");
      await enqueue(home, {
        resource: "machine",
        mode: "exclusive",
        wrapper: { pid: process.pid, start: ticksForPid(process.pid) },
        argv: ["waiter"],
        cwd: home,
        since: Date.now(),
      }, undefined, seam);
    },
  });

  assert.equal(code, 17, "already-settled command must return its real exit code instead of falsely yielding with 75");
  assert.doesNotMatch(stderrLines.join("\n"), /yielded/, "must not claim the completed command was yielded");
});

test("Windows job hold: --yield and signal use controlled stop (DrainJob) and never pre-kill owner before endLeaseProcesses snapshot", { skip: posixOnly, timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-win-job-ctrl-stop-"));
  t.after(() => { cleanupHomeProcesses(home); return rm(home, { recursive: true, force: true }); });
  const { compiler } = await createJobStandIn(home);

  // 1. Responsive owner on --yield: controlled stop triggers DrainJob without writing group-end or invoking killOwner.
  {
    const stopObserved = join(home, "yield-stop-observed");
    const grandPidFile = join(home, "ctrl-yield-grand.pid");
    const killedTargets: WinProcessIdentity[][] = [];
    const seam = makeWinLeaseSeam(() => [], killedTargets);
    const yielding = hold(parseHold(["machine", "--yield", "--", process.execPath, "-e", [
      "const { spawn } = require('node:child_process'), { writeFileSync } = require('node:fs');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });",
      "g.unref(); writeFileSync(process.argv[1], String(g.pid));",
      "setInterval(() => {}, 1000);",
    ].join(""), grandPidFile]), {
      env: { ...process.env, DSA_HOME: home, HOLD_TEST_STOP_OBSERVED: stopObserved },
      platform: "win32",
      pollMs: 25,
      graceMs: 200,
      captureWrapperStart: async pid => ticksForPid(pid),
      lease: seam,
      job: { compiler, observe: async () => [...procSnapshot().values()] },
    });
    await until(() => existsSync(grandPidFile) && readTickets(home, "machine").some(x => x.command !== undefined), "yielding job running");
    const grandPid = Number(readFileSync(grandPidFile, "utf8").trim());
    t.after(() => { try { process.kill(grandPid, "SIGKILL"); } catch {} });
    const waiter = hold(parseHold(["machine", "--", process.execPath, "-e", "process.exit(0)"]), {
      env: { ...process.env, DSA_HOME: home },
      platform: "win32",
      pollMs: 25,
      graceMs: 100,
      captureWrapperStart: async pid => ticksForPid(pid),
      lease: seam,
      job: { compiler, observe: async () => [...procSnapshot().values()] },
    });
    assert.deepEqual(await Promise.all([yielding, waiter]), [75, 0]);
    assert.equal(existsSync(stopObserved), true, "DsaJob observed the controlled stop sentinel and ran DrainJob");
    assert.equal(pidAlive(grandPid), false, "detached grandchild was drained before waiter ran");
    assert.equal(killedTargets.length, 0, "controlled stop avoided force-killing the owner");
  }

  // 2. Responsive owner on SIGTERM: controlled stop triggers DrainJob and returns 143.
  {
    const stopObserved = join(home, "sig-stop-observed");
    const grandPidFile = join(home, "ctrl-sig-grand.pid");
    const runner = await writeHolderRunner(home, compiler);
    const sigHolder = spawn(process.execPath, [runner, "machine", "--", process.execPath, "-e", [
      "const { spawn } = require('node:child_process'), { writeFileSync } = require('node:fs');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });",
      "g.unref(); writeFileSync(process.argv[1], String(g.pid));",
      "setInterval(() => {}, 1000);",
    ].join(""), grandPidFile], {
      env: { ...process.env, DSA_HOME: home, DSA_CALL: undefined, DSA_EXEC: undefined, HOLD_TEST_STOP_OBSERVED: stopObserved },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sigExit = new Promise<number | null>(resolve => sigHolder.once("exit", code => resolve(code)));
    await until(() => existsSync(grandPidFile) && readTickets(home, "machine").some(x => x.command !== undefined), "signal job running");
    const grandPid = Number(readFileSync(grandPidFile, "utf8").trim());
    t.after(() => { try { process.kill(grandPid, "SIGKILL"); } catch {} });
    sigHolder.kill("SIGTERM");
    assert.equal(await sigExit, 143);
    assert.equal(existsSync(stopObserved), true, "SIGTERM triggered controlled stop instead of pre-killing the owner");
    assert.equal(pidAlive(grandPid), false, "detached grandchild ended cleanly");
  }

  // 3. Unresponsive owner (ignores stop file): hold does NOT pre-kill owner before endLeaseProcesses;
  // endLeaseProcesses captures the live owner + command in its first snap(0) BEFORE calling killOwnerWinSync.
  {
    const grandPidFile = join(home, "unresp-grand.pid");
    const events: string[] = [];
    let ownerPid = 0, cmdPid = 0;
    const seam: EndLeaseOptions = {
      platform: "win32",
      snapshotWin: () => {
        const rows = procSnapshot();
        if (ownerPid && cmdPid && rows.has(ownerPid) && rows.has(cmdPid)) {
          events.push("snap-saw-owner-and-cmd");
        }
        return rows;
      },
      startWinSync: pid => procSnapshot().get(pid)?.start ?? "",
      processAlive: pid => pidAlive(pid),
      killOwnerWinSync: targets => {
        events.push(`kill-owner:${targets.map(x => x.pid).join(",")}`);
        for (const target of targets) {
          try { process.kill(target.pid, "SIGTERM"); } catch { /* gone */ }
        }
      },
    };
    const yielding = hold(parseHold(["gpu", "--yield", "--", process.execPath, "-e", [
      "const { spawn } = require('node:child_process'), { writeFileSync } = require('node:fs');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });",
      "g.unref(); writeFileSync(process.argv[1], String(g.pid));",
      "setInterval(() => {}, 1000);",
    ].join(""), grandPidFile]), {
      env: { ...process.env, DSA_HOME: home, HOLD_TEST_IGNORE_STOP: "1" },
      platform: "win32",
      pollMs: 25,
      graceMs: 100,
      captureWrapperStart: async pid => ticksForPid(pid),
      lease: seam,
      job: { compiler, observe: async () => [...procSnapshot().values()] },
    });
    const activeTicket = await until(() => {
      if (!existsSync(grandPidFile)) return false;
      return readTickets(home, "gpu").find(x => x.command !== undefined && x.group !== undefined);
    }, "unresponsive yielding job running");
    ownerPid = activeTicket.group!.pid;
    cmdPid = activeTicket.command!.pid;
    const grandPid = Number(readFileSync(grandPidFile, "utf8").trim());
    t.after(() => { try { process.kill(grandPid, "SIGKILL"); } catch {} });

    const waiter = hold(parseHold(["gpu", "--", process.execPath, "-e", "process.exit(0)"]), {
      env: { ...process.env, DSA_HOME: home },
      platform: "win32",
      pollMs: 25,
      graceMs: 100,
      captureWrapperStart: async pid => ticksForPid(pid),
      lease: seam,
      job: { compiler, observe: async () => [...procSnapshot().values()] },
    });
    assert.deepEqual(await Promise.all([yielding, waiter]), [75, 0]);
    const firstSnap = events.indexOf("snap-saw-owner-and-cmd");
    const firstKill = events.indexOf(`kill-owner:${ownerPid}`);
    assert.ok(firstSnap >= 0, `expected endLeaseProcesses snapshot to see live owner and command, got ${JSON.stringify(events)}`);
    assert.ok(firstKill > firstSnap, `owner must not be killed before first endLeaseProcesses snapshot, got ${JSON.stringify(events)}`);
    assert.equal(pidAlive(grandPid), false, "detached grandchild ended before waiter ran");
  }
});

test("endLeaseProcesses re-reads late-written group record on checkRows before releasing", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-win-job-late-group-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const jobDir = join(home, "job-1");
  mkdirSync(jobDir, { recursive: true });

  const owner: WinProcessIdentity = { pid: 9100, start: "639000000500001000" };
  const cmd: WinProcessIdentity = { pid: 9200, start: "639000000500002000" };
  const grand: WinProcessIdentity = { pid: 9300, start: "639000000500003000" };
  // Before killOwner, only helper-begin exists; `group` has not been published yet.
  writeFileSync(join(jobDir, "helper-begin"), JSON.stringify(owner));

  const ticket: LeaseTicket = {
    seq: 1,
    resource: "machine",
    mode: "exclusive",
    wrapper: { pid: 9000, start: "639000000500000500" },
    jobDir,
    argv: ["cmd"],
    cwd: home,
    since: Date.now(),
    grantedAt: Date.now(),
  };

  let snapCall = 0;
  const killed: WinProcessIdentity[][] = [];
  const logs: string[] = [];
  await endLeaseProcesses(ticket, 100, l => logs.push(l), {
    platform: "win32",
    processAlive: pid => snapCall < 2 && pid === owner.pid,
    snapshotWin: () => {
      snapCall += 1;
      if (snapCall === 1) {
        // Initial snap(0) BEFORE killOwner: owner, cmd, and grandchild are all live, while `group` is still absent.
        return new Map<number, WinProcessRow>([
          [owner.pid, { pid: owner.pid, ppid: 9000, start: owner.start }],
          [cmd.pid, { pid: cmd.pid, ppid: owner.pid, start: cmd.start }],
          [grand.pid, { pid: grand.pid, ppid: cmd.pid, start: grand.start }],
        ]);
      }
      if (snapCall === 2) {
        // checkRows AFTER killOwner: owner and cmd have exited, while grandchild is STILL draining!
        return new Map<number, WinProcessRow>([
          [grand.pid, { pid: grand.pid, ppid: cmd.pid, start: grand.start }],
        ]);
      }
      // Next scan: grandchild has finished exiting.
      return new Map<number, WinProcessRow>();
    },
    killOwnerWinSync: targets => {
      killed.push(targets.map(x => ({ ...x })));
      // Simulate DsaJob publishing `group` right before dying from the kill.
      writeFileSync(join(jobDir, "group"), JSON.stringify({ pid: cmd.pid, start: cmd.start, group: owner }));
    },
  });

  assert.deepEqual(killed, [[owner]], "targeted only the verified owner");
  assert.ok(snapCall >= 3, `must re-read late group on checkRows and wait for grandchild to exit (saw ${snapCall} snapshots)`);
  assert.deepEqual(logs, [], "clean exit after grandchild drained without timing out");
});
