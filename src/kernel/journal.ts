import { open, mkdir } from 'node:fs/promises';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Entry, JournalHandle } from '../types.ts';

const TABLE = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
/** Entries are immutable history (A1): freeze them so shared snapshots can be handed out without copying. */
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const v of Object.values(value)) freeze(v); }
  return value;
}
function decode(bytes: Buffer, prior: readonly Entry[] = []): { entries: Entry[]; length: number } {
  const entries: Entry[] = prior.slice();
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset);
    if (end < 0) break;
    try {
      const line = bytes.subarray(offset, end), json = line.subarray(9);
      if (!/^[0-9a-f]{8} $/.test(line.subarray(0, 9).toString()) || crc32(json) !== line.subarray(0, 8).toString()) throw new Error('CRC');
      const entry = JSON.parse(json.toString()) as Entry;
      if (entry.seq !== entries.length + 1 || !Number.isFinite(entry.ts) || typeof entry.type !== 'string') throw new Error('Envelope');
      entries.push(freeze(entry));
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
// Readers poll journals (UI, main agent, CLI). Committed bytes never change, so a snapshot is extended by decoding
// only the bytes appended since the last read; a different inode or a shorter file is read from scratch.
const snapshots = new Map<string, { ino: number; size: number; length: number; entries: readonly Entry[] }>();
/** A1, C11: Read a committed snapshot without repairing or writing its tail. The result is shared and frozen. */
export function readJournalSnapshot(path: string): Entry[] {
  let fd: number;
  try { fd = openSync(path, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { snapshots.delete(path); return []; } throw error; }
  try {
    const { ino, size } = fstatSync(fd), cached = snapshots.get(path);
    if (cached && cached.ino === ino && cached.size === size) return cached.entries as Entry[];
    const from = cached && cached.ino === ino && size > cached.size ? cached.length : 0;
    const bytes = Buffer.alloc(size - from);
    for (let read = 0; read < bytes.length;) { const n = readSync(fd, bytes, read, bytes.length - read, from + read); if (!n) break; read += n; }
    const decoded = decode(bytes, from ? cached!.entries : []);
    const entries = Object.freeze(decoded.entries) as readonly Entry[];
    snapshots.set(path, { ino, size, length: from + decoded.length, entries });
    return entries as Entry[];
  } finally { closeSync(fd); }
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
  let queue: Promise<unknown> = Promise.resolve(), closed = false, failed: unknown, view: Entry[] | undefined;
  return {
    path,
    // Shared frozen view, rebuilt only after an append (entries are immutable, see freeze()).
    entries: () => view ??= Object.freeze(entries.slice()) as Entry[],
    append<T extends string>(type: T, fields: Record<string, unknown>): Promise<Entry<T>> {
      if (closed) return Promise.reject(new Error('Journal closed'));
      const frozen = structuredClone(fields);
      const operation = queue.then(async () => {
        if (failed) throw failed;
        const entry = { ...frozen, seq: entries.length + 1, ts: Date.now(), type } as Entry<T>;
        const json = JSON.stringify(entry), bytes = Buffer.from(json);
        await file.writeFile(`${crc32(bytes)} ${json}\n`);
        await file.sync();
        entries.push(freeze(JSON.parse(json))); view = undefined;
        return structuredClone(entry);
      });
      queue = operation.catch(error => { failed = error; });
      return operation;
    },
    async close() { if (closed) return; closed = true; await queue; await file.close(); },
    get closed() { return closed; },
  };
}
