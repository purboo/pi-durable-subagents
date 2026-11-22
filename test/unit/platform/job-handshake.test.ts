// The handshake of a Windows command attempt beyond the group itself: the tag that finds the attempt before any group
// record exists (the owner's own argv), a sharing failure of a handshake file that is a retry, and the failure path that
// adopts an attempt instead of reporting it failed while the owner may still act. The last two need a real compiled
// owner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { JOB_END, JOB_GROUP, jobHostArgv, spawnInJob, transientRead } from "../../../src/platform/job.ts";
import { winTag, winProcessRows } from "../../../src/platform/windows.ts";

const windowsOnly = process.platform === "win32" ? false : "a Windows Job Object (Win32)";
const dirOf = () => mkdtempSync(join(tmpdir(), "dsa-job-hand-"));
async function until<T>(get: () => Promise<T | undefined> | T | undefined, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await get(); if (value !== undefined) return value; if (Date.now() > end) throw new Error(`timeout: ${what}`); await delay(50); }
}
const live = async (pid: number) => (await winProcessRows()).some(row => row.pid === pid);
/** The owner's end, through a timer: its handle is unref'd (it must not hold this process open), so a bare await could
 *  end the test process instead. */
async function ended(launched: { exited: Promise<void> }, ms = 30_000): Promise<void> {
  await Promise.race([launched.exited, delay(ms).then(() => { throw new Error("the owner did not end"); })]);
}
async function gone(pid: number) {
  const end = Date.now() + 20_000;
  while (await live(pid)) { if (Date.now() > end) throw new Error(`pid ${pid} still runs`); await delay(50); }
}

test("the attempt's tag is spelled in the owner's own argv, where a process-table scan finds it", () => {
  const dir = "C:\\dsa\\attempt", id = "command:W@1/a@1#1";
  const argv = jobHostArgv(dir, id);
  // argv[0] is the attempt directory; the tag is the second argument, which the C# ignores.
  assert.deepEqual(argv, [dir, `DSA_EXEC=${id}`]);
  // The tag is what a Windows scan reads: an owner that has not reported a group yet is still this attempt, not a loss.
  assert.equal(winTag(argv.join(" "), "DSA_EXEC"), id);
  // A launch without an attempt id (a probe) carries no tag and stays out of every attempt's scan.
  assert.deepEqual(jobHostArgv(dir), [dir]);
  assert.equal(winTag(jobHostArgv(dir).join(" "), "DSA_EXEC"), undefined);
});

test("a handshake file held for a moment is a retry, never a failed attempt", () => {
  for (const code of ["EBUSY", "EPERM", "EACCES", "EAGAIN", "EMFILE", "ENFILE"])
    assert.equal(transientRead(Object.assign(new Error("in use"), { code })), true, code);
  // A missing record is a wait (the owner is still starting), and a real I/O failure is not a retry either.
  for (const code of ["ENOENT", "EIO", "ENOTDIR", "ENOSPC"]) assert.equal(transientRead(Object.assign(new Error("no"), { code })), false, code);
  assert.equal(transientRead(new Error("no code")), false);
});

test("the attempt is found by the tag in the running owner's argv while the wrapper is still to come", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const id = "command:W@1/tag@1#1";
  // A program that does not end promptly: the owner waits for it, so its own row is observable throughout.
  const launched = await spawnInJob(dir, { exe: process.execPath, args: ["-e", "setTimeout(() => process.exit(0), 3000)"], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env }, exec: id });
  assert.ok(launched);
  assert.ok(launched.group && launched.group.pid > 0);
  // This is the row a successor finds for a recorded intent: the owner itself, tagged by the argument in its argv.
  const rows = await winProcessRows(), helper = rows.find(row => row.pid === launched.group!.pid);
  assert.ok(helper, "the owner is observable while the attempt runs");
  assert.equal(winTag(helper.command, "DSA_EXEC"), id);
  // And the wrapper carries the same tag, so either identity anchors the attempt.
  assert.equal(winTag(rows.find(row => row.pid === launched.pid)?.command, "DSA_EXEC"), id);
  await ended(launched);
  await gone(launched.pid), await gone(launched.group!.pid);
});

test("a transient observation failure is retried instead of ending the attempt", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const program = join(dir, "once.mjs");
  writeFileSync(program, "console.log('ran'); process.exit(3);\n");
  let reads = 0;
  const launched = await spawnInJob(dir, { exe: process.execPath, args: [program], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env }, exec: "command:W@1/flaky@1#1" },
    { observe: async () => { if (++reads <= 2) throw new Error("cim unavailable"); return winProcessRows(); } });
  assert.ok(launched);
  assert.equal(launched.uncertain, undefined, "the attempt started normally once the table answered");
  assert.ok(launched.group && launched.group.start, "the group owner's identity is recorded");
  await ended(launched);
  assert.equal(JSON.parse(readFileSync(join(dir, JOB_END), "utf8")).status, 3);
  assert.match(readFileSync(join(dir, "output.log"), "utf8"), /ran/);
});

test("an attempt whose owner cannot be confirmed retired is adopted, not refused", { skip: windowsOnly, timeout: 120_000 }, async t => {
  const dir = dirOf(); t.after(() => rm(dir, { recursive: true, force: true }));
  const id = "command:W@1/adopt@1#1";
  // The wrapper acts (so its exit record appears) but the observation never answers and the kill is denied: the attempt
  // must not be reported failed -- the owner may still create the group -- so it is adopted with the owner's identity.
  const program = join(dir, "adopted.mjs");
  writeFileSync(program, "setTimeout(() => { console.log('adopted'); process.exit(0); }, 1200);\n");
  const launched = await spawnInJob(dir, { exe: process.execPath, args: [program], cwd: dir,
    log: join(dir, "output.log"), env: { ...process.env }, exec: id },
    { observe: async () => { throw new Error("the process table is not readable"); },
      endHelper: async () => { throw new Error("taskkill denied"); }, observeMs: 100, endMs: 100 });
  assert.ok(launched);
  assert.match(String(launched.uncertain), /could not be observed/);
  assert.ok(launched.pid > 0, "the adopted identity is the owner's pid");
  assert.equal(launched.start, "", "the identity could not be read, so the tag finds it");
  // The adopted attempt really ran: nothing was killed and the group closed only when the command ended.
  await until(async () => { try { return JSON.parse(readFileSync(join(dir, JOB_GROUP), "utf8")).pid as number; } catch { return undefined; } }, "the group record of the adopted attempt");
  const rows = await winProcessRows();
  assert.equal(winTag(rows.find(row => row.pid === launched.pid)?.command, "DSA_EXEC"), id, "the adopted owner carries the attempt's tag");
  await ended(launched);
  assert.equal(JSON.parse(readFileSync(join(dir, JOB_END), "utf8")).status, 0);
  assert.match(readFileSync(join(dir, "output.log"), "utf8"), /adopted/);
  // Only a scan that finds the owner gone lets another attempt start: the adopted identity is the whole group's anchor.
  await gone(launched.pid);
});
