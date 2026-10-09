// R1–R4: Program-facing commands named by caller-chosen request ids — `run|send|stop --request <id>` and `describe`.
// Exit codes: 0 decided (applied/created), 1 rejected or invalid, 3 request-conflict (the id names other content),
// 75 not decided within --wait-ms (retry with the same id and content: safe).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readJournalSnapshot } from "../kernel/journal.ts";
import { reduceLifecycle, type DecisionRecord } from "../kernel/lifecycle.ts";
import { journalPath, orchLedger } from "../paths.ts";
import { findRequest, REQUEST_ID, requestId, requestRid, RequestsBusy, specDigest, type Identified } from "../requests.ts";
import { isLive, slotsView, workflowSnapshot, type CallSnapshot } from "../orchestrator/snapshot.ts";
import { leaseCalls, leaseState } from "../platform/lease.ts";
import { checkAgents, request } from "../agent/main/tool.ts";
import { discoverAgents } from "../compat/agents.ts";
import { JT, type CallResult, type Entry, type Request, type RunBody } from "../types.ts";
import { startOrchestrator, submitIdentified } from "./control.ts";

export const EXIT = { ok: 0, rejected: 1, conflict: 3, pending: 75 } as const;
export interface Context { home: string; env: NodeJS.ProcessEnv; write: (line: string) => void; starter?: typeof startOrchestrator; waitMs?: number; cwd?: string; stdin?: () => Promise<string> }
type Flags = Record<string, string | true>;
type Sent = Extract<Identified, { sent: boolean }>;

/** Strict `--name value` / `--flag` parsing; unknown or repeated options are errors. */
function flags(args: string[], spec: Record<string, "value" | "flag">): { values: Flags; positionals: string[] } {
  const values: Flags = {}, positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    const name = arg.slice(2), kind = spec[name];
    if (!kind || Object.hasOwn(values, name)) throw new Error(`Unknown or repeated option ${arg}`);
    if (kind === "flag") { values[name] = true; continue; }
    const value = args[++i];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    values[name] = value;
  }
  return { values, positionals };
}
const text = (values: Flags, name: string): string | undefined => typeof values[name] === "string" ? values[name] as string : undefined;
function waitMs(values: Flags, ctx: Context): number {
  const raw = text(values, "wait-ms");
  if (raw !== undefined && !/^\d+$/.test(raw)) throw new Error("--wait-ms needs a non-negative integer");
  return raw !== undefined ? Number(raw) : ctx.waitMs ?? 60_000;
}
function ledger(home: string): Entry[] { return readJournalSnapshot(orchLedger(home)) as Entry[]; }
function decision(entries: readonly Entry[], rid: string) {
  const records = entries.filter(e => [JT.admitted, JT.applied, JT.rejected, JT.withdrawn].includes(e.type as typeof JT.admitted)) as unknown as DecisionRecord[];
  return reduceLifecycle(records).resolved.get(rid);
}
const createdBy = (entries: readonly Entry[], rid: string) => entries.find(e => e.type === JT.created && e.rid === rid);
async function stdin(): Promise<string> { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(chunk as Buffer); return Buffer.concat(chunks).toString("utf8"); }

// ---------------------------------------------------------------------------------------------------------------------
// describe (R3): read-only from the journals; never starts the orchestrator.
// ---------------------------------------------------------------------------------------------------------------------
export type DescribeState = "absent" | "pending" | "rejected" | "running" | "asking" | "sealed" | "pruned" | "applied";
export interface DescribedCall {
  key: string; gen: number; phase: CallSnapshot["phase"]; agent: string; model?: string;
  status?: CallResult["status"]; ok?: boolean; error?: string; output?: string; data?: unknown;
  /** Unsealed calls: why they wait — writer lock, resource lease, the provider's slot use and exhaustion (as `status`). */
  waiting?: { writerWait?: { root: string; holder: string }; lease?: string; slot?: string; exhausted?: string; hibernated?: true };
}
export interface Description {
  state: DescribeState; request?: string; kind?: string; wid?: string; spec_digest?: string; reason?: string;
  status?: string; error?: string; pruned?: { status?: string; endedAt?: number };
  calls?: DescribedCall[];
  questions?: { qid?: string; rev: number; to: string; call?: string; text: string }[];
  attention?: { id: string; rev: number; kind: string; call?: string; text: string }[];
  lastFence?: { at: number; exec: string; reason: "restart-force" | "orchestrator-crash" | "process-died" };
}
/** R3: The state of a request id (`{request}`) or a workflow (`{wid}`), with full texts (no clipping). */
export async function describe(home: string, key: { request: string } | { wid: string }, now = Date.now()): Promise<Description> {
  const entries = ledger(home);
  if ("wid" in key) return describeWorkflow(home, key.wid, entries, now);
  const rid = requestRid(key.request), found = await findRequest(home, rid);
  if (!found) return { state: "absent", request: key.request };
  const head = { request: key.request, kind: found.request.kind, spec_digest: specDigest(found.request) };
  const decided = decision(entries, rid), created = createdBy(entries, rid);
  if (found.request.kind === "run" && created) return { ...await describeWorkflow(home, String(created.wid), entries, now), ...head };
  if (decided?.type === "rejected") return { state: "rejected", ...head, reason: String(decided.reason) };
  // A send or stop has no workflow of its own: its decision is the outcome.
  if (decided && found.request.kind !== "run") return { state: "applied", ...head };
  return { state: "pending", ...head };
}
function describeWorkflow(home: string, wid: string, entries: readonly Entry[], now: number): Description {
  const pruned = entries.find(e => e.type === "pruned" && e.wid === wid);
  if (pruned) return { state: "pruned", wid, pruned: { ...(pruned.status !== undefined ? { status: String(pruned.status) } : {}), endedAt: Number(pruned.endedAt) },
    ...(typeof pruned.request === "string" ? { request: pruned.request } : {}), ...(typeof pruned.spec_digest === "string" ? { spec_digest: pruned.spec_digest } : {}) };
  if (!/^[^/\\\0]+$/.test(wid) || wid === "." || wid === ".." || !existsSync(journalPath(home, wid))) return { state: "absent", wid };
  const wf = workflowSnapshot(home, wid), journal = readJournalSnapshot(journalPath(home, wid)) as Entry[];
  const created = entries.find(e => e.type === JT.created && e.wid === wid), id = created ? requestId(String(created.rid)) : undefined;
  const admitted = id ? entries.find(e => e.type === "request" && (e.request as Request).rid === created!.rid)?.request as Request | undefined : undefined;
  const slots = slotsView(home, now), leases = leaseCalls(leaseState(home), now);
  const line = (lines: string[] | undefined, model?: string) => { const provider = model?.split("/")[0]; return provider ? lines?.find(l => l.startsWith(`${provider} `)) : undefined; };
  const latest = [...new Map(wf.calls.map(c => [c.key, c] as const)).values()];
  const calls = latest.map((c): DescribedCall => {
    const r = c.result, waiting = r ? undefined : {
      ...(c.writerWait ? { writerWait: c.writerWait } : {}), ...(leases.get(c.callId) ? { lease: leases.get(c.callId) } : {}),
      ...(line(slots.slots, c.model) ? { slot: line(slots.slots, c.model) } : {}), ...(line(slots.exhausted, c.model) ? { exhausted: line(slots.exhausted, c.model) } : {}),
      ...(c.hibernated ? { hibernated: true as const } : {}) };
    return { key: c.key, gen: c.gen, phase: c.phase, agent: c.agent, ...(c.model ? { model: c.model } : {}),
      ...(r ? { status: r.status, ok: r.ok, ...(r.error ? { error: r.error } : {}), output: r.output, ...(r.data !== undefined ? { data: r.data } : {}) } : {}),
      ...(waiting && Object.keys(waiting).length ? { waiting } : {}) };
  });
  const keyOf = (call?: string) => call?.replace(/^[^/]*\//, "").replace(/@\d+$/, "");
  const questions = wf.attention.filter(a => a.kind === "question").map(a => ({ ...(a.qid ? { qid: a.qid } : {}), rev: a.rev, to: `${wid}/${keyOf(a.call)}`, ...(a.call ? { call: a.call } : {}), text: a.text }));
  const attention = wf.attention.filter(a => a.kind !== "question").map(a => ({ id: a.id, rev: a.rev, kind: a.kind, ...(a.call ? { call: a.call } : {}), text: a.text }));
  const state: DescribeState = questions.length ? "asking" : isLive(wf) || wf.status === "parked" ? "running" : "sealed";
  const fence = lastFence(journal, entries);
  return { state, wid, ...(id ? { request: id } : {}), ...(admitted ? { spec_digest: specDigest(admitted) } : {}), status: wf.status, ...(wf.error ? { error: wf.error } : {}),
    calls, ...(questions.length ? { questions } : {}), ...(attention.length ? { attention } : {}), ...(fence ? { lastFence: fence } : {}) };
}
/** R3, best effort: why the latest fence that interrupted work happened. Every execution ends with a fence; one interrupted
 *  work only when the execution neither settled (its turn ended) before it nor hibernated (it waits for an answer), and
 *  was not sealed on purpose: a seal ends an execution on purpose unless its outcome is `unknown` (a `once` call cut off
 *  in a tool) or the execution was recorded as lost (the loss bound sealed it), which are interruptions themselves.
 *  A seal for an execution that never ran (a launch failure) or that the call's stop, timeout or budget ended is on
 *  purpose. restart-force: a forced restart listed the execution as live;
 *  orchestrator-crash: the execution was launched before an orchestrator start that is not preceded by a clean exit and
 *  fenced after it (startup recovery); otherwise process-died (the child or its host went away, or a drain fenced it). */
export function lastFence(journal: readonly Entry[], orch: readonly Entry[]): Description["lastFence"] {
  const lost = new Set(journal.filter(e => e.type === "loss").map(e => String(e.exec)));
  const fencedAt = new Map(journal.filter(e => e.type === JT.fenced).map(e => [String(e.exec), Number(e.seq)]));
  const ended = new Set(journal.filter(e => {
    const exec = String(e.exec);
    // Recovery records `hibernated` after the fence for an execution cut off while only its question's ask ran (P28):
    // it was waiting, not working, so that is no interruption either.
    if (e.type === "hibernated") return true;
    if (e.type === "settled") return Number(e.seq) < (fencedAt.get(exec) ?? Infinity);
    return e.type === JT.sealed && (e.result as { status?: string } | undefined)?.status !== "unknown" && !lost.has(exec);
  }).map(e => String(e.exec)));
  const fence = journal.findLast(e => e.type === JT.fenced && !ended.has(String(e.exec)));
  if (!fence) return undefined;
  const exec = String(fence.exec), at = Number(fence.ts);
  if (orch.some(e => e.type === "restart" && e.force === true && Array.isArray(e.live) && e.live.includes(exec))) return { at, exec, reason: "restart-force" };
  const launched = journal.find(e => e.type === JT.exec && e.exec === exec), starts = orch.filter(e => e.type === "orchestrator");
  const recovery = starts.findLast(s => Number(s.ts) <= at);
  if (launched && recovery && Number(launched.ts) < Number(recovery.ts)) {
    const prior = orch.filter(e => Number(e.seq) < Number(recovery.seq));
    const lastStart = prior.findLast(e => e.type === "orchestrator"), cleanExit = lastStart && prior.some(e => e.type === "orchestrator-exit" && Number(e.seq) > Number(lastStart.seq));
    if (!cleanExit) return { at, exec, reason: "orchestrator-crash" };
  }
  return { at, exec, reason: "process-died" };
}
export function renderDescription(d: Description): string {
  const lines = [`${d.request ?? d.wid}: ${d.state}${d.reason ? ` (${d.reason})` : ""}${d.wid && d.request ? ` — ${d.wid}` : ""}${d.status && d.state !== d.status ? ` · ${d.status}` : ""}`];
  if (d.pruned) lines.push(`  pruned: ${d.pruned.status ?? "?"} at ${new Date(d.pruned.endedAt ?? 0).toISOString()}`);
  if (d.error) lines.push(`  error: ${d.error}`);
  for (const c of d.calls ?? []) {
    lines.push(`  ${c.key}@${c.gen} ${c.agent} ${c.phase}${c.status ? ` ${c.status}` : ""}${c.model ? ` (${c.model})` : ""}${c.error ? ` — ${c.error}` : ""}`);
    if (c.waiting) lines.push(`    waiting: ${JSON.stringify(c.waiting)}`);
    if (c.data !== undefined) lines.push(`    data: ${JSON.stringify(c.data)}`);
    if (c.output) lines.push(...c.output.split("\n").map(l => `    | ${l}`));
  }
  for (const q of d.questions ?? []) lines.push(`  question ${q.to} qid=${q.qid} rev=${q.rev}:`, ...q.text.split("\n").map(l => `    ${l}`));
  for (const a of d.attention ?? []) lines.push(`  ${a.kind}${a.call ? ` ${a.call}` : ""}: ${a.text}`);
  if (d.lastFence) lines.push(`  last fence: ${d.lastFence.exec} ${d.lastFence.reason} at ${new Date(d.lastFence.at).toISOString()}`);
  return lines.join("\n");
}
export async function describeCommand(args: string[], ctx: Context): Promise<number> {
  const { values, positionals } = flags(args, { key: "value", json: "flag" });
  const key = text(values, "key");
  if ((key === undefined) === (positionals.length !== 1) || positionals.length > 1) throw new Error("describe needs --key <request id> or a workflow id");
  const d = await describe(ctx.home, key !== undefined ? { request: key } : { wid: positionals[0]! });
  ctx.write(values.json ? JSON.stringify(d, null, 2) : renderDescription(d));
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// run / send / stop --request (R1, R2)
// ---------------------------------------------------------------------------------------------------------------------
type Outcome = { type: "applied"; wid?: string } | { type: "rejected"; reason: string };
/** Wait (bounded) for the request's decision: a run's `created` wid, or the lifecycle resolution. */
async function outcome(home: string, rid: string, run: boolean, timeoutMs: number): Promise<Outcome | undefined> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const entries = ledger(home), created = run ? createdBy(entries, rid) : undefined;
    if (created) return { type: "applied", wid: String(created.wid) };
    const decided = decision(entries, rid);
    if (decided?.type === "rejected") return { type: "rejected", reason: String(decided.reason) };
    if (decided && !run) return { type: "applied" };
    if (performance.now() >= deadline) return undefined;
    await delay(Math.min(100, Math.max(0, deadline - performance.now())));
  }
}
async function conflict(ctx: Context, id: string, original: string, json: boolean): Promise<number> {
  const d = await describe(ctx.home, { request: id });
  const reply = { request: id, error: "request-conflict", ...(d.wid ? { wid: d.wid } : {}), spec_digest: original, state: d.state };
  ctx.write(json ? JSON.stringify(reply) : `${id}: request-conflict — this id names other content (${d.state}${d.wid ? `, ${d.wid}` : ""}); retry with the stored spec bytes or use a new id`);
  return EXIT.conflict;
}
function pending(ctx: Context, id: string, json: boolean, why = ""): number {
  ctx.write(json ? JSON.stringify({ request: id, pending: true, ...(why ? { reason: why } : {}) }) : `${id}: submitted; not decided yet${why ? ` (${why})` : ""} — retry with the same id (safe)`);
  return EXIT.pending;
}
/** Submit, then wait; a decision whose admitted envelope has other content (another sender won the id) is a conflict. */
async function submitAndWait(ctx: Context, seen: Seen, id: string, kind: "run" | "send" | "stop", body: unknown, cond: Request["cond"], wait: number, json: boolean):
  Promise<{ code: number } | { sent: Sent; outcome: Outcome; earlier: boolean }> {
  // R2: `created` is false only when the id was already decided before this invocation submitted (decisions are
  // monotonic); racing first attempts may all report created — the wid is what identifies the run.
  const rid = requestRid(id), earlier = Boolean(await outcome(ctx.home, rid, kind === "run", 0));
  let sent: Identified;
  try { sent = await submitIdentified(ctx.home, rid, kind, body, cond, ctx.env, ctx.starter); seen.submitted = !("conflict" in sent); }
  catch (error) {
    // Exit 1 means decided (rejected) or a usage error. A busy lock submitted nothing, and a failure after the envelope
    // was recorded (starting the orchestrator, say) leaves it submitted: both are "not decided yet — retry the same id".
    const recorded = await findRequest(ctx.home, rid).catch(() => undefined);
    if (error instanceof RequestsBusy || recorded && specDigest(recorded.request) === specDigest({ kind, body, cond }))
      return { code: pending(ctx, id, json, error instanceof RequestsBusy ? "busy" : `submitted, then: ${(error as Error).message ?? String(error)}`) };
    throw error;
  }
  if ("conflict" in sent) return { code: await conflict(ctx, id, sent.digest, json) };
  const result = await outcome(ctx.home, rid, kind === "run", wait);
  if (!result) return { code: pending(ctx, id, json) };
  const admitted = (await findRequest(ctx.home, rid))?.request;
  if (admitted && specDigest(admitted) !== sent.digest) return { code: await conflict(ctx, id, specDigest(admitted), json) };
  return { sent, outcome: result, earlier };
}
type Seen = { id?: string; json?: boolean; digest?: string; submitted?: boolean };
/** R2: a failure once this invocation submitted, or once the id is found recorded with this content, is "not decided
 *  yet" (75), never a refusal. Otherwise, with --json, a request refused before submission (a usage error, an invalid
 *  spec, an unknown agent, no open question) answers `{request, applied:false, reason, spec_digest?}` with exit 1;
 *  spec_digest is present once the content was complete enough to hash. This invocation submitted nothing. */
async function refusable(args: string[], ctx: Context, run: (args: string[], ctx: Context, seen: Seen) => Promise<number>): Promise<number> {
  const seen: Seen = {};
  try { return await run(args, ctx, seen); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error), json = seen.json ?? args.includes("--json");
    const recorded = !seen.submitted && seen.id && seen.digest && REQUEST_ID.test(seen.id) ? await findRequest(ctx.home, requestRid(seen.id)).catch(() => undefined) : undefined;
    if (seen.id && (seen.submitted || recorded && specDigest(recorded.request) === seen.digest)) return pending(ctx, seen.id, json, `submitted, then: ${reason}`);
    if (!json) throw error;
    const at = args.indexOf("--request"), id = seen.id ?? (at >= 0 && at + 1 < args.length ? args[at + 1] : undefined);
    ctx.write(JSON.stringify({ request: id ?? null, applied: false, reason, ...(seen.digest ? { spec_digest: seen.digest } : {}) }));
    return EXIT.rejected;
  }
}
const forks = (spec: Record<string, unknown>) => [spec, ...["tasks", "chain"].flatMap(k => Array.isArray(spec[k]) ? spec[k] as unknown[] : [])]
  .some(s => s && typeof s === "object" && (s as { context?: unknown }).context === "fork");

/** R2: `run --request <id> --spec <file|-> [--cwd <dir>] [--json] [--wait-ms <n>]`. The spec is the `subagents` run
 *  form ({agent,task,…} or {tasks|chain:[…],…}); it is validated by the tool's own normalizer and agent check. */
export const runCommand = (args: string[], ctx: Context): Promise<number> => refusable(args, ctx, runRequest);
async function runRequest(args: string[], ctx: Context, seen: Seen): Promise<number> {
  const { values, positionals } = flags(args, { request: "value", spec: "value", cwd: "value", json: "flag", "wait-ms": "value" });
  const id = text(values, "request"), file = text(values, "spec"), json = values.json === true, wait = waitMs(values, ctx);
  seen.id = id; seen.json = json;
  if (!id || !file || positionals.length) throw new Error("usage: run --request <id> --spec <file|-> [--cwd <dir>] [--json] [--wait-ms <n>]");
  requestRid(id);
  const bytes = file === "-" ? await (ctx.stdin ?? stdin)() : readFileSync(resolve(ctx.cwd ?? process.cwd(), file), "utf8");
  let spec: Record<string, unknown>;
  try { spec = JSON.parse(bytes); } catch (error) { throw new Error(`--spec is not JSON: ${(error as Error).message}`); }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("--spec must be a JSON object");
  if (spec.action !== undefined && spec.action !== "run") throw new Error("--spec describes a run; action must be absent or \"run\"");
  if (spec.request !== undefined) throw new Error("the request id is --request, not a spec field");
  if (forks(spec)) throw new Error("context \"fork\" needs a pi session to fork; it is not available to run --request");
  // RunBody.cwd = spec.cwd ?? --cwd ?? the current directory, absolute before the digest.
  const base = resolve(ctx.cwd ?? process.cwd(), text(values, "cwd") ?? "."), dir = typeof spec.cwd === "string" && spec.cwd ? resolve(base, spec.cwd) : base;
  const normalized = request({ ...spec, action: "run", ...(typeof spec.cwd === "string" && spec.cwd ? { cwd: dir } : {}) }, dir);
  const body = normalized.body as RunBody;
  seen.digest = specDigest({ kind: "run", body });
  // An id already recorded is decided by that record: the same content gets its first outcome (the agents it named may
  // have changed since), other content is a request-conflict. Only a new id is checked here.
  const prior = (await findRequest(ctx.home, requestRid(id)))?.request;
  if (!prior) checkAgents(body, () => discoverAgents(dir, { home: ctx.env.HOME || undefined, agentDir: ctx.env.PI_CODING_AGENT_DIR || undefined }).agents.map(a => a.name));
  const done = await submitAndWait(ctx, seen, id, "run", body, undefined, wait, json);
  if ("code" in done) return done.code;
  if (done.outcome.type === "rejected") {
    ctx.write(json ? JSON.stringify({ request: id, applied: false, reason: done.outcome.reason, spec_digest: done.sent.digest }) : `${id}: rejected ${done.outcome.reason}`);
    return EXIT.rejected;
  }
  const reply = { request: id, wid: done.outcome.wid!, created: !done.earlier, spec_digest: done.sent.digest };
  ctx.write(json ? JSON.stringify(reply) : `${id} → ${reply.wid} (${reply.created ? "created" : "existing"})`);
  return EXIT.ok;
}
/** `<run-id>` or `<wid>` → wid when that run id created one; `pending` when the run is known but has no workflow yet. */
async function widOf(home: string, head: string): Promise<{ wid: string } | { pending: true }> {
  if (!REQUEST_ID.test(head)) return { wid: head };
  const rid = requestRid(head), created = createdBy(ledger(home), rid);
  if (created) return { wid: String(created.wid) };
  const found = await findRequest(home, rid);
  return found?.request.kind === "run" && decision(ledger(home), rid)?.type !== "rejected" ? { pending: true } : { wid: head };
}
/** R2: `--to <run-id>[/<key>] | <wid>/<key>` (+ `--call <key>`) → `<wid>/<key>`; a run of one call implies its key. */
async function target(home: string, to: string, call: string | undefined, prior: Request | undefined): Promise<{ to: string } | { pending: true }> {
  const cut = to.indexOf("/"), head = cut < 0 ? to : to.slice(0, cut), key = cut < 0 ? call : to.slice(cut + 1);
  if (cut >= 0 && call !== undefined) throw new Error("give the call key in --to or --call, not both");
  const resolved = await widOf(home, head);
  if ("pending" in resolved) return resolved;
  if (key) return { to: `${resolved.wid}/${key}` };
  // A retry addresses what the original did (the workflow may have been pruned since).
  const before = (prior?.body as { to?: unknown } | undefined)?.to;
  if (typeof before === "string" && before.startsWith(`${resolved.wid}/`)) return { to: before };
  if (!existsSync(journalPath(home, resolved.wid))) return { to: resolved.wid };
  const keys = [...new Set(workflowSnapshot(home, resolved.wid).calls.map(c => c.key))];
  if (keys.length === 1) return { to: `${resolved.wid}/${keys[0]}` };
  throw new Error(`${to} has ${keys.length ? `calls ${keys.join(", ")}` : "no calls yet"}; name one with --call <key> or --to <wid>/<key>`);
}
/** R2: `send --request <id> --to <…> --kind follow-up|answer|steer|model [--qid <qid> --rev <n>] --message <text|@file> [--model <m>]`. */
export const sendCommand = (args: string[], ctx: Context): Promise<number> => refusable(args, ctx, sendRequest);
async function sendRequest(args: string[], ctx: Context, seen: Seen): Promise<number> {
  const { values, positionals } = flags(args, { request: "value", to: "value", call: "value", kind: "value", qid: "value", rev: "value", message: "value", model: "value", json: "flag", "wait-ms": "value" });
  const id = text(values, "request"), to = text(values, "to"), kind = text(values, "kind"), json = values.json === true, wait = waitMs(values, ctx);
  seen.id = id; seen.json = json;
  if (!id || !to || !kind || positionals.length) throw new Error("usage: send --request <id> --to <run-id|wid/key> --kind follow-up|answer|steer|model [--qid <qid> --rev <n>] --message <text|@file> [--model <m>] [--json]");
  const rid = requestRid(id), prior = (await findRequest(ctx.home, rid))?.request;
  const where = await target(ctx.home, to, text(values, "call"), prior);
  if ("pending" in where) return pending(ctx, id, json, `run ${to.split("/")[0]} has no workflow yet`);
  const raw = text(values, "message"), message = raw?.startsWith("@") ? readFileSync(resolve(ctx.cwd ?? process.cwd(), raw.slice(1)), "utf8") : raw;
  const rev = text(values, "rev");
  if (rev !== undefined && !/^\d+$/.test(rev)) throw new Error("--rev needs a positive integer");
  let qid = text(values, "qid"), revision = rev !== undefined ? Number(rev) : undefined;
  if (kind === "answer" && (qid === undefined || revision === undefined)) {
    // The open question of the target call (or, on a retry, the one the original answered) supplies qid/rev.
    const before = prior?.kind === "send" && (prior.body as { to?: string; kind?: string }).kind === "answer" && (prior.body as { to?: string }).to === where.to ? prior.cond : undefined;
    const [wid, key] = [where.to.slice(0, where.to.indexOf("/")), where.to.slice(where.to.indexOf("/") + 1)];
    const open = before ? [{ qid: before.qid, rev: before.rev }] : existsSync(journalPath(ctx.home, wid))
      ? workflowSnapshot(ctx.home, wid).attention.filter(a => a.kind === "question" && a.call?.replace(/^[^/]*\//, "").replace(/@\d+$/, "") === key && (qid === undefined || a.qid === qid)) : [];
    if (open.length !== 1) throw new Error(open.length ? `several questions are open on ${where.to}; give --qid and --rev` : `no open question on ${where.to}${qid ? ` with qid ${qid}` : ""}`);
    qid ??= open[0]!.qid; revision ??= open[0]!.rev;
  }
  const normalized = request({ action: "send", to: where.to, kind, ...(message !== undefined ? { message } : {}), ...(text(values, "model") !== undefined ? { model: text(values, "model") } : {}),
    ...(qid !== undefined ? { qid } : {}), ...(revision !== undefined ? { rev: revision } : {}) }, ctx.cwd ?? process.cwd());
  seen.digest = specDigest({ kind: "send", body: normalized.body, cond: normalized.cond });
  const done = await submitAndWait(ctx, seen, id, "send", normalized.body, normalized.cond, wait, json);
  if ("code" in done) return done.code;
  return decided(ctx, id, done, json);
}
/** R2: `stop --request <id> <run-id|wid|wid/key|callId>`. */
export const stopCommand = (args: string[], ctx: Context): Promise<number> => refusable(args, ctx, stopRequest);
async function stopRequest(args: string[], ctx: Context, seen: Seen): Promise<number> {
  const { values, positionals } = flags(args, { request: "value", json: "flag", "wait-ms": "value" });
  const id = text(values, "request"), json = values.json === true, wait = waitMs(values, ctx);
  seen.id = id; seen.json = json;
  if (!id || positionals.length !== 1) throw new Error("usage: stop --request <id> <run-id|wid|wid/key> [--json]");
  requestRid(id);
  const raw = positionals[0]!, cut = raw.indexOf("/"), head = cut < 0 ? raw : raw.slice(0, cut);
  const resolved = raw.includes("@") ? { wid: head } : await widOf(ctx.home, head);
  if ("pending" in resolved) return pending(ctx, id, json, `run ${head} has no workflow yet`);
  const normalized = request({ action: "stop", target: raw.includes("@") ? raw : `${resolved.wid}${raw.slice(head.length)}` }, ctx.cwd ?? process.cwd());
  seen.digest = specDigest({ kind: "stop", body: normalized.body });
  const done = await submitAndWait(ctx, seen, id, "stop", normalized.body, undefined, wait, json);
  if ("code" in done) return done.code;
  return decided(ctx, id, done, json);
}
function decided(ctx: Context, id: string, done: { sent: Sent; outcome: Outcome }, json: boolean): number {
  if (done.outcome.type === "rejected") {
    ctx.write(json ? JSON.stringify({ request: id, applied: false, reason: done.outcome.reason, spec_digest: done.sent.digest }) : `${id}: rejected ${done.outcome.reason}`);
    return EXIT.rejected;
  }
  // A follow-up opens a new generation: the orchestrator records it in the workflow journal under the request's rid.
  const body = done.sent.request.body as { to?: string; kind?: string };
  const wid = typeof body.to === "string" ? body.to.split("/")[0]!.split("@")[0]! : undefined;
  const opened = done.sent.request.kind === "send" && wid && existsSync(journalPath(ctx.home, wid))
    ? (readJournalSnapshot(journalPath(ctx.home, wid)) as Entry[]).find(e => e.type === "generation" && e.rid === done.sent.request.rid) : undefined;
  const reply = { request: id, applied: true, ...(opened ? { generation: Number(opened.gen), call: `${wid}/${String(opened.key)}` } : {}), spec_digest: done.sent.digest };
  ctx.write(json ? JSON.stringify(reply) : `${id}: applied${opened ? ` (follow-up generation ${reply.generation} of ${reply.call})` : ""}`);
  return EXIT.ok;
}
