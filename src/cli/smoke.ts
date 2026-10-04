import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProcessTable } from "../platform/proctable.ts";
import { Containment } from "../platform/containment.ts";
import { OsLock } from "../platform/lock.ts";
import { publishFile } from "../kernel/mailbox.ts";
import { ulid } from "../kernel/ids.ts";

export interface Capability { name: string; ok: boolean; detail: string }
export interface SmokeReport { execution: Capability[]; ui: Capability[]; gap: string }
/** P21, C1–C4, C11: Measure execution surfaces independently and report UI degradation. */
export async function smoke(env: NodeJS.ProcessEnv = process.env, tty = Boolean(process.stdin.isTTY && process.stdout.isTTY)): Promise<SmokeReport> {
  const root = await mkdtemp(join(tmpdir(), "dsa-smoke-"));
  const execution: Capability[] = [];
  const check = async (name: string, fn: () => Promise<string>) => {
    try { execution.push({ name, ok: true, detail: await fn() }); }
    catch (error) { execution.push({ name, ok: false, detail: String(error) }); }
  };
  try {
    await check("process-table", async () => { const rows = await new ProcessTable().list(); if (!rows.some(p => p.pid === process.pid)) throw new Error("Own process missing"); return `${rows.length} processes visible`; });
    const containment = new Containment(), exec = `smoke:${ulid()}`;
    await check("spawn/tag/fence", async () => {
      const child = await containment.spawn({ exec, command: process.execPath, args: ["-e", "process.stdin.resume(); setTimeout(()=>process.exit(2),10000)"], cwd: root, env: Object.fromEntries(Object.entries(env).filter((pair): pair is [string, string] => pair[1] !== undefined)) });
      child.stdin.on("error", () => {});
      try {
        const rows = await new ProcessTable().list(new Set([exec]));
        if (!rows.some(p => p.pid === child.pid && p.tag === exec && p.start === child.start)) throw new Error("Child tag/start token not visible");
        await containment.fence(exec, [], { timeoutMs: 5000 });
        await child.exited;
        return "tag visible; tagged child fenced";
      } finally {
        child.stdin.end();
        await containment.fence(exec, [], { timeoutMs: 5000 });
        await child.exited;
      }
    });
    await check("lock", async () => {
      const path = join(root, "probe.lock"), lock = await new OsLock().tryAcquire(path);
      if (!lock) throw new Error("Fresh lock unavailable");
      try { const second = await new OsLock().tryAcquire(path); if (second) { await second.release(); throw new Error("Lock did not exclude a second holder"); } }
      finally { await lock.release(); }
      const next = await new OsLock().tryAcquire(path); if (!next) throw new Error("Released lock unavailable"); await next.release();
      return "exclusive and reacquirable";
    });
    await check("publishFile", async () => {
      const results = [await publishFile(root, "probe", "one"), await publishFile(root, "probe", "one"), await publishFile(root, "probe", "two")];
      if (results.join() !== "published,exists-identical,conflict") throw new Error(`Unexpected publication: ${results}`);
      return "fsync and no-replace publication";
    });
    await check("pi-version", async () => {
      const { stdout } = await promisify(execFile)(env.DSA_PI_BIN ?? "pi", ["--version"], { env: { ...env, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" }, cwd: root, timeout: 10_000, maxBuffer: 64 * 1024 });
      if (!stdout.trim()) throw new Error("pi returned no version");
      return stdout.trim();
    });
  } finally { await rm(root, { recursive: true, force: true }); }
  return { execution, ui: [{ name: "interactive-terminal", ok: tty, detail: tty ? "TTY available; UI hooks require interactive pi" : "No interactive TTY; UI degrades to CLI/RPC" }], gap: "A process that clears its tag and leaves the process tree before the first scan cannot be discovered (C1–C3)." };
}
