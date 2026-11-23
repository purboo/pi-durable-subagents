import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { ulid } from "../../../../src/kernel/ids.ts";
import { callDir, journalPath, orchLedger } from "../../../../src/paths.ts";
import { JT, type Containment, type ProcInfo } from "../../../../src/types.ts";
import type { CallTicket } from "../../../../src/orchestrator/contract.ts";
import createExecutor from "../../../../src/orchestrator/executor/index.ts";
import { COMMAND_INTENT, COMMAND_STARTED, commandDirName, commandId } from "../../../../src/orchestrator/executor/command.ts";
import { COMMAND_EXIT, readExitRecord } from "../../../../src/platform/command.ts";

class ScriptedContainment implements Containment {
  liveByScan: ProcInfo[][] = [];
  scans = 0;
  fenced: string[] = [];
  async spawn(): Promise<never> { throw new Error("not used for adopted command attempts"); }
  async scan(known: ReadonlyMap<string, readonly ProcInfo[]>) {
    const idx = Math.min(this.scans, Math.max(0, this.liveByScan.length - 1));
    this.scans += 1;
    const rows = this.liveByScan[idx] ?? [];
    return new Map([...known.keys()].map(exec => [exec, rows]));
  }
  async fence(exec: string) { this.fenced.push(exec); }
}

const effects = {
  prepare: async (t: CallTicket) => ({ cwd: t.cwd }),
  beforeSeal: async (_t: CallTicket, _e: string, r: never) => r,
  afterSeal: async () => {},
  recover: async () => {},
};

async function commandFixture(t: TestContext, options: {
  rerun?: boolean;
  liveByScan?: ProcInfo[][];
  readExitRecord?: (dir: string) => Promise<{ status: number; at: number } | undefined>;
  platform?: NodeJS.Platform;
} = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dsa-cmd-exit-"))), wid = ulid();
  const orch = await openJournal(orchLedger(home)), journal = await openJournal(journalPath(home, wid));
  const containment = new ScriptedContainment();
  containment.liveByScan = options.liveByScan ?? [[]];
  const key = "cmd", callId = `${wid}@1/${key}@1`, id = commandId(callId, 1);
  const attemptDir = join(callDir(home, wid, key, 1), commandDirName(1));
  await mkdir(attemptDir, { recursive: true });
  const spec = { agent: "", task: "", command: ["echo", "ok"], ...(options.rerun ? { rerun: true } : {}) };
  await journal.append("call", { key, gen: 1, spec });
  await journal.append(COMMAND_INTENT, { call: callId, id, n: 1 });
  await journal.append(COMMAND_STARTED, { call: callId, id, pid: 0, start: "", dir: attemptDir });
  const executor = createExecutor(
    { home, orch, config: { k: { trackerMs: 10 }, writerLock: "off" } },
    {
      effects,
      containment,
      memory: async () => 1e6,
      sweepMs: 10_000,
      ...(options.readExitRecord ? { readExitRecord: options.readExitRecord } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
    },
  );
  t.after(async () => {
    try { await executor.shutdown(); }
    finally { await journal.close(); await orch.close(); await rm(home, { recursive: true, force: true }); }
  });
  const ticket: CallTicket = {
    wid, widRev: `${wid}@1`, key, gen: 1, callId, cwd: home, journal,
    spec,
    agent: { name: "command", description: "", body: "", sourcePath: "", source: "project", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false },
  };
  return { home, wid, journal, containment, attemptDir, ticket, executor };
}

type CommandData = { exitCode: number | null; signal: string | null; durationMs: number };
const dataOf = (result: { data?: unknown }) => result.data as CommandData;

const sharingError = (code: "EACCES" | "EBUSY" | "EPERM") => Object.assign(new Error(`${code}: sharing violation`), { code });

test("command watcher survives transient sharing errors while running on Windows and seals the published exit status", { timeout: 10_000 }, async t => {
  let reads = 0;
  const f = await commandFixture(t, {
    platform: "win32",
    liveByScan: [[{ pid: 1234, ppid: 0, start: "live-1" }], []],
    readExitRecord: async dir => {
      reads += 1;
      if (reads === 1) throw sharingError("EBUSY");
      if (reads === 2) return undefined; // not published yet while process is finishing
      return readExitRecord(dir, {
        platform: "win32",
        baseDelayMs: 1,
        sleep: async () => {},
        read: async () => {
          if (reads === 3) { reads += 1; throw sharingError("EACCES"); }
          return { text: "0\n", at: Date.now() };
        },
      });
    },
  });
  const result = await f.executor.run(f.ticket);
  assert.equal(result.status, "ok");
  assert.equal(dataOf(result).exitCode, 0);
  assert.equal(dataOf(result).signal, null);
  assert.ok(reads >= 3, "retried across transient sharing errors and settled cleanly");
  assert.equal(f.journal.entries().find(e => e.type === JT.sealed)?.call, f.ticket.callId);
});

test("command watcher recovers a late exit record locked transiently right after the process and job retire", { timeout: 10_000 }, async t => {
  const errCodes = ["EPERM", "EBUSY", "EACCES"] as const;
  let calls = 0;
  let fileAttempts = 0;
  const f = await commandFixture(t, {
    platform: "win32",
    liveByScan: [[]], // process and job already retired on first scan
    readExitRecord: async dir => {
      calls += 1;
      // First read (top of loop) sees ENOENT while publication finishes; post-retirement read sees transient locks
      // that clear within readExitRecord's bounded Windows retry budget.
      if (calls === 1) return undefined;
      return readExitRecord(dir, {
        platform: "win32",
        baseDelayMs: 1,
        sleep: async () => {},
        read: async () => {
          const code = errCodes[fileAttempts++];
          if (code) throw sharingError(code);
          return { text: "7\n", at: Date.now() };
        },
      });
    },
  });
  const result = await f.executor.run(f.ticket);
  assert.equal(result.status, "failed");
  assert.equal(dataOf(result).exitCode, 7);
  assert.equal(result.error, "Command exited 7");
  assert.equal(calls, 2, "recovered on the post-retirement read without a redundant third read");
  assert.equal(fileAttempts, 4, "3 transient sharing errors followed by successful read");
});

test("command watcher fails closed as unknown when exit evidence is genuinely missing after retirement", { timeout: 10_000 }, async t => {
  const f = await commandFixture(t, { liveByScan: [[]] });
  const result = await f.executor.run(f.ticket);
  assert.equal(result.status, "unknown");
  assert.equal(result.error, "Command ended without an exit record");
  assert.equal(dataOf(result).exitCode, null);
});

test("command watcher fails closed as unknown on Windows when sharing conflicts persist past bounded retries after retirement", { timeout: 10_000 }, async t => {
  let reads = 0;
  const f = await commandFixture(t, {
    platform: "win32",
    liveByScan: [[]],
    readExitRecord: async dir => {
      reads += 1;
      return readExitRecord(dir, {
        platform: "win32",
        maxAttempts: 3,
        baseDelayMs: 1,
        sleep: async () => {},
        read: async () => { throw sharingError("EACCES"); },
      });
    },
  });
  const result = await f.executor.run(f.ticket);
  assert.equal(result.status, "unknown", "never hangs or crashes on persistent sharing conflict");
  assert.equal(result.error, "Command ended without an exit record");
  assert.equal(reads, 2, "checked before and after retirement scan, then failed closed");
});

test("command watcher propagates POSIX EACCES/EPERM permission errors explicitly instead of silently sealing unknown", { timeout: 10_000 }, async t => {
  for (const code of ["EACCES", "EPERM"] as const) {
    let reads = 0;
    const f = await commandFixture(t, {
      platform: "linux",
      liveByScan: [[]],
      readExitRecord: async () => {
        reads += 1;
        throw Object.assign(new Error(`${code}: permission denied`), { code });
      },
    });
    await assert.rejects(f.executor.run(f.ticket), { code });
    assert.equal(reads, 1, `POSIX ${code} propagated immediately on first read without turning into lost/unknown`);
    assert.equal(f.journal.entries().find(e => e.type === JT.sealed), undefined, "permission error did not silently seal unknown");
  }
});

test("command watcher reads a real published exit record cleanly after retirement", { timeout: 10_000 }, async t => {
  const f = await commandFixture(t, { liveByScan: [[]] });
  await writeFile(join(f.attemptDir, COMMAND_EXIT), "0\n", "utf8");
  const result = await f.executor.run(f.ticket);
  assert.equal(result.status, "ok");
  assert.equal(dataOf(result).exitCode, 0);
});
