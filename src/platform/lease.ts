// Command-scoped resource leases: `pi-durable-subagents hold <resource> -- <command>`.
// Tickets are numbered under a kernel lock and waiters rank by descending priority, then ascending sequence.
// Granted incompatible tickets always block; waiting incompatible tickets block only requests behind them in rank.
// Enqueue and every final check-and-grant share the resource lock: a later higher-priority waiter can now block an
// earlier request, so the old FIFO lock-free grant argument no longer applies. No lock is held while commands run or
// their processes are ended. A ticket stays live while its wrapper, command, group or exact DSA_HOLD tag lives;
// waiters reclaim orphaned command trees before granting the next request. No orchestrator is involved.
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { replacePath, replacePathSync } from "../kernel/fsx.ts";
import { OsLock } from "./lock.ts";
import { ProcessTable } from "./proctable.ts";
import { IS_WINDOWS, killTreeSync, winSnapshotSync, type WinProcessRow } from "./windows.ts";

export type LeaseMode = "exclusive" | "shared" | "counted";
export interface LeaseProcess { pid: number; start?: string }
export interface LeaseTicket {
  seq: number; resource: string; mode: LeaseMode;
  /** Mode "counted": at most this many live granted tickets (counted or shared) when it is granted. */
  slots?: number;
  priority?: number; yield?: true; expectMs?: number;
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

/** Every live descendant of `pid` (Windows has no process groups: the command's tree is the group). Rows older than the
 *  root's creation token are never taken for its children: a reused pid has a later token. */
function winDescendants(pid: number, after?: string): WinProcessRow[] {
  const rows = winSnapshotSync(), out: WinProcessRow[] = [], queue = [pid];
  const floor = after && /^\d+$/.test(after) ? BigInt(after) : undefined;
  for (let i = 0; i < queue.length; i++)
    for (const row of rows.values()) if (row.ppid === queue[i] && !out.some(o => o.pid === row.pid)) {
      if (floor !== undefined && /^\d+$/.test(row.start) && BigInt(row.start) < floor) continue;
      out.push(row); queue.push(row.pid);
    }
  return out;
}

/** Whether a process still runs; on Linux the start token also tells it from a later process with the same pid. */
export function alive(p: LeaseProcess | undefined): boolean {
  if (!p) return false;
  try { process.kill(p.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") return false; }
  if (IS_WINDOWS) {
    // Creation time is Windows' start token. A row missing from the short-lived cache is not proof of death.
    if (!p.start) return true;
    const row = winSnapshotSync().get(p.pid);
    return row ? row.start === p.start : true;
  }
  if (!p.start || process.platform !== "linux") return true;
  try {
    const fields = readFileSync(`/proc/${p.pid}/stat`, "utf8");
    const rest = fields.slice(fields.lastIndexOf(")") + 2).split(" ");
    return rest[0] !== "Z" && rest[0] !== "X" && rest[19] === p.start;
  } catch { return false; }
}
/** Whether process group `pgid` still has a member that can run (Linux: zombies, which no signal ends, do not count). */
export function groupAlive(pgid: number): boolean {
  if (IS_WINDOWS) {
    try { process.kill(pgid, 0); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") return winDescendants(pgid).length > 0; }
  }
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
function leftoverGroup(t: LeaseTicket): boolean {
  const c = t.command;
  if (!c) return false;
  if (IS_WINDOWS) {
    // The command's pid is the root of its tree, not a process group. Live leader: no leftovers (alive() checks the
    // creation token). Dead leader: its children keep the parent pid, so they are its leftovers.
    if (alive(c)) return false;
    return winDescendants(c.pid, c.start).length > 0;
  }
  if (process.platform === "linux") {
    try {
      const fields = readFileSync(`/proc/${c.pid}/stat`, "utf8");
      const rest = fields.slice(fields.lastIndexOf(")") + 2).split(" ");
      if (!c.start || rest[19] !== c.start) return false;
    } catch { /* the leader is gone: only its group can remain */ }
  } else {
    try { process.kill(c.pid, 0); return false; } catch { /* the leader is gone */ }
  }
  if (groupAlive(c.pid)) return true;
  // One /proc listing is not atomic: a member can fork and exit between reading the directory and reading the stats, so
  // "no running member" is not proof. Whatever the group still holds is leftovers of a holder that is gone (which the
  // waiters would end anyway), so end it: a group signal reaches every member at once, a newborn included; zombies stay.
  try { process.kill(-c.pid, "SIGKILL"); } catch { /* the group is gone */ }
  return false;
}
const holdTable = new ProcessTable({ tagName: "DSA_HOLD" });
export const holdTag = (t: Pick<LeaseTicket, "resource" | "seq">) => `${t.resource}:${t.seq}`;
export const tagged = (t: Pick<LeaseTicket, "resource" | "seq">): LeaseProcess[] => holdTable.tagged(holdTag(t));
/** An orphan may retain its tag even after its leader and entire original process group have gone. */
export const orphaned = (t: LeaseTicket) => {
  if (alive(t.wrapper) || alive(t.command)) return false;
  if (IS_WINDOWS) return leftoverGroup(t) || winDescendants(t.wrapper.pid, t.wrapper.start).length > 0;
  return leftoverGroup(t) || tagged(t).length > 0;
};
/** A ticket is live while its wrapper, command, process group or exact inherited tag can still act. */
export const live = (t: LeaseTicket) => alive(t.wrapper) || alive(t.command) || orphaned(t);

/** End the group and escaped tagged descendants, rescanning for forks. Release is bounded even for unkillable tasks. */
export async function endLeaseProcesses(t: LeaseTicket, graceMs: number, say: (line: string) => void): Promise<void> {
  const started = Date.now(), until = started + 5000;
  if (IS_WINDOWS) {
    // taskkill /T is the tree signal (there is no SIGTERM to deliver). The wrapper is this holder process and must
    // outlive the cleanup: only the command's tree is ended here.
    for (;;) {
      if (t.command && alive(t.command)) { try { killTreeSync(t.command.pid); } catch { /* gone */ } }
      const orphans = t.command ? winDescendants(t.command.pid, t.command.start) : [];
      for (const row of orphans) if (!alive({ pid: row.pid, start: row.start })) continue; else { try { killTreeSync(row.pid); } catch { /* gone */ } }
      const remaining = t.command ? winDescendants(t.command.pid, t.command.start).length : 0;
      if (!(t.command && alive(t.command)) && !remaining) break;
      if (Date.now() >= until) { say(`hold: ${remaining} processes of ${who(t)} survived; releasing`); break; }
      await new Promise(r => setTimeout(r, 25));
    }
    return;
  }
  for (;;) {
    const members = tagged(t), group = t.command && (alive(t.command) || leftoverGroup(t));
    const signal = Date.now() - started >= graceMs ? "SIGKILL" : "SIGTERM";
    if (group) { try { process.kill(-t.command!.pid, signal); } catch { /* gone */ } }
    for (const p of members) if (alive(p)) { try { process.kill(p.pid, signal); } catch { /* gone */ } }
    if (!group && !members.length) break;
    if (Date.now() >= until) {
      if (members.length) say(`hold: ${members.length} processes tagged ${holdTag(t)} survived; releasing`);
      break;
    }
    await new Promise(r => setTimeout(r, 25));
  }
  // /proc listings are not atomic. A final group signal also reaches a newborn missed by the last scan.
  if (t.command && (alive(t.command) || leftoverGroup(t))) { try { process.kill(-t.command.pid, "SIGKILL"); } catch { /* gone */ } }
}

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

/** Priority is optional for persisted 1.0 tickets. Ties retain the original sequence order. */
export const rank = (a: Pick<LeaseTicket, "seq" | "priority">, b: Pick<LeaseTicket, "seq" | "priority">) =>
  (b.priority ?? 0) - (a.priority ?? 0) || a.seq - b.seq;

/** All incompatible holders, plus incompatible waiters ranked ahead. A grant is never taken back by later grants. */
export function blockers(t: Pick<LeaseTicket, "seq" | "mode" | "slots" | "grantedAt" | "priority">, tickets: LeaseTicket[]): LeaseTicket[] {
  if (t.grantedAt !== undefined) return [];
  const others = tickets.filter(o => o.seq !== t.seq);
  const full = t.mode === "counted" && others.filter(o => o.grantedAt !== undefined).length >= (t.slots ?? 1);
  return others.filter(o => o.grantedAt !== undefined
    ? t.mode === "exclusive" || o.mode === "exclusive" || full
    : rank(o, t) < 0 && (t.mode !== "shared" || o.mode === "exclusive"));
}

/** Write `file` through a temporary file renamed over it; a failed write or rename removes the temporary file (a full
 *  disk left empty ones behind). */
export function replaceFileSync(file: string, content: string, mode?: number) {
  const tmp = `${file}.${process.pid}.tmp`;
  try { writeFileSync(tmp, content); if (mode !== undefined) chmodSync(tmp, mode); replacePathSync(tmp, file); }
  catch (error) { try { unlinkSync(tmp); } catch { /* never written */ } throw error; }
}
async function replaceFile(file: string, content: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  try { await writeFile(tmp, content); await replacePath(tmp, file); }
  catch (error) { await unlink(tmp).catch(() => {}); throw error; }
}
/** Remove `*.tmp` files in `dir` older than `maxAgeMs` (partial writes of processes that died or ran out of disk). Best
 *  effort: returns how many were removed, never throws. */
export function removeStaleTemps(dir: string, maxAgeMs: number, now = Date.now()): number {
  let removed = 0, names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names.filter(n => n.endsWith(".tmp"))) {
    try {
      const file = path.join(dir, name), info = statSync(file);
      if (info.isFile() && now - info.mtimeMs > maxAgeMs) { unlinkSync(file); removed++; }
    } catch { /* gone meanwhile, or not ours to remove */ }
  }
  return removed;
}
function writeTicketSync(home: string, t: LeaseTicket) {
  replaceFileSync(path.join(leaseDir(home, t.resource), ticketName(t.seq)), JSON.stringify(t));
}
export async function writeTicket(home: string, t: LeaseTicket) {
  await replaceFile(path.join(leaseDir(home, t.resource), ticketName(t.seq)), JSON.stringify(t));
}
export function removeTicket(home: string, t: LeaseTicket) {
  try { unlinkSync(path.join(leaseDir(home, t.resource), ticketName(t.seq))); } catch { /* already gone */ }
}

/** Queue a request under the same lock used by queued and no-wait grants. */
export async function enqueue(home: string, ticket: Omit<LeaseTicket, "seq">, lock = new OsLock()): Promise<LeaseTicket> {
  return (await numbered(home, ticket, false, lock)) as LeaseTicket;
}
/** Take the lease now or not at all. Refusal never creates a waiter; the synthetic sequence ranks after equal priority. */
export async function tryGrant(home: string, ticket: Omit<LeaseTicket, "seq" | "grantedAt">, lock = new OsLock()): Promise<LeaseTicket | { busy: LeaseTicket[] }> {
  return numbered(home, ticket, true, lock);
}
async function locked<T>(home: string, resource: string, lock: OsLock, action: () => Promise<T> | T): Promise<T> {
  const dir = leaseDir(home, resource);
  mkdirSync(dir, { recursive: true });
  let handle = await lock.tryAcquire(path.join(dir, ".lock"));
  for (let delay = 5; !handle; delay = Math.min(delay * 2, 100)) {
    await new Promise(r => setTimeout(r, delay));
    handle = await lock.tryAcquire(path.join(dir, ".lock"));
  }
  try { return await action(); } finally { await handle.release(); }
}
/** Recheck and commit a queued grant under the resource lock. No awaits separate the final read and ticket write. */
export async function grantQueued(home: string, t: LeaseTicket, lock = new OsLock()): Promise<LeaseTicket[]> {
  return locked(home, t.resource, lock, () => {
    const busy = blockers(t, liveTickets(home, t.resource));
    if (!busy.length) { t.grantedAt = Date.now(); writeTicketSync(home, t); }
    return busy;
  });
}
async function numbered(home: string, ticket: Omit<LeaseTicket, "seq">, now: boolean, lock: OsLock): Promise<LeaseTicket | { busy: LeaseTicket[] }> {
  return locked(home, ticket.resource, lock, async () => {
    const dir = leaseDir(home, ticket.resource), counter = path.join(dir, ".seq");
    const last = Number.parseInt(await readFile(counter, "utf8").catch(() => "0"), 10) || 0;
    const highest = readTickets(home, ticket.resource).reduce((m, t) => Math.max(m, t.seq), last);
    const t: LeaseTicket = { ...ticket, seq: highest + 1 };
    if (now) {
      const busy = blockers(t, liveTickets(home, ticket.resource));
      if (busy.length) return { busy };
      t.grantedAt = Date.now();
    }
    await replaceFile(counter, String(t.seq));
    writeTicketSync(home, t);
    return t;
  });
}

/** Every resource with live tickets: holders (granted) and waiters, in request order. Cheap: a directory listing,
 *  small files and a liveness check of the few ticket processes. */
export interface LeaseResource {
  resource: string; holders: LeaseTicket[]; waiters: LeaseTicket[];
  /** When a live ticket is counted: the slot count (that of the first counted waiter, else of the latest counted ticket)
   *  and how many tickets hold the resource. */
  slots?: number; held?: number;
}
export function leaseState(home: string): LeaseResource[] {
  let resources: string[];
  try { resources = readdirSync(leasesRoot(home)).filter(r => RESOURCE.test(r)).sort(); } catch { return []; }
  return resources.map(resource => {
    const tickets = liveTickets(home, resource), holders = tickets.filter(t => t.grantedAt !== undefined), waiters = tickets.filter(t => t.grantedAt === undefined).sort(rank);
    const slots = slotCount(tickets);
    return { resource, holders, waiters, ...(slots !== undefined ? { slots, held: holders.length } : {}) };
  }).filter(r => r.holders.length || r.waiters.length);
}
/** The slot count shown for a resource: its first ranked counted waiter's, else its latest counted ticket's. */
export function slotCount(tickets: LeaseTicket[]): number | undefined {
  const counted = tickets.filter(t => t.mode === "counted");
  return (counted.filter(t => t.grantedAt === undefined).sort(rank)[0] ?? counted.at(-1))?.slots;
}

const age = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`;
const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s;
/** "<wid>/<key>" of a call id "<wid>@<rev>/<key>@<gen>". */
export const callAddress = (call: string) => { const m = /^([^@/]+)@\d+\/(.+)@\d+$/.exec(call); return m ? `${m[1]}/${m[2]}` : call; };
/** Who holds or waits: the subagent call when there is one, else the pid and command. */
export const who = (t: LeaseTicket) => t.call ? callAddress(t.call) : `pid ${t.wrapper.pid} \`${clip(t.argv.join(" "), 60)}\``;

/** How a mode reads in listings: a counted ticket holds a "slot". */
export const modeLabel = (t: Pick<LeaseTicket, "mode">) => t.mode === "counted" ? "slot" : t.mode;
/** A granted ticket's mode, how long it has been held, the command (unless `who` already names it) and the note:
 *  "exclusive, 12m, `make bench`, nightly". */
export const holdDetail = (t: LeaseTicket, now = Date.now(), command = !!t.call) =>
  `${modeLabel(t)}, ${age(now - (t.grantedAt ?? t.since))}${t.expectMs !== undefined ? ` of ~${age(t.expectMs)}` : ""}${command ? `, \`${clip(t.argv.join(" "), 60)}\`` : ""}${t.note ? `, ${clip(t.note, 80)}` : ""}`;

/** One status line per resource: "machine held by <who> (exclusive, 12m, `make bench`); waiting: <who> 3m, …". A resource
 *  with counted tickets: "build 3/5 held: <who> (slot, 2m, ...), ...; waiting: 2 (first: <who>, 30s)". */
export function leaseLines(state: LeaseResource[], now = Date.now()): string[] {
  return state.map(({ resource, holders, waiters, slots }) => {
    if (slots !== undefined) {
      const by = holders.map(t => `${who(t)} (${holdDetail(t, now)})`).join(", ");
      return `${resource} ${holders.length}/${slots} held${by ? `: ${by}` : ""}${waiters.length ? `; waiting: ${waiters.length} (first: ${who(waiters[0]!)}, ${age(now - waiters[0]!.since)}${waiters[0]!.expectMs !== undefined ? `, expects ${age(waiters[0]!.expectMs)}` : ""})` : ""}`;
    }
    const held = holders.length ? `held by ${holders.map(t => `${who(t)} (${holdDetail(t, now)})`).join(", ")}` : "free";
    return `${resource} ${held}${waiters.length ? `; waiting: ${waiters.map(t => `${who(t)} ${t.mode === "shared" ? "shared " : ""}${age(now - t.since)}${t.expectMs !== undefined ? ` expects ${age(t.expectMs)}` : ""}`).join(", ")}` : ""}`;
  });
}

/** Per call id: "holds lease machine" / "waiting for lease machine 3m". */
export function leaseCalls(state: LeaseResource[], now = Date.now()): Map<string, string> {
  const out = new Map<string, string>();
  for (const { resource, holders, waiters } of state) {
    for (const t of holders) if (t.call) out.set(t.call, [out.get(t.call), `holds lease ${resource}`].filter(Boolean).join(", "));
    for (const t of waiters) if (t.call) out.set(t.call, [out.get(t.call), `waiting for lease ${resource} ${age(now - t.since)}`].filter(Boolean).join(", "));
  }
  return out;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** A cmd.exe shim: paths quoted, percent signs doubled so batch does not expand them. */
const batchQuote = (s: string) => `"${s.replace(/%/g, "%%")}"`;
/** The `pi-durable-subagents` command for subagents: `<dir>/pi-durable-subagents` (a `.cmd` on Windows) runs this node
 *  with the CLI entry of the running orchestrator, so children can `hold` without the package on their PATH. Rewritten
 *  at every start. */
export function writeShim(dir: string, node: string, entry: string): string {
  mkdirSync(dir, { recursive: true });
  if (IS_WINDOWS) {
    const file = path.join(dir, "pi-durable-subagents.cmd");
    replaceFileSync(file, `@echo off\r\n${batchQuote(node)} ${batchQuote(entry)} %*\r\n`);
    // Git Bash (pi's bash tool) does not run a .cmd by bare name; the same shim as a POSIX script sits beside it.
    replaceFileSync(path.join(dir, "pi-durable-subagents"), `#!/bin/sh\nexec ${quote(node)} ${quote(entry)} "$@"\n`, 0o755);
    return file;
  }
  const file = path.join(dir, "pi-durable-subagents");
  replaceFileSync(file, `#!/bin/sh\nexec ${quote(node)} ${quote(entry)} "$@"\n`, 0o755);
  return file;
}
