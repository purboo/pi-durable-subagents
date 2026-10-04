import { open, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Entry, JournalHandle } from '../types.ts';

function crc32(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
function decode(bytes: Buffer): { entries: Entry[]; length: number } {
  const entries: Entry[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset);
    if (end < 0) break;
    try {
      const line = bytes.subarray(offset, end), json = line.subarray(9);
      if (!/^[0-9a-f]{8} $/.test(line.subarray(0, 9).toString()) || crc32(json) !== line.subarray(0, 8).toString()) throw new Error('CRC');
      const entry = JSON.parse(json.toString()) as Entry;
      if (entry.seq !== entries.length + 1 || !Number.isFinite(entry.ts) || typeof entry.type !== 'string') throw new Error('Envelope');
      entries.push(entry);
    } catch (cause) {
      if (end !== bytes.length - 1) throw new Error(`Journal corruption at byte ${offset}`, { cause });
      break;
    }
    offset = end + 1;
  }
  return { entries, length: offset };
}
/** C11: Make directory changes durable before reporting publication success. */
export async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, 'r');
  try { await file.sync(); } finally { await file.close(); }
}
/** A1, C11: Read a committed snapshot without repairing or writing its tail. */
export function readJournalSnapshot(path: string): Entry[] {
  try { return decode(readFileSync(path)).entries; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
/** A1, C11: Repair only the tail, then serialize durable framed appends. */
export async function openJournal(path: string): Promise<JournalHandle> {
  await mkdir(dirname(path), { recursive: true });
  let created = false;
  const file = await open(path, 'ax+').then(f => { created = true; return f; }, async error => {
    if (error.code !== 'EEXIST') throw error;
    return open(path, 'a+');
  });
  let entries: Entry[];
  try {
    const bytes = await file.readFile(), decoded = decode(bytes);
    entries = decoded.entries;
    if (decoded.length !== bytes.length) { await file.truncate(decoded.length); await file.sync(); }
    if (created) { await file.sync(); await syncDirectory(dirname(path)); }
  } catch (error) { await file.close(); throw error; }
  let queue: Promise<unknown> = Promise.resolve(), closed = false, failed: unknown;
  return {
    path,
    entries: () => structuredClone(entries),
    append<T extends string>(type: T, fields: Record<string, unknown>): Promise<Entry<T>> {
      if (closed) return Promise.reject(new Error('Journal closed'));
      const frozen = structuredClone(fields);
      const operation = queue.then(async () => {
        if (failed) throw failed;
        const entry = { ...frozen, seq: entries.length + 1, ts: Date.now(), type } as Entry<T>;
        const json = JSON.stringify(entry), bytes = Buffer.from(json);
        await file.writeFile(`${crc32(bytes)} ${json}\n`);
        await file.sync();
        entries.push(JSON.parse(json));
        return structuredClone(entry);
      });
      queue = operation.catch(error => { failed = error; });
      return operation;
    },
    async close() { if (closed) return; closed = true; await queue; await file.close(); },
  };
}
