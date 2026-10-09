#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { dsaHome } from "../paths.ts";
import { readJournalSnapshot } from "../kernel/journal.ts";
import { journalPath, orchLedger } from "../paths.ts";
import { allWorkflows, eventsFromEntries, formatUsage, renderEvent, statusDetail, statusView, workflowSnapshot, type StatusView, type WorkflowSnapshot, compactWorkflow, labelsText, outputSelect, statusCompactDetail, type StatusCompactDetail } from "../orchestrator/snapshot.ts";
import { resolution, start, startOrchestrator, submit, type Control } from "./control.ts";
import { doctor, renderDoctor, size } from "./doctor.ts";
import { smoke } from "./smoke.ts";
import { serviceFiles, manageService, type ServiceRunner } from "./service.ts";
import { leaseLines, leaseState } from "../platform/lease.ts";
import { currentOrchestrator, decidedBy, legacyRestart, cliInitiator, waitExit, waitSuccessor } from "./restart.ts";
import { restartInputError } from "../orchestrator/restart.ts";
import type { RestartBody } from "../types.ts";

const commands = ["smoke", "tail", "status", "events", "start", "resume", "drain", "stop", "stop-all", "prune", "restart", "leases", "doctor", "install-service", "uninstall-service", "help"] as const;
type Command = typeof commands[number];
export interface Arguments { command: Command; target?: string; json: boolean; dryRun?: boolean; olderThanDays?: number; force?: string | true; reason?: string; tail?: number; grep?: string }
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
  let force: string | true | undefined, reason: string | undefined, tail: number | undefined, grep: string | undefined;
  for (const flag of ["--tail", "--grep"]) {
    const index = rest.indexOf(flag);
    if (index < 0) continue;
    if (command !== "status") throw new Error(`${flag} is only supported by status <wid>`);
    if (rest.filter(a => a === flag).length > 1) throw new Error("Unknown or repeated option");
    const value = rest[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--tail") { if (!/^[1-9]\d*$/.test(value)) throw new Error("--tail needs a positive number of lines"); tail = Number(value); }
    else grep = value;
    rest = [...rest.slice(0, index), ...rest.slice(index + 2)];
  }
  for (const flag of ["--force", "--reason"]) {
    const index = rest.indexOf(flag);
    if (index < 0) continue;
    if (command !== "restart") throw new Error(`${flag} is only supported by restart`);
    if (rest.filter(a => a === flag).length > 1) throw new Error("Unknown or repeated option");
    const value = rest[index + 1], present = value !== undefined && !value.startsWith("--");
    if (flag === "--force") force = present ? value : true;
    else { if (!present) throw new Error("--reason needs text"); reason = value; }
    rest = [...rest.slice(0, index), ...rest.slice(index + (present ? 2 : 1))];
  }
  const json = rest.includes("--json"), dryRun = rest.includes("--dry-run");
  if (dryRun && !["install-service", "uninstall-service"].includes(command)) throw new Error("--dry-run requires a service command");
  if (json && !["status", "events", "tail", "doctor", "leases"].includes(command)) throw new Error("--json is only supported by status, events, tail, leases and doctor");
  if (rest.filter(a => a === "--json").length > 1 || rest.filter(a => a === "--dry-run").length > 1 || rest.some(a => a.startsWith("-") && a !== "--json" && a !== "--dry-run")) throw new Error("Unknown or repeated option");
  const targets = rest.filter(a => a !== "--json" && a !== "--dry-run");
  const optional = ["status", "tail", "resume", "prune"].includes(command);
  const required = command === "stop" || command === "events";
  if (targets.length > (optional || required ? 1 : 0) || (required && targets.length !== 1)) throw new Error(`Invalid arguments for ${command}`);
  const target = targets[0];
  if (target && command !== "stop" && (!/^[^/\\\0]+$/.test(target) || target === "." || target === "..")) throw new Error("Invalid workflow id");
  if (target && olderThanDays !== undefined) throw new Error("prune takes a workflow id or --older-than, not both");
  if ((tail !== undefined || grep !== undefined) && !target) throw new Error("--tail and --grep select lines of one workflow's outputs: status <wid> --tail <n> --grep <regex>");
  if (grep !== undefined) outputSelect(undefined, grep); // an invalid regular expression is a usage error
  return { command, json, ...(tail !== undefined ? { tail } : {}), ...(grep !== undefined ? { grep } : {}), ...(force !== undefined ? { force } : {}), ...(reason !== undefined ? { reason } : {}), ...(dryRun ? { dryRun } : {}), ...(target ? { target } : {}), ...(olderThanDays !== undefined ? { olderThanDays } : {}) };
}
const clip = (text: string, n: number) => text.length > n ? `${text.slice(0, n)}…` : text;
/** Notes recorded for a call that is not running (send kind "notify"); its next follow-up carries them. */
const notesLine = (n?: number) => n ? ` · ${n} note${n > 1 ? "s" : ""} pending` : "";
/** P25, T10: Render journal-derived status (one line per call, last output line only) without live orchestrator memory. */
export function renderStatus(wf: WorkflowSnapshot & { scriptLog?: string }): string {
  const sealed = wf.counts.sealed, total = wf.calls.length, used = wf.usage && (wf.usage.input || wf.usage.output || wf.usage.costUsd);
  return [`${wf.wid}@${wf.rev}${wf.labels ? ` ${labelsText(wf.labels)}` : ""}${wf.name ? ` ${wf.name}` : ""}: ${wf.status}${wf.error ? ` (${clip(wf.error, 300)})` : ""} · ${sealed}/${total} sealed${used ? ` · ${formatUsage(wf.usage!)}` : ""}`,
    ...wf.calls.map(c => {
      const last = c.result?.output?.split("\n").map(l => l.trim()).filter(Boolean).at(-1), err = c.result?.error;
      return `  ${c.key}@${c.gen} ${c.result?.status ?? c.phase}${c.model ? ` ${c.model}` : ""}${c.tools ? ` tools:${c.tools}` : ""}${c.usage && (c.usage.input || c.usage.output) ? ` ${formatUsage(c.usage)}` : ""}${last ? ` ${JSON.stringify(clip(last, 160))}` : err ? ` (${clip(err, 160)})` : ""}${c.sharedWorktree ? ` (shares worktree with ${c.sharedWorktree.join(", ")})` : ""}${c.writerWait && !c.result && c.phase !== "sealed" ? ` (waiting for writer lock: ${c.writerWait.root} held by ${c.writerWait.holder})` : ""}${notesLine(c.notesPending)}`;
    }),
    ...wf.attention.map(a => `  ${a.kind}: ${JSON.stringify(clip(a.text, 300))}`),
    ...(wf.scriptLog ? [`  script log: ${wf.scriptLog}`] : [])].join("\n");
}
/** `status <wid> --tail/--grep`: the workflow line, then each call with its selected output lines. */
export function renderSelected(wf: StatusCompactDetail): string {
  return [`${wf.wid}@${wf.rev}${wf.labels ? ` ${labelsText(wf.labels)}` : ""}${wf.name ? ` ${wf.name}` : ""}: ${wf.status} · ${wf.done}/${wf.planned ?? wf.calls.length} done`,
    ...wf.calls.flatMap(c => [`  ${c.key}@${c.gen} ${c.status ?? c.phase}`, ...(c.output ? c.output.split("\n").map(l => `    | ${l}`) : [])])].join("\n");
}
/** P25, T10: Render the compact status projection shared with the `subagents` tool. */
export function renderView(view: StatusView): string {
  const lines = view.workflows.map(w => [`${w.wid}@${w.rev}${w.labels ? ` ${labelsText(w.labels)}` : ""}${w.name ? ` ${w.name}` : ""}: ${w.status}${w.followUps ? " (follow-up running)" : ""}${w.error ? ` (${clip(w.error, 200)})` : ""} · ${w.done}/${w.planned ?? w.calls.length}${w.planned === undefined && w.status === "running" ? "+" : ""} done${w.usage.input || w.usage.output || w.usage.costUsd ? ` · ${formatUsage(w.usage)}` : ""}`,
    ...w.calls.map(c => `  ${c.key}@${c.gen} ${c.status ?? c.phase}${c.hibernated ? " (hibernated, no slot)" : ""}${c.model ? ` ${c.model}` : ""}${c.switching ? ` → ${c.switching} (requested)` : ""}${c.switchFailed ? ` (switch refused: ${c.switchFailed})` : ""}${c.tools ? ` tools:${c.tools}` : ""}${c.usage ? ` ${formatUsage(c.usage)}` : ""}${c.lastLine ? ` ${JSON.stringify(c.lastLine)}` : c.error ? ` (${c.error})` : ""}${c.sharedWorktree ? ` (shares worktree with ${c.sharedWorktree.join(", ")})` : ""}${c.writerWait && c.phase !== "sealed" ? ` (waiting for writer lock: ${c.writerWait.root} held by ${c.writerWait.holder})` : ""}${c.lease && c.phase !== "sealed" ? ` (${c.lease})` : ""}${notesLine(c.notesPending)}`),
    ...w.attention.map(a => `  ${a.kind}: ${JSON.stringify(a.text.split("\n")[0])}`)].join("\n"));
  if (view.paused) lines.unshift(`${view.paused} (pi-durable-subagents resume)`);
  if (view.olderFinished) lines.push(`(+${view.olderFinished} older finished workflows; status <wid> shows one in detail)`);
  const footer = [view.slots?.length ? `slots: ${view.slots.join(", ")}` : "", view.config ? `config: ${view.config}` : "", view.configRejected ? `config.json rejected: ${view.configRejected}` : "", view.orchestrator ? `orchestrator: ${view.orchestrator}` : "", ...(view.leases ?? []).map(l => `lease: ${l}`), ...(view.exhausted ?? []), view.versionNote ? `note: ${view.versionNote}` : ""].filter(Boolean);
  if (!lines.length) lines.push("No workflows");
  return [...lines, ...footer].join("\n");
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
export const HELP = "pi-durable-subagents: smoke | status [wid] [--json] | status <wid> [--tail <n>] [--grep <regex>] [--json] | events <wid> [--json] | events --all [--since <cursor>] [--limit <n>] [--json] [--wait-ms <n>] | tail [wid] [--json] | start | resume [wid] | drain | stop <wid|callId> | stop-all | run --request <id> --spec <file|-> [--labels <json>] [--cwd <dir>] [--json] [--wait-ms <n>] | send --request <id> --to <run-id|wid/key> [--to ...] [--call <key>] --kind follow-up|answer|steer|notify|model [--qid <qid> --rev <n>] [--message <text|@file>] [--model <m>] [--json] [--wait-ms <n>] | stop --request <id> <run-id|wid|wid/key> [--json] [--wait-ms <n>] | describe --key <id> | describe <wid> [--json] | prune [wid] [--older-than <days>] | restart [--force <token> --reason <text>] | hold <resource> [--shared | --slots <n>] [--max-wait <s> | --no-wait] [--note <text>] -- <command…> | leases [--json] | doctor [--json] | install-service [--dry-run] | uninstall-service [--dry-run] | chaos [--scenario <1-9>] [--keep] [--json] | drill failover [--keep] [--json]";
/** Restart: the orchestrator exits when no execution runs (or `force`) and the installed version takes over. */
async function restartCommand(home: string, env: NodeJS.ProcessEnv, write: (line: string) => void, options: { force?: string | true; reason?: string; starter?: typeof startOrchestrator; waitMs?: number; pendingMs?: number }): Promise<number> {
  const body: RestartBody = { ...(typeof options.force === "string" ? { token: options.force } : options.force === true ? { force: true } : {}), ...(options.reason !== undefined ? { reason: options.reason } : {}), initiator: cliInitiator(env) };
  const invalid = restartInputError(body, env.DSA_EXEC !== undefined);
  if (invalid) { write(`restart refused: ${invalid}`); return 1; }
  const starter = options.starter ?? startOrchestrator;
  let old = currentOrchestrator(home);
  if (!old) {
    write(await start(home, env, starter) ? "restart: no orchestrator was running; started one for the pending work" : "restart: no orchestrator is running (one starts when work is submitted)");
    return 0;
  }
  const waitMs = options.waitMs ?? 30_000;
  if (!old.restart) {
    // An orchestrator older than the restart request: check its journals here and end it with SIGTERM.
    const legacy = legacyRestart(home, old, body, { subagent: env.DSA_EXEC !== undefined });
    if (!legacy.applied) { write(`restart refused: ${legacy.reason}`); return 1; }
  } else {
    const [req] = await submit(home, "restart", undefined, env, { restart: body });
    // The orchestrator reads requests only after recovering its workflows (it may itself have just started): keep
    // waiting while one runs. An undecided request stays durable and is decided later — say so, never resubmit.
    let outcome = await resolution(home, req!.rid, waitMs);
    if (!outcome && currentOrchestrator(home)) {
      write(`restart ${req!.rid}: submitted; the orchestrator has not reached it yet (it may still be recovering) — waiting`);
      const deadline = performance.now() + (options.pendingMs ?? 600_000);
      while (!outcome && currentOrchestrator(home) && performance.now() < deadline) outcome = await resolution(home, req!.rid, Math.min(waitMs, 5_000));
    }
    if (!outcome) { write(`restart ${req!.rid} is still pending: it is decided when an orchestrator reaches it (do not resubmit; see: pi-durable-subagents status)`); return 75; }
    if (outcome.type === "rejected") { write(`restart refused: ${outcome.reason}`); return 1; }
    old = decidedBy(home, req!.rid) ?? old;
  }
  if (!await waitExit(old, Math.max(waitMs, 60_000))) { write(`restart: orchestrator ${old.version} (pid ${old.pid}) is still shutting down; see: pi-durable-subagents status`); return 1; }
  await starter(home, env);
  const next = await waitSuccessor(home, old, 15_000);
  write(next ? `restarted: orchestrator ${old.version} (pid ${old.pid}) → ${next.version} (pid ${next.pid})` : `restart: orchestrator ${old.version} (pid ${old.pid}) exited; the next one starts when work is pending`);
  return 0;
}
/** P1, P21, P25, P38: Dispatch the public CLI using durable requests and read-only snapshots. */
export async function main(args = process.argv.slice(2), options: { env?: NodeJS.ProcessEnv; write?: (line: string) => void; signal?: AbortSignal; serviceRunner?: ServiceRunner; starter?: typeof startOrchestrator; entry?: string; waitMs?: number; pendingMs?: number; now?: number; cwd?: string; stdin?: () => Promise<string> } = {}): Promise<number> {
  if (args[0] === "hold") { const { hold, parseHold } = await import("./hold.ts"); return hold(parseHold(args.slice(1)), { env: options.env ?? process.env }); }
  if (args[0] === "chaos") return (await import("./chaos/index.ts")).chaos(args.slice(1), options.env ?? process.env, options.write);
  if (args[0] === "drill") return (await import("./drill/index.ts")).drill(args.slice(1), options.env ?? process.env, options.write);
  // The cross-workflow event log (strict flags of its own); `events <wid>` stays below.
  if (args[0] === "events" && args.includes("--all")) {
    const env = options.env ?? process.env;
    return (await import("../events/cli.ts")).eventsAll(args.slice(1), { home: dsaHome(env), env, write: options.write ?? ((line: string) => console.log(line)), starter: options.starter ?? startOrchestrator, waitMs: options.waitMs });
  }
  // Program-facing commands named by request ids (strict flags of their own).
  if (["run", "send", "describe"].includes(args[0]!) || (args[0] === "stop" && args.includes("--request"))) {
    const env = options.env ?? process.env, requests = await import("./requests.ts");
    const ctx = { home: dsaHome(env), env, write: options.write ?? ((line: string) => console.log(line)), starter: options.starter, waitMs: options.waitMs, cwd: options.cwd, stdin: options.stdin };
    return args[0] === "run" ? requests.runCommand(args.slice(1), ctx) : args[0] === "send" ? requests.sendCommand(args.slice(1), ctx)
      : args[0] === "stop" ? requests.stopCommand(args.slice(1), ctx) : requests.describeCommand(args.slice(1), ctx);
  }
  const { command, target, json, dryRun, olderThanDays, force, reason, tail: lines, grep } = parseArgs(args), env = options.env ?? process.env;
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
    const select = outputSelect(lines, grep);
    if (target && select) { const detail = statusCompactDetail(home, target, select); write(json ? JSON.stringify(detail, null, 2) : renderSelected(detail)); }
    else if (target) { const detail = statusDetail(home, target); write(json ? JSON.stringify(detail, null, 2) : renderStatus(detail)); }
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
  if (command === "leases") {
    const state = leaseState(home);
    write(json ? JSON.stringify(state, null, 2) : state.length ? leaseLines(state).join("\n") : "No leases held or waited for");
    return 0;
  }
  if (command === "restart") return restartCommand(home, env, write, { force, reason, starter: options.starter, waitMs: options.waitMs, pendingMs: options.pendingMs });
  for (const req of await submit(home, command as Control, target, env)) write(`submitted ${req.kind} ${req.rid}`);
  return 0;
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => { console.error(`pi-durable-subagents: ${String(error)}`); process.exitCode = 1; });
}
