import { isDeepStrictEqual } from 'node:util';

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
