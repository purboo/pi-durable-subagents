import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessTable } from "../../../src/platform/proctable.ts";
import { Containment } from "../../../src/platform/containment.ts";
import { OsLock } from "../../../src/platform/lock.ts";
import type { Spawned } from "../../../src/types.ts";

async function until<T>(fn: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 4000;
  while (Date.now() < end) { const value = await fn(); if (value !== undefined) return value; await delay(20); }
  throw new Error("Timed out waiting for process evidence");
}
function line(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No child response")), 4000);
    let text = "";
    child.stdout!.on("data", chunk => { text += chunk; if (text.includes("\n")) { clearTimeout(timer); resolve(text.trim()); } });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Child exited before response")); });
  });
}
async function cleanup(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
}
const spec = (exec: string, command: string, args: string[]) => ({ exec, command, args, cwd: tmpdir(), env: {} });

test("Linux process table reports identity, tag and CPU; direct spawn fences", { timeout: 10000 }, async () => {
  const c = new Containment(); const tag = randomUUID(); let child: Spawned | undefined;
  try {
    child = await c.spawn(spec(tag, process.execPath, ["-e", "setInterval(()=>{},1000)"]));
    const table = new ProcessTable();
    const p = (await table.list(new Set([tag]))).find(p => p.pid === child!.pid)!;
    assert.equal(p.ppid, process.pid); assert.equal(p.start, child.start); assert.equal(p.tag, tag);
    assert.ok(p.cpuMs! >= 0);
    assert.equal((await table.list(new Set([tag]))).find(p => p.pid === child!.pid)?.tag, tag);
    await c.fence(tag, []); assert.equal((await child.exited).signal, "SIGKILL");
  } finally { await c.fence(tag, []); }
});

test("setsid escaped descendant is fenced by tag after parent SIGKILL", { skip: process.platform !== "linux", timeout: 10000 }, async () => {
  const tag = randomUUID(); const c = new Containment(); const table = new ProcessTable();
  try {
    const parent = await c.spawn(spec(tag, "/bin/sh", ["-c", "setsid sleep 60 & wait"]));
    const escaped = await until(async () => {
      const p = (await table.list()).find(p => p.tag === tag && p.pid !== parent.pid);
      if (!p) return;
      const stat = await readFile(`/proc/${p.pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return Number(fields[3]) === p.pid && stat.includes("(sleep)") ? p : undefined;
    });
    process.kill(parent.pid, "SIGKILL"); await parent.exited;
    assert.ok((await table.list()).some(p => p.pid === escaped.pid));
    await new Containment().fence(tag, []);
    assert.equal((await table.list()).filter(p => p.tag === tag).length, 0);
  } finally { await c.fence(tag, []); }
});

test("tracked identity is fenced after exec clears its tag", { timeout: 10000 }, async () => {
  const tag = randomUUID(); const c = new Containment(); let tracked: Awaited<ReturnType<ProcessTable["list"]>> = [];
  try {
    const child = await c.spawn(spec(tag, "/bin/sh", ["-c", "read x; exec env -u DSA_EXEC sleep 60"]));
    tracked = (await new ProcessTable().list(new Set([tag]))).filter(p => p.pid === child.pid);
    child.stdin.write("go\n");
    await until(async () => (await new ProcessTable().list(new Set([tag]))).find(p => p.pid === child.pid && p.tag === undefined));
    await new Containment().fence(tag, tracked);
    assert.equal((await child.exited).signal, "SIGKILL");
  } finally { await c.fence(tag, tracked); }
});

test("scan discovers untagged descendants and ignores mismatched start tokens", { timeout: 10000 }, async () => {
  const tag = randomUUID(); const c = new Containment();
  try {
    const parent = await c.spawn(spec(tag, "/bin/sh", ["-c", "env -u DSA_EXEC sleep 60 & wait"]));
    const child = await until(async () => (await c.scan(new Map())).get(tag)?.find(p => p.pid !== parent.pid));
    assert.equal(child.tag, undefined);
    const fresh = new Containment();
    await fresh.fence("nonexistent", [{ ...child, start: "wrong" }]);
    assert.ok((await new ProcessTable().list()).some(p => p.pid === child.pid));
    await c.fence(tag, [child]);
  } finally { await c.fence(tag, []); }
});

test("fence rejects when process-table evidence does not arrive; spawn errors reject", { timeout: 5000 }, async () => {
  const c = new Containment({ list: () => new Promise(() => {}) });
  await assert.rejects(c.fence("missing", [], { timeoutMs: 30 }), /Fence timeout/);
  await assert.rejects(new Containment().spawn(spec(randomUUID(), "/nonexistent-dsa-command", [])), /ENOENT/);
});

const lockModule = pathToFileURL(join(process.cwd(), "src/platform/lock.ts")).href;
function holder(path: string): ChildProcess {
  return spawn(process.execPath, ["--input-type=module", "-e", `
    import {OsLock} from ${JSON.stringify(lockModule)};
    const lock = await new OsLock().tryAcquire(process.argv[1]);
    console.log(lock ? 'yes' : 'no');
    if(lock) { process.stdin.resume(); process.stdin.on('end', async()=>{await lock.release();}); }
  `, path], { stdio: "pipe" });
}

test("OS lock releases on holder SIGKILL and exactly one concurrent acquirer succeeds", { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsa-lock-")); const path = join(dir, "lock");
  const children: ChildProcess[] = []; const lock = new OsLock();
  try {
    const a = holder(path), b = holder(path); children.push(a, b);
    const answers = await Promise.all([line(a), line(b)]);
    assert.deepEqual([...answers].sort(), ["no", "yes"]);
    assert.equal(await lock.tryAcquire(path), null);
    const winner = answers[0] === "yes" ? a : b;
    const helpers = (await new ProcessTable().list()).filter(p => p.ppid === winner.pid);
    assert.equal(helpers.length, 1);
    await cleanup(winner);
    await until(async () => {
      const live = await new ProcessTable().list();
      return helpers.every(helper => !live.some(p => p.pid === helper.pid && p.start === helper.start)) ? true : undefined;
    });
    const next = await until(async () => (await lock.tryAcquire(path)) ?? undefined);
    await next.release(); await next.release();
    const reacquired = await lock.tryAcquire(path); assert.ok(reacquired); await reacquired.release();
    await assert.rejects(lock.tryAcquire(join(dir, "missing", "lock")), /helper exited/);
  } finally {
    await Promise.all(children.map(cleanup));
    await rm(dir, { recursive: true, force: true });
  }
});
