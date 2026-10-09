import { open, mkdir, type FileHandle } from 'node:fs/promises';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Entry, JournalHandle } from '../types.ts';

const TABLE = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
/** C11: the CRC-32 (IEEE) of a record, 8 lowercase hex digits: the frame of every journal line. */
export function crc32(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
/** C11: One framed line `<crc32 hex 8> <json>\n` (the journal format; the event log uses it too). */
export function frameLine(json: string): string { return `${crc32(Buffer.from(json))} ${json}\n`; }
/** C11: The JSON text of one framed line (without its newline), or undefined when its frame or checksum is wrong. */
export function unframeLine(line: Uint8Array): string | undefined {
  if (line.length < 10 || line[8] !== 32) return undefined;
  const head = Buffer.from(line.subarray(0, 8)).toString(), json = line.subarray(9);
  return /^[0-9a-f]{8}$/.test(head) && crc32(json) === head ? Buffer.from(json).toString() : undefined;
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
/** How long a resting journal keeps its descriptor after its last append (a burst of appends opens it once). */
export const JOURNAL_REST_MS = 1000;
let descriptors = 0, appends = 0;
/** Appends committed by this process to any journal: a fold over journal entries only can be reused while it stays. */
export function journalAppends(): number { return appends; }
/** Journal descriptors this process holds open now (handles opened by openJournal, resting ones excluded). */
export function openJournalDescriptors(): number { return descriptors; }
/** A1, C11: Repair only the tail, then serialize durable framed appends. A resting handle (`resting = true`) closes its
 *  descriptor once its appends are done and reopens it for the next append; its entries stay in memory. */
export async function openJournal(path: string): Promise<JournalHandle> {
  await mkdir(dirname(path), { recursive: true });
  let created = false;
  const first = await open(path, 'ax+').then(f => { created = true; return f; }, async error => {
    if (error.code !== 'EEXIST') throw error;
    return open(path, 'a+');
  });
  let entries: Entry[], size: number;
  try {
    const bytes = await first.readFile(), decoded = decode(bytes);
    entries = decoded.entries; size = decoded.length;
    if (decoded.length !== bytes.length) { await first.truncate(decoded.length); await first.sync(); }
    if (created) { await first.sync(); await syncDirectory(dirname(path)); }
  } catch (error) { await first.close(); throw error; }
  let file: FileHandle | undefined = first;
  descriptors++;
  let queue: Promise<unknown> = Promise.resolve(), closed = false, failed: unknown, view: Entry[] | undefined;
  let resting = false, restTimer: ReturnType<typeof setTimeout> | undefined;
  // Only this process writes the file (A2): a reopened file that is not exactly what was committed was changed by
  // someone else, and appending to it could interleave records.
  const reopen = async (): Promise<FileHandle> => {
    if (file) return file;
    const f = await open(path, constants.O_WRONLY | constants.O_APPEND);
    try { const now = (await f.stat()).size; if (now !== size) throw new Error(`Journal changed while closed: ${path} has ${now} bytes, ${size} committed`); }
    catch (error) { await f.close(); throw error; }
    descriptors++;
    return file = f;
  };
  const release = async () => {
    if (!file || !resting || closed) return;
    const f = file; file = undefined; descriptors--;
    await f.close().catch(error => console.error(`durable-subagents: closing resting journal ${path} failed: ${String(error)}`));
  };
  const unwritten = new WeakSet<object>();
  const rest = () => {
    if (restTimer) { restTimer.refresh(); return; }
    if (!resting || closed || !file) return;
    restTimer = setTimeout(() => { restTimer = undefined; queue = queue.then(release); }, JOURNAL_REST_MS);
    restTimer.unref?.();
  };
  const handle: JournalHandle = {
    path,
    // Shared frozen view, rebuilt only after an append (entries are immutable, see freeze()).
    entries: () => view ??= Object.freeze(entries.slice()) as Entry[],
    // The growing array itself (no copy): it is only ever appended to, so a reader may keep it and read below a length
    // it saw (the event pump reads new entries per tick without copying the journal).
    committed: () => entries,
    onAppend: undefined,
    append<T extends string>(type: T, fields: Record<string, unknown>): Promise<Entry<T>> {
      if (closed) return Promise.reject(new Error('Journal closed'));
      const frozen = structuredClone(fields);
      const operation = queue.then(async () => {
        if (failed) throw failed;
        const entry = { ...frozen, seq: entries.length + 1, ts: Date.now(), type } as Entry<T>;
        const json = JSON.stringify(entry), bytes = Buffer.from(json), line = `${crc32(bytes)} ${json}\n`;
        let target: FileHandle;
        try { target = await reopen(); }
        catch (error) { unwritten.add(error as object); throw error; }
        await target.writeFile(line);
        await target.sync();
        size += Buffer.byteLength(line);
        entries.push(freeze(JSON.parse(json))); view = undefined; appends++;
        rest();
        try { handle.onAppend?.(); } catch (error) { console.error(`durable-subagents: journal listener failed: ${String(error)}`); }
        return structuredClone(entry);
      });
      // A failed reopen wrote nothing: the next append tries again. A failed write or sync leaves the file unknown.
      queue = operation.catch(error => { if (!(error && typeof error === 'object' && unwritten.has(error))) failed = error; });
      return operation;
    },
    async close() {
      if (closed) return; closed = true; clearTimeout(restTimer); await queue;
      if (file) { const f = file; file = undefined; descriptors--; await f.close(); }
    },
    get closed() { return closed; },
    get resting() { return resting; },
    set resting(value: boolean) {
      resting = value;
      if (value) rest(); else { clearTimeout(restTimer); restTimer = undefined; }
    },
    get descriptorOpen() { return file !== undefined; },
  };
  return handle;
}
