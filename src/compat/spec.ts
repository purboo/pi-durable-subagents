import { schemaProblems } from "../agent/child/schema.ts";

const fields = new Set(["agent", "task", "model", "cwd", "timeoutMs", "output", "schema", "gate", "isolation", "context", "budget", "once", "tools", "skills", "key", "writer", "command", "env", "rerun"]);
/** Fields a command call takes; every other known field belongs to agent calls. */
export const COMMAND_FIELDS = ["command", "cwd", "timeoutMs", "env", "rerun", "writer", "key"] as const;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
type Spec = Record<string, unknown>;
const isObject = (v: unknown): v is Spec => v !== null && typeof v === "object" && !Array.isArray(v);
const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
const text = (v: unknown) => typeof v === "string" && v.trim() !== "";
/** The received value, clipped, so a rejected field says what was sent (e.g. a number sent as a string). */
const got = (v: unknown) => { const s = typeof v === "number" ? String(v) : JSON.stringify(v) ?? String(v); return ` (got ${s.length > 60 ? `${s.slice(0, 60)}…` : s})`; };
const unknown = (value: Spec, known: readonly string[], prefix = "") =>
  Object.keys(value).filter(k => value[k] !== undefined && !known.includes(k)).map(k => `unknown field "${prefix}${k}"`);

function gate(value: unknown): string[] {
  if (typeof value === "string") return text(value) ? [] : ["gate must be a non-empty command"];
  if (!isObject(value)) return ["gate must be a string or {command, output?, schema?, timeoutMs?}"];
  const errors = unknown(value, ["command", "output", "schema", "timeoutMs"], "gate.");
  if (!text(value.command)) errors.push("gate.command must be a non-empty string");
  if (value.output !== undefined && value.output !== "json") errors.push('gate.output must be "json"');
  if (value.schema !== undefined) errors.push(...schemaProblems(value.schema, "gate.schema"));
  if (value.timeoutMs !== undefined && !positive(value.timeoutMs)) errors.push(`gate.timeoutMs must be a positive number${got(value.timeoutMs)}`);
  return errors;
}
function budget(value: unknown): string[] {
  if (!isObject(value)) return ["budget must be an object {tokens?, costUsd?}"];
  const errors = unknown(value, ["tokens", "costUsd"], "budget.");
  if (value.tokens === undefined && value.costUsd === undefined) errors.push("budget needs tokens or costUsd");
  for (const k of ["tokens", "costUsd"]) if (value[k] !== undefined && !positive(value[k])) errors.push(`budget.${k} must be a positive number${got(value[k])}`);
  return errors;
}

/** P34, P24, T2/T3/T4: Validate a call spec at submission; `key` is accepted only for tasks/chain steps. Empty = valid. */
export function validateCallSpec(spec: unknown, options: { fanout?: boolean } = {}): string[] {
  if (!isObject(spec)) return ["call spec must be an object"];
  const s = spec, errors: string[] = [], has = (k: string) => s[k] !== undefined;
  for (const k of Object.keys(s)) {
    if (s[k] === undefined) continue;
    if (!fields.has(k)) errors.push(`unknown field "${k}"`);
    else if (k === "key" && !options.fanout) errors.push("key is only allowed in tasks/chain steps");
  }
  if (has("command")) return [...errors, ...commandProblems(s, options)];
  for (const k of ["env", "rerun"]) if (has(k)) errors.push(`${k} is only allowed in a command call`);
  if (!text(s.agent)) errors.push(`agent must be a non-empty string${has("agent") ? got(s.agent) : ""}`);
  if (!text(s.task)) errors.push("task must be a non-empty string");
  for (const k of ["model", "cwd", "output"]) if (has(k) && typeof s[k] !== "string") errors.push(`${k} must be a string${got(s[k])}`);
  if (has("timeoutMs") && !positive(s.timeoutMs)) errors.push(`timeoutMs must be a positive number (milliseconds)${got(s.timeoutMs)}`);
  if (has("schema")) errors.push(...schemaProblems(s.schema, "schema"));
  if (has("gate")) errors.push(...gate(s.gate));
  if (has("isolation") && s.isolation !== "none" && s.isolation !== "worktree") errors.push(`isolation must be "none" or "worktree"${got(s.isolation)}`);
  if (has("context") && s.context !== "fresh" && s.context !== "fork" && s.context !== "exact") errors.push(`context must be "fresh", "fork" or "exact"${got(s.context)}`);
  if (has("budget")) errors.push(...budget(s.budget));
  if (has("once") && typeof s.once !== "boolean") errors.push(`once must be a boolean${got(s.once)}`);
  if (has("writer") && typeof s.writer !== "boolean") errors.push(`writer must be a boolean${got(s.writer)}`);
  for (const k of ["tools", "skills"]) if (has(k) && (!Array.isArray(s[k]) || !(s[k] as unknown[]).every(v => typeof v === "string"))) errors.push(`${k} must be an array of strings${got(s[k])}`);
  if (options.fanout && has("key") && !text(s.key)) errors.push("key must be a non-empty string");
  return errors;
}

/** A command call: command (argv array or sh string) plus cwd, timeoutMs, env, rerun, writer, key; nothing else. */
function commandProblems(s: Spec, options: { fanout?: boolean }): string[] {
  const errors: string[] = [], has = (k: string) => s[k] !== undefined;
  for (const k of Object.keys(s)) if (has(k) && fields.has(k) && !(COMMAND_FIELDS as readonly string[]).includes(k)) errors.push(`${k} is not allowed in a command call`);
  const c = s.command;
  if (Array.isArray(c)) {
    if (!c.length || !c.every(v => typeof v === "string") || !text(c[0])) errors.push(`command must be a non-empty string or an array of strings with a non-empty first element${got(c)}`);
  } else if (!text(c)) errors.push(`command must be a non-empty string or an array of strings with a non-empty first element${got(c)}`);
  if (has("cwd") && typeof s.cwd !== "string") errors.push(`cwd must be a string${got(s.cwd)}`);
  if (has("timeoutMs") && !positive(s.timeoutMs)) errors.push(`timeoutMs must be a positive number (milliseconds)${got(s.timeoutMs)}`);
  if (has("env")) {
    if (!isObject(s.env)) errors.push(`env must be an object of strings${got(s.env)}`);
    else for (const [k, v] of Object.entries(s.env)) {
      if (!ENV_NAME.test(k)) errors.push(`env name ${JSON.stringify(k)} is not a valid variable name`);
      else if (k.startsWith("DSA_")) errors.push(`env name ${k} is reserved (DSA_*)`);
      if (typeof v !== "string") errors.push(`env.${k} must be a string${got(v)}`);
    }
  }
  for (const k of ["rerun", "writer"]) if (has(k) && typeof s[k] !== "boolean") errors.push(`${k} must be a boolean${got(s[k])}`);
  if (options.fanout && has("key") && !text(s.key)) errors.push("key must be a non-empty string");
  return errors;
}
