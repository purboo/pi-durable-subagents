// Command-scoped resource leases: `pi-durable-subagents hold <resource> -- <command>`.
// Tickets are numbered under a kernel lock and waiters rank by descending priority, then ascending sequence.
// Granted incompatible tickets always block; waiting incompatible tickets block only requests behind them in rank.
// Enqueue and every final check-and-grant share the resource lock: a later higher-priority waiter can now block an
// earlier request, so the old FIFO lock-free grant argument no longer applies. No lock is held while commands run or
// their processes are ended. A ticket stays live while its wrapper, command, group or exact DSA_HOLD tag lives;
// waiters reclaim orphaned command trees before granting the next request. No orchestrator is involved.
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { replacePath, replacePathSync } from "../kernel/fsx.ts";
import { readBeginIdentitySync, readGroupEndSync, readGroupRecordStateSync } from "./job.ts";
import { OsLock } from "./lock.ts";
import { ProcessTable } from "./proctable.ts";
import { IS_WINDOWS, isWinStart, killProcessSync, killTreeSync, probeKernelPid, sameCreation, winLiveDescendants, winProcessAlive, winSnapshotSync, winStartSync, winTag, type KernelPidProbe, type WinProcessIdentity, type WinProcessRow } from "./windows.ts";

export type LeaseMode = "exclusive" | "shared" | "counted";
export interface LeaseProcess { pid: number; start?: string }
export interface LeaseTicket {
  seq: number; resource: string; mode: LeaseMode;
  /** Mode "counted": at most this many live granted tickets (counted or shared) when it is granted. */
  slots?: number;
  priority?: number; yield?: true; expectMs?: number;
  wrapper: LeaseProcess; command?: LeaseProcess;
  /** Windows: the Job Object owner process and its durable handshake directory. */
  group?: LeaseProcess; jobDir?: string;
  /** The command as given (clipped), its working directory and an optional note. */
  argv: string[]; cwd: string; note?: string;
  since: number; grantedAt?: number;
  /** The dsa execution and call that run the wrapper, when it runs inside a subagent (DSA_EXEC / DSA_CALL). */
  exec?: string; call?: string;
}

export const RESOURCE = /^[A-Za-z0-9._-]{1,64}$/;
export const leasesRoot = (home: string) => path.join(home, "leases");
export const leaseDir = (home: string, resource: string) => path.join(leasesRoot(home), resource);
export const leaseJobDir = (home: string, resource: string, seq: number) => path.join(leaseDir(home, resource), ".jobs", String(seq).padStart(12, "0"));
const ticketName = (seq: number) => `${String(seq).padStart(12, "0")}.json`;
const TICKET = /^\d{12}\.json$/;

export interface LeaseCheckOptions {
  platform?: NodeJS.Platform;
  snapshotWin?: (maxAgeMs?: number) => Map<number, WinProcessRow>;
  startWinSync?: (pid: number) => string;
  processAlive?: (pid: number) => boolean;
  probePid?: (pid: number) => KernelPidProbe;
}

const checkOpts = (options?: LeaseCheckOptions): LeaseCheckOptions | undefined =>
  options && typeof options === "object" ? options : undefined;

function resolveProbePid(opts?: LeaseCheckOptions): (pid: number) => KernelPidProbe {
  if (opts?.probePid) return opts.probePid;
  if (opts?.processAlive) return pid => (opts.processAlive!(pid) ? "alive" : "dead");
  return probeKernelPid;
}

/** Proven-owned live descendants of `(pid, start)` in the current snapshot. Requires a valid `start` token and a live
 *  matching parent in the snapshot: once a parent exits on Windows, its numeric PID can be reused by an unrelated
 *  process whose children share that `ParentProcessId`, and pre-existing boot/system orphans have `child.start < start`. */
function winDescendants(pid: number, start?: string, rows?: ReadonlyMap<number, WinProcessRow>): WinProcessRow[] {
  if (!isWinStart(start)) return [];
  const table = rows ?? winSnapshotSync();
  return winLiveDescendants([{ pid, start }], table.values());
}

/** Whether a process still runs; on Linux/Windows the start token also tells it from a later process with the same pid. */
export function alive(p: LeaseProcess | undefined, options?: LeaseCheckOptions): boolean {
  if (!p) return false;
  const opts = checkOpts(options);
  const probePid = resolveProbePid(opts);
  const platform = opts?.platform ?? (IS_WINDOWS ? "win32" : process.platform);
  if (platform === "win32") {
    return winProcessAlive(p.pid, p.start, {
      probePid,
      ...(opts?.snapshotWin ? { snapshotWin: opts.snapshotWin } : {}),
      ...(opts?.startWinSync ? { startWinSync: opts.startWinSync } : {}),
    });
  }
  if (probePid(p.pid) === "dead") return false;
  if (!p.start || platform !== "linux") return true;
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
    try { return winDescendants(c.pid, c.start).length > 0; } catch { return false; }
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

const isWinJobTicket = (t: LeaseTicket) => Boolean(t.jobDir || t.group);

/** Inspect a Windows Job-backed ticket after its wrapper has exited:
 *  - "running": the Job Object owner and the command root are live (retains the lease until the command finishes);
 *  - "orphaned": the wrapper and command root are gone (or the wrapper died mid-launch before `group`), while the
 *    Job Object owner or a verified root is still alive (retains the lease until a waiter or the owner finishes draining);
 *  - "dead": the Job Object owner is gone, so its non-inherited KILL_ON_JOB_CLOSE handle is closed and nothing remains. */
function inspectWinJob(t: LeaseTicket, opts?: LeaseCheckOptions): "running" | "orphaned" | "dead" {
  const probePid = resolveProbePid(opts);
  const snap = opts?.snapshotWin ?? winSnapshotSync;
  const startOf = opts?.startWinSync ?? winStartSync;
  // Fresh snapshot AFTER observing the wrapper gone, before reading the job directory: never uses a pre-spawn cache.
  let rows: ReadonlyMap<number, WinProcessRow> | undefined;
  try { rows = snap(0); } catch { rows = undefined; }
  const groupState = t.jobDir ? readGroupRecordStateSync(t.jobDir) : { state: "absent" as const };
  const groupRec = groupState.state === "ready" ? groupState.record : undefined;
  const began = t.jobDir ? readBeginIdentitySync(t.jobDir) : undefined;
  const groupEnded = Boolean(t.jobDir && readGroupEndSync(t.jobDir) !== undefined);
  const recordedOwner = (groupRec?.group && isWinStart(groupRec.group.start) ? groupRec.group : undefined)
    ?? (t.group && isWinStart(t.group.start) ? { pid: t.group.pid, start: t.group.start } : undefined)
    ?? (began && isWinStart(began.start) ? began : undefined);
  const tag = holdTag(t);
  let ownerAlive = false;
  if (recordedOwner) {
    const ownerProbe = probePid(recordedOwner.pid);
    if (ownerProbe !== "dead") {
      if (!rows) {
        ownerAlive = ownerProbe === "alive";
      } else {
        const ownerRow = rows.get(recordedOwner.pid);
        ownerAlive = ownerRow ? sameCreation(ownerRow.start, recordedOwner.start)
          : ownerProbe === "alive" && sameCreation(startOf(recordedOwner.pid), recordedOwner.start);
      }
    }
  } else if (!rows) {
    return "running";
  } else {
    const taggedOwner = [...rows.values()].find(r => isWinStart(r.start) && winTag(r.command, "DSA_HOLD") === tag);
    if (taggedOwner && probePid(taggedOwner.pid) !== "dead") ownerAlive = true;
  }
  const cmd = (groupRec && isWinStart(groupRec.start) ? { pid: groupRec.pid, start: groupRec.start } : undefined)
    ?? (t.command && isWinStart(t.command.start) ? { pid: t.command.pid, start: t.command.start } : undefined);
  let cmdAlive = false;
  if (!groupEnded && cmd) {
    const cmdProbe = probePid(cmd.pid);
    if (cmdProbe !== "dead") {
      if (!rows) {
        cmdAlive = cmdProbe === "alive";
      } else {
        const cmdRow = rows.get(cmd.pid);
        cmdAlive = cmdRow ? sameCreation(cmdRow.start, cmd.start)
          : cmdProbe === "alive" && sameCreation(startOf(cmd.pid), cmd.start);
      }
    }
  }
  if (ownerAlive && (cmdAlive || groupState.state === "transient")) return "running";
  if (ownerAlive || cmdAlive) return "orphaned";
  return "dead";
}

/** An orphan may retain its tag or job even after its wrapper and command leader have gone. */
export const orphaned = (t: LeaseTicket, options?: LeaseCheckOptions): boolean => {
  const opts = checkOpts(options);
  const platform = opts?.platform ?? (IS_WINDOWS ? "win32" : process.platform);
  if (alive(t.wrapper, opts)) return false;
  if (platform === "win32" && isWinJobTicket(t)) return inspectWinJob(t, opts) === "orphaned";
  if (alive(t.command, opts)) return false;
  if (platform === "win32") {
    const snap = opts?.snapshotWin ?? winSnapshotSync;
    try {
      const rows = snap(0);
      return (t.command ? winDescendants(t.command.pid, t.command.start, rows).length > 0 : false)
        || winDescendants(t.wrapper.pid, t.wrapper.start, rows).length > 0;
    } catch { return false; }
  }
  return leftoverGroup(t) || tagged(t).length > 0;
};
/** A ticket is live while its wrapper, command, job/process group or exact inherited tag can still act. */
export const live = (t: LeaseTicket, options?: LeaseCheckOptions): boolean => {
  const opts = checkOpts(options);
  const platform = opts?.platform ?? (IS_WINDOWS ? "win32" : process.platform);
  if (alive(t.wrapper, opts)) return true;
  if (platform === "win32" && isWinJobTicket(t)) return inspectWinJob(t, opts) !== "dead";
  return alive(t.command, opts) || orphaned(t, opts);
};

export interface EndLeaseOptions extends LeaseCheckOptions {
  killWinSync?: (targets: readonly WinProcessIdentity[]) => void;
  killOwnerWinSync?: (targets: readonly WinProcessIdentity[]) => void;
}

/** End the group and escaped tagged descendants, rescanning for forks. Release is bounded even for unkillable tasks. */
export async function endLeaseProcesses(t: LeaseTicket, graceMs: number, say: (line: string) => void, options: EndLeaseOptions = {}): Promise<void> {
  const started = Date.now(), until = started + 5000;
  if ((options.platform ?? process.platform) === "win32") {
    const snap = options.snapshotWin ?? winSnapshotSync;
    const trySnap = (): Map<number, WinProcessRow> | undefined => {
      try { return snap(0); } catch { return undefined; }
    };
    if (isWinJobTicket(t)) {
      // Terminating the verified Job Object owner closes the job's sole handle (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE),
      // so the kernel ends the command root and every surviving child/grandchild without walking dead parent PIDs.
      const killOwner = options.killOwnerWinSync ?? options.killWinSync ?? (targets => killProcessSync(targets));
      const probe = resolveProbePid(options);
      const tag = holdTag(t);
      const proven = new Map<string, WinProcessIdentity>();
      const addProvenCmd = (cmd: WinProcessIdentity, ...snapshots: ReadonlyArray<ReadonlyMap<number, WinProcessRow> | undefined>) => {
        proven.set(`${cmd.pid}:${cmd.start}`, cmd);
        for (const snapshot of snapshots) {
          if (!snapshot) continue;
          for (const d of winLiveDescendants([cmd], snapshot.values())) {
            proven.set(`${d.pid}:${d.start}`, { pid: d.pid, start: d.start });
          }
        }
      };
      let checkedOwnerHandle = false;
      for (;;) {
        const rows = trySnap();
        const groupState = t.jobDir ? readGroupRecordStateSync(t.jobDir) : { state: "absent" as const };
        const groupRec = groupState.state === "ready" ? groupState.record : undefined;
        const began = t.jobDir ? readBeginIdentitySync(t.jobDir) : undefined;
        const recordedOwner = (groupRec?.group && isWinStart(groupRec.group.start) ? groupRec.group : undefined)
          ?? (t.group && isWinStart(t.group.start) ? { pid: t.group.pid, start: t.group.start } : undefined)
          ?? (began && isWinStart(began.start) ? began : undefined);
        const taggedRow = recordedOwner || !rows ? undefined
          : [...rows.values()].find(r => isWinStart(r.start) && winTag(r.command, "DSA_HOLD") === tag);
        const owner: WinProcessIdentity | undefined = recordedOwner
          ?? (taggedRow ? { pid: taggedRow.pid, start: taggedRow.start } : undefined);
        const cmd: WinProcessIdentity | undefined = (groupRec && isWinStart(groupRec.start) ? { pid: groupRec.pid, start: groupRec.start } : undefined)
          ?? (t.command && isWinStart(t.command.start) ? { pid: t.command.pid, start: t.command.start } : undefined);
        if (owner) proven.set(`${owner.pid}:${owner.start}`, owner);
        if (cmd) addProvenCmd(cmd, rows);
        const ownerLiveInRows = Boolean(owner && rows && rows.get(owner.pid) && sameCreation(rows.get(owner.pid)!.start, owner.start));
        const shouldKillOwner = Boolean(owner && (ownerLiveInRows || (recordedOwner !== undefined && (!checkedOwnerHandle || !rows) && probe(owner.pid) !== "dead")));
        if (rows) checkedOwnerHandle = true;
        if (shouldKillOwner && owner) {
          try { killOwner([owner]); } catch { /* retry until deadline when a verified owner resists termination */ }
        }
        const checkRows = shouldKillOwner ? trySnap() : rows;
        let transientGroup = groupState.state === "transient";
        let effectiveCmd = cmd;
        if (!groupRec && t.jobDir && shouldKillOwner) {
          const lateGroupState = readGroupRecordStateSync(t.jobDir);
          transientGroup = lateGroupState.state === "transient";
          if (lateGroupState.state === "ready") {
            const late = lateGroupState.record;
            if (late.group && isWinStart(late.group.start)) {
              proven.set(`${late.group.pid}:${late.group.start}`, late.group);
            }
            if (isWinStart(late.start)) {
              effectiveCmd = { pid: late.pid, start: late.start };
              addProvenCmd(effectiveCmd, rows, checkRows);
            }
          }
        }
        if (effectiveCmd) addProvenCmd(effectiveCmd, checkRows);
        const remaining = checkRows
          ? [...proven.values()].filter(p => {
            const row = checkRows.get(p.pid);
            return row !== undefined && sameCreation(row.start, p.start);
          }).length
          : Math.max(1, proven.size);
        if (checkRows && !remaining && !transientGroup) break;
        if (Date.now() >= until) { say(`hold: ${remaining || 1} processes of ${who(t)} survived; releasing`); break; }
        await new Promise(r => setTimeout(r, 25));
      }
      return;
    }
    // Legacy/non-job Windows ticket fallback: handle-verified tree termination on `t.command`.
    if (!t.command) return;
    if (!isWinStart(t.command.start)) {
      say(`hold: refusing to end pid ${t.command.pid} of ${who(t)} without verified start identity; releasing`);
      return;
    }
    const killWin = options.killWinSync ?? (targets => killTreeSync(targets));
    const rootIdentity: WinProcessIdentity = { pid: t.command.pid, start: t.command.start };
    const proven = new Map<string, WinProcessIdentity>([[`${rootIdentity.pid}:${rootIdentity.start}`, rootIdentity]]);
    let checkedRootHandle = false;
    for (;;) {
      const rows = trySnap();
      if (rows) {
        for (const d of winLiveDescendants([...proven.values()], rows.values())) {
          proven.set(`${d.pid}:${d.start}`, { pid: d.pid, start: d.start });
        }
      }
      const liveTargets = rows
        ? [...proven.values()].filter(p => {
          const row = rows.get(p.pid);
          return row !== undefined && sameCreation(row.start, p.start);
        })
        : [rootIdentity];
      if (!checkedRootHandle && !liveTargets.some(p => p.pid === rootIdentity.pid)) {
        liveTargets.unshift(rootIdentity);
      }
      if (rows) checkedRootHandle = true;
      if (rows && !liveTargets.length) break;
      try { killWin(liveTargets); } catch { /* retry until deadline when a verified owned process resists termination */ }
      const after = trySnap();
      if (after) {
        for (const d of winLiveDescendants([...proven.values()], after.values())) {
          proven.set(`${d.pid}:${d.start}`, { pid: d.pid, start: d.start });
        }
      }
      const remaining = after
        ? [...proven.values()].filter(p => {
          const row = after.get(p.pid);
          return row !== undefined && sameCreation(row.start, p.start);
        }).length
        : Math.max(1, proven.size);
      if (after && !remaining) break;
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

function removeTicketJobDir(home: string, t: Pick<LeaseTicket, "resource" | "seq" | "jobDir">) {
  const dir = t.jobDir || leaseJobDir(home, t.resource, t.seq);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* still held or already gone */ }
  try { rmdirSync(path.join(leaseDir(home, t.resource), ".jobs")); } catch { /* non-empty or absent */ }
}

/** Live tickets; dead ones are deleted (their numbers are never reused, so a stale reader cannot delete a newer one). */
export function liveTickets(home: string, resource: string, options?: LeaseCheckOptions): LeaseTicket[] {
  const opts = checkOpts(options);
  return readTickets(home, resource).filter(t => {
    if (live(t, opts)) return true;
    try { unlinkSync(path.join(leaseDir(home, resource), ticketName(t.seq))); } catch { /* already gone */ }
    removeTicketJobDir(home, t);
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
export function writeTicketSync(home: string, t: LeaseTicket) {
  replaceFileSync(path.join(leaseDir(home, t.resource), ticketName(t.seq)), JSON.stringify(t));
}
export async function writeTicket(home: string, t: LeaseTicket) {
  await replaceFile(path.join(leaseDir(home, t.resource), ticketName(t.seq)), JSON.stringify(t));
}
export function removeTicket(home: string, t: LeaseTicket) {
  try { unlinkSync(path.join(leaseDir(home, t.resource), ticketName(t.seq))); } catch { /* already gone */ }
  removeTicketJobDir(home, t);
}

/** Queue a request under the same lock used by queued and no-wait grants. */
export async function enqueue(home: string, ticket: Omit<LeaseTicket, "seq">, lock = new OsLock(), options?: LeaseCheckOptions): Promise<LeaseTicket> {
  return (await numbered(home, ticket, false, lock, options)) as LeaseTicket;
}
/** Take the lease now or not at all. Refusal never creates a waiter; the synthetic sequence ranks after equal priority. */
export async function tryGrant(home: string, ticket: Omit<LeaseTicket, "seq" | "grantedAt">, lock = new OsLock(), options?: LeaseCheckOptions): Promise<LeaseTicket | { busy: LeaseTicket[] }> {
  return numbered(home, ticket, true, lock, options);
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
export async function grantQueued(home: string, t: LeaseTicket, lock = new OsLock(), options?: LeaseCheckOptions): Promise<LeaseTicket[]> {
  return locked(home, t.resource, lock, () => {
    const busy = blockers(t, liveTickets(home, t.resource, options));
    if (!busy.length) { t.grantedAt = Date.now(); writeTicketSync(home, t); }
    return busy;
  });
}
async function numbered(home: string, ticket: Omit<LeaseTicket, "seq">, now: boolean, lock: OsLock, options?: LeaseCheckOptions): Promise<LeaseTicket | { busy: LeaseTicket[] }> {
  return locked(home, ticket.resource, lock, async () => {
    const dir = leaseDir(home, ticket.resource), counter = path.join(dir, ".seq");
    const last = Number.parseInt(await readFile(counter, "utf8").catch(() => "0"), 10) || 0;
    const highest = readTickets(home, ticket.resource).reduce((m, t) => Math.max(m, t.seq), last);
    const t: LeaseTicket = { ...ticket, seq: highest + 1 };
    if (now) {
      const busy = blockers(t, liveTickets(home, ticket.resource, options));
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
export function leaseState(home: string, options?: LeaseCheckOptions): LeaseResource[] {
  let resources: string[];
  try { resources = readdirSync(leasesRoot(home)).filter(r => RESOURCE.test(r)).sort(); } catch { return []; }
  return resources.map(resource => {
    const tickets = liveTickets(home, resource, options), holders = tickets.filter(t => t.grantedAt !== undefined), waiters = tickets.filter(t => t.grantedAt === undefined).sort(rank);
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
