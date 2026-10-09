// The subagents tool's parameter schema. Kept apart from tool.ts because it needs the optional pi peer
// package, which the CLI (sharing tool.ts) must not import: it runs from the package directory.
import { Type } from "@earendil-works/pi-ai";

const stepsDoc = "Call specs {agent, task, model?, cwd?, timeoutMs?, output?, schema?, gate?, isolation?, context?, budget?, once?, tools?, skills?, writer?, key?}; " +
  "each call is addressed as '<wid>/<key>', where key is the step's own unique key or else 'tasks:<i>' / 'chain:<i>'.";

export const parameters = Type.Object({
  action: Type.Optional(Type.Union(["run", "agents", "send", "stop", "revise", "status", "resume", "drain", "restart"].map(v => Type.Literal(v)))),
  workflow: Type.Optional(Type.String()), source: Type.Optional(Type.String()), args: Type.Optional(Type.Unknown()),
  tasks: Type.Optional(Type.Array(Type.Any(), { description: `Parallel calls. ${stepsDoc}` })),
  chain: Type.Optional(Type.Array(Type.Any(), { description: `Sequential calls ({previous} = previous output). ${stepsDoc}` })),
  agent: Type.Optional(Type.String()), task: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String({ description: "Run directory (default: this session's). Relative workflow, inputs and call cwd paths resolve against it." })),
  to: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "send: '<wid>/<key>', or a list of them for steer, notify, follow-up and model (one request per call; answer takes one)." })),
  kind: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("notify"), Type.Literal("follow-up"), Type.Literal("answer"), Type.Literal("model")])),
  message: Type.Optional(Type.String()), qid: Type.Optional(Type.String()), rev: Type.Optional(Type.Integer({ minimum: 1 })),
  replaces: Type.Optional(Type.Array(Type.String())), target: Type.Optional(Type.String()), wid: Type.Optional(Type.String()),
  usageBudget: Type.Optional(Type.Object({ tokens: Type.Optional(Type.Number()), costUsd: Type.Optional(Type.Number()) })),
  maxCalls: Type.Optional(Type.Integer({ minimum: 1 })), inputs: Type.Optional(Type.Record(Type.String(), Type.String())),
  name: Type.Optional(Type.String()),
  labels: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "run: your labels, e.g. {node, attempt}: at most 32 keys [A-Za-z0-9_.:-]{1,64}, string values of at most 256 characters, 4096 bytes of JSON; part of the request's content (spec_digest), shown by describe and on its events." })),
  timeoutMs: Type.Optional(Type.Number({ description: "Per-call limit on active time in milliseconds (a number). Omit unless a hard limit is needed; prefer budgets." })),
  key: Type.Optional(Type.String({ description: "A single agent/task run: the call's key. status with wid: that call's full result." })),
  tail: Type.Optional(Type.Integer({ minimum: 1, description: "status with wid: the last N lines of each call's result (unclipped, at most 4000 characters per call)." })),
  grep: Type.Optional(Type.String({ description: "status with wid: only the lines of each call's result matching this case-sensitive JS regular expression, run in-process: avoid nested quantifiers such as (a+)+; it tests the first 2000 characters of a line and the last 5000 lines (with tail: grep first, then the last N)." })),
  full: Type.Optional(Type.Boolean({ description: "status: with wid, the complete workflow detail including every output." })),
  force: Type.Optional(Type.Union([Type.String(), Type.Boolean()], { description: "restart: the token shown by a refusal. Show the user the list and obtain explicit approval first; boolean true is refused. Subagents cannot force a restart (an environment-based rail against accidents, not a security boundary)." })),
  reason: Type.Optional(Type.String({ description: "restart: non-empty reason, at most 500 characters; required with force." })),
  request: Type.Optional(Type.String({ description: "run/send/stop: your own request id (1-124 chars [A-Za-z0-9][A-Za-z0-9._:-]*) making a retry safe: the same id with the same content gets the first outcome; other content is refused (request-conflict)." })),
}, { additionalProperties: true });
