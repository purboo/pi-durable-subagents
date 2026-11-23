// Command-scoped leases: priority then FIFO among waiters, with every grant committed under the resource lock.
// Commands run in their own process group and inherit DSA_HOLD; their group and tagged descendants end before release.
import { spawn } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { dsaHome } from "../paths.ts";
import { prepareCancelled, prepareJob, readGroupEndSync, readGroupRecord, readStartErrorSync, requestJobStop, spawnInJob, startError, type JobLaunch, type JobOptions } from "../platform/job.ts";
import { captureStart } from "../platform/proctable.ts";
import { executableFile, execTarget } from "../platform/launch.ts";
import { comspec, envValue, IS_WINDOWS, isWinStart, mergeEnv, normalizeEnv } from "../platform/windows.ts";
import { blockers, endLeaseProcesses, enqueue, grantQueued, holdDetail, holdTag, leaseDir, leaseJobDir, liveTickets, orphaned, rank, removeTicket, RESOURCE, tryGrant, who, writeTicket, writeTicketSync, type EndLeaseOptions, type LeaseMode, type LeaseTicket } from "../platform/lease.ts";

export const HOLD_USAGE = "usage: pi-durable-subagents hold <resource> [--shared | --slots <n>] [--priority <n>] [--yield] [--expect <duration>] [--max-wait <seconds> | --no-wait] [--note <text>] -- <command> [args…]";
/** Exit status when the command did not run or was stopped to yield (EX_TEMPFAIL). */
export const WAIT_EXPIRED = 75;

export interface HoldArgs { resource: string; mode: LeaseMode; slots?: number; priority?: number; yield?: true; expectMs?: number; maxWaitMs?: number; note?: string; argv: string[] }
export function parseHold(args: string[]): HoldArgs {
  const split = args.indexOf("--");
  if (split < 0) throw new Error(`hold needs -- before the command. ${HOLD_USAGE}`);
  const opts = args.slice(0, split), argv = args.slice(split + 1);
  let resource: string | undefined, shared = false, slots: number | undefined, maxWaitMs: number | undefined, note: string | undefined;
  let priority: number | undefined, yielding: true | undefined, expectMs: number | undefined;
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i]!;
    if (a === "--shared") shared = true;
    else if (a === "--yield") yielding = true;
    else if (a === "--no-wait") maxWaitMs = 0;
    else if (["--max-wait", "--note", "--slots", "--priority", "--expect"].includes(a)) {
      const v = opts[++i];
      if (v === undefined) throw new Error(`${a} needs a value. ${HOLD_USAGE}`);
      if (a === "--note") note = v;
      else if (a === "--slots") {
        if (!/^\d+$/.test(v) || !(Number(v) >= 1) || !Number.isSafeInteger(Number(v))) throw new Error(`--slots must be an integer >= 1. ${HOLD_USAGE}`);
        slots = Number(v);
      } else if (a === "--priority") {
        if (!/^-?\d+$/.test(v) || !Number.isInteger(Number(v)) || Number(v) < -100 || Number(v) > 100) throw new Error(`--priority must be an integer from -100 to 100. ${HOLD_USAGE}`);
        priority = Number(v);
      } else if (a === "--expect") {
        const m = /^(\d+)([smh]?)$/.exec(v);
        const duration = m ? Number(m[1]) * (m[2] === "h" ? 3_600_000 : m[2] === "m" ? 60_000 : 1000) : NaN;
        if (!Number.isSafeInteger(duration) || duration < 1000 || duration > 7 * 24 * 3_600_000) throw new Error(`--expect must be a duration from 1s to 7d (seconds, s, m or h). ${HOLD_USAGE}`);
        expectMs = duration;
      } else {
        const s = Number(v);
        if (!Number.isFinite(s) || s < 0) throw new Error(`--max-wait must be a number of seconds ≥ 0. ${HOLD_USAGE}`);
        maxWaitMs = s * 1000;
      }
    } else if (a.startsWith("-")) throw new Error(`Unknown option ${a}. ${HOLD_USAGE}`);
    else if (resource === undefined) resource = a;
    else throw new Error(`Unexpected argument ${a}. ${HOLD_USAGE}`);
  }
  if (!resource) throw new Error(`hold needs a resource name. ${HOLD_USAGE}`);
  if (!RESOURCE.test(resource)) throw new Error(`Invalid resource ${JSON.stringify(resource)}: use 1–64 of A-Z a-z 0-9 . _ -`);
  if (!argv.length) throw new Error(`hold needs a command after --. ${HOLD_USAGE}`);
  if (shared && slots !== undefined) throw new Error(`--slots and --shared cannot be combined. ${HOLD_USAGE}`);
  const mode: LeaseMode = slots !== undefined ? "counted" : shared ? "shared" : "exclusive";
  return { resource, mode, ...(slots !== undefined ? { slots } : {}), ...(priority !== undefined ? { priority } : {}),
    ...(yielding ? { yield: yielding } : {}), ...(expectMs !== undefined ? { expectMs } : {}),
    ...(maxWaitMs !== undefined ? { maxWaitMs } : {}), ...(note !== undefined ? { note } : {}), argv };
}

const age = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`;
const SIGNALS = (IS_WINDOWS ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"]) as readonly NodeJS.Signals[];

export function resolveWinHoldTarget(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  const isAbs = path.isAbsolute(command) || path.win32.isAbsolute(command);
  if (isAbs || /[\\/]/.test(command)) {
    const candidate = isAbs ? command : path.resolve(cwd, command);
    if (executableFile(candidate, "win32")) return execTarget(candidate, args, { env, platform: "win32" });
    if (!path.win32.extname(candidate)) {
      const exts = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";");
      for (const rawExt of exts) {
        const ext = rawExt.trim();
        if (!ext) continue;
        const lower = ext.toLowerCase();
        if (executableFile(candidate + lower, "win32")) return execTarget(candidate + lower, args, { env, platform: "win32" });
        if (lower !== ext && executableFile(candidate + ext, "win32")) return execTarget(candidate + ext, args, { env, platform: "win32" });
      }
    }
  }
  return execTarget(command, args, { env, platform: "win32" });
}

export interface HoldOptions {
  env?: NodeJS.ProcessEnv;
  stderr?: (line: string) => void;
  pollMs?: number;
  graceMs?: number;
  /** Test seams for exercising the Windows Job Object path deterministically with explicit barriers. */
  platform?: NodeJS.Platform;
  captureWrapperStart?: (pid: number) => Promise<string>;
  job?: Pick<JobOptions, "compiler" | "compileMs" | "publish" | "timeoutMs" | "observeMs" | "endMs" | "observe" | "endHelper" | "stdio">;
  lease?: EndLeaseOptions;
  onJobOwnerSpawned?: () => void;
  beforeRecordCommand?: () => Promise<void> | void;
}

/** Run one held command; resolves only after its command tree has been ended and its lease released. */
export async function hold(args: HoldArgs, options: HoldOptions = {}): Promise<number> {
  const env = options.env ?? process.env, home = dsaHome(env), say = options.stderr ?? (l => process.stderr.write(`${l}\n`));
  const pollMs = options.pollMs ?? 250, graceMs = options.graceMs ?? 2000;
  const winHold = (options.platform ?? (IS_WINDOWS ? "win32" : process.platform)) === "win32";
  const leaseOpts: EndLeaseOptions | undefined = options.lease ?? (options.platform ? { platform: options.platform } : undefined);
  const getStart = options.captureWrapperStart ?? captureStart;
  const wrapperStart = (await getStart(process.pid).catch(() => "")) || undefined;
  if (winHold && !isWinStart(wrapperStart)) throw new Error(`hold: cannot verify wrapper start identity for pid ${process.pid}`);
  const request = {
    resource: args.resource, mode: args.mode, ...(args.slots !== undefined ? { slots: args.slots } : {}),
    ...(args.priority !== undefined ? { priority: args.priority } : {}), ...(args.yield ? { yield: args.yield } : {}),
    ...(args.expectMs !== undefined ? { expectMs: args.expectMs } : {}),
    wrapper: { pid: process.pid, start: wrapperStart },
    argv: args.argv.map(a => a.length > 200 ? `${a.slice(0, 199)}…` : a).slice(0, 32), cwd: process.cwd(),
    ...(args.note ? { note: args.note.slice(0, 300) } : {}), since: Date.now(),
    ...(env.DSA_EXEC ? { exec: env.DSA_EXEC } : {}), ...(env.DSA_CALL ? { call: env.DSA_CALL } : {}),
  };
  const granted = args.maxWaitMs === 0 ? await tryGrant(home, request, undefined, leaseOpts) : undefined;
  if (granted && "busy" in granted) {
    const now = Date.now(), by = granted.busy.map(t => `${who(t)} (${t.grantedAt === undefined
      ? `${t.mode === "counted" ? "slot" : t.mode}, waiting, ${age(now - t.since)}${t.expectMs !== undefined ? `, expects ${age(t.expectMs)}` : ""}`
      : holdDetail({ ...t, note: undefined }, now, false)})`).join(", ");
    say(`hold: ${args.resource} is not free now (${by}); not running the command (exit ${WAIT_EXPIRED})`);
    return WAIT_EXPIRED;
  }
  const ticket: LeaseTicket = granted ?? await enqueue(home, request, undefined, leaseOpts);
  let child: ReturnType<typeof spawn> | undefined, interrupted: NodeJS.Signals | undefined, wake = () => {}, cleaned = false;
  let winJobActive = false, activeJobDir: string | undefined;
  let activeJob: { requestStop?: () => Promise<void>; exited: Promise<void> } | undefined;
  const prepAbort = new AbortController();
  const stopWinJob = async () => {
    const stopBudgetMs = Math.min(Math.max(graceMs, 250), 2000);
    if (activeJob) {
      await activeJob.requestStop?.();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          activeJob.exited,
          new Promise<void>(resolve => { timer = setTimeout(resolve, stopBudgetMs); }),
        ]);
      } finally { clearTimeout(timer); }
    } else if (activeJobDir) {
      await requestJobStop(activeJobDir);
    }
    await endLeaseProcesses(ticket, graceMs, say, leaseOpts);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    if (winHold) {
      interrupted = signal;
      prepAbort.abort();
      if (activeJob?.requestStop) void activeJob.requestStop();
      else if (activeJobDir) void requestJobStop(activeJobDir);
      wake();
    } else if (child?.pid) {
      try { process.kill(-child.pid, signal); } catch { /* gone */ }
    } else { interrupted = signal; wake(); }
  };
  for (const s of SIGNALS) process.on(s, onSignal);
  let watcher: FSWatcher | undefined;
  const pause = () => new Promise<void>(resolve => {
    const timer = setTimeout(resolve, pollMs);
    wake = () => { clearTimeout(timer); resolve(); };
  });
  try {
    const deadline = args.maxWaitMs !== undefined ? ticket.since + args.maxWaitMs : undefined;
    try { watcher = watch(leaseDir(home, args.resource), () => wake()); watcher.on("error", () => {}); } catch { /* polling suffices */ }
    let shown: string | undefined;
    while (ticket.grantedAt === undefined) {
      if (interrupted) return 128 + (constants.signals[interrupted] ?? 1);
      const all = liveTickets(home, args.resource, leaseOpts);
      let ahead = blockers(ticket, all);
      // A lock-free observation is only a hint. Priority can change while the lock is being acquired.
      if (!ahead.length) {
        ahead = await grantQueued(home, ticket, undefined, leaseOpts);
        if (ticket.grantedAt !== undefined) break;
      }
      const leftovers = ahead.filter(t => orphaned(t, leaseOpts));
      for (const t of leftovers) {
        say(`hold: ending processes left by ${who(t)} (its hold process is gone)`);
        await endLeaseProcesses(t, graceMs, say, leaseOpts);
        removeTicket(home, t);
      }
      if (leftovers.length) continue;
      const now = Date.now();
      if (deadline !== undefined && now >= deadline) {
        say(`hold: ${args.resource} still held by ${ahead.filter(t => t.grantedAt !== undefined).map(who).join(", ") || who(ahead[0]!)} after ${age(now - ticket.since)}; not running the command (exit ${WAIT_EXPIRED})`);
        return WAIT_EXPIRED;
      }
      const counted = args.mode === "counted", holders = (counted ? all : ahead).filter(t => t.grantedAt !== undefined && t.seq !== ticket.seq);
      const position = all.filter(t => t.grantedAt === undefined && rank(t, ticket) < 0).length + 1;
      const key = `${holders.map(t => t.seq).join(",") || `q${ahead[0]!.seq}`}${counted ? `@${position}` : ""}`;
      if (key !== shown) {
        shown = key;
        const by = holders.length ? holders.map(t => `${who(t)} (${holdDetail({ ...t, note: undefined }, now, false)})`).join(", ") : `${who(ahead[0]!)} (waiting)`;
        say(counted
          ? `hold: waiting for ${args.resource} (slot, position ${position}, held ${holders.length}/${args.slots}); held by ${by}`
          : `hold: waiting for ${args.resource} (${args.mode}) — held by ${by}; ${ahead.length} ahead`);
      }
      await pause();
    }
    if (interrupted) return 128 + (constants.signals[interrupted] ?? 1);
    if (shown) say(`hold: ${args.resource} granted after ${age(ticket.grantedAt! - ticket.since)}`);
    if (winHold) {
      const cwd = process.cwd();
      const childEnv = mergeEnv(normalizeEnv(env), {
        ComSpec: envValue(env, "ComSpec") || comspec(env),
        PATHEXT: envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD",
        DSA_HOLD: holdTag(ticket),
      });
      const target = resolveWinHoldTarget(args.argv[0]!, args.argv.slice(1), cwd, childEnv);
      const jobDir = leaseJobDir(home, ticket.resource, ticket.seq);
      const launch: JobLaunch = {
        exe: target.command,
        args: target.args,
        cwd,
        log: "",
        env: childEnv,
        hold: holdTag(ticket),
        ...(env.DSA_EXEC ? { exec: env.DSA_EXEC } : {}),
      };
      let prepared;
      try {
        prepared = await prepareJob(jobDir, launch, {
          signal: prepAbort.signal,
          ...(options.job?.compiler ? { compiler: options.job.compiler } : {}),
          ...(options.job?.compileMs ? { compileMs: options.job.compileMs } : {}),
          ...(options.job?.publish ? { publish: options.job.publish } : {}),
        });
      } catch (error) {
        if (interrupted || prepareCancelled(error)) {
          cleaned = true;
          return 128 + (constants.signals[interrupted ?? "SIGINT"] ?? 1);
        }
        cleaned = true;
        throw error;
      }
      if (interrupted) {
        await prepared.release();
        cleaned = true;
        return 128 + (constants.signals[interrupted] ?? 1);
      }
      // Persist the job handshake directory on the ticket BEFORE spawning the Job Object owner: if this wrapper is
      // hard-killed at any instant during or after launch, readers recover the job owner and command from `jobDir`.
      ticket.jobDir = jobDir;
      writeTicketSync(home, ticket);
      activeJobDir = jobDir;
      winJobActive = true;
      let spawned;
      try {
        spawned = await spawnInJob(jobDir, launch, {
          prepared,
          proceed: () => !interrupted,
          stdio: options.job?.stdio ?? [process.stdin.isTTY ? "ignore" : "inherit", "inherit", "inherit"],
          unref: false,
          onOwnerSpawned: () => {
            if (interrupted) void requestJobStop(jobDir);
            options.onJobOwnerSpawned?.();
          },
          ...(options.job?.timeoutMs !== undefined ? { timeoutMs: options.job.timeoutMs } : {}),
          ...(options.job?.observeMs !== undefined ? { observeMs: options.job.observeMs } : {}),
          ...(options.job?.endMs !== undefined ? { endMs: options.job.endMs } : {}),
          ...(options.job?.observe ? { observe: options.job.observe } : {}),
          ...(options.job?.endHelper ? { endHelper: options.job.endHelper } : {}),
        });
      } catch (error) {
        if (interrupted) {
          await stopWinJob();
          cleaned = true;
          return 128 + (constants.signals[interrupted] ?? 1);
        }
        const recordedErr = readStartErrorSync(jobDir);
        if (recordedErr?.startsWith("CreateProcess ")) {
          say(`hold: cannot run ${args.argv[0]}: ${recordedErr}`);
          cleaned = true;
          return 127;
        }
        cleaned = true;
        throw error;
      }
      if (!spawned) {
        await prepared.release();
        cleaned = true;
        return 128 + (constants.signals[interrupted ?? "SIGINT"] ?? 1);
      }
      activeJob = spawned;
      let jobEnded = false;
      void spawned.exited.then(() => { jobEnded = true; wake(); });
      if (interrupted) void spawned.requestStop?.();
      if (spawned.uncertain) {
        if (isWinStart(spawned.start)) {
          ticket.group = { pid: spawned.pid, start: spawned.start };
          await writeTicket(home, ticket).catch(() => {});
        }
        throw new Error(`hold: ${spawned.uncertain}`);
      }
      const groupRec = await readGroupRecord(jobDir);
      if (!groupRec || !isWinStart(groupRec.start) || !groupRec.group || !isWinStart(groupRec.group.start)) {
        await stopWinJob();
        cleaned = true;
        throw new Error(`hold: cannot verify command start identity for pid ${spawned.pid}`);
      }
      if (options.beforeRecordCommand) await options.beforeRecordCommand();
      ticket.command = { pid: groupRec.pid, start: groupRec.start };
      ticket.group = { pid: groupRec.group.pid, start: groupRec.group.start };
      await writeTicket(home, ticket).catch(() => {});
      if (!jobEnded && readGroupEndSync(jobDir)) jobEnded = true;
      while (!jobEnded) {
        if (interrupted) break;
        if (args.yield) {
          const all = liveTickets(home, args.resource, leaseOpts);
          const waiter = all.filter(t => t.grantedAt === undefined && blockers(t, all).some(b => b.seq === ticket.seq)).sort(rank)[0];
          if (waiter) {
            await stopWinJob();
            cleaned = true;
            say(`hold: yielded ${args.resource} to ${who(waiter)} after ${age(Date.now() - ticket.grantedAt!)}; the command was stopped (exit ${WAIT_EXPIRED})`);
            return WAIT_EXPIRED;
          }
        }
        await pause();
      }
      if (interrupted) {
        await stopWinJob();
        cleaned = true;
        return 128 + (constants.signals[interrupted] ?? 1);
      }
      await spawned.exited;
      const groupEnd = readGroupEndSync(jobDir);
      if (!groupEnd) {
        const detail = await startError(jobDir);
        throw new Error(`hold: command job host ended without recording exit status${detail}`);
      }
      cleaned = true;
      return groupEnd.status;
    }
    // stdin stays attached only when it is not a terminal: a background group reading the terminal stops.
    const target = execTarget(args.argv[0]!, args.argv.slice(1), { env });
    const c = spawn(target.command, target.args, { stdio: [process.stdin.isTTY ? "ignore" : "inherit", "inherit", "inherit"], detached: true,
      env: { ...env, DSA_HOLD: holdTag(ticket) }, windowsHide: true });
    child = c;
    let status: number | undefined;
    const exit = new Promise<number>(resolve => {
      c.once("error", error => { say(`hold: cannot run ${args.argv[0]}: ${error.message}`); resolve(127); });
      c.once("exit", (code, signal) => resolve(code ?? 128 + (signal ? constants.signals[signal] ?? 1 : 1)));
    });
    void exit.then(value => { status = value; wake(); });
    if (c.pid) {
      ticket.command = { pid: c.pid, start: (await captureStart(c.pid).catch(() => "")) || undefined };
      await writeTicket(home, ticket).catch(() => {});
    }
    while (status === undefined) {
      if (args.yield) {
        const all = liveTickets(home, args.resource);
        const waiter = all.filter(t => t.grantedAt === undefined && blockers(t, all).some(b => b.seq === ticket.seq)).sort(rank)[0];
        if (waiter) {
          await endLeaseProcesses(ticket, graceMs, say);
          cleaned = true;
          say(`hold: yielded ${args.resource} to ${who(waiter)} after ${age(Date.now() - ticket.grantedAt!)}; the command was stopped (exit ${WAIT_EXPIRED})`);
          return WAIT_EXPIRED;
        }
      }
      await pause();
    }
    return status;
  } finally {
    watcher?.close();
    // Also covers errors during launch/capture/write and forwarded signals followed by command exit.
    try {
      if (winJobActive && !cleaned) await stopWinJob();
      else if (child && !cleaned) await endLeaseProcesses(ticket, graceMs, say, leaseOpts);
    }
    finally {
      removeTicket(home, ticket);
      for (const s of SIGNALS) process.off(s, onSignal);
    }
  }
}

/** `leases [--json]`. */
export { leaseLines, leaseState } from "../platform/lease.ts";
