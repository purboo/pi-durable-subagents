import { createHash, randomBytes } from 'node:crypto';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let last = -1n;
/** A3: Generate process-monotonic ULIDs, including during clock rollback. */
export function ulid(): string {
  const candidate = (BigInt(Date.now()) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
  last = candidate > last ? candidate : last + 1n;
  let value = last, result = '';
  for (let i = 0; i < 26; i++) { result = alphabet[Number(value & 31n)] + result; value >>= 5n; }
  return result;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Value is not JSON');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(v => canonical(v ?? null)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().filter(k => object[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(object[k])}`).join(',')}}`;
}
/** A3, P7: Hash canonical JSON with recursively sorted object keys. */
export function contentHash(obj: unknown): string {
  const json = JSON.stringify(obj);
  if (json === undefined) throw new TypeError('Value is not JSON');
  return createHash('sha256').update(canonical(JSON.parse(json))).digest('hex');
}
/** P7: Bind a forwarded identity to its source, destination and immutable content. */
export function forwardRid(rid: string, widRev: string, key: string, hash: string): string {
  return contentHash([rid, widRev, key, hash]);
}
/** A file name for an identity. Windows refuses `:` (and several other characters) in a name, while request ids may
 *  contain them (`req:r1`, a sender `cli:user@host`); percent-encoding keeps the mapping deterministic and reversible
 *  inside the code. Other platforms keep the historical raw names. */
export function fileId(id: string): string {
  if (/[/\\\0]/.test(id)) throw new Error('Invalid file identity');
  if (process.platform !== "win32") return id;
  const encoded = id.replace(/[%:/\\<>"|?*\x00-\x1f]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(encoded) ? `_${encoded}` : encoded;
}
