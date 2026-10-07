// Read-only health check of DSA_HOME (housekeeping). Never writes, never sends a request; the only side effect is a
// non-blocking probe of the orchestrator lock (as the starter does) when the lock file exists.
import { existsSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJournalSnapshot } from "../kernel/journal.ts";
import { reduceLifecycle, type DecisionRecord } from "../kernel/lifecycle.ts";
import { scanInbox } from "../kernel/mailbox.ts";
import { OsLock } from "../platform/lock.ts";
import { journalPath, orchInbox, orchLedger, orchLock } from "../paths.ts";
import { snapshotFromEntries } from "../orchestrator/snapshot.ts";
import { diskUsage } from "../orchestrator/store.ts";
import { JT, isEntry } from "../types.ts";
import { serviceFiles } from "./service.ts";

const HOUR = 3_600_000, DAY = 24 * HOUR, CLI = "pi-durable-subagents";
export interface Finding { kind: "parked" | "fence-failed" | "orphan-staging" | "tmp-file"; detail: string; command: string }
export interface DoctorReport {
  home: string; bytes: number;
  workflows: Record<string, number>;
  ledger: { entries: number; bytes: number };
  largestJournals: { wid: string; bytes: number }[];
  parked: { wid: string; ageMs: number }[];
  attention: { wid: string; id: string; kind: string; ageMs: number }[];
  fenceFailed: { wid: string; exec: string; ageMs: number }[];
  orphanStaging: string[];
  tmpFiles: string[];
  orchestrator: "running" | "not running" | "unknown";
  service: "installed" | "not installed" | "unavailable";
  findings: Finding[];
}
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const names = async (dir: string) => readdir(dir).catch(error => { if (error.code === "ENOENT") return [] as string[]; throw error; });
async function tmpFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const name of await names(dir)) {
    const path = join(dir, name), info = await lstat(path).catch(() => undefined);
    if (info?.isDirectory()) await tmpFiles(path, out);
    else if (/^\..*\.tmp$/.test(name)) out.push(path);
  }
  return out;
}
async function lockHeld(home: string): Promise<DoctorReport["orchestrator"]> {
  if (!existsSync(orchLock(home))) return "not running";
  try { const lock = await new OsLock().tryAcquire(orchLock(home)); if (!lock) return "running"; await lock.release(); return "not running"; }
  catch { return "unknown"; }
}
/** C2: The command that lists the processes still tagged with an execution identity. */
const stuckProcesses = (exec: string) => process.platform === "linux" ? `grep -lsz ${quote(`DSA_EXEC=${exec}`)} /proc/*/environ` : `ps -Eww -o pid,command | grep -F ${quote(`DSA_EXEC=${exec}`)}`;

/** Housekeeping: Collect DSA_HOME health facts read-only; `findings` lists only actionable ones, one command each. */
export async function doctor(home: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<DoctorReport> {
  const ledger = readJournalSnapshot(orchLedger(home));
  const pruned = new Set(ledger.filter(e => e.type === "pruned").map(e => String(e.wid)));
  const report: DoctorReport = { home, bytes: await diskUsage(home), workflows: {}, ledger: { entries: ledger.length, bytes: await diskUsage(orchLedger(home)) },
    largestJournals: [], parked: [], attention: [], fenceFailed: [], orphanStaging: [], tmpFiles: [], orchestrator: await lockHeld(home), service: "unavailable", findings: [] };
  const journals: { wid: string; bytes: number }[] = [];
  for (const wid of (await names(join(home, "w"))).filter(n => !n.startsWith(".") && !pruned.has(n)).sort()) {
    const entries = readJournalSnapshot(journalPath(home, wid)), snap = snapshotFromEntries(wid, entries);
    report.workflows[snap.status] = (report.workflows[snap.status] ?? 0) + 1;
    journals.push({ wid, bytes: await diskUsage(journalPath(home, wid)) });
    if (snap.status === "parked") {
      const ageMs = now - (snap.endedAt ?? now);
      report.parked.push({ wid, ageMs });
      if (ageMs > DAY) report.findings.push({ kind: "parked", detail: `${wid} parked for ${age(ageMs)}`, command: `${CLI} resume ${wid}` });
    }
    // Finished notices are delivered to the origin session and stay open in the journal by design: not counted.
    const resolved = new Set(entries.filter(e => e.type === JT.attentionResolved).map(e => `${e.id}@${e.rev}`));
    for (const e of entries) {
      const item = isEntry(e, JT.attention) ? e.item : undefined;
      if (item && item.kind !== "finished" && !resolved.has(`${item.id}@${item.rev}`) && now - e.ts > HOUR)
        report.attention.push({ wid, id: item.id, kind: item.kind, ageMs: now - e.ts });
      if (e.type !== "fence-failed") continue;
      const exec = String(e.exec);
      if (entries.some(r => r.seq > e.seq && ((r.type === JT.fenced && r.exec === exec) || (r.type === "gate" && r.id === exec) || (r.type === JT.attentionResolved && r.id === `fence:${exec}`)))) continue;
      report.fenceFailed.push({ wid, exec, ageMs: now - e.ts });
      report.findings.push({ kind: "fence-failed", detail: `${exec}: processes did not exit after SIGKILL (${String(e.error ?? "")})`, command: stuckProcesses(exec) });
    }
  }
  report.largestJournals = journals.sort((a, b) => b.bytes - a.bytes || (a.wid < b.wid ? -1 : 1)).slice(0, 5);
  // A staging dir belongs to a request in the inbox, an admitted unresolved request, or a live workflow's intent.
  // Read in publication order (staging, then inbox, then the ledger again): staging is written before admission and an
  // inbox file is removed only after its resolution, so a request that completes during this scan is never an orphan.
  const staged = (await names(join(home, "staging"))).filter(n => !n.startsWith(".")).sort();
  const inbox = await scanInbox(orchInbox(home), () => {}), fresh = readJournalSnapshot(orchLedger(home));
  const view = reduceLifecycle(fresh.filter(e => [JT.admitted, JT.applied, JT.rejected, JT.withdrawn].includes(e.type as typeof JT.admitted)) as unknown as DecisionRecord[]);
  const owners = new Set([...inbox.map(r => r.rid), ...[...view.admitted.keys()].filter(rid => !view.resolved.has(rid)),
    ...fresh.filter(e => (e.type === "create-intent" || e.type === "revise-intent") && !pruned.has(String(e.wid))).map(e => String(e.rid))]);
  for (const name of staged) {
    let rid: string; try { rid = decodeURIComponent(name); } catch { rid = name; }
    if (owners.has(rid)) continue;
    const dir = join(home, "staging", name);
    report.orphanStaging.push(dir);
    report.findings.push({ kind: "orphan-staging", detail: `${dir} has no pending request`, command: `rm -rf ${quote(dir)}` });
  }
  for (const file of await tmpFiles(home)) {
    report.tmpFiles.push(file);
    report.findings.push({ kind: "tmp-file", detail: `${file} is a leftover partial write`, command: `rm -f ${quote(file)}` });
  }
  try { report.service = serviceFiles(env.HOME ?? homedir(), home, "").every(f => existsSync(f.path)) ? "installed" : "not installed"; } catch { report.service = "unavailable"; }
  return report;
}

/** Housekeeping: Human-readable byte count. */
export function size(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return i ? `${n.toFixed(1)} ${units[i]}` : `${n} B`;
}
/** Housekeeping: Human-readable age, e.g. "2d 3h", "5h 12m", "40m". */
export function age(ms: number): string {
  const m = Math.floor(ms / 60_000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
}
/** Housekeeping: Render the report; one suggested command per actionable finding. */
export function renderDoctor(r: DoctorReport): string {
  const counts = Object.entries(r.workflows).sort(([a], [b]) => a < b ? -1 : 1);
  const total = counts.reduce((n, [, c]) => n + c, 0);
  const list = <T>(title: string, items: T[], line: (item: T) => string) => items.length ? [`${title}:`, ...items.map(i => `  ${line(i)}`)] : [`${title}: none`];
  return [
    `DSA_HOME ${r.home}: ${size(r.bytes)}`,
    `workflows: ${total ? `${counts.map(([s, c]) => `${c} ${s}`).join(", ")} (${total} total)` : "none"}`,
    `orchestrator.jsonl: ${r.ledger.entries} entries, ${size(r.ledger.bytes)}`,
    ...list("largest journals", r.largestJournals, j => `${j.wid} ${size(j.bytes)}`),
    ...list("parked", r.parked, p => `${p.wid} ${age(p.ageMs)}`),
    ...list("open attention older than 1h", r.attention, a => `${a.wid} ${a.kind} ${a.id} ${age(a.ageMs)}`),
    ...list("unresolved fence failures", r.fenceFailed, f => `${f.wid} ${f.exec} ${age(f.ageMs)}`),
    ...list("orphan staging", r.orphanStaging, s => s),
    ...list("leftover tmp files", r.tmpFiles, s => s),
    `orchestrator: ${r.orchestrator === "running" ? "running (holds the lock)" : r.orchestrator}`,
    `service: ${r.service}`,
    ...(r.findings.length ? [`${r.findings.length} actionable finding(s):`, ...r.findings.flatMap(f => [`  ${f.kind}: ${f.detail}`, `    ${f.command}`])] : ["nothing actionable"]),
  ].join("\n");
}
