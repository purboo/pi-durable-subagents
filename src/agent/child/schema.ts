import { ASK_FIELDS } from '../../types.ts';
import { isDeepStrictEqual } from 'node:util';

const keywords = new Set(['type', 'enum', 'items', 'properties', 'required', 'additionalProperties', 'description', 'title']);
const types = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** AK2: validate before creating a question, revision or waiter. No coercion. */
export function askProblem(value: unknown, requireDecision = false): string | undefined {
  if (!isObject(value)) return 'ask refused: arguments must be an object';
  const structured = ASK_FIELDS.some(key => Object.hasOwn(value, key));
  if ((structured || requireDecision) && (value.decision_needed === undefined || typeof value.decision_needed === 'string' && !value.decision_needed.trim()))
    return 'ask refused: decision_needed is required (one sentence naming the decision you need), then options';
  const string = (v: unknown, at: string) => typeof v !== 'string' ? `${at} must be a string` : v.length > 2000 ? `${at} exceeds 2000 characters` : undefined;
  const list = (v: unknown, at: string, max: number, item: (v: unknown, at: string) => string | undefined): string | undefined => {
    if (!Array.isArray(v)) return `${at} must be an array`;
    if (v.length > max) return `${at} exceeds ${max} items`;
    for (const [i, entry] of v.entries()) { const problem = item(entry, `${at}[${i}]`); if (problem) return problem; }
  };
  let problem = string(value.question, 'question');
  if (!problem && Object.hasOwn(value, 'decision_needed')) problem = string(value.decision_needed, 'decision_needed');
  for (const key of ['facts', 'tried'] as const) if (!problem && Object.hasOwn(value, key)) problem = list(value[key], key, 20, string);
  if (!problem && Object.hasOwn(value, 'options')) {
    problem = list(value.options, 'options', 9, (v, at) => {
      if (!isObject(v)) return `${at} must be an object`;
      let p = string(v.label, `${at}.label`);
      for (const key of ['scope', 'cost', 'risk']) if (!p && Object.hasOwn(v, key)) p = string(v[key], `${at}.${key}`);
      if (!p && Object.hasOwn(v, 'preferred') && typeof v.preferred !== 'boolean') p = `${at}.preferred must be a boolean`;
      return p;
    });
    if (!problem && (value.options as { preferred?: boolean }[]).filter(o => o.preferred).length > 1) problem = 'at most one option may be preferred';
  }
  if (!problem && Object.hasOwn(value, 'classification_candidates')) problem = list(value.classification_candidates, 'classification_candidates', 9, (v, at) => {
    if (!isObject(v)) return `${at} must be an object`;
    let p = string(v.label, `${at}.label`);
    for (const key of ['evidence', 'unproven']) if (!p && Object.hasOwn(v, key)) p = list(v[key], `${at}.${key}`, Infinity, string);
    return p;
  });
  return problem ? `ask refused: ${problem}` : undefined;
}

/** P24, T4: List unsupported keywords and malformed shapes so a schema that would not constrain fails loudly. */
export function schemaProblems(schema: unknown, path = '$'): string[] {
  if (typeof schema === 'boolean') return [];
  if (!isObject(schema)) return [`${path}: must be an object or boolean`];
  const problems: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    const at = `${path}.${key}`;
    if (!keywords.has(key)) problems.push(`${path}: unsupported keyword "${key}"`);
    else if (key === 'type') {
      const names = Array.isArray(value) ? value : [value];
      if (!names.length || !names.every(n => typeof n === 'string' && types.has(n))) problems.push(`${at}: must be one of ${[...types].join(', ')} or a nonempty array of them`);
    } else if (key === 'enum') { if (!Array.isArray(value)) problems.push(`${at}: must be an array`); }
    else if (key === 'items' || key === 'additionalProperties') problems.push(...schemaProblems(value, at));
    else if (key === 'properties') {
      if (!isObject(value)) problems.push(`${at}: must be an object of schemas`);
      else for (const [name, item] of Object.entries(value)) problems.push(...schemaProblems(item, `${at}.${name}`));
    } else if (key === 'required') { if (!Array.isArray(value) || !value.every(n => typeof n === 'string')) problems.push(`${at}: must be an array of strings`); }
    else if (typeof value !== 'string') problems.push(`${at}: must be a string`);
  }
  return problems;
}

/** P24: Validate the supported JSON schema vocabulary without coercion or dependencies. */
export function validate(schema: unknown, value: unknown, path = '$'): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${path}: forbidden`];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Invalid report schema');
  const s = schema as Record<string, any>, errors: string[] = [];
  const matches = (type: string) => {
    if (type === 'null') return value === null;
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    return typeof value === type;
  };
  if (s.type && !(Array.isArray(s.type) ? s.type : [s.type]).some(matches)) errors.push(`${path}: expected ${s.type}`);
  if (s.enum && !s.enum.some((item: unknown) => isDeepStrictEqual(item, value))) errors.push(`${path}: not in enum`);
  if (Array.isArray(value) && s.items !== undefined) value.forEach((item, i) => errors.push(...validate(s.items, item, `${path}[${i}]`)));
  if (matches('object')) {
    const obj = value as Record<string, unknown>, properties = s.properties ?? {};
    for (const key of s.required ?? []) if (!Object.hasOwn(obj, key)) errors.push(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(obj)) {
      if (Object.hasOwn(properties, key)) errors.push(...validate(properties[key], item, `${path}.${key}`));
      else if (s.additionalProperties === false) errors.push(`${path}.${key}: additional property`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') errors.push(...validate(s.additionalProperties, item, `${path}.${key}`));
    }
  }
  return errors;
}
