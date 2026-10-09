// R6 (owed requirements §20.2): caller labels of a run — `run --labels <json>`, the tool's `labels`, and the
// orchestrator's admission all validate with this one function. Labels are part of RunBody, so they are part of the
// request's spec_digest (the same request id with other labels is a request-conflict) and are echoed by `describe` and
// on every event of the workflow.

/** At most this many keys. */
export const LABELS_MAX_KEYS = 32;
/** A key: 1-64 characters of [A-Za-z0-9_.:-]. */
export const LABEL_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
/** A value: a string of at most this many UTF-16 units. */
export const LABEL_VALUE_MAX = 256;
/** The labels' JSON is at most this many UTF-8 bytes. */
export const LABELS_JSON_MAX = 4096;

/** What is wrong with `value` as run labels (naming the offending key), or undefined when they are valid. */
export function labelsProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "labels must be a JSON object of string values";
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return "labels must be a plain JSON object of string values";
  const entries = Object.entries(value);
  if (entries.length > LABELS_MAX_KEYS) return `labels have ${entries.length} keys; at most ${LABELS_MAX_KEYS}`;
  for (const [key, v] of entries) {
    if (!LABEL_KEY.test(key)) return `label key ${JSON.stringify(key)} must be 1-64 characters [A-Za-z0-9_.:-]`;
    if (typeof v !== "string") return `label ${JSON.stringify(key)} must have a string value`;
    if (v.length > LABEL_VALUE_MAX) return `label ${JSON.stringify(key)} is ${v.length} characters long; at most ${LABEL_VALUE_MAX}`;
  }
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > LABELS_JSON_MAX) return `labels are ${bytes} bytes of JSON; at most ${LABELS_JSON_MAX}`;
  return undefined;
}

/** Valid labels as given (throws the problem otherwise). */
export function checkLabels(value: unknown): Record<string, string> {
  const problem = labelsProblem(value);
  if (problem) throw new Error(problem);
  return value as Record<string, string>;
}

/** `--labels <json>`: parse and validate. */
export function parseLabels(json: string): Record<string, string> {
  let value: unknown;
  try { value = JSON.parse(json); } catch (error) { throw new Error(`--labels is not JSON: ${(error as Error).message}`); }
  return checkLabels(value);
}
