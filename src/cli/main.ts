#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { dsaHome } from "../paths.ts";
import { readJournalSnapshot } from "../kernel/journal.ts";
import { journalPath, orchLedger } from "../paths.ts";
import { allWorkflows, eventsFromEntries, formatUsage, renderEvent, statusDetail, statusView, workflowSnapshot, type StatusView, type WorkflowSnapshot, compactWorkflow } from "../orchestrator/snapshot.ts";
import { resolution, start, startOrchestrator, submit, type Control } from "./control.ts";
import { doctor, renderDoctor, size } from "./doctor.ts";
import { smoke } from "./smoke.ts";
import { serviceFiles, manageService, type ServiceRunner } from "./service.ts";

const commands = ["smoke", "tail", "status", "events", "start", "resume", "drain", "stop", "stop-all", "prune", "doctor", "install-service", "uninstall-service", "help"] as const;
type Command = typeof commands[number];
export interface Arguments { command: Command; target?: string; json: boolean; dryRun?: boolean; olderThanDays?: number }
/** P25: Reject ambiguous CLI arguments before any durable action. */
export function parseArgs(args: string[]): Arguments {
  if (!args.length || (args.length === 1 && ["-h", "--help"].includes(args[0]!))) return { command: "help", json: false };
  const command = args[0] as Command;
  if (!commands.includes(command)) throw new Error(`Unknown command: ${command}`);
  let rest = args.slice(1), olderThanDays: number | undefined;
  const at = rest.indexOf("--older-than");
  if (at >= 0) {
    if (command !== "prune") throw new Error("--older-than is only supported by prune");
    const value = rest[at + 1];
    if (value === undefined || !/^\d+(\.\d+)?$/.test(value)) throw new Error("--older-than needs a number of days");
    olderThanDays = Number(value); rest = [...rest.slice(0, at), ...rest.slice(at + 2)];
  }
  const json = rest.includes("--json"), dryRun = rest.includes("--dry-run");
  if (dryRun && !["install-service", "uninstall-service"].includes(command)) throw new Error("--dry-run requires a service command");
  if (json && !["status", "events", "tail", "doctor"].includes(command)) throw new Error("--json is only supported by status, events, tail and doctor");
  if (rest.filter(a => a === "--json").length > 1 || rest.filter(a => a === "--dry-run").length > 1 || rest.some(a => a.startsWith("-") && a !== "--json" && a !== "--dry-run")) throw new Error("Unknown or repeated option");
  const targets = rest.filter(a => a !== "--json" && a !== "--dry-run");
  const optional = ["status", "tail", "resume", "prune"].includes(command);
  const required = command === "stop" || command === "events";
  if (targets.length > (optional || required ? 1 : 0) || (required && targets.length !== 1)) throw new Error(`Invalid arguments for ${command}`);
  const target = targets[0];
  if (target && command !== "stop" && (!/^[^/\\\0]+$/.test(target) || target === "." || target === "..")) throw new Error("Invalid workflow id");
  if (target && olderThanDays !== undefined) throw new Error("prune takes a workflow id or --older-than, not both");
  return { command, json, ...(dryRun ? { dryRun } : {}), ...(target ? { target } : {}), ...(olderThanDays !== undefined ? { olderThanDays } : {}) };
}
const clip = (text: string, n: number) => text.length > n ? `${text.slice(0, n)}…` : text;
/** P25, T10: Render journal-derived status (one line per call, last output line only) without live orchestrator memory. */
export function renderStatus(wf: WorkflowSnapshot & { scriptLog?: string }): string {
  const sealed = wf.counts.sealed, total = wf.calls.length, used = wf.usage && (wf.usage.input || wf.usage.output || wf.usage.costUsd);
  return [`${wf.wid}@${wf.rev}${wf.name ? ` ${wf.name}` : ""}: ${wf.status}${wf.error ? ` (${clip(wf.error, 300)})` : ""} · ${sealed}/${total} sealed${used ? ` · ${formatUsage(wf.usage!)}` : ""}`,
    ...wf.calls.map(c => {
      const last = c.result?.output?.split("\n").map(l => l.trim()).filter(Boolean).at(-1), err = c.result?.error;
      return `  ${c.key}@${c.gen} ${c.result?.status ?? c.phase}${c.model ? ` ${c.model}` : ""}${c.tools ? ` tools:${c.tools}` : ""}${c.usage && (c.usage.input || c.usage.output) ? ` ${formatUsage(c.usage)}` : ""}${last ? ` ${JSON.stringify(clip(last, 160))}` : err ? ` (${clip(err, 160)})` : ""}`;
    }),
    ...wf.attention.map(a => `  ${a.kind}: ${JSON.stringify(clip(a.text, 300))}`),
    ...(wf.scriptLog ? [`  script log: ${wf.scriptLog}`] : [])].join("\n");
}
/** P25, T10: Render the compact status projection shared with the `subagents` tool. */
export function renderView(view: StatusView): string {
  const lines = view.workflows.map(w => [`${w.wid}@${w.rev}${w.name ? ` ${w.name}` : ""}: ${w.status}${w.followUps ? " (follow-up running)" : ""}${w.error ? ` (${clip(w.error, 200)})` : ""} · ${w.done}/${w.planned ?? w.calls.length}${w.planned === undefined && w.status === "running" ? "+" : ""} done${w.usage.input || w.usage.output || w.usage.costUsd ? ` · ${formatUsage(w.usage)}` : ""}`,
    ...w.calls.map(c => `  ${c.key}@${c.gen} ${c.status ?? c.phase}${c.model ? ` ${c.model}` : ""}${c.tools ? ` tools:${c.tools}` : ""}${c.usage ? ` ${formatUsage(c.usage)}` : ""}${c.lastLine ? ` ${JSON.stringify(c.lastLine)}` : c.error ? ` (${c.error})` : ""}`),
    ...w.attention.map(a => `  ${a.kind}: ${JSON.stringify(a.text.split("\n")[0])}`)].join("\n"));
  if (view.paused) lines.unshift(`${view.paused} (pi-durable-subagents resume)`);
  if (view.olderFinished) lines.push(`(+${view.olderFinished} older finished workflows; status <wid> shows one in detail)`);
  return lines.join("\n") || "No workflows";
}
function snapshots(home: string, wid?: string) {
  if (!wid) return allWorkflows(home);
  const snapshot = workflowSnapshot(home, wid);
  if (snapshot.startedAt === undefined) throw new Error(`Unknown workflow: ${wid}`);
  return [snapshot];
}
/** P25: Follow fresh snapshots, emitting only changed human-readable workflow lines. */
export async function tail(home: string, wid: string | undefined, write: (line: string) => void, signal: AbortSignal, interval = 500, json = false): Promise<void> {
  const seen = new Map<string, string>();
  while (!signal.aborted) {
    for (const wf of snapshots(home, wid)) {
      const version = JSON.stringify(wf);
      if (seen.get(wf.wid) !== version) { write(json ? JSON.stringify(compactWorkflow(wf)) : renderStatus(wf)); seen.set(wf.wid, version); }
    }
    try { await delay(interval, undefined, { signal }); } catch (error) { if (!signal.aborted) throw error; }
  }
}
/** P1: A service bound to an npx cache path breaks when the cache is pruned; require a stable install. */
export function serviceEntryError(entry: string): string | undefined {
  if (/[/\\]_npx[/\\]/.test(entry)) return `install-service refuses to run from an npx cache (${entry}); the cache can be pruned and the service would break. Install the CLI with \`npm i -g pi-durable-subagents\` and run \`pi-durable-subagents install-service\` again.`;
  return undefined;
}
export const HELP = "pi-durable-subagents: smoke | status [wid] [--json] | events <wid> [--json] | tail [wid] [--json] | start | resume [wid] | drain | stop <wid|callId> | stop-all | prune [wid] [--older-than <days>] | doctor [--json] | install-service [--dry-run] | uninstall-service [--dry-run] | chaos [--scenario <1-9>] [--keep] [--json]";
/** P1, P21, P25, P38: Dispatch the public CLI using durable requests and read-only snapshots. */
export async function main(args = process.argv.slice(2), options: { env?: NodeJS.ProcessEnv; write?: (line: string) => void; signal?: AbortSignal; serviceRunner?: ServiceRunner; starter?: typeof startOrchestrator; entry?: string; waitMs?: number; now?: number } = {}): Promise<number> {
  if (args[0] === "chaos") return (await import("./chaos/index.ts")).chaos(args.slice(1), options.env ?? process.env, options.write);
  const { command, target, json, dryRun, olderThanDays } = parseArgs(args), env = options.env ?? process.env;
  const home = dsaHome(env), write = options.write ?? (line => console.log(line));
  if (command === "help") { write(HELP); return 0; }
  // Quiet when idle: the optional service runs this every K1 and must not fill the system log.
  if (command === "start") { if (await start(home, env, options.starter)) write("start: work pending; orchestrator started unless already running"); return 0; }
  if (command === "smoke") {
    const report = await smoke(env);
    for (const [domain, checks] of [["execution", report.execution], ["UI", report.ui]] as const)
      for (const check of checks) write(`${domain} ${check.ok ? "ok" : domain === "UI" ? "degraded" : "FAILED"}: ${check.name}: ${check.detail}`);
    write(`Containment assurance: ${report.gap}`);
    return report.execution.every(c => c.ok) ? 0 : 1;
  }
  if (command === "status") {
    if (target) { const detail = statusDetail(home, target); write(json ? JSON.stringify(detail, null, 2) : renderStatus(detail)); }
    else { const view = statusView(home); write(json ? JSON.stringify(view, null, 2) : renderView(view)); }
    return 0;
  }
  if (command === "events") {
    statusDetail(home, target!); // Unknown workflow -> error before printing anything.
    const events = eventsFromEntries(readJournalSnapshot(journalPath(home, target!)));
    for (const e of events) write(json ? JSON.stringify(e) : renderEvent(e));
    return 0;
  }
  if (command === "tail") {
    const controller = new AbortController(), stop = () => controller.abort();
    if (!options.signal) { process.once("SIGINT", stop); process.once("SIGTERM", stop); }
    try { await tail(home, target, write, options.signal ?? controller.signal, 500, json); }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    return 0;
  }
  if (command === "install-service" || command === "uninstall-service") {
    const entry = options.entry ?? fileURLToPath(import.meta.url), refused = command === "install-service" ? serviceEntryError(entry) : undefined;
    if (refused) { (options.write ?? (line => console.error(line)))(refused); return 1; }
    const files = serviceFiles(env.HOME ?? homedir(), home, entry);
    await manageService(files, command === "install-service", { dryRun, runner: options.serviceRunner, write });
    files.forEach(f => write(`${command}: ${f.path}`));
    return 0;
  }
  if (command === "doctor") {
    const report = await doctor(home, env, options.now);
    write(json ? JSON.stringify(report, null, 2) : renderDoctor(report));
    return report.findings.length ? 1 : 0;
  }
  if (command === "prune") {
    const [req] = await submit(home, "prune", target, env, { olderThanDays });
    const waitMs = options.waitMs ?? 60_000, outcome = await resolution(home, req!.rid, waitMs);
    if (!outcome) { write(`submitted prune ${req!.rid}; not resolved within ${Math.round(waitMs / 1000)} s (is the orchestrator running? see: pi-durable-subagents doctor)`); return 1; }
    if (outcome.type === "rejected") { write(`prune rejected: ${outcome.reason}`); return 1; }
    const pruned = readJournalSnapshot(orchLedger(home)).filter(e => e.type === "pruned" && e.rid === req!.rid);
    write(`pruned ${pruned.length} workflow${pruned.length === 1 ? "" : "s"}, freed ${size(pruned.reduce((n, e) => n + (Number(e.bytes) || 0), 0))}`);
    for (const e of pruned) write(`  ${String(e.wid)}`);
    return 0;
  }
  for (const req of await submit(home, command as Control, target, env)) write(`submitted ${req.kind} ${req.rid}`);
  return 0;
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => { console.error(`pi-durable-subagents: ${String(error)}`); process.exitCode = 1; });
}
