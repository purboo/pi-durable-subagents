import { resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { CallSpec, Conditions, RequestKind, RunBody } from "../../types.ts";

export const parameters = Type.Object({
  action: Type.Union(["run", "send", "stop", "revise", "status", "resume", "drain"].map(v => Type.Literal(v))),
  workflow: Type.Optional(Type.String()), source: Type.Optional(Type.String()), args: Type.Optional(Type.Unknown()),
  tasks: Type.Optional(Type.Array(Type.Any())), chain: Type.Optional(Type.Array(Type.Any())),
  agent: Type.Optional(Type.String()), task: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()), kind: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("answer"), Type.Literal("model")])),
  message: Type.Optional(Type.String()), qid: Type.Optional(Type.String()), rev: Type.Optional(Type.Integer({ minimum: 1 })),
  replaces: Type.Optional(Type.Array(Type.String())), target: Type.Optional(Type.String()), wid: Type.Optional(Type.String()),
}, { additionalProperties: true });

type Args = Record<string, unknown>;
function string(args: Args, name: string): string {
  if (typeof args[name] !== "string" || !args[name]) throw new Error(`${name} is required`);
  return args[name];
}
function call(value: unknown, cwd: string): CallSpec {
  if (!value || typeof value !== "object") throw new Error("Expected a call specification");
  const spec = { ...value } as Args;
  string(spec, "agent"); string(spec, "task");
  if (spec.cwd !== undefined) spec.cwd = resolve(cwd, string(spec, "cwd"));
  return spec as unknown as CallSpec;
}
/** P25, P34: Normalize the public tool into the pinned orchestrator wire bodies. */
export function request(args: Args, cwd: string): { kind: RequestKind; body: unknown; cond?: Conditions; replaces?: string[] } {
  const action = string(args, "action");
  if (action === "run") {
    const { action: _, workflow, source, tasks, chain, args: inputs, name, ...spec } = args;
    const choices = [workflow, source, tasks, chain, spec.agent === undefined && spec.task === undefined ? undefined : spec];
    if (choices.filter(v => v !== undefined).length !== 1) throw new Error("run requires exactly one of workflow, source, tasks, chain, or agent/task");
    const body: RunBody = { cwd };
    if (workflow !== undefined) body.workflow = resolve(cwd, string(args, "workflow"));
    else if (source !== undefined) body.source = string(args, "source");
    else if (tasks !== undefined || chain !== undefined) {
      const list = tasks ?? chain;
      if (!Array.isArray(list) || !list.length) throw new Error("tasks/chain must be nonempty");
      body[tasks !== undefined ? "tasks" : "chain"] = list.map(value => call(value, cwd));
    } else body.call = call(spec, cwd);
    if (inputs !== undefined) body.args = inputs;
    if (name !== undefined) body.name = string(args, "name");
    return { kind: "run", body };
  }
  if (action === "send") {
    const kind = string(args, "kind");
    if (!["steer", "answer", "model"].includes(kind)) throw new Error("Unsupported send kind");
    const body = { to: string(args, "to"), kind, ...(kind === "model" ? { model: string(args, "model") } : { message: string(args, "message") }) };
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
  throw new Error(`Unsupported action: ${action}`);
}
