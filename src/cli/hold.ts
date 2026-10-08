// `pi-durable-subagents hold <resource> [--shared] [--max-wait <s>] [--note <text>] -- <command> [args…]`
// Waits for the lease (strict FIFO), runs the command in its own process group, ends what the command left in that
// group, then releases. See src/platform/lease.ts for the ticket protocol.
import { spawn } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { constants } from "node:os";
import { dsaHome } from "../paths.ts";
import { captureStart } from "../platform/proctable.ts";
import { blockers, enqueue, leaseDir, liveTickets, removeTicket, RESOURCE, who, writeTicket, type LeaseMode, type LeaseTicket } from "../platform/lease.ts";

export const HOLD_USAGE = "usage: pi-durable-subagents hold <resource> [--shared] [--max-wait <seconds>] [--note <text>] -- <command> [args…]";
/** Exit status when --max-wait expires before the lease is granted (EX_TEMPFAIL). */
export const WAIT_EXPIRED = 75;

export interface HoldArgs { resource: string; mode: LeaseMode; maxWaitMs?: number; note?: string; argv: string[] }
export function parseHold(args: string[]): HoldArgs {
  const split = args.indexOf("--");
  if (split < 0) throw new Error(`hold needs -- before the command. ${HOLD_USAGE}`);
  const opts = args.slice(0, split), argv = args.slice(split + 1);
  let resource: string | undefined, mode: LeaseMode = "exclusive", maxWaitMs: number | undefined, note: string | undefined;
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i]!;
    if (a === "--shared") mode = "shared";
    else if (a === "--max-wait" || a === "--note") {
      const v = opts[++i];
      if (v === undefined) throw new Error(`${a} needs a value. ${HOLD_USAGE}`);
      if (a === "--note") note = v;
      else {
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
  return { resource, mode, ...(maxWaitMs !== undefined ? { maxWaitMs } : {}), ...(note !== undefined ? { note } : {}), argv };
}

const age = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

export interface HoldOptions { env?: NodeJS.ProcessEnv; stderr?: (line: string) => void; pollMs?: number; graceMs?: number }

/** Run one held command; resolves to the exit status for the process. */
export async function hold(args: HoldArgs, options: HoldOptions = {}): Promise<number> {
  const env = options.env ?? process.env, home = dsaHome(env), say = options.stderr ?? (l => process.stderr.write(`${l}\n`));
  const pollMs = options.pollMs ?? 250, graceMs = options.graceMs ?? 2000;
  const ticket: LeaseTicket = await enqueue(home, {
    resource: args.resource, mode: args.mode,
    wrapper: { pid: process.pid, start: (await captureStart(process.pid)) || undefined },
    argv: args.argv.map(a => a.length > 200 ? `${a.slice(0, 199)}…` : a).slice(0, 32), cwd: process.cwd(),
    ...(args.note ? { note: args.note.slice(0, 300) } : {}), since: Date.now(),
    ...(env.DSA_EXEC ? { exec: env.DSA_EXEC } : {}), ...(env.DSA_CALL ? { call: env.DSA_CALL } : {}),
  });
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
    for (;;) {
      if (interrupted) { removeTicket(home, ticket); return 128 + (constants.signals[interrupted] ?? 1); }
      const ahead = blockers(ticket, liveTickets(home, args.resource));
      if (!ahead.length) break;
      const now = Date.now();
      if (deadline !== undefined && now >= deadline) {
        removeTicket(home, ticket);
        say(`hold: ${args.resource} still held by ${ahead.filter(t => t.grantedAt !== undefined).map(who).join(", ") || who(ahead[0]!)} after ${age(now - ticket.since)}; not running the command (exit ${WAIT_EXPIRED})`);
        return WAIT_EXPIRED;
      }
      const holders = ahead.filter(t => t.grantedAt !== undefined), key = holders.map(t => t.seq).join(",") || `q${ahead[0]!.seq}`;
      if (key !== shown) {
        shown = key;
        const by = holders.length ? holders.map(t => `${who(t)} (${t.mode}, ${age(now - (t.grantedAt ?? t.since))})`).join(", ") : `${who(ahead[0]!)} (waiting)`;
        say(`hold: waiting for ${args.resource} (${args.mode}) — held by ${by}; ${ahead.length} ahead`);
      }
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, pollMs); wake = () => { clearTimeout(timer); resolve(); }; });
    }
    watcher?.close(); watcher = undefined;
    ticket.grantedAt = Date.now();
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
    removeTicket(home, ticket);
    return status;
  } finally {
    watcher?.close();
    for (const s of SIGNALS) process.off(s, onSignal);
  }
}

/** `leases [--json]`. */
export { leaseLines, leaseState } from "../platform/lease.ts";
