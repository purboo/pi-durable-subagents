// Command-scoped leases: priority then FIFO among waiters, with every grant committed under the resource lock.
// Commands run in their own process group and inherit DSA_HOLD; their group and tagged descendants end before release.
import { spawn } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { constants } from "node:os";
import { dsaHome } from "../paths.ts";
import { captureStart } from "../platform/proctable.ts";
import { blockers, endLeaseProcesses, enqueue, grantQueued, holdDetail, holdTag, tryGrant, leaseDir, liveTickets, orphaned, rank, removeTicket, RESOURCE, who, writeTicket, type LeaseMode, type LeaseTicket } from "../platform/lease.ts";

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
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export interface HoldOptions { env?: NodeJS.ProcessEnv; stderr?: (line: string) => void; pollMs?: number; graceMs?: number }

/** Run one held command; resolves only after its command tree has been ended and its lease released. */
export async function hold(args: HoldArgs, options: HoldOptions = {}): Promise<number> {
  const env = options.env ?? process.env, home = dsaHome(env), say = options.stderr ?? (l => process.stderr.write(`${l}\n`));
  const pollMs = options.pollMs ?? 250, graceMs = options.graceMs ?? 2000;
  const request = {
    resource: args.resource, mode: args.mode, ...(args.slots !== undefined ? { slots: args.slots } : {}),
    ...(args.priority !== undefined ? { priority: args.priority } : {}), ...(args.yield ? { yield: args.yield } : {}),
    ...(args.expectMs !== undefined ? { expectMs: args.expectMs } : {}),
    wrapper: { pid: process.pid, start: (await captureStart(process.pid)) || undefined },
    argv: args.argv.map(a => a.length > 200 ? `${a.slice(0, 199)}…` : a).slice(0, 32), cwd: process.cwd(),
    ...(args.note ? { note: args.note.slice(0, 300) } : {}), since: Date.now(),
    ...(env.DSA_EXEC ? { exec: env.DSA_EXEC } : {}), ...(env.DSA_CALL ? { call: env.DSA_CALL } : {}),
  };
  const granted = args.maxWaitMs === 0 ? await tryGrant(home, request) : undefined;
  if (granted && "busy" in granted) {
    const now = Date.now(), by = granted.busy.map(t => `${who(t)} (${t.grantedAt === undefined
      ? `${t.mode === "counted" ? "slot" : t.mode}, waiting, ${age(now - t.since)}${t.expectMs !== undefined ? `, expects ${age(t.expectMs)}` : ""}`
      : holdDetail({ ...t, note: undefined }, now, false)})`).join(", ");
    say(`hold: ${args.resource} is not free now (${by}); not running the command (exit ${WAIT_EXPIRED})`);
    return WAIT_EXPIRED;
  }
  const ticket: LeaseTicket = granted ?? await enqueue(home, request);
  let child: ReturnType<typeof spawn> | undefined, interrupted: NodeJS.Signals | undefined, wake = () => {}, cleaned = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (child?.pid) { try { process.kill(-child.pid, signal); } catch { /* gone */ } }
    else { interrupted = signal; wake(); }
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
      const all = liveTickets(home, args.resource);
      let ahead = blockers(ticket, all);
      // A lock-free observation is only a hint. Priority can change while the lock is being acquired.
      if (!ahead.length) {
        ahead = await grantQueued(home, ticket);
        if (ticket.grantedAt !== undefined) break;
      }
      const leftovers = ahead.filter(orphaned);
      for (const t of leftovers) {
        say(`hold: ending processes left by ${who(t)} (its hold process is gone)`);
        await endLeaseProcesses(t, graceMs, say);
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
    // stdin stays attached only when it is not a terminal: a background group reading the terminal stops.
    const c = spawn(args.argv[0]!, args.argv.slice(1), { stdio: [process.stdin.isTTY ? "ignore" : "inherit", "inherit", "inherit"], detached: true,
      env: { ...env, DSA_HOLD: holdTag(ticket) } });
    child = c;
    let status: number | undefined;
    const exit = new Promise<number>(resolve => {
      c.once("error", error => { say(`hold: cannot run ${args.argv[0]}: ${error.message}`); resolve(127); });
      c.once("exit", (code, signal) => resolve(code ?? 128 + (signal ? constants.signals[signal] ?? 1 : 1)));
    });
    void exit.then(value => { status = value; wake(); });
    if (c.pid) {
      ticket.command = { pid: c.pid };
      ticket.command.start = (await captureStart(c.pid)) || undefined;
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
    try { if (child && !cleaned) await endLeaseProcesses(ticket, graceMs, say); }
    finally {
      removeTicket(home, ticket);
      for (const s of SIGNALS) process.off(s, onSignal);
    }
  }
}

/** `leases [--json]`. */
export { leaseLines, leaseState } from "../platform/lease.ts";
