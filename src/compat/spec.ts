import { schemaProblems } from "../agent/child/schema.ts";

const fields = new Set(["agent", "task", "model", "cwd", "timeoutMs", "output", "schema", "gate", "isolation", "context", "budget", "once", "tools", "skills", "key"]);
type Spec = Record<string, unknown>;
const isObject = (v: unknown): v is Spec => v !== null && typeof v === "object" && !Array.isArray(v);
const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
const text = (v: unknown) => typeof v === "string" && v.trim() !== "";
const unknown = (value: Spec, known: readonly string[], prefix = "") =>
  Object.keys(value).filter(k => value[k] !== undefined && !known.includes(k)).map(k => `unknown field "${prefix}${k}"`);

function gate(value: unknown): string[] {
  if (typeof value === "string") return text(value) ? [] : ["gate must be a non-empty command"];
  if (!isObject(value)) return ["gate must be a string or {command, output?, schema?, timeoutMs?}"];
  const errors = unknown(value, ["command", "output", "schema", "timeoutMs"], "gate.");
  if (!text(value.command)) errors.push("gate.command must be a non-empty string");
  if (value.output !== undefined && value.output !== "json") errors.push('gate.output must be "json"');
  if (value.schema !== undefined) errors.push(...schemaProblems(value.schema, "gate.schema"));
  if (value.timeoutMs !== undefined && !positive(value.timeoutMs)) errors.push("gate.timeoutMs must be a positive number");
  return errors;
}
function budget(value: unknown): string[] {
  if (!isObject(value)) return ["budget must be an object {tokens?, costUsd?}"];
  const errors = unknown(value, ["tokens", "costUsd"], "budget.");
  if (value.tokens === undefined && value.costUsd === undefined) errors.push("budget needs tokens or costUsd");
  for (const k of ["tokens", "costUsd"]) if (value[k] !== undefined && !positive(value[k])) errors.push(`budget.${k} must be a positive number`);
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
  if (!text(s.agent)) errors.push("agent must be a non-empty string");
  if (!text(s.task)) errors.push("task must be a non-empty string");
  for (const k of ["model", "cwd", "output"]) if (has(k) && typeof s[k] !== "string") errors.push(`${k} must be a string`);
  if (has("timeoutMs") && !positive(s.timeoutMs)) errors.push("timeoutMs must be a positive number");
  if (has("schema")) errors.push(...schemaProblems(s.schema, "schema"));
  if (has("gate")) errors.push(...gate(s.gate));
  if (has("isolation") && s.isolation !== "none" && s.isolation !== "worktree") errors.push('isolation must be "none" or "worktree"');
  if (has("context") && s.context !== "fresh" && s.context !== "fork") errors.push('context must be "fresh" or "fork"');
  if (has("budget")) errors.push(...budget(s.budget));
  if (has("once") && typeof s.once !== "boolean") errors.push("once must be a boolean");
  for (const k of ["tools", "skills"]) if (has(k) && (!Array.isArray(s[k]) || !(s[k] as unknown[]).every(v => typeof v === "string"))) errors.push(`${k} must be an array of strings`);
  if (options.fanout && has("key") && !text(s.key)) errors.push("key must be a non-empty string");
  return errors;
}
