// Command-scoped resource leases: `pi-durable-subagents hold <resource> -- <command>` (README "Resource leases").
// One ticket file per request under $DSA_HOME/leases/<resource>/, numbered under a kernel lock so the numbers are
// strictly increasing and never reused. Grants are strict FIFO by number: an exclusive request needs no earlier live
// ticket, a shared one no earlier live exclusive ticket. Whether a request is grantable depends only on earlier tickets,
// which can only disappear, so a grant needs no lock once the ticket exists. A ticket is live while its wrapper or its
// command (pid + start token) lives, or processes the command left in its group remain; a waiter next in line ends such
// leftovers of a killed wrapper. Anyone may delete a dead ticket. No orchestrator is involved.
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { OsLock } from "./lock.ts";

export type LeaseMode = "exclusive" | "shared";
export interface LeaseProcess { pid: number; start?: string }
export interface LeaseTicket {
  seq: number; resource: string; mode: LeaseMode;
  wrapper: LeaseProcess; command?: LeaseProcess;
  /** The command as given (clipped), its working directory and an optional note. */
  argv: string[]; cwd: string; note?: string;
  since: number; grantedAt?: number;
  /** The dsa execution and call that run the wrapper, when it runs inside a subagent (DSA_EXEC / DSA_CALL). */
  exec?: string; call?: string;
}

export const RESOURCE = /^[A-Za-z0-9._-]{1,64}$/;
export const leasesRoot = (home: string) => path.join(home, "leases");
export const leaseDir = (home: string, resource: string) => path.join(leasesRoot(home), resource);
const ticketName = (seq: number) => `${String(seq).padStart(12, "0")}.json`;
const TICKET = /^\d{12}\.json$/;

/** Whether a process still runs; on Linux the start token also tells it from a later process with the same pid. */
export function alive(p: LeaseProcess | undefined): boolean {
  if (!p) return false;
  try { process.kill(p.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") return false; }
  if (!p.start || process.platform !== "linux") return true;
  try {
    const fields = readFileSync(`/proc/${p.pid}/stat`, "utf8");
    const rest = fields.slice(fields.lastIndexOf(")") + 2).split(" ");
    return rest[0] !== "Z" && rest[0] !== "X" && rest[19] === p.start;
  } catch { return false; }
}
/** Whether process group `pgid` still has a member that can run (Linux: zombies, which no signal ends, do not count). */
export function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") return false; }
  if (process.platform !== "linux") return true;
  let pids: string[];
  try { pids = readdirSync("/proc").filter(n => /^\d+$/.test(n)); } catch { return true; }
  for (const pid of pids) {
    try {
      const fields = readFileSync(`/proc/${pid}/stat`, "utf8");
      const rest = fields.slice(fields.lastIndexOf(")") + 2).split(" ");
      if (Number(rest[2]) === pgid && rest[0] !== "Z" && rest[0] !== "X") return true;
    } catch { /* exited meanwhile */ }
  }
  return false;
}
/**
 * Whether the command's process group outlives both the wrapper and the command (a killed wrapper cannot end what the
 * command left behind). The command was spawned as its group's leader, so the group id is its pid. A pid stays
 * allocated while a group uses it as its id, so with the leader gone a group with that id is the command's own. While a
 * process owns the pid it must be the command itself (on Linux the start token, zombie or not); any other owner means
 * the original group emptied and the pid was reused. macOS has no start token here: a reused pid that is alive there
 * counts as the command (the lease waits for it), never as leftovers to end.
 */
export function orphaned(t: LeaseTicket): boolean {
  const c = t.command;
  if (!c || alive(t.wrapper) || alive(c)) return false;
  if (process.platform === "linux") {
    try {
      const fields = readFileSync(`/proc/${c.pid}/stat`, "utf8");
      const rest = fields.slice(fields.lastIndexOf(")") + 2).split(" ");
      if (!c.start || rest[19] !== c.start) return false;
    } catch { /* the leader is gone: only its group can remain */ }
  } else {
    try { process.kill(c.pid, 0); return false; } catch { /* the leader is gone */ }
  }
  return groupAlive(c.pid);
}
/** A ticket is live while its wrapper, its command, or processes the command left in its group run. */
export const live = (t: LeaseTicket) => alive(t.wrapper) || alive(t.command) || orphaned(t);

/** The tickets of one resource in request order (unreadable or half-written files are skipped). */
export function readTickets(home: string, resource: string): LeaseTicket[] {
  let names: string[];
  try { names = readdirSync(leaseDir(home, resource)); } catch { return []; }
  const out: LeaseTicket[] = [];
  for (const name of names.filter(n => TICKET.test(n)).sort()) {
    try { out.push(JSON.parse(readFileSync(path.join(leaseDir(home, resource), name), "utf8")) as LeaseTicket); } catch { /* raced with a delete */ }
  }
  return out;
}

/** Live tickets; dead ones are deleted (their numbers are never reused, so a stale reader cannot delete a newer one). */
export function liveTickets(home: string, resource: string): LeaseTicket[] {
  return readTickets(home, resource).filter(t => {
    if (live(t)) return true;
    try { unlinkSync(path.join(leaseDir(home, resource), ticketName(t.seq))); } catch { /* already gone */ }
    return false;
  });
}

/** The live tickets that come before `t` and keep it waiting (empty when it may run). */
export function blockers(t: Pick<LeaseTicket, "seq" | "mode">, tickets: LeaseTicket[]): LeaseTicket[] {
  return tickets.filter(o => o.seq < t.seq && (t.mode === "exclusive" || o.mode === "exclusive"));
}

function writeTicketSync(home: string, t: LeaseTicket) {
  const file = path.join(leaseDir(home, t.resource), ticketName(t.seq)), tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(t)); renameSync(tmp, file);
}
export async function writeTicket(home: string, t: LeaseTicket) {
  const file = path.join(leaseDir(home, t.resource), ticketName(t.seq)), tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(t)); renameSync(tmp, file);
}
export function removeTicket(home: string, t: LeaseTicket) {
  try { unlinkSync(path.join(leaseDir(home, t.resource), ticketName(t.seq))); } catch { /* already gone */ }
}

/** Queue a request: number it under the resource's kernel lock and write its ticket before the lock is released, so a
 *  later request always sees it. */
export async function enqueue(home: string, ticket: Omit<LeaseTicket, "seq">, lock = new OsLock()): Promise<LeaseTicket> {
  const dir = leaseDir(home, ticket.resource);
  mkdirSync(dir, { recursive: true });
  let handle = await lock.tryAcquire(path.join(dir, ".lock"));
  for (let delay = 5; !handle; delay = Math.min(delay * 2, 100)) {
    await new Promise(r => setTimeout(r, delay));
    handle = await lock.tryAcquire(path.join(dir, ".lock"));
  }
  try {
    const counter = path.join(dir, ".seq");
    const last = Number.parseInt(await readFile(counter, "utf8").catch(() => "0"), 10) || 0;
    const highest = readTickets(home, ticket.resource).reduce((m, t) => Math.max(m, t.seq), last);
    const t: LeaseTicket = { ...ticket, seq: highest + 1 };
    await writeFile(`${counter}.tmp`, String(t.seq)); renameSync(`${counter}.tmp`, counter);
    writeTicketSync(home, t);
    return t;
  } finally { await handle.release(); }
}

/** Every resource with live tickets: holders (granted) and waiters, in request order. Cheap: a directory listing,
 *  small files and a liveness check of the few ticket processes. */
export function leaseState(home: string): { resource: string; holders: LeaseTicket[]; waiters: LeaseTicket[] }[] {
  let resources: string[];
  try { resources = readdirSync(leasesRoot(home)).filter(r => RESOURCE.test(r)).sort(); } catch { return []; }
  return resources.map(resource => {
    const tickets = liveTickets(home, resource);
    return { resource, holders: tickets.filter(t => t.grantedAt !== undefined), waiters: tickets.filter(t => t.grantedAt === undefined) };
  }).filter(r => r.holders.length || r.waiters.length);
}

const age = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`;
const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s;
/** "<wid>/<key>" of a call id "<wid>@<rev>/<key>@<gen>". */
export const callAddress = (call: string) => { const m = /^([^@/]+)@\d+\/(.+)@\d+$/.exec(call); return m ? `${m[1]}/${m[2]}` : call; };
/** Who holds or waits: the subagent call when there is one, else the pid and command. */
export const who = (t: LeaseTicket) => t.call ? callAddress(t.call) : `pid ${t.wrapper.pid} \`${clip(t.argv.join(" "), 60)}\``;

/** One status line per resource: "machine held by <who> (exclusive, 12m, `make bench`); waiting: <who> 3m, …". */
export function leaseLines(state: ReturnType<typeof leaseState>, now = Date.now()): string[] {
  return state.map(({ resource, holders, waiters }) => {
    const held = holders.length
      ? `held by ${holders.map(t => `${who(t)} (${t.mode}, ${age(now - (t.grantedAt ?? t.since))}${t.call ? `, \`${clip(t.argv.join(" "), 60)}\`` : ""}${t.note ? `, ${clip(t.note, 80)}` : ""})`).join(", ")}`
      : "free";
    return `${resource} ${held}${waiters.length ? `; waiting: ${waiters.map(t => `${who(t)} ${t.mode === "shared" ? "shared " : ""}${age(now - t.since)}`).join(", ")}` : ""}`;
  });
}

/** Per call id: "holds lease machine" / "waiting for lease machine 3m". */
export function leaseCalls(state: ReturnType<typeof leaseState>, now = Date.now()): Map<string, string> {
  const out = new Map<string, string>();
  for (const { resource, holders, waiters } of state) {
    for (const t of holders) if (t.call) out.set(t.call, [out.get(t.call), `holds lease ${resource}`].filter(Boolean).join(", "));
    for (const t of waiters) if (t.call) out.set(t.call, [out.get(t.call), `waiting for lease ${resource} ${age(now - t.since)}`].filter(Boolean).join(", "));
  }
  return out;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** The `pi-durable-subagents` command for subagents: `<dir>/pi-durable-subagents` runs this node with the CLI entry of
 *  the running orchestrator, so children can `hold` without the package on their PATH. Rewritten at every start. */
export function writeShim(dir: string, node: string, entry: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "pi-durable-subagents"), tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `#!/bin/sh\nexec ${quote(node)} ${quote(entry)} "$@"\n`);
  chmodSync(tmp, 0o755); renameSync(tmp, file);
  return file;
}
