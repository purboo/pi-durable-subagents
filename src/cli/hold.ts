// `pi-durable-subagents hold <resource> [--shared | --slots <n>] [--max-wait <s>] [--note <text>] -- <command> [args…]`
// Waits for the lease (strict FIFO), runs the command in its own process group, ends what the command left in that
// group, then releases. `--max-wait 0` (or `--no-wait`) takes the lease at once or exits 75 without ever being queued.
// See src/platform/lease.ts for the ticket protocol.
import { spawn } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { constants } from "node:os";
import { dsaHome } from "../paths.ts";
import { captureStart } from "../platform/proctable.ts";
import { blockers, enqueue, groupAlive, tryGrant, leaseDir, liveTickets, orphaned, removeTicket, RESOURCE, who, writeTicket, modeLabel, type LeaseMode, type LeaseTicket } from "../platform/lease.ts";

export const HOLD_USAGE = "usage: pi-durable-subagents hold <resource> [--shared | --slots <n>] [--max-wait <seconds> | --no-wait] [--note <text>] -- <command> [args…]";
/** Exit status when --max-wait expires before the lease is granted (EX_TEMPFAIL). */
export const WAIT_EXPIRED = 75;

export interface HoldArgs { resource: string; mode: LeaseMode; slots?: number; maxWaitMs?: number; note?: string; argv: string[] }
export function parseHold(args: string[]): HoldArgs {
  const split = args.indexOf("--");
  if (split < 0) throw new Error(`hold needs -- before the command. ${HOLD_USAGE}`);
  const opts = args.slice(0, split), argv = args.slice(split + 1);
  let resource: string | undefined, shared = false, slots: number | undefined, maxWaitMs: number | undefined, note: string | undefined;
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i]!;
    if (a === "--shared") shared = true;
    else if (a === "--no-wait") maxWaitMs = 0;
    else if (a === "--max-wait" || a === "--note" || a === "--slots") {
      const v = opts[++i];
      if (v === undefined) throw new Error(`${a} needs a value. ${HOLD_USAGE}`);
      if (a === "--note") note = v;
      else if (a === "--slots") {
        if (!/^\d+$/.test(v) || !(Number(v) >= 1) || !Number.isSafeInteger(Number(v))) throw new Error(`--slots must be an integer >= 1. ${HOLD_USAGE}`);
        slots = Number(v);
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
  return { resource, mode, ...(slots !== undefined ? { slots } : {}), ...(maxWaitMs !== undefined ? { maxWaitMs } : {}), ...(note !== undefined ? { note } : {}), argv };
}

const age = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export interface HoldOptions { env?: NodeJS.ProcessEnv; stderr?: (line: string) => void; pollMs?: number; graceMs?: number }

/** Run one held command; resolves to the exit status for the process. */
export async function hold(args: HoldArgs, options: HoldOptions = {}): Promise<number> {
  const env = options.env ?? process.env, home = dsaHome(env), say = options.stderr ?? (l => process.stderr.write(`${l}\n`));
  const pollMs = options.pollMs ?? 250, graceMs = options.graceMs ?? 2000;
  const request = {
    resource: args.resource, mode: args.mode, ...(args.slots !== undefined ? { slots: args.slots } : {}),
    wrapper: { pid: process.pid, start: (await captureStart(process.pid)) || undefined },
    argv: args.argv.map(a => a.length > 200 ? `${a.slice(0, 199)}…` : a).slice(0, 32), cwd: process.cwd(),
    ...(args.note ? { note: args.note.slice(0, 300) } : {}), since: Date.now(),
    ...(env.DSA_EXEC ? { exec: env.DSA_EXEC } : {}), ...(env.DSA_CALL ? { call: env.DSA_CALL } : {}),
  };
  // No wait: granted now, or refused without a ticket — never listed as a waiter, even for a moment.
  const granted = args.maxWaitMs === 0 ? await tryGrant(home, request) : undefined;
  if (granted && "busy" in granted) {
    const now = Date.now(), by = granted.busy.map(t => `${who(t)} (${modeLabel(t)}${t.grantedAt === undefined ? ", waiting" : ""}, ${age(now - (t.grantedAt ?? t.since))})`).join(", ");
    say(`hold: ${args.resource} is not free now (${by}); not running the command (exit ${WAIT_EXPIRED})`);
    return WAIT_EXPIRED;
  }
  const ticket: LeaseTicket = granted ?? await enqueue(home, request);
  // Signals: while waiting they withdraw the request; while the command runs they go to its process group.
  let child: ReturnType<typeof spawn> | undefined, interrupted: NodeJS.Signals | undefined, wake = () => {};
  const onSignal = (signal: NodeJS.Signals) => {
    if (child?.pid) { try { process.kill(-child.pid, signal); } catch { /* gone */ } }
    else { interrupted = signal; wake(); }
  };
  for (const s of SIGNALS) process.on(s, onSignal);
  let watcher: FSWatcher | undefined;
  try {
    // Wait in order.
    const deadline = args.maxWaitMs !== undefined ? ticket.since + args.maxWaitMs : undefined;
    try { watcher = watch(leaseDir(home, args.resource), () => wake()); watcher.on("error", () => {}); } catch { /* polling suffices */ }
    let shown: string | undefined;
    const ended = new Map<number, number>();
    for (;;) {
      if (interrupted) { removeTicket(home, ticket); return 128 + (constants.signals[interrupted] ?? 1); }
      const all = liveTickets(home, args.resource), ahead = blockers(ticket, all);
      if (!ahead.length) break;
      const now = Date.now();
      // A holder whose wrapper was killed after its command ended can leave processes in the command's group; the
      // wrapper would have ended them before releasing, so a waiter does: TERM, then KILL after the grace period.
      for (const t of ahead.filter(orphaned)) {
        const first = ended.get(t.seq);
        if (first === undefined) say(`hold: ending processes left by ${who(t)} (its hold process is gone)`);
        try { process.kill(-t.command!.pid, first !== undefined && now - first >= graceMs ? "SIGKILL" : "SIGTERM"); } catch { /* gone */ }
        if (first === undefined) ended.set(t.seq, now);
      }
      if (deadline !== undefined && now >= deadline) {
        removeTicket(home, ticket);
        say(`hold: ${args.resource} still held by ${ahead.filter(t => t.grantedAt !== undefined).map(who).join(", ") || who(ahead[0]!)} after ${age(now - ticket.since)}; not running the command (exit ${WAIT_EXPIRED})`);
        return WAIT_EXPIRED;
      }
      // A counted request names its place among the waiters and how many slots are taken: "position 2, held 4/4".
      const counted = args.mode === "counted", granted = (counted ? all : ahead).filter(t => t.grantedAt !== undefined && t.seq !== ticket.seq);
      const position = all.filter(t => t.seq < ticket.seq && t.grantedAt === undefined).length + 1;
      const key = `${granted.map(t => t.seq).join(",") || `q${ahead[0]!.seq}`}${counted ? `@${position}` : ""}`;
      if (key !== shown) {
        shown = key;
        const by = granted.length ? granted.map(t => `${who(t)} (${modeLabel(t)}, ${age(now - (t.grantedAt ?? t.since))})`).join(", ") : `${who(ahead[0]!)} (waiting)`;
        say(counted
          ? `hold: waiting for ${args.resource} (slot, position ${position}, held ${granted.length}/${args.slots}); held by ${by}`
          : `hold: waiting for ${args.resource} (${args.mode}) — held by ${by}; ${ahead.length} ahead`);
      }
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, pollMs); wake = () => { clearTimeout(timer); resolve(); }; });
    }
    watcher?.close(); watcher = undefined;
    ticket.grantedAt ??= Date.now();
    await writeTicket(home, ticket);
    if (interrupted) { removeTicket(home, ticket); return 128 + (constants.signals[interrupted] ?? 1); }
    if (shown) say(`hold: ${args.resource} granted after ${age(ticket.grantedAt - ticket.since)}`);
    // Run. stdin stays attached only when it is not a terminal: a background process group reading the terminal stops.
    const c = spawn(args.argv[0]!, args.argv.slice(1), { stdio: [process.stdin.isTTY ? "ignore" : "inherit", "inherit", "inherit"], detached: true, env });
    child = c;
    const exit = new Promise<number>(resolve => {
      c.once("error", error => { say(`hold: cannot run ${args.argv[0]}: ${error.message}`); resolve(127); });
      c.once("exit", (code, signal) => resolve(code ?? 128 + (signal ? constants.signals[signal] ?? 1 : 1)));
    });
    if (c.pid) {
      ticket.command = { pid: c.pid, start: (await captureStart(c.pid)) || undefined };
      await writeTicket(home, ticket).catch(() => {});
    }
    const status = await exit;
    // End what the command left behind in its group before the lease goes to the next holder.
    if (c.pid && groupAlive(c.pid)) {
      try { process.kill(-c.pid, "SIGTERM"); } catch { /* gone */ }
      const until = Date.now() + graceMs;
      while (groupAlive(c.pid) && Date.now() < until) await new Promise(r => setTimeout(r, 50));
      if (groupAlive(c.pid)) { try { process.kill(-c.pid, "SIGKILL"); } catch { /* gone */ } }
      for (let i = 0; i < 40 && groupAlive(c.pid); i++) await new Promise(r => setTimeout(r, 25));
    }
    // A /proc listing is not atomic (a member can fork and exit while it is read): a last group signal ends any member
    // the checks missed, a newborn included. The group id is still ours while it has members.
    if (c.pid) { try { process.kill(-c.pid, "SIGKILL"); } catch { /* gone */ } }
    removeTicket(home, ticket);
    return status;
  } finally {
    watcher?.close();
    for (const s of SIGNALS) process.off(s, onSignal);
  }
}

/** `leases [--json]`. */
export { leaseLines, leaseState } from "../platform/lease.ts";
