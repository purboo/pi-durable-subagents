import { resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { CallSpec, Conditions, RequestKind, RunBody } from "../../types.ts";
import { validateCallSpec } from "../../compat/spec.ts";
import { compileFanout } from "../../compat/fanout.ts";

const stepsDoc = "Call specs {agent, task, model?, cwd?, timeoutMs?, output?, schema?, gate?, isolation?, context?, budget?, once?, tools?, skills?, key?}; " +
  "each call is addressed as '<wid>/<key>', where key is the step's own unique key or else 'tasks:<i>' / 'chain:<i>'.";

export const parameters = Type.Object({
  action: Type.Optional(Type.Union(["run", "agents", "send", "stop", "revise", "status", "resume", "drain"].map(v => Type.Literal(v)))),
  workflow: Type.Optional(Type.String()), source: Type.Optional(Type.String()), args: Type.Optional(Type.Unknown()),
  tasks: Type.Optional(Type.Array(Type.Any(), { description: `Parallel calls. ${stepsDoc}` })),
  chain: Type.Optional(Type.Array(Type.Any(), { description: `Sequential calls ({previous} = previous output). ${stepsDoc}` })),
  agent: Type.Optional(Type.String()), task: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()), kind: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("follow-up"), Type.Literal("answer"), Type.Literal("model")])),
  message: Type.Optional(Type.String()), qid: Type.Optional(Type.String()), rev: Type.Optional(Type.Integer({ minimum: 1 })),
  replaces: Type.Optional(Type.Array(Type.String())), target: Type.Optional(Type.String()), wid: Type.Optional(Type.String()),
  usageBudget: Type.Optional(Type.Object({ tokens: Type.Optional(Type.Number()), costUsd: Type.Optional(Type.Number()) })),
  maxCalls: Type.Optional(Type.Integer({ minimum: 1 })), inputs: Type.Optional(Type.Record(Type.String(), Type.String())),
}, { additionalProperties: true });

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
/** v12 §2: Infer unambiguous runs and normalize controls into unchanged wire bodies. */
export function request(args: Args, cwd: string): { kind: RequestKind; body: unknown; cond?: Conditions; replaces?: string[] } {
  // v12 §2: Infer run only when one launch form is present; never guess a control verb.
  const launchForms = [args.agent !== undefined || args.task !== undefined, args.tasks !== undefined,
    args.chain !== undefined, args.workflow !== undefined, args.source !== undefined];
  const action = args.action === undefined && launchForms.filter(Boolean).length === 1 ? "run" : args.action;
  if (typeof action !== "string" || !action) throw new Error("action is required: run, agents, send, stop, revise, status, resume, drain");
  if (action === "run") {
    const { action: _, workflow, source, tasks, chain, args: inputs, name, usageBudget, maxCalls, inputs: files, by: _by, ...spec } = args;
    const choices = [workflow, source, tasks, chain, spec.agent === undefined && spec.task === undefined ? undefined : spec];
    if (choices.filter(v => v !== undefined).length !== 1) throw new Error("run requires exactly one of workflow, source, tasks, chain, or agent/task");
    const body: RunBody = { cwd };
    if (workflow !== undefined) body.workflow = resolve(cwd, string(args, "workflow"));
    else if (source !== undefined) body.source = string(args, "source");
    else if (tasks !== undefined || chain !== undefined) {
      const list = tasks ?? chain;
      if (!Array.isArray(list) || !list.length) throw new Error("tasks/chain must be nonempty");
      const kind = tasks !== undefined ? "tasks" : "chain";
      body[kind] = list.map((value, i) => call(value, cwd, `${kind}[${i}]`));
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
      body.inputs = Object.fromEntries(Object.entries(files).map(([k, v]) => { if (typeof v !== "string" || !v) throw new Error(`inputs.${k} must be a path`); return [k, resolve(cwd, v)]; }));
    }
    return { kind: "run", body };
  }
  if (action === "send") {
    const kind = string(args, "kind");
    if (!["steer", "follow-up", "answer", "model"].includes(kind)) throw new Error("Unsupported send kind");
    const body = { to: string(args, "to"), kind, ...(kind === "model" ? { model: string(args, "model") } : { message: string(args, "message") }), ...(args.by === "user" ? { by: "user" } : {}) };
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
  if (action === "resume") return { kind: "resume", body: args.wid === undefined ? {} : { wid: string(args, "wid") } };
  if (action === "drain") return { kind: "drain", body: {} };
  throw new Error(`Unsupported action: ${action}; use run, agents, send, stop, revise, status, resume, or drain`);
}
