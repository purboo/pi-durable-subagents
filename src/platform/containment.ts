import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import type { Containment as Contract, ExecId, ProcInfo, ProcessTable as Table, Spawned, SpawnSpec } from "../types.ts";
import { captureStart, ProcessTable } from "./proctable.ts";

// One table per orchestrator process, including evaluator and gate observers.
const sharedTable = new ProcessTable();

type KnownTable = { list(knownExecs?: ReadonlySet<string>, options?: { maxAgeMs?: number; fresh?: boolean }): ReturnType<Table["list"]> };

const identity = (p: Pick<ProcInfo, "pid" | "start">) => `${p.pid}:${p.start}`;

/** P22, P23, C1, C3: Direct launch and identity-based retirement of executions. */
export class Containment implements Contract {
  private table: KnownTable;
  private launched = new Map<ExecId, ProcInfo[]>();
  constructor(table: KnownTable = sharedTable) { this.table = table; }

  /** C1, C3: Inject the execution tag and capture the direct child's start token. */
  async spawn(spec: SpawnSpec): Promise<Spawned> {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd,
      env: { ...process.env, ...spec.env, DSA_EXEC: spec.exec }, stdio: "pipe" });
    // Buffer output immediately: Node drains child pipes on exit, even while
    // identity capture is pending and the caller has not received the streams.
    const stdout = child.stdout.pipe(new PassThrough());
    const stderr = child.stderr.pipe(new PassThrough());
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    // Attach a handler before any asynchronous process-table work.
    void exited.catch(() => {});
    try {
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      const pid = child.pid!;
      const captured = await captureStart(pid);
      // Empty tokens represent children that retired before identity capture.
      const start = child.exitCode !== null || child.signalCode !== null ? "" : captured;
      const known = this.launched.get(spec.exec) ?? [];
      if (start) known.push({ pid, ppid: process.pid, start, tag: spec.exec });
      this.launched.set(spec.exec, known);
      return { pid, start, stdin: child.stdin, stdout, stderr, exited };
    } catch (error) {
      stdout.destroy(); stderr.destroy();
      child.kill("SIGKILL");
      await exited.catch(() => {});
      throw error;
    }
  }

  /** P22: Find tagged processes and the live descendants of known identities. */
  async scan(known: ReadonlyMap<ExecId, readonly ProcInfo[]>, options: { maxAgeMs?: number; fresh?: boolean } = {}): Promise<Map<ExecId, ProcInfo[]>> {
    const execs = new Set([...known.keys(), ...this.launched.keys()]);
    const all = await this.table.list(execs, options);
    for (const p of all) if (p.tag !== undefined) execs.add(p.tag);
    const result = new Map<ExecId, ProcInfo[]>(), liveStarts = new Map(all.map(p => [p.pid, p.start]));
    for (const exec of execs) {
      // Historical identities cannot select an absent/reused pid. Avoid allocating a string/Set entry for each one.
      const ids = new Set<string>();
      for (const group of [known.get(exec) ?? [], this.launched.get(exec) ?? []])
        for (const p of group) if (p.start !== "" && liveStarts.get(p.pid) === p.start) ids.add(identity(p));
      const selected = new Map(all.filter(p => p.tag === exec || ids.has(identity(p))).map(p => [p.pid, p]));
      let changed = true;
      while (changed) {
        changed = false;
        for (const p of all) if (!selected.has(p.pid) && selected.has(p.ppid)) {
          selected.set(p.pid, p); changed = true;
        }
      }
      result.set(exec, [...selected.values()]);
    }
    return result;
  }

  /** P22, P23: Kill tagged and tracked identities until a rescan proves retirement. */
  async fence(exec: ExecId, tracked: readonly ProcInfo[], opts: { timeoutMs?: number } = {}): Promise<void> {
    const timeout = opts.timeoutMs ?? 5000;
    if (!Number.isFinite(timeout) || timeout < 0) throw new Error("Invalid fence timeout");
    const deadline = performance.now() + timeout;
    const known = new Map(tracked.filter(p => p.start !== "").map(p => [identity(p), p]));
    for (;;) {
      const remaining = deadline - performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const live = await Promise.race([
        this.scan(new Map([[exec, [...known.values()]]]), { fresh: true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Fence timeout: ${exec}`)), Math.max(0, remaining)); }),
      ]).finally(() => clearTimeout(timer));
      const targets = live.get(exec) ?? [];
      if (!targets.length) { this.launched.delete(exec); return; }
      if (performance.now() >= deadline) throw new Error(`Fence timeout: ${exec}`);
      for (const p of targets) {
        known.set(identity(p), p);
        // C3: the pid may have exited and been reused since the scan; kill only if it still has the scanned start.
        if (p.start !== "" && await captureStart(p.pid) !== p.start) continue;
        try { process.kill(p.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      await delay(Math.min(20, Math.max(0, deadline - performance.now())));
    }
  }
}
