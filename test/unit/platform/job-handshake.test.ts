// The handshake of a Windows command attempt beyond the group itself: versioned argv tags (with legacy read) across
// spaces, quotes, `&` and Unicode call keys; handle-persisted creation identities that never bind unrelated reused
// pids after wrapper/owner exit; deterministic exit-evidence ordering; and transient/adopted observation paths.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Containment } from "../../../src/platform/containment.ts";
import { readExitRecord, spawnCommand } from "../../../src/platform/command.ts";
import {
  JOB_BEGIN, JOB_END, JOB_GROUP, frameworkCompiler, jobHostArgv, readBeginIdentity, readGroupRecord, sameCreation,
  spawnInJob, transientRead,
} from "../../../src/platform/job.ts";
import { shellTarget } from "../../../src/platform/launch.ts";
import { WIN_TAG_PREFIX, parseProcessRows, winProcessRows, winTag, winTagArg } from "../../../src/platform/windows.ts";

const windowsOnly = process.platform === "win32" ? false : "a Windows Job Object (Win32)";
const dirOf = () => mkdtempSync(join(tmpdir(), "dsa-job-hand-"));
async function until<T>(get: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await get(); if (value) return value; if (Date.now() > end) throw new Error(`timeout: ${what}`); await delay(25); }
}
const live = async (pid: number) => (await winProcessRows()).some(row => row.pid === pid);
async function ended(launched: { exited: Promise<void> }, ms = 30_000): Promise<void> {
  await Promise.race([launched.exited, delay(ms).then(() => { throw new Error("the owner did not end"); })]);
}
const gone = (pid: number) => until(async () => !(await live(pid)), `pid ${pid} to end`);

/** A deterministic gate-controlled Node program: writes `ready`, waits for `gate` (bounded), prints `text` and exits `code`. */
function gatedProgram(dir: string, name: string, text: string, code: number) {
  const program = join(dir, `${name}.mjs`), ready = join(dir, `${name}.ready`), gate = join(dir, `${name}.gate`);
  writeFileSync(program, [
    "import { existsSync, writeFileSync } from 'node:fs';",
    `const ready = ${JSON.stringify(ready)}, gate = ${JSON.stringify(gate)}, started = Date.now();`,
    "writeFileSync(ready, 'ready');",
    "const timer = setInterval(() => {",
    "  if (!existsSync(gate)) { if (Date.now() - started > 60_000) process.exit(90); return; }",
    `  clearInterval(timer); console.log(${JSON.stringify(text)}); process.exit(${code});`,
    "}, 20);",
  ].join("\n"));
  return { program, ready, gate };
}

interface StubPlan {
  begin?: "" | "legacy" | string;
  error?: string;
  group?: "" | `legacy:${number}` | `full:${number}:${string}:${string}`;
  endStatus?: "" | string;
  waitGate?: string;
  exitCode: number;
}

let cachedStubCompiler: { dir: string; compiler: string } | undefined;
function stubCompiler(): string {
  if (cachedStubCompiler) return cachedStubCompiler.compiler;
  const dir = mkdtempSync(join(tmpdir(), "dsa-stub-csc-"));
  process.once("exit", () => { try { execFileSync(process.execPath, ["-e", `require("node:fs").rmSync(${JSON.stringify(dir)}, { recursive: true, force: true })`]); } catch { /* best effort */ } });
  if (process.platform === "win32") {
    const csc = frameworkCompiler(), stubCs = join(dir, "StubOwner.cs"), stubExe = join(dir, "StubOwner.exe");
    const fakeCs = join(dir, "FakeCsc.cs"), fakeExe = join(dir, "FakeCsc.exe");
    writeFileSync(stubCs, [
      "using System; using System.Diagnostics; using System.Globalization; using System.IO; using System.Threading;",
      "static class StubOwner {",
      "  static void Atomic(string p, string t) { string tmp = p + \".tmp\"; File.WriteAllText(tmp, t); if (File.Exists(p)) File.Delete(p); File.Move(tmp, p); }",
      "  static int Main(string[] a) {",
      "    string d = a[0]; string[] lines = File.ReadAllLines(Path.Combine(d, \"stub-plan.txt\"));",
      "    string pid = Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);",
      "    File.WriteAllText(Path.Combine(d, \"stub-pid\"), pid);",
      "    if (lines[0] == \"legacy\") Atomic(Path.Combine(d, \"helper-begin\"), \"begin\");",
      "    else if (lines[0].Length > 0) Atomic(Path.Combine(d, \"helper-begin\"), \"{\\\"pid\\\":\" + pid + \",\\\"start\\\":\\\"\" + lines[0] + \"\\\"}\");",
      "    if (lines[1].Length > 0) File.WriteAllText(Path.Combine(d, \"start-error\"), lines[1]);",
      "    if (lines[2].StartsWith(\"legacy:\")) Atomic(Path.Combine(d, \"group\"), \"{\\\"pid\\\":\" + lines[2].Substring(7) + \"}\");",
      "    else if (lines[2].StartsWith(\"full:\")) { string[] p = lines[2].Split(':'); Atomic(Path.Combine(d, \"group\"), \"{\\\"pid\\\":\" + p[1] + \",\\\"start\\\":\\\"\" + p[2] + \"\\\",\\\"group\\\":{\\\"pid\\\":\" + pid + \",\\\"start\\\":\\\"\" + p[3] + \"\\\"}}\"); }",
      "    if (lines[3].Length > 0) Atomic(Path.Combine(d, \"group-end\"), \"{\\\"status\\\":\" + lines[3] + \"}\");",
      "    if (lines[4].Length > 0) { for (int i = 0; i < 1000 && !File.Exists(lines[4]); i++) Thread.Sleep(10); }",
      "    return Int32.Parse(lines[5], CultureInfo.InvariantCulture);",
      "  }",
      "}",
    ].join("\n"));
    writeFileSync(fakeCs, [
      "using System; using System.IO;",
      "static class FakeCsc {",
      `  const string Src = ${JSON.stringify(stubExe)};`,
      "  static int Main(string[] a) {",
      "    foreach (string s in a) if (s.StartsWith(\"/out:\")) { File.Copy(Src, s.Substring(5), true); return 0; }",
      "    return 2;",
      "  }",
      "}",
    ].join("\n"));
    execFileSync(csc, ["/nologo", "/codepage:65001", "/target:winexe", `/out:${stubExe}`, stubCs], { windowsHide: true });
    execFileSync(csc, ["/nologo", "/codepage:65001", "/target:exe", `/out:${fakeExe}`, fakeCs], { windowsHide: true });
    cachedStubCompiler = { dir, compiler: fakeExe };
    return fakeExe;
  }
  const runner = join(dir, "stub-owner.cjs"), compiler = join(dir, "fake-csc");
  writeFileSync(runner, [
    `#!${process.execPath}`,
    "const { existsSync, readFileSync, renameSync, writeFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    "const dir = process.argv[2], lines = readFileSync(join(dir, 'stub-plan.txt'), 'utf8').split('\\n');",
    "writeFileSync(join(dir, 'stub-pid'), String(process.pid));",
    "const atomic = (name, text) => { const p = join(dir, name); writeFileSync(`${p}.tmp`, text); renameSync(`${p}.tmp`, p); };",
    "if (lines[0] === 'legacy') atomic('helper-begin', 'begin');",
    "else if (lines[0]) atomic('helper-begin', JSON.stringify({ pid: process.pid, start: lines[0] }));",
    "if (lines[1]) writeFileSync(join(dir, 'start-error'), lines[1]);",
    "if (lines[2]?.startsWith('legacy:')) atomic('group', JSON.stringify({ pid: Number(lines[2].slice(7)) }));",
    "else if (lines[2]?.startsWith('full:')) { const [, cPid, cStart, oStart] = lines[2].split(':'); atomic('group', JSON.stringify({ pid: Number(cPid), start: cStart, group: { pid: process.pid, start: oStart } })); }",
    "if (lines[3]) atomic('group-end', JSON.stringify({ status: Number(lines[3]) }));",
    "const code = Number(lines[5] || 0);",
    "if (!lines[4]) process.exit(code);",
    "const started = Date.now(), t = setInterval(() => { if (existsSync(lines[4]) || Date.now() - started > 10_000) { clearInterval(t); process.exit(code); } }, 10);",
  ].join("\n"));
  chmodSync(runner, 0o755);
  writeFileSync(compiler, [
    `#!${process.execPath}`,
    "const { chmodSync, copyFileSync } = require('node:fs');",
    "const out = process.argv.slice(2).find(a => a.startsWith('/out:'))?.slice(5);",
    `copyFileSync(${JSON.stringify(runner)}, out); chmodSync(out, 0o755);`,
  ].join("\n"));
  chmodSync(compiler, 0o755);
  cachedStubCompiler = { dir, compiler };
  return compiler;
}

function writePlan(dir: string, plan: StubPlan): void {
  writeFileSync(join(dir, "stub-plan.txt"), [
    plan.begin ?? "", plan.error ?? "", plan.group ?? "", plan.endStatus ?? "", plan.waitGate ?? "", String(plan.exitCode),
  ].join("\n"));
}

test("versioned argv tags encode spaces, quotes, & and Unicode unambiguously while preserving legacy reads", () => {
  const dir = "C:\\dsa\\attempt \"1\"";
  const ids = [
    "command:W@1/a@1#1",
    "command:01JXYZ@1/step \"1\" & '2' %PATH% \\ (a=b) ’ü’ 你好 🚀@1#1",
    "gate:01JXYZ@1/check \"a & b\" ’x’ 你好@2#1",
  ];
  for (const id of ids) {
    const token = winTagArg("DSA_EXEC", id);
    assert.match(token, new RegExp(`^DSA_EXEC=${WIN_TAG_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[A-Za-z0-9_-]+$`));
    assert.deepEqual(jobHostArgv(dir, id), [dir, token]);
    // Quoted directory + unquoted or quoted versioned tag round-trips identically through parseProcessRows + winTag.
    const rowText = `420\t100\t639000000000000000\t0\t"C:\\host\\DsaJob.exe" "${dir}" ${token}`;
    assert.equal(winTag(parseProcessRows(rowText)[0]?.command, "DSA_EXEC"), id);
    assert.equal(winTag(`"C:\\host\\DsaJob.exe" "${dir}" "${token}"`, "DSA_EXEC"), id);
    // Windows shellTarget embeds the versioned marker without mutating env.DSA_EXEC, and wins over decoy legacy text.
    const gateTarget = shellTarget("echo DSA_EXEC=decoy & exit /b 0", id, "win32");
    assert.equal(gateTarget.shell, true);
    assert.equal(winTag(`C:\\Windows\\system32\\cmd.exe /d /s /c "${gateTarget.command}"`, "DSA_EXEC"), id);
  }
  // Legacy read compatibility: existing unencoded command/gate/hold tags remain readable.
  assert.equal(winTag("C:\\host.exe C:\\attempt DSA_EXEC=command:W@1/a@1#1", "DSA_EXEC"), "command:W@1/a@1#1");
  assert.equal(winTag('cmd.exe /d /s /c "set DSA_EXEC=gate:W@1/a@1#1&& echo ok"', "DSA_EXEC"), "gate:W@1/a@1#1");
  assert.equal(winTag("node.exe run DSA_HOLD=v1:12", "DSA_HOLD"), "v1:12", "v1:<seq> lease tags do not collide with v1~");
  // Malformed versioned tokens, ambiguous distinct tags and unrelated prefixes fail closed to undefined.
  assert.equal(winTag("C:\\host.exe DSA_EXEC=v1~***", "DSA_EXEC"), undefined);
  assert.equal(winTag("C:\\host.exe DSA_EXEC=v1~", "DSA_EXEC"), undefined);
  assert.equal(winTag(`C:\\host.exe ${winTagArg("DSA_EXEC", "a")} ${winTagArg("DSA_EXEC", "b")}`, "DSA_EXEC"), undefined);
  assert.equal(winTag("C:\\host.exe DSA_EXEC=legacy-a DSA_EXEC=legacy-b", "DSA_EXEC"), undefined);
  assert.equal(winTag(`C:\\host.exe OTHER_${winTagArg("DSA_EXEC", "a")} --flag=${winTagArg("DSA_EXEC", "a")}`, "DSA_EXEC"), undefined);
  assert.deepEqual(jobHostArgv(dir), [dir]);
  assert.equal(winTag(jobHostArgv(dir).join(" "), "DSA_EXEC"), undefined);
});

test("a handshake file held for a moment is a retry, never a failed attempt", () => {
  for (const code of ["EBUSY", "EPERM", "EACCES", "EAGAIN", "EMFILE", "ENFILE"])
    assert.equal(transientRead(Object.assign(new Error("in use"), { code })), true, code);
  for (const code of ["ENOENT", "EIO", "ENOTDIR", "ENOSPC"]) assert.equal(transientRead(Object.assign(new Error("no"), { code })), false, code);
  assert.equal(transientRead(new Error("no code")), false);
});

test("handle creation records and legacy records parse cleanly and reject reused timestamps", async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(sameCreation("639311245471234560", "639311245471234560"), true);
  assert.equal(sameCreation("639311245471234560", "639311245471234567"), true, "sub-microsecond WMI DMTF truncation");
  assert.equal(sameCreation("639311245471250000", "639311245471234560"), false, "later reused pid");
  assert.equal(sameCreation("", "639311245471234560"), false);

  writeFileSync(join(dir, JOB_GROUP), JSON.stringify({ pid: 8240 }));
  assert.deepEqual(await readGroupRecord(dir), { pid: 8240 });
  writeFileSync(join(dir, JOB_GROUP), JSON.stringify({ pid: 8240, start: "639000000000000020", group: { pid: 8200, start: "639000000000000010" } }));
  assert.deepEqual(await readGroupRecord(dir), { pid: 8240, start: "639000000000000020", group: { pid: 8200, start: "639000000000000010" } });
  writeFileSync(join(dir, JOB_BEGIN), "begin");
  assert.equal(await readBeginIdentity(dir), undefined);
  writeFileSync(join(dir, JOB_BEGIN), JSON.stringify({ pid: 8200, start: "639000000000000010" }));
  assert.deepEqual(await readBeginIdentity(dir), { pid: 8200, start: "639000000000000010" });
});

test("diagnostic race: rapid owner exit always records host-exit before formatting the refusal reason", { timeout: 60_000 }, async (t: TestContext) => {
  const compiler = stubCompiler();
  for (let round = 0; round < 5; round++) {
    const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
    writePlan(dir, { begin: "639000000000000010", error: "CreateProcess failed (error 2)", exitCode: 125 });
    const message = await spawnInJob(dir, { exe: process.execPath, args: ["-e", ""], cwd: dir, log: join(dir, "output.log"), env: {} },
      { compiler, endHelper: async () => {} }).then(() => "", (err: Error) => err.message);
    assert.match(message, /CreateProcess failed \(error 2\)/);
    assert.match(message, /the job host exited with code 125/, `round ${round}: host-exit must not race ended`);
  }
  const silentDir = dirOf(); t.after(() => rm(silentDir, { recursive: true, force: true }));
  writePlan(silentDir, { exitCode: 0 });
  const silent = await spawnInJob(silentDir, { exe: process.execPath, args: ["-e", ""], cwd: silentDir, log: join(silentDir, "output.log"), env: {} },
    { compiler, endHelper: async () => {} }).then(() => "", (err: Error) => err.message);
  assert.match(silent, /the job host exited with code 0 before it reported starting/);
});

test("pid reuse safety: spawnInJob never binds unrelated pids after wrapper or owner exit", { timeout: 60_000 }, async (t: TestContext) => {
  const compiler = stubCompiler();
  // 1. Both wrapper and owner exit before observe() finishes; both pids are reused in the observed table.
  {
    const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
    writePlan(dir, { begin: "639000000000000010", group: "full:424242:639000000000000020:639000000000000010", endStatus: "0", exitCode: 0 });
    const launched = await spawnInJob(dir, { exe: process.execPath, args: ["-e", ""], cwd: dir, log: join(dir, "output.log"), env: {}, exec: "command:W@1/reuse@1#1" },
      { compiler, observe: async () => { await delay(60); return [{ pid: 424242, ppid: 1, start: "639000000000999999" }]; } });
    assert.ok(launched);
    assert.equal(launched.pid, 424242);
    assert.equal(launched.start, "", "never bind an unrelated process that reused the wrapper pid");
    assert.equal(launched.group, undefined, "closed group omits owner identity");
  }
  // 2. Wrapper exits and its pid is reused while the owner still holds the job open: wrapper start is rejected, live owner kept.
  {
    const dir = dirOf(), release = join(dir, "release"); t.after(() => rm(dir, { recursive: true, force: true }));
    writePlan(dir, { begin: "639000000000000010", group: "full:424242:639000000000000020:639000000000000010", endStatus: "0", waitGate: release, exitCode: 0 });
    const launched = await spawnInJob(dir, { exe: process.execPath, args: ["-e", ""], cwd: dir, log: join(dir, "output.log"), env: {}, exec: "command:W@1/wrap-reuse@1#1" }, {
      compiler,
      observe: async () => {
        const rec = await readGroupRecord(dir);
        return [
          { pid: rec!.group!.pid, ppid: process.pid, start: "639000000000000010" },
          { pid: 424242, ppid: 1, start: "639000000000888888" },
        ];
      },
    });
    assert.ok(launched);
    assert.equal(launched.start, "", "mismatched wrapper creation ticks are rejected");
    assert.equal(launched.group?.start, "639000000000000010", "matching live owner identity is preserved");
    writeFileSync(release, "done");
    await ended(launched);
  }
  // 3. If the owner row at helperPid already has another creation time before Node delivers 'exit', neither row is bound.
  {
    const dir = dirOf(), release = join(dir, "release"); t.after(() => rm(dir, { recursive: true, force: true }));
    writePlan(dir, { begin: "639000000000000010", group: "full:424242:639000000000000020:639000000000000010", waitGate: release, exitCode: 0 });
    const launched = await spawnInJob(dir, { exe: process.execPath, args: ["-e", ""], cwd: dir, log: join(dir, "output.log"), env: {} }, {
      compiler,
      observe: async () => {
        const rec = await readGroupRecord(dir);
        return [
          { pid: rec!.group!.pid, ppid: 1, start: "639000000000555555" },
          { pid: 424242, ppid: rec!.group!.pid, start: "639000000000000020" },
        ];
      },
    });
    assert.ok(launched);
    assert.equal(launched.group, undefined, "replaced owner pid is never bound");
    assert.equal(launched.start, "", "wrapper row is not trusted once owner pid is replaced");
    writeFileSync(release, "done");
    await ended(launched);
  }
  // 4. Legacy group record without creation ticks still rejects an unrelated pid once group-end exists or ppid mismatches.
  {
    const dir = dirOf(), release = join(dir, "release"); t.after(() => rm(dir, { recursive: true, force: true }));
    writePlan(dir, { begin: "legacy", group: "legacy:424242", endStatus: "0", waitGate: release, exitCode: 0 });
    const launched = await spawnInJob(dir, { exe: process.execPath, args: ["-e", ""], cwd: dir, log: join(dir, "output.log"), env: {} }, {
      compiler,
      observe: async () => [{ pid: 424242, ppid: 1, start: "639000000000777777" }],
    });
    assert.ok(launched);
    assert.equal(launched.start, "", "legacy group record never binds an unrelated pid");
    writeFileSync(release, "done");
    await ended(launched);
  }
  // 5. Refuse path: handle-recorded start is persisted when observe fails, never overwritten by a reused helperPid row,
  //    legacy untagged rows are rejected when exec was given, and owner exit during observe rejects with exit evidence.
  {
    const dir = dirOf(), release = join(dir, "release"); t.after(() => rm(dir, { recursive: true, force: true }));
    writePlan(dir, { begin: "639000000000000010", group: "full:424242:639000000000000020:639000000000000010", waitGate: release, exitCode: 9 });
    let calls = 0;
    const adopted = await spawnInJob(dir, { exe: process.execPath, args: ["-e", ""], cwd: dir, log: join(dir, "output.log"), env: {} }, {
      compiler, observeMs: 50, endMs: 20,
      endHelper: async () => { throw new Error("kill denied"); },
      observe: async () => {
        if (++calls === 1) throw new Error("table down");
        const rec = await readGroupRecord(dir);
        return [{ pid: rec!.group!.pid, ppid: 1, start: "639999999999999999" }];
      },
    });
    assert.ok(adopted && adopted.uncertain);
    assert.equal(adopted.start, "639000000000000010", "reused row at helperPid cannot overwrite handle-recorded start");
    writeFileSync(release, "done");
    await ended(adopted);

    const legacyDir = dirOf(), gateLegacy = join(legacyDir, "release");
    t.after(() => rm(legacyDir, { recursive: true, force: true }));
    writePlan(legacyDir, { begin: "legacy", waitGate: gateLegacy, exitCode: 0 });
    const legacyAdopted = await spawnInJob(legacyDir, { exe: process.execPath, args: ["-e", ""], cwd: legacyDir, log: join(legacyDir, "output.log"), env: {}, exec: "command:W@1/k@1#1" }, {
      compiler, timeoutMs: 40, endMs: 20,
      endHelper: async () => { throw new Error("kill denied"); },
      observe: async () => [{ pid: Number(readFileSync(join(legacyDir, "stub-pid"), "utf8")), ppid: 1, start: "639999999999999999", command: "C:\\other.exe" }],
    });
    assert.ok(legacyAdopted && legacyAdopted.uncertain);
    assert.equal(legacyAdopted.start, "", "legacy refuse without handle ticks falls back to argv tag rather than untagged row");
    writeFileSync(gateLegacy, "done");
    await ended(legacyAdopted);

    const exitDuringObserve = dirOf(), gate2 = join(exitDuringObserve, "release");
    t.after(() => rm(exitDuringObserve, { recursive: true, force: true }));
    writePlan(exitDuringObserve, { begin: "639000000000000010", waitGate: gate2, exitCode: 125 });
    const rejected = await spawnInJob(exitDuringObserve, { exe: process.execPath, args: ["-e", ""], cwd: exitDuringObserve, log: join(exitDuringObserve, "output.log"), env: {} }, {
      compiler, timeoutMs: 40, endMs: 20,
      endHelper: async () => { throw new Error("kill denied"); },
      observe: async () => { writeFileSync(gate2, "done"); await delay(80); return [{ pid: 1, ppid: 1, start: "639999999999999999" }]; },
    }).then(() => "", (err: Error) => err.message);
    assert.match(rejected, /exited with code 125/, "owner exiting during refuse observe rejects cleanly with exit evidence");
  }
});

// The owner writes the group record (the suspended wrapper's pid and both creation times, taken from the live handles)
// before it resumes the wrapper, and group-end only once the wrapper ended. An owner that is ended in between leaves a
// wrapper that exited with no end record at all: the creation time the owner already recorded is then the attempt's only
// identity, and an observed row for that pid is another process once its ticks disagree. Neither a global tolerance nor a
// different record format is introduced for this: the recorded value is used as it was written.
test("a wrapper that exited without group-end keeps its handle-recorded identity, never a recycled pid's", { timeout: 60_000 }, async t => {
  const compiler = stubCompiler();
  const wrapperStart = "639311245471234560", ownerStart = "639311245471230000";
  /** One launch of the stub owner: group written, no group-end (unless `endStatus`), gate held, then exit 0. */
  const run = async (options: { endStatus?: string; rows: () => Promise<{ pid: number; ppid: number; start: string }[]> }) => {
    const dir = dirOf(), release = join(dir, "release");
    t.after(() => rm(dir, { recursive: true, force: true }));
    writePlan(dir, { begin: ownerStart, group: `full:424242:${wrapperStart}:${ownerStart}`, ...(options.endStatus ? { endStatus: options.endStatus } : {}), waitGate: release, exitCode: 0 });
    const launched = await spawnInJob(dir, { exe: process.execPath, args: ["-e", ""], cwd: dir, log: join(dir, "output.log"), env: {} },
      { compiler, observe: options.rows });
    assert.ok(launched);
    return { dir, launched, release };
  };
  // 1. The wrapper is gone from the table and the owner never recorded its end: the handle-recorded identity is kept.
  {
    const { dir, launched, release } = await run({ rows: async () => [] });
    assert.equal(launched.start, wrapperStart, "the identity the owner took from the wrapper's handle before resuming it");
    assert.equal(launched.group?.start, ownerStart, "the owner's own handle identity travels with the attempt");
    assert.ok(!existsSync(join(dir, JOB_END)), "the owner recorded no end");
    writeFileSync(release, "done"); await ended(launched);
  }
  // 2. A row at the wrapper pid whose ticks are another instance: that identity is rejected and the recorded one stands.
  {
    const { launched, release } = await run({ rows: async () => [{ pid: 424242, ppid: 1, start: "639311245471999999" }] });
    assert.equal(launched.start, wrapperStart, "the recycled pid's ticks are never bound");
    assert.notEqual(launched.start, "639311245471999999");
    writeFileSync(release, "done"); await ended(launched);
  }
  // 3. With group-end the wrapper ended normally and its identity is history: an unrelated row is still never bound.
  {
    const { launched, release } = await run({ endStatus: "0", rows: async () => [{ pid: 424242, ppid: 1, start: "639311245471999999" }] });
    assert.equal(launched.start, "", "a recorded end needs no identity, and an unrelated row supplies none");
    writeFileSync(release, "done"); await ended(launched);
  }
});

test("Windows: running owner and wrapper carry versioned tags for keys with spaces, quotes, & and Unicode, and scan recovers them", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(), attempt = join(dir, "command-1"); t.after(() => rm(dir, { recursive: true, force: true }));
  const id = "command:W@1/tag \"a\" & 'b' ’ü’ 你好@1#1";
  const { program, ready, gate } = gatedProgram(dir, "tagged", "tagged-ok", 0);
  const launched = await spawnCommand({ command: [process.execPath, program], cwd: dir, dir: attempt, env: { ...process.env, DSA_EXEC: id }, exec: id });
  assert.ok(launched);
  assert.ok(launched.start, "wrapper identity is recorded");
  assert.ok(launched.group && launched.group.pid > 0 && launched.group.start, "owner identity is recorded");
  await until(() => existsSync(ready), "gated command to start");

  const diskGroup = await readGroupRecord(attempt);
  assert.ok(diskGroup?.start && diskGroup.group?.start, "real Win32 handles persisted both creation identities in group");
  assert.equal(sameCreation(launched.start, diskGroup.start), true);
  assert.equal(sameCreation(launched.group!.start, diskGroup.group.start), true);

  const rows = await winProcessRows();
  const helper = rows.find(row => row.pid === launched.group!.pid), wrapper = rows.find(row => row.pid === launched.pid);
  assert.ok(helper, "the owner is observable while the attempt waits on its gate");
  assert.ok(wrapper, "the wrapper is observable while the attempt waits on its gate");
  assert.equal(winTag(helper.command, "DSA_EXEC"), id);
  assert.equal(winTag(wrapper.command, "DSA_EXEC"), id);

  // Recovery before command-started (empty known identities) discovers both owner and wrapper through ProcessTable + Containment.
  const discovered = (await new Containment().scan(new Map([[id, []]]), { fresh: true })).get(id) ?? [];
  const discoveredPids = new Set(discovered.map(p => p.pid));
  assert.ok(discoveredPids.has(launched.group!.pid), "intent-only scan discovers the compiled owner");
  assert.ok(discoveredPids.has(launched.pid), "intent-only scan discovers the wrapper");

  writeFileSync(gate, "open");
  await ended(launched);
  assert.equal((await until(() => readExitRecord(attempt), "exit record")).status, 0);
  await gone(launched.pid);
  await gone(launched.group!.pid);
});

test("Windows: a transient observation failure is retried and records the live group owner identity", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const { program, ready, gate } = gatedProgram(dir, "flaky", "ran", 3);
  let reads = 0;
  const launched = await spawnInJob(dir, { exe: process.execPath, args: [program], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env }, exec: "command:W@1/flaky \"1\" & 你好@1#1" },
    { observe: async () => { if (++reads <= 2) throw new Error("cim unavailable"); return winProcessRows(); } });
  assert.ok(launched);
  assert.equal(reads, 3);
  assert.equal(launched.uncertain, undefined, "the attempt started normally once the table answered");
  assert.ok(launched.start, "the wrapper's identity is recorded");
  assert.ok(launched.group && launched.group.start, "the group owner's identity is recorded");
  await until(() => existsSync(ready), "gated program ready");
  writeFileSync(gate, "open");
  await ended(launched);
  assert.equal(JSON.parse(readFileSync(join(dir, JOB_END), "utf8")).status, 3);
  assert.match(readFileSync(join(dir, "output.log"), "utf8"), /ran/);
});

test("Windows: an attempt whose owner cannot be confirmed retired is adopted with its handle identity and tag", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const id = "command:W@1/adopt \"x\" & 你好@1#1";
  const { program, ready, gate } = gatedProgram(dir, "adopted", "adopted", 0);
  const launched = await spawnInJob(dir, { exe: process.execPath, args: [program], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env }, exec: id },
    { observe: async () => { throw new Error("the process table is not readable"); },
      endHelper: async () => { throw new Error("taskkill denied"); }, observeMs: 100, endMs: 100 });
  assert.ok(launched);
  assert.match(String(launched.uncertain), /could not be observed/);
  assert.ok(launched.pid > 0, "the adopted identity is the owner's pid");
  assert.ok(launched.start, "the owner's handle creation identity is persisted even when the table could not be read");
  await until(() => existsSync(ready), "adopted program ready");
  const rows = await winProcessRows(), owner = rows.find(row => row.pid === launched.pid);
  assert.ok(owner, "the adopted owner is still live");
  assert.equal(sameCreation(owner.start, launched.start), true, "handle creation identity matches the live process-table token");
  assert.equal(winTag(owner.command, "DSA_EXEC"), id, "the adopted owner carries the attempt's versioned tag");
  writeFileSync(gate, "open");
  await ended(launched);
  assert.equal(JSON.parse(readFileSync(join(dir, JOB_END), "utf8")).status, 0);
  assert.match(readFileSync(join(dir, "output.log"), "utf8"), /adopted/);
  await gone(launched.pid);
});