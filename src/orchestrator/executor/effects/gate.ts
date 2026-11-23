// Private workflow records (P30, A5): gate-intent{call,id,exec,jobDir?},
// gate-tracked{id,process}; gate{id,exit,json?,error?,unknown?,aborted?}.
// DSA_RESULT and DSA_OUTPUT are immutable gate inputs; JSON output is read from stdout.
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publishFile } from "../../../kernel/mailbox.ts";
import { callDir } from "../../../paths.ts";
import { validate } from "../../../agent/child/schema.ts";
import { fenceAttentionResolved, gateJobProcesses, gateJobTracked, recordFenceFailure, recordOnce } from "../sweep.ts";
import { entriesOf } from "../indexes.ts";
import {
  JOB_HOST_LOG,
  prepareCancelled,
  prepareJob,
  readGroupEndSync,
  spawnInJob,
  startError,
  type JobLaunch,
  type JobOptions,
  type JobPrep,
  type JobSpawned,
} from "../../../platform/job.ts";
import { shellTarget } from "../../../platform/launch.ts";
import { comspec, envValue, helperEnv, isWinStart, mergeEnv, normalizeEnv, sameCreation, systemRoot, winTagArg } from "../../../platform/windows.ts";
import type { CallResult, Containment, Entry, JournalHandle, ProcInfo } from "../../../types.ts";
import type { CallTicket } from "../../contract.ts";

const GATE_SPEC = "gate.json";
const GATE_WRAPPER = "wrapper.mjs";
const GATE_STDOUT = "stdout.log";

/** Windows gate wrapper: runs inside the per-gate Job Object (created suspended and assigned before its first
 *  instruction). Normalizes the case-insensitive Windows environment, executes the gate command through its ComSpec
 *  with stdout inherited and stdin/stderr attached to NUL, and exits with the normalized DWORD status. */
const GATE_WRAPPER_SOURCE = `import { spawn } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
let spec;
try {
  spec = JSON.parse(readFileSync(join(dir, "${GATE_SPEC}"), "utf8"));
  try { unlinkSync(join(dir, "${GATE_SPEC}")); } catch { /* already gone */ }
} catch { process.exit(126); }
function dword(code) { return code >>> 0; }
function value(env, name) { const lower = name.toLowerCase(); let found; for (const key of Object.keys(env)) if (key.toLowerCase() === lower) found = env[key]; return found; }
function put(env, name, val) { const lower = name.toLowerCase(); for (const key of Object.keys(env)) if (key.toLowerCase() === lower) delete env[key]; env[name] = val; }
const shell = value(spec.env, "ComSpec") || value(process.env, "ComSpec") || (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
const env = {};
for (const key of Object.keys(spec.env)) put(env, key, spec.env[key]);
put(env, "ComSpec", shell);
put(env, "PATHEXT", value(spec.env, "PATHEXT") || value(process.env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD");
let child;
try {
  child = spawn(spec.command, { cwd: spec.cwd, env, shell, stdio: ["ignore", "inherit", "ignore"], windowsHide: true });
} catch (error) {
  process.exit(error && error.code === "ENOENT" ? 127 : 126);
}
child.once("error", error => { process.exit(error && error.code === "ENOENT" ? 127 : 126); });
child.once("exit", (code, signal) => { process.exit(code === null ? (signal ? 128 : 1) : dword(code)); });
`;

export interface GateOptions {
  /** Test seam for exercising the Windows Job Object gate path deterministically on non-Windows hosts. */
  platform?: NodeJS.Platform;
  job?: Pick<JobOptions, "compiler" | "compileMs" | "publish" | "timeoutMs" | "observeMs" | "endMs" | "observe" | "endHelper" | "stdio">;
  onJobOwnerSpawned?: () => void;
  beforeRecordTracked?: () => Promise<void> | void;
}

function tracked(journal: JournalHandle, intent: Entry): ProcInfo[] {
  const id = String(intent.id);
  const recorded = journal.entries().filter(e => e.type === "gate-tracked" && e.id === id).map(e => e.process as ProcInfo);
  return gateJobTracked(intent.jobDir, id, recorded);
}

// Calls parked on an unfenced gate, woken when the sweep records the gate's outcome.
const parked = new Map<string, Set<() => void>>();
/** P30, F1: A gate proven retired after a failed fence gets its unknown outcome once and its attention resolved. */
export async function gateRetired(journal: JournalHandle, id: string): Promise<void> {
  await recordOnce(journal, async () => {
    if (!journal.entries().some(e => e.type === "gate" && e.id === id)) await journal.append("gate", { id, unknown: true });
    await fenceAttentionResolved(journal, id);
  });
  for (const wake of parked.get(id) ?? []) wake();
}
/** A2, F1: Wait until the sweep has fenced a gate and recorded its outcome; a settlement abort (stop, timeout,
 *  budget, suspend) ends the wait without an outcome. */
async function gateParked(journal: JournalHandle, id: string, signal: AbortSignal): Promise<Entry | undefined> {
  const waiters = parked.get(id) ?? new Set<() => void>(); parked.set(id, waiters);
  try {
    for (;;) {
      const record = journal.entries().find(e => e.type === "gate" && e.id === id);
      if (record || signal.aborted) return record;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); waiters.delete(done); resolve(); };
        const timer = setTimeout(done, 1000);
        signal.addEventListener("abort", done, { once: true }); waiters.add(done);
      });
    }
  } finally { if (!waiters.size) parked.delete(id); }
}
/** F1: Fence a gate identity; a failure is recorded once (timeouts raise an unknown attention) and left to the sweep. */
async function fenceGate(journal: JournalHandle, intent: Entry, containment: Pick<Containment, "fence">): Promise<boolean> {
  const id = String(intent.id);
  try { await containment.fence(id, tracked(journal, intent)); return true; }
  catch (error) {
    if (!journal.entries().some(e => e.type === "fence-failed" && e.exec === id)) console.error(`durable-subagents: fence of ${id} failed: ${String(error)}`);
    if (/Fence timeout/.test(String(error))) await recordFenceFailure(journal, id, String(intent.call), error);
    else await recordOnce(journal, async () => { if (!journal.entries().some(e => e.type === "fence-failed" && e.exec === id)) await journal.append("fence-failed", { exec: id, error: String(error) }); });
    return false;
  }
}
/** P30, A5, F1: Fence unresolved gate identities before recording their outcome as unknown; a gate whose fence fails
 *  never fails recovery: it stays without an outcome and the executor sweep retries it every K1. */
export async function recoverGates(journal: JournalHandle, containment: Pick<Containment, "fence">): Promise<void> {
  const intents = entriesOf(journal, "gate-intent");
  if (!intents.length) return;
  const outcomes = new Set(entriesOf(journal, "gate").map(e => String(e.id)));
  for (const intent of intents) {
    const id = String(intent.id);
    if (outcomes.has(id)) continue;
    if (await fenceGate(journal, intent, containment)) { await gateRetired(journal, id); outcomes.add(id); }
  }
}
function apply(result: CallResult, record: Entry): CallResult {
  if (record.aborted) return result;
  if (record.unknown) return { ...result, status: "unknown", ok: false, error: "Gate outcome unknown after recovery" };
  if (record.exit !== 0 || record.error) return { ...result, status: "gate-failed", ok: false, error: String(record.error ?? `Gate exited ${record.exit}`) };
  if (!Object.hasOwn(record, "json")) return result;
  const data = result.data && typeof result.data === "object" && !Array.isArray(result.data) ? result.data : {};
  return { ...result, data: { ...data, gate: record.json } };
}
/** P30: Run a contained, journaled gate at most once and honor settlement aborts. */
export async function runGate(t: CallTicket, home: string, cwd: string, exec: string, result: CallResult, signal: AbortSignal, containment: Containment, options: GateOptions = {}): Promise<CallResult> {
  if (!t.spec.gate || signal.aborted) return result;
  const prior = t.journal.entries().filter(e => e.type === "gate-intent" && e.call === t.callId);
  if (prior.length) {
    const intent = prior.at(-1)!;
    let record = t.journal.entries().find(e => e.type === "gate" && e.id === intent.id);
    if (!record) {
      // A gate that cannot be fenced is never re-run and the call never seals while it may live (A2): park until
      // the sweep retires it and records its unknown outcome.
      if (await fenceGate(t.journal, intent, containment)) await gateRetired(t.journal, String(intent.id));
      record = await gateParked(t.journal, String(intent.id), signal);
      if (!record) return result;
    }
    return apply(result, record);
  }
  const gate = typeof t.spec.gate === "string" ? { command: t.spec.gate } : t.spec.gate;
  if (gate.timeoutMs !== undefined && (!Number.isFinite(gate.timeoutMs) || gate.timeoutMs < 0)) throw new Error("Invalid gate timeout");
  const n = prior.length + 1, win = (options.platform ?? process.platform) === "win32";
  const id = `gate:${t.callId}#${n}`, dir = join(callDir(home, t.wid, t.key, t.gen), `gate-${n}`), jobDir = join(dir, "job");
  // Persist the Windows Job Object handshake directory on `gate-intent` BEFORE spawning any host or gate process,
  // so crash recovery and sweeps always bind the verified Job Object owner and wrapper identities before user code acts.
  const intent = await t.journal.append("gate-intent", { call: t.callId, id, exec, ...(win ? { jobDir } : {}) });
  for (const [name, bytes] of [["result.json", JSON.stringify(result)], ["output.txt", result.output]]) {
    if (await publishFile(dir, name!, bytes!) === "conflict") throw new Error(`Gate input conflict: ${dir}/${name}`);
  }
  if (signal.aborted) { await t.journal.append("gate", { id, aborted: true, exit: null }); return result; }
  const known: ProcInfo[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined, scanTimer: ReturnType<typeof setInterval> | undefined;
  let scanQueue = Promise.resolve(), stdout = "", outputError: string | undefined;
  let abort = () => {};
  let fields: Record<string, unknown> = { id, exit: null };
  let finishRead: Promise<void> = Promise.resolve(), retired = false;
  if (win) {
    const stdoutPath = join(jobDir, GATE_STDOUT);
    let prepared: JobPrep | undefined, spawned: JobSpawned | undefined, killActiveOwner: (() => boolean) | undefined;
    let abortLaunch = () => {}, stdoutReady = false;
    try {
      await mkdir(jobDir, { recursive: true });
      await writeFile(stdoutPath, "");
      const inherited = normalizeEnv(process.env);
      const gateEnv = mergeEnv(inherited, {
        ComSpec: envValue(inherited, "ComSpec") || (process.platform === "win32" ? comspec(inherited) : "/bin/sh"),
        PATHEXT: envValue(inherited, "PATHEXT") || ".COM;.EXE;.BAT;.CMD",
        DSA_RESULT: join(dir, "result.json"),
        DSA_OUTPUT: join(dir, "output.txt"),
        DSA_CALL: t.callId,
        DSA_EXEC: id,
      });
      await writeFile(join(jobDir, GATE_SPEC), JSON.stringify({ command: gate.command, cwd, env: gateEnv }));
      await writeFile(join(jobDir, GATE_WRAPPER), GATE_WRAPPER_SOURCE);
      const launch: JobLaunch = {
        exe: process.execPath,
        args: [join(jobDir, GATE_WRAPPER), jobDir, winTagArg("DSA_EXEC", id)],
        cwd,
        log: "",
        env: helperEnv({ SystemRoot: systemRoot() }),
        exec: id,
      };
      prepared = await prepareJob(jobDir, launch, {
        signal,
        ...(options.job?.compiler ? { compiler: options.job.compiler } : {}),
        ...(options.job?.compileMs ? { compileMs: options.job.compileMs } : {}),
        ...(options.job?.publish ? { publish: options.job.publish } : {}),
      });
      if (signal.aborted) {
        await prepared.release().catch(() => {});
        fields.aborted = true;
      } else {
        abortLaunch = () => { try { killActiveOwner?.(); } catch { /* gone */ } };
        signal.addEventListener("abort", abortLaunch, { once: true });
        let stdoutFd: number | undefined, errFd: number | undefined;
        try {
          stdoutFd = openSync(stdoutPath, "a");
          errFd = openSync(join(jobDir, JOB_HOST_LOG), "a");
          spawned = await spawnInJob(jobDir, launch, {
            prepared,
            proceed: () => !signal.aborted,
            stdio: options.job?.stdio ?? ["ignore", stdoutFd, errFd],
            unref: false,
            onOwnerSpawned: kill => {
              killActiveOwner = kill;
              if (signal.aborted) { try { kill(); } catch { /* gone */ } }
              options.onJobOwnerSpawned?.();
            },
            ...(options.job?.timeoutMs !== undefined ? { timeoutMs: options.job.timeoutMs } : {}),
            ...(options.job?.observeMs !== undefined ? { observeMs: options.job.observeMs } : {}),
            ...(options.job?.endMs !== undefined ? { endMs: options.job.endMs } : {}),
            ...(options.job?.observe ? { observe: options.job.observe } : {}),
            ...(options.job?.endHelper ? { endHelper: options.job.endHelper } : {}),
          });
        } finally {
          if (stdoutFd !== undefined) closeSync(stdoutFd);
          if (errFd !== undefined) closeSync(errFd);
          signal.removeEventListener("abort", abortLaunch);
        }
        if (!spawned) {
          await prepared.release().catch(() => {});
          fields.aborted = true;
        } else {
          killActiveOwner = spawned.killOwner;
          const remember = async (p: ProcInfo) => {
            if (!isWinStart(p.start) || known.some(k => k.pid === p.pid && sameCreation(k.start, p.start))) return;
            await t.journal.append("gate-tracked", { id, process: p });
            known.push(p);
          };
          if (spawned.uncertain) {
            for (const p of gateJobProcesses(jobDir, id)) await remember(p);
            if (spawned.pid > 0 && isWinStart(spawned.start)) await remember({ pid: spawned.pid, start: spawned.start, ppid: process.pid, tag: id });
            fields.error = spawned.uncertain;
          } else {
            if (options.beforeRecordTracked) await options.beforeRecordTracked();
            for (const p of gateJobProcesses(jobDir, id)) await remember(p);
            if (spawned.group && isWinStart(spawned.group.start)) await remember({ pid: spawned.group.pid, start: spawned.group.start, ppid: process.pid, tag: id });
            if (spawned.pid > 0 && isWinStart(spawned.start)) await remember({ pid: spawned.pid, start: spawned.start, ppid: spawned.group?.pid ?? process.pid, tag: id });
            let failScan: (error: unknown) => void = () => {};
            const scanFailed = new Promise<never>((_, reject) => { failScan = reject; });
            scanTimer = setInterval(() => {
              scanQueue = scanQueue.then(async () => {
                const found = await containment.scan(new Map([[id, known]]));
                for (const p of found.get(id) ?? []) await remember(p);
              });
              void scanQueue.catch(failScan);
            }, 1000);
            const interrupted = new Promise<"aborted" | "timeout">(resolve => {
              abort = () => resolve("aborted");
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
              if (gate.timeoutMs !== undefined) timer = setTimeout(() => resolve("timeout"), gate.timeoutMs);
            });
            const outcome = await Promise.race([spawned.exited.then(() => "exited" as const), interrupted, scanFailed]);
            if (outcome === "aborted") fields.aborted = true;
            else if (outcome === "timeout") fields.error = "Gate timeout";
            else {
              const groupEnd = readGroupEndSync(jobDir);
              if (groupEnd) { stdoutReady = true; fields.exit = groupEnd.status; }
              else fields.error = `Gate job host ended without recording exit status${await startError(jobDir)}`;
            }
          }
        }
      }
    } catch (error) {
      if (signal.aborted || prepareCancelled(error)) fields.aborted = true;
      else fields.error = String(error);
    } finally {
      clearTimeout(timer); clearInterval(scanTimer);
      signal.removeEventListener("abort", abortLaunch);
      signal.removeEventListener("abort", abort);
      if (spawned && (fields.aborted || fields.error || signal.aborted)) {
        try { killActiveOwner?.(); } catch { /* gone */ }
        let waitTimer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([spawned.exited, new Promise<void>(resolve => { waitTimer = setTimeout(resolve, 2000); })]); }
        finally { clearTimeout(waitTimer); }
      }
      await scanQueue.catch(() => {});
      retired = await fenceGate(t.journal, intent, containment);
    }
    if (stdoutReady && retired && !signal.aborted) {
      finishRead = readFile(stdoutPath, "utf8").then(text => { stdout = text; });
    }
  } else {
    try {
      const child = await containment.spawn({ ...shellTarget(gate.command, id), cwd, exec: id,
        env: { DSA_RESULT: join(dir, "result.json"), DSA_OUTPUT: join(dir, "output.txt"), DSA_CALL: t.callId } });
      child.stdin.end(); child.stderr.resume(); child.stdout.setEncoding("utf8");
      finishRead = (async () => { for await (const chunk of child.stdout) stdout += chunk.toString(); })();
      void finishRead.catch(() => {});
      const remember = async (p: ProcInfo) => {
        if (known.some(k => k.pid === p.pid && k.start === p.start)) return;
        await t.journal.append("gate-tracked", { id, process: p }); known.push(p);
      };
      if (child.start) await remember({ pid: child.pid, start: child.start, ppid: process.pid, tag: id });
      let failScan: (error: unknown) => void = () => {};
      const scanFailed = new Promise<never>((_, reject) => { failScan = reject; });
      scanTimer = setInterval(() => {
        scanQueue = scanQueue.then(async () => { const found = await containment.scan(new Map([[id, known]])); for (const p of found.get(id) ?? []) await remember(p); });
        void scanQueue.catch(failScan);
      }, 1000);
      const interrupted = new Promise<"aborted" | "timeout">((resolve) => {
        abort = () => resolve("aborted"); signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        if (gate.timeoutMs !== undefined) timer = setTimeout(() => resolve("timeout"), gate.timeoutMs);
      });
      const outcome = await Promise.race([child.exited, interrupted, scanFailed]);
      if (outcome === "aborted") fields.aborted = true;
      else if (outcome === "timeout") fields.error = "Gate timeout";
      else fields.exit = outcome.code;
    } catch (error) { fields.error = String(error); }
    finally {
      clearTimeout(timer); clearInterval(scanTimer); signal.removeEventListener("abort", abort);
      await scanQueue.catch(() => {});
      retired = await fenceGate(t.journal, intent, containment);
    }
  }
  if (!retired) {
    // F1, A2: descendants may still live; the outcome is left to the sweep (unknown) and the call waits for it.
    const record = await gateParked(t.journal, id, signal);
    return record ? apply(result, record) : result;
  }
  await finishRead.catch(error => { outputError = String(error); });
  if (signal.aborted) fields = { id, exit: fields.exit, aborted: true };
  else if (!fields.error && outputError) fields.error = outputError;
  else if (fields.exit === 0 && !fields.error && gate.output === "json") {
    try {
      fields.json = JSON.parse(stdout);
      if (gate.schema !== undefined) { const errors = validate(gate.schema, fields.json); if (errors.length) fields.error = errors.join("; "); }
    } catch (error) { fields.error = `Gate JSON: ${error}`; }
  }
  return apply(result, await t.journal.append("gate", fields));
}
