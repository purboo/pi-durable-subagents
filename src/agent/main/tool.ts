import { restartInputError } from "../../orchestrator/restart.ts";
import { resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { CallSpec, Conditions, Entry, RequestKind, RunBody } from "../../types.ts";
import { validateCallSpec } from "../../compat/spec.ts";
import { compileFanout } from "../../compat/fanout.ts";

const stepsDoc = "Call specs {agent, task, model?, cwd?, timeoutMs?, output?, schema?, gate?, isolation?, context?, budget?, once?, tools?, skills?, writer?, key?}; " +
  "each call is addressed as '<wid>/<key>', where key is the step's own unique key or else 'tasks:<i>' / 'chain:<i>'.";

export const parameters = Type.Object({
  action: Type.Optional(Type.Union(["run", "agents", "send", "stop", "revise", "status", "resume", "drain", "restart"].map(v => Type.Literal(v)))),
  workflow: Type.Optional(Type.String()), source: Type.Optional(Type.String()), args: Type.Optional(Type.Unknown()),
  tasks: Type.Optional(Type.Array(Type.Any(), { description: `Parallel calls. ${stepsDoc}` })),
  chain: Type.Optional(Type.Array(Type.Any(), { description: `Sequential calls ({previous} = previous output). ${stepsDoc}` })),
  agent: Type.Optional(Type.String()), task: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String({ description: "Run directory (default: this session's). Relative workflow, inputs and call cwd paths resolve against it." })),
  to: Type.Optional(Type.String()), kind: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("follow-up"), Type.Literal("answer"), Type.Literal("model")])),
  message: Type.Optional(Type.String()), qid: Type.Optional(Type.String()), rev: Type.Optional(Type.Integer({ minimum: 1 })),
  replaces: Type.Optional(Type.Array(Type.String())), target: Type.Optional(Type.String()), wid: Type.Optional(Type.String()),
  usageBudget: Type.Optional(Type.Object({ tokens: Type.Optional(Type.Number()), costUsd: Type.Optional(Type.Number()) })),
  maxCalls: Type.Optional(Type.Integer({ minimum: 1 })), inputs: Type.Optional(Type.Record(Type.String(), Type.String())),
  name: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number({ description: "Per-call limit on active time in milliseconds (a number). Omit unless a hard limit is needed; prefer budgets." })),
  key: Type.Optional(Type.String({ description: "A single agent/task run: the call's key. status with wid: that call's full result." })),
  full: Type.Optional(Type.Boolean({ description: "status: with wid, the complete workflow detail including every output." })),
  force: Type.Optional(Type.Union([Type.String(), Type.Boolean()], { description: "restart: the token shown by a refusal. Show the user the list and obtain explicit approval first; boolean true is refused. Subagents cannot force a restart." })),
  reason: Type.Optional(Type.String({ description: "restart: non-empty reason, at most 500 characters; required with force." })),
  request: Type.Optional(Type.String({ description: "run/send/stop: your own request id (1-124 chars [A-Za-z0-9][A-Za-z0-9._:-]*) making a retry safe: the same id with the same content gets the first outcome; other content is refused (request-conflict)." })),
}, { additionalProperties: true });

/** Call fields a tasks/chain run applies to every step that does not set its own. */
export const stepDefaults = ["model", "timeoutMs", "budget", "isolation", "context", "tools", "skills", "once", "writer"];

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
 *  the tool and the CLI `run --request` (R2). */
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
export function sendReceipt(ledger: readonly Entry[], rid: string): { model?: string; effect?: string; pool?: string } {
  const note = ledger.find(e => e.type === "send-note" && e.rid === rid);
  return note ? { model: String(note.model), effect: String(note.effect), ...(note.pool ? { pool: String(note.pool) } : {}) } : {};
}
export function request(args: Args, cwd: string): { kind: RequestKind; body: unknown; cond?: Conditions; replaces?: string[] } {
  // v12 §2: Infer run only when one launch form is present; never guess a control verb.
  const launchForms = [args.agent !== undefined || args.task !== undefined, args.tasks !== undefined,
    args.chain !== undefined, args.workflow !== undefined, args.source !== undefined];
  const action = args.action === undefined && launchForms.filter(Boolean).length === 1 ? "run" : args.action;
  if (typeof action !== "string" || !action) throw new Error("action is required: run, agents, send, stop, revise, status, resume, drain, restart");
  if (action === "run") {
    const { action: _, workflow, source, tasks, chain, args: inputs, name, usageBudget, maxCalls, inputs: files, by: _by, request: _request, ...spec } = args;
    const choices = [workflow, source, tasks, chain, spec.agent === undefined && spec.task === undefined ? undefined : spec];
    if (choices.filter(v => v !== undefined).length !== 1) throw new Error("run requires exactly one of workflow, source, tasks, chain, or agent/task");
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
    if (!["steer", "follow-up", "answer", "model"].includes(kind)) throw new Error("Unsupported send kind");
    // follow-up may name the model its continuation runs on (P37); other kinds ignore one.
    const model = kind === "model" || kind === "follow-up" && args.model !== undefined ? { model: string(args, "model") } : {};
    const body = { to: string(args, "to"), kind, ...model, ...(kind === "model" ? {} : { message: string(args, "message") }), ...(args.by === "user" ? { by: "user" } : {}) };
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
