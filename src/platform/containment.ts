import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import type { Containment as Contract, ExecId, ProcInfo, ProcessTable as Table, Spawned, SpawnSpec } from "../types.ts";
import { captureStart, ProcessTable } from "./proctable.ts";
import { isOwnedWinChild, isWinStart, killTree, sameCreation, type WinProcessIdentity } from "./windows.ts";

// One table per orchestrator process, including evaluator and gate observers.
const sharedTable = new ProcessTable();

type KnownTable = { list(knownExecs?: ReadonlySet<string>, options?: { maxAgeMs?: number; fresh?: boolean }): ReturnType<Table["list"]> };

const identity = (p: Pick<ProcInfo, "pid" | "start">) => `${p.pid}:${p.start}`;

export type FenceOptions = {
  timeoutMs?: number;
  /** EX1: Best-effort diagnostics before each SIGKILL round; aborted after 500 ms, never a retirement guard. */
  beforeKill?: (targets: readonly ProcInfo[], signal: AbortSignal) => Promise<void>;
};

export interface ContainmentOptions {
  platform?: NodeJS.Platform;
  captureStart?: (pid: number) => Promise<string>;
  /** Windows seam: terminate verified `(pid, start)` trees (default: handle-verified `killTree`). */
  killWindows?: (targets: readonly WinProcessIdentity[], options?: { timeout?: number }) => Promise<void>;
  /** POSIX seam: signal a verified pid (default: `process.kill(pid, "SIGKILL")`). */
  killPosix?: (pid: number) => void;
}

/** P22, P23, C1, C3: Direct launch and identity-based retirement of executions. */
export class Containment implements Contract {
  private table: KnownTable;
  private launched = new Map<ExecId, ProcInfo[]>();
  private platform: NodeJS.Platform;
  private readStart: (pid: number) => Promise<string>;
  private killWin: (targets: readonly WinProcessIdentity[], options?: { timeout?: number }) => Promise<void>;
  private killUnix?: (pid: number) => void;
  constructor(table: KnownTable = sharedTable, options: ContainmentOptions = {}) {
    this.table = table;
    this.platform = options.platform ?? process.platform;
    this.readStart = options.captureStart ?? captureStart;
    this.killWin = options.killWindows ?? killTree;
    this.killUnix = options.killPosix;
  }

  /** C1, C3: Inject the execution tag and capture the direct child's start token. */
  async spawn(spec: SpawnSpec): Promise<Spawned> {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, shell: spec.shell,
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
      let captured = await this.readStart(pid);
      if (!captured && child.exitCode === null && child.signalCode === null) {
        // The child may have just exited in the kernel before libuv delivered `'exit'`; wait briefly, then re-read once.
        await Promise.race([exited.then(() => undefined, () => undefined), delay(100)]);
        if (child.exitCode === null && child.signalCode === null) captured = await this.readStart(pid);
      }
      // Empty tokens represent children that retired before identity capture; a still-live child without a valid start
      // token fails closed instead of running untracked.
      const retired = child.exitCode !== null || child.signalCode !== null;
      const start = retired ? "" : captured;
      if (!retired && (!start || (this.platform === "win32" && !isWinStart(start)))) {
        throw new Error(`C3: process ${pid} has no verifiable start identity`);
      }
      const known = this.launched.get(spec.exec) ?? [];
      if (start) known.push({ pid, ppid: process.pid, start, tag: spec.exec });
      this.launched.set(spec.exec, known);
      return { pid, start, stdin: child.stdin, stdout, stderr, exited };
    } catch (error) {
      stdout.destroy(); stderr.destroy();
      // Direct libuv handle termination (`uv_process_kill`), never bare-PID `taskkill /T` without verified `start`.
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited.catch(() => {});
      throw error;
    }
  }

  /** P22: Find tagged processes and the live descendants of known identities. */
  async scan(known: ReadonlyMap<ExecId, readonly ProcInfo[]>, options: { maxAgeMs?: number; fresh?: boolean } = {}): Promise<Map<ExecId, ProcInfo[]>> {
    const windows = this.platform === "win32";
    const execs = new Set([...known.keys(), ...this.launched.keys()]);
    const all = await this.table.list(execs, options);
    for (const p of all) if (p.tag !== undefined) execs.add(p.tag);
    const result = new Map<ExecId, ProcInfo[]>(), liveStarts = new Map(all.map(p => [p.pid, p.start]));
    // One index of the table per scan: tagged processes and children by parent, so each execution costs its own tree.
    const tagged = new Map<string, ProcInfo[]>(), children = new Map<number, ProcInfo[]>();
    for (const p of all) {
      if (p.tag !== undefined) { const list = tagged.get(p.tag); if (list) list.push(p); else tagged.set(p.tag, [p]); }
      const list = children.get(p.ppid); if (list) list.push(p); else children.set(p.ppid, [p]);
    }
    const validChild = (parent: ProcInfo, child: ProcInfo): boolean => {
      if (child.pid === parent.pid || child.ppid !== parent.pid || !parent.start || !child.start) return false;
      if (windows) return isOwnedWinChild(parent, child);
      if (this.platform === "linux" && /^\d+$/.test(parent.start) && /^\d+$/.test(child.start)) {
        return BigInt(child.start) >= BigInt(parent.start);
      }
      return true;
    };
    for (const exec of execs) {
      // Historical identities cannot select an absent/reused pid. Avoid allocating a string/Set entry for each one.
      const matchedPids = new Set<number>();
      for (const group of [known.get(exec) ?? [], this.launched.get(exec) ?? []]) {
        for (const p of group) {
          if (!p.start || (windows && !isWinStart(p.start))) continue;
          const liveStart = liveStarts.get(p.pid);
          if (liveStart !== undefined && (windows ? sameCreation(liveStart, p.start) : liveStart === p.start)) matchedPids.add(p.pid);
        }
      }
      const own = tagged.get(exec);
      // Nothing tagged and no live identity selects nothing (most execs of a sweep are history).
      if (!matchedPids.size && !own) { result.set(exec, []); continue; }
      // The tagged and the known live processes in table order, then every proven-owned live descendant (breadth first).
      const selected = new Map<number, ProcInfo>();
      for (const p of all) if (p.tag === exec || matchedPids.has(p.pid)) selected.set(p.pid, p);
      const queue = [...selected.keys()];
      for (let i = 0; i < queue.length; i++) {
        const parent = selected.get(queue[i]!)!;
        if (!parent.start || (windows && !isWinStart(parent.start))) continue;
        for (const c of children.get(parent.pid) ?? []) {
          if (!selected.has(c.pid) && validChild(parent, c)) { selected.set(c.pid, c); queue.push(c.pid); }
        }
      }
      result.set(exec, [...selected.values()]);
    }
    return result;
  }

  /** P22, P23: Kill tagged and tracked identities until a rescan proves retirement. */
  async fence(exec: ExecId, tracked: readonly ProcInfo[], opts: FenceOptions = {}): Promise<void> {
    const windows = this.platform === "win32";
    // PowerShell/CIM scans and handle-verified termination are ~0.5 s on Windows: the Unix 5 s deadline is too
    // tight under load (several workflows, parallel test files).
    const timeout = opts.timeoutMs ?? (windows ? 15_000 : 5000);
    if (!Number.isFinite(timeout) || timeout < 0) throw new Error("Invalid fence timeout");
    const deadline = performance.now() + timeout;
    let recordingMs = 500;
    const hasIdentity = (p: Pick<ProcInfo, "pid" | "start">) => p.pid > 0 && (windows ? isWinStart(p.start) : p.start !== "");
    const known = new Map(tracked.filter(hasIdentity).map(p => [identity(p), p]));
    let unverifiedPid: number | undefined;
    const timeoutReason = () => unverifiedPid === undefined ? `Fence timeout: ${exec}` : `Fence timeout: ${exec} (unverified identity for pid ${unverifiedPid})`;
    for (;;) {
      const remaining = deadline - performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const live = await Promise.race([
        this.scan(new Map([[exec, [...known.values()]]]), { fresh: true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(timeoutReason())), Math.max(0, remaining)); }),
      ]).finally(() => clearTimeout(timer));
      const targets = live.get(exec) ?? [];
      if (!targets.length) { this.launched.delete(exec); return; }
      for (const p of targets) {
        if (hasIdentity(p)) known.set(identity(p), p);
        else if (windows) unverifiedPid = p.pid;
      }
      if (performance.now() >= deadline) throw new Error(timeoutReason());

      if (windows) {
        // Fail closed: never touch a target whose `(pid, start)` identity is missing or malformed.
        const verified = targets.filter(hasIdentity);
        if (verified.length) {
          if (opts.beforeKill && recordingMs > 0) {
            const recordingStarted = performance.now(), controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                Promise.resolve().then(() => opts.beforeKill!(verified, controller.signal)),
                new Promise<void>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); }, recordingMs); }),
              ]);
            } catch { /* A recording failure must never prevent termination. */ }
            finally { clearTimeout(timer); controller.abort(); recordingMs = Math.max(0, recordingMs - (performance.now() - recordingStarted)); }
          }
          // Handle-verified termination checks GetProcessTimes on the open kernel handle right before TerminateProcess,
          // so exit/PID reuse during scan or beforeKill cannot touch an unrelated process.
          await this.killWin(verified.map(p => ({ pid: p.pid, start: p.start })), { timeout: Math.max(1000, Math.ceil(deadline - performance.now())) });
        }
        await delay(Math.min(20, Math.max(0, deadline - performance.now())));
        continue;
      }

      const signalUnix = (pid: number) => {
        try { if (this.killUnix) this.killUnix(pid); else process.kill(pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      };
      const killing: ProcInfo[] = [];
      for (const p of targets) {
        // C3: the pid may have exited and been reused since the scan; kill only if it still has the scanned start.
        if (p.start !== "" && await this.readStart(p.pid) !== p.start) continue;
        if (!opts.beforeKill) signalUnix(p.pid);
        else killing.push(p);
      }
      if (killing.length && opts.beforeKill && recordingMs > 0) {
        const recordingStarted = performance.now(), controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(() => opts.beforeKill!(killing, controller.signal)),
            new Promise<void>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); }, recordingMs); }),
          ]);
        } catch { /* A recording failure must never prevent SIGKILL. */ }
        finally { clearTimeout(timer); controller.abort(); recordingMs = Math.max(0, recordingMs - (performance.now() - recordingStarted)); }
      }
      for (const p of killing) {
        // Diagnostic I/O was asynchronous: revalidate identity again before signalling.
        if (opts.beforeKill && p.start !== "" && await this.readStart(p.pid) !== p.start) continue;
        signalUnix(p.pid);
      }
      await delay(Math.min(20, Math.max(0, deadline - performance.now())));
    }
  }
}
