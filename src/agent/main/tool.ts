import { restartInputError } from "../../orchestrator/restart.ts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readJournalSnapshot } from "../../kernel/journal.ts";
import { generationRids } from "../../orchestrator/notes.ts";
import { journalPath } from "../../paths.ts";
import type { CallSpec, Conditions, Entry, RequestKind, RunBody } from "../../types.ts";
import { validateCallSpec } from "../../compat/spec.ts";
import { compileFanout } from "../../compat/fanout.ts";
import { checkLabels } from "../../events/labels.ts";

/** Call fields a tasks/chain run applies to every step that does not set its own. */
export const stepDefaults = ["agent", "model", "timeoutMs", "budget", "isolation", "context", "tools", "skills", "once", "writer"];

type Args = Record<string, unknown>;
function string(args: Args, name: string): string {
  if (typeof args[name] !== "string" || !args[name]) throw new Error(`${name} is required`);
  return args[name];
}
function call(value: unknown, cwd: string, where: string): CallSpec {
  // A single call may name its key too (it compiles to tasks:[call], so the key addresses it as <wid>/<key>).
  const errors = validateCallSpec(value, { fanout: true });
  if (errors.length) throw new Error(`Invalid ${where}: ${errors.join("; ")}`);
  const spec = { ...value as Args };
  if (typeof spec.cwd === "string") spec.cwd = resolve(cwd, spec.cwd);
  return spec as unknown as CallSpec;
}
/** v12 §2: Reject unknown explicit call agents before starter or outbox publication; scripts remain call-local. Shared by
 *  the tool and the CLI `run --request`. */
export function checkAgents(body: RunBody, available: () => string[]): void {
  const names = [...(body.call ? [body.call] : []), ...(body.tasks ?? []), ...(body.chain ?? [])].map(call => call.agent);
  if (!names.length) return;
  const known = available(), unknown = [...new Set(names.filter(name => !known.includes(name)))];
  if (unknown.length) throw new Error(`Unknown agent${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Available agents: ${known.join(", ") || "(none)"}`);
}
/** v12 §2: Infer unambiguous runs and normalize controls into unchanged wire bodies. */
/** P12: a send naming a model is answered with that model and when it applies — `next-request` (a running call switches
 *  at its next provider request), `next-execution` (a call with no live execution launches on it) or `next-generation`
 *  (a follow-up's new generation runs on it). From the orchestrator ledger's `send-note`. */
export function sendReceipt(ledger: readonly Entry[], rid: string): { model?: string; effect?: string; pool?: string; delivery?: Delivery; note?: string } {
  // The latest one counts: a replayed notify corrects what an interrupted first decision recorded.
  const note = ledger.findLast(e => e.type === "send-note" && e.rid === rid);
  if (!note) return {};
  if (typeof note.delivery === "string") return { delivery: note.delivery as Delivery, note: DELIVERY_NOTE[note.delivery as Delivery] ?? note.delivery };
  return { model: String(note.model), effect: String(note.effect), ...(note.pool ? { pool: String(note.pool) } : {}) };
}
/** Where an applied follow-up went. It opened a generation: `generation` and `call` (`<wid>/<key>`), from the workflow
 *  journal, under the request's rid or, for one forwarded into running work that sealed first, in `follows` of the
 *  generation that took it along. It was queued into unfinished work: `delivery: "forwarded"` and `call`
 *  (`<wid>/<key>@<gen>`, the running generation). If that generation ends before taking it, the message opens the next
 *  generation (unless a stop ended it), and a retry of the same request then names that generation. */
export function followUpReceipt(home: string, rid: string, body: unknown): { generation?: number; call?: string; delivery?: "forwarded"; note?: string } {
  const send = body as { to?: unknown; kind?: unknown } | undefined;
  if (send?.kind !== "follow-up" || typeof send.to !== "string") return {};
  const wid = send.to.split("/")[0]!.split("@")[0]!, path = journalPath(home, wid);
  if (!existsSync(path)) return {};
  const log = readJournalSnapshot(path) as Entry[], opened = log.find(e => e.type === "generation" && generationRids(e).includes(rid));
  if (opened) return { generation: Number(opened.gen), call: `${wid}/${String(opened.key)}` };
  const queued = log.find(e => e.type === "forward" && e.rid === rid);
  if (!queued) return {};
  const into = `${wid}/${String(queued.dest).slice(String(queued.dest).indexOf("/") + 1)}`;
  return { delivery: "forwarded", call: into, note: `queued into running ${into}; if it ends before taking it, it opens the next generation` };
}
/** The internal argument through which a send to several calls passes its `batch` (not a tool parameter). */
export const BATCH = Symbol("batch");
/** One line of a reply per target: applied (with how a notify went), rejected with its reason, or not decided yet. */
export function outcomeLine(r: Record<string, unknown>): string {
  if (r.applied === true) return `applied${r.generation !== undefined ? ` (follow-up generation ${String(r.generation)} of ${String(r.call)})` : ""}${r.delivery ? ` (${String(r.delivery)}: ${String(r.note)})` : r.effect ? ` (model ${String(r.model)}, ${String(r.effect)})` : ""}`;
  if (r.applied === false) return `rejected ${String(r.reason)}`;
  if (r.submitted) return `submitted, not decided yet (${String((r.submitted as { rid?: string }).rid)})`;
  return JSON.stringify(r);
}
/** How a notify went: `steered` (a running call gets it at its next safe point, like a steer), `held-until-answer` (the
 *  call waits on its question; it gets the note at the first safe point after the answer) or `noted` (the call is not
 *  running: a pending note, carried by its next follow-up; nothing was started). */
export type Delivery = "steered" | "held-until-answer" | "noted";
export const DELIVERY_NOTE: Record<Delivery, string> = {
  steered: "the call is running; it gets the note at its next safe point",
  "held-until-answer": "the call waits on its question; it gets the note after the answer",
  noted: "the call is not running: recorded as a pending note for its next follow-up (nothing was started)",
};
export function request(args: Args, cwd: string): { kind: RequestKind; body: unknown; cond?: Conditions; replaces?: string[] } {
  // v12 §2: Infer run only when one launch form is present; never guess a control verb.
  // A top-level agent without a task beside tasks/chain is the steps' default agent, not a launch form of its own.
  const listRun = args.tasks !== undefined || args.chain !== undefined;
  // A task beside tasks/chain is refused with what to do, before the launch form is inferred (with or without action).
  if ((args.action === undefined || args.action === "run") && listRun && args.task !== undefined)
    throw new Error(`task cannot be set beside ${args.tasks !== undefined ? "tasks" : "chain"}: agent+task is a single call; give each step its own task (a top-level agent alone is the default agent of every step)`);
  const launchForms = [args.task !== undefined || args.agent !== undefined && !listRun, args.tasks !== undefined,
    args.chain !== undefined, args.workflow !== undefined, args.source !== undefined];
  const action = args.action === undefined && launchForms.filter(Boolean).length === 1 ? "run" : args.action;
  if (typeof action !== "string" || !action) throw new Error("action is required: run, agents, send, stop, revise, status, resume, drain, restart");
  if (action === "run") {
    const { action: _, workflow, source, tasks, chain, args: inputs, name, usageBudget, maxCalls, inputs: files, labels, by: _by, request: _request, ...spec } = args;
    const steps = tasks !== undefined || chain !== undefined;
    // With tasks/chain a top-level agent (no task) is the default agent of every step, like model or timeoutMs.
    const single = spec.task !== undefined || spec.agent !== undefined && !steps;
    const choices = [workflow, source, tasks, chain, single ? spec : undefined];
    if (choices.filter(v => v !== undefined).length !== 1) throw new Error("run requires exactly one of workflow, source, tasks, chain, or agent/task (with tasks/chain, a top-level agent without task is the steps' default agent)");
    // A top-level cwd on a workflow/tasks/chain/source run is the run's directory: relative paths (the workflow file,
    // inputs, per-call cwd) resolve against it and calls default to it. It used to be ignored, so a relative
    // workflow path was looked up in the session's directory instead.
    const runCwd = choices[4] === undefined && typeof spec.cwd === "string" && spec.cwd ? resolve(cwd, spec.cwd) : cwd;
    // Call fields beside a tasks/chain list are defaults for its steps; anything else beside a list or a script was
    // silently dropped before (a top-level model or timeoutMs did nothing), so it is an error now.
    const extra = choices[4] === undefined ? Object.keys(spec).filter(k => k !== "cwd" && spec[k] !== undefined) : [];
    const fields = (keys: string[]) => keys.map(k => `"${k}"`).join(", ");
    if (tasks !== undefined || chain !== undefined) {
      const bad = extra.filter(k => !stepDefaults.includes(k));
      if (bad.length) throw new Error(`${fields(bad)} cannot be set for a whole ${tasks !== undefined ? "tasks" : "chain"} run; set ${bad.length > 1 ? "them" : "it"} in each step (run-level step defaults: ${stepDefaults.join(", ")})`);
    } else if (extra.length) throw new Error(`${fields(extra)} cannot be set for a ${workflow !== undefined ? "workflow" : "source"} run; set ${extra.length > 1 ? "them" : "it"} in the script's runs.run(key, spec) calls`);
    const defaults = Object.fromEntries(extra.map(k => [k, spec[k]]));
    const body: RunBody = { cwd: runCwd };
    if (workflow !== undefined) body.workflow = resolve(runCwd, string(args, "workflow"));
    else if (source !== undefined) body.source = string(args, "source");
    else if (tasks !== undefined || chain !== undefined) {
      const list = tasks ?? chain;
      if (!Array.isArray(list) || !list.length) throw new Error("tasks/chain must be nonempty");
      const kind = tasks !== undefined ? "tasks" : "chain";
      body[kind] = list.map((value, i) => call(value && typeof value === "object" && !Array.isArray(value) ? { ...defaults, ...value } : value, runCwd, `${kind}[${i}]`));
      compileFanout(kind === "tasks" ? { tasks: body.tasks! } : { chain: body.chain! }); // duplicate keys fail here, not at admission
    } else body.call = call(spec, cwd, "call");
    if (inputs !== undefined) body.args = inputs;
    if (name !== undefined) body.name = string(args, "name");
    // Part of the spec digest; an empty object is the same as none.
    if (labels !== undefined && Object.keys(checkLabels(labels)).length) body.labels = labels as Record<string, string>;
    // P31a, P36, P11: workflow-level limits and declared input files (absolute paths, pinned at admission).
    if (usageBudget !== undefined) {
      const b = usageBudget as { tokens?: unknown; costUsd?: unknown };
      if (!b || typeof b !== "object" || ![b.tokens, b.costUsd].some(v => typeof v === "number" && v > 0)) throw new Error("usageBudget needs tokens or costUsd");
      body.usageBudget = { ...(typeof b.tokens === "number" ? { tokens: b.tokens } : {}), ...(typeof b.costUsd === "number" ? { costUsd: b.costUsd } : {}) };
    }
    if (maxCalls !== undefined) { if (!Number.isSafeInteger(maxCalls) || Number(maxCalls) < 1) throw new Error("maxCalls must be a positive integer"); body.maxCalls = maxCalls as number; }
    if (files !== undefined) {
      if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("inputs must map names to file paths");
      body.inputs = Object.fromEntries(Object.entries(files).map(([k, v]) => { if (typeof v !== "string" || !v) throw new Error(`inputs.${k} must be a path`); return [k, resolve(runCwd, v)]; }));
    }
    return { kind: "run", body };
  }
  if (action === "send") {
    const kind = string(args, "kind");
    if (!["steer", "notify", "follow-up", "answer", "model"].includes(kind)) throw new Error("Unsupported send kind");
    if (Array.isArray(args.to)) throw new Error("to names one call here; several targets are sent one request each");
    // follow-up may name the model its continuation runs on (P37); other kinds ignore one.
    const model = kind === "model" || kind === "follow-up" && args.model !== undefined ? { model: string(args, "model") } : {};
    // `batch` is set by a send to several calls (see manyIds in src/requests.ts), never by a caller.
    const body = { to: string(args, "to"), kind, ...model, ...(kind === "model" ? {} : { message: string(args, "message") }), ...(args.by === "user" ? { by: "user" } : {}),
      ...(typeof (args as Record<symbol, unknown>)[BATCH] === "string" ? { batch: (args as Record<symbol, unknown>)[BATCH] as string } : {}) };
    const cond: Conditions = {};
    if (kind === "answer") {
      cond.qid = string(args, "qid");
      if (!Number.isSafeInteger(args.rev) || Number(args.rev) < 1) throw new Error("answer requires a positive rev");
      cond.rev = args.rev as number;
    }
    if (args.replaces !== undefined && (!Array.isArray(args.replaces) || !args.replaces.every(v => typeof v === "string" && v))) throw new Error("replaces must contain request ids");
    return { kind: "send", body, cond, replaces: args.replaces as string[] | undefined };
  }
  if (action === "stop") return { kind: "stop", body: { target: string(args, "target") } };
  if (action === "revise") return { kind: "revise", body: { wid: string(args, "wid"),
    ...(args.workflow === undefined ? {} : { workflow: resolve(cwd, string(args, "workflow")) }),
    ...(args.source === undefined ? {} : { source: string(args, "source") }), ...(args.args === undefined ? {} : { args: args.args }) } };
  if (action === "resume") return { kind: "resume", body: args.wid !== undefined ? { wid: string(args, "wid") } : typeof args.origin === "string" ? { origin: args.origin } : {} };
  if (action === "drain") return { kind: "drain", body: {} };
  if (action === "restart") {
    if (args.force === true) throw new Error('force:true is refused; show the user the running executions from a restart refusal, then use force:"<token>" and reason:"<why>" only with explicit user approval');
    if (args.force !== undefined && args.force !== false && typeof args.force !== "string") throw new Error("force must be the token from a refused restart");
    const body = { ...(typeof args.force === "string" ? { token: args.force } : {}), ...(args.reason !== undefined ? { reason: args.reason as string } : {}) };
    const invalid = restartInputError(body);
    if (invalid) throw new Error(invalid);
    return { kind: "restart", body };
  }
  throw new Error(`Unsupported action: ${action}; use run, agents, send, stop, revise, status, resume, drain, or restart`);
}
