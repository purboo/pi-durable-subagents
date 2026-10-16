import { open, mkdir, type FileHandle } from 'node:fs/promises';
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import * as zlib from 'node:zlib';
import type { Entry, JournalHandle } from '../types.ts';

const TABLE = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
/** The CRC-32 (IEEE) of `bytes` as an unsigned number: node's native one when it has it (22.2+), else a table. */
const crcValue: (bytes: Uint8Array) => number = typeof (zlib as { crc32?: unknown }).crc32 === 'function'
  ? bytes => (zlib as unknown as { crc32(data: Uint8Array): number }).crc32(bytes)
  : bytes => {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
/** C11: the CRC-32 (IEEE) of a record, 8 lowercase hex digits: the frame of every journal line. */
export function crc32(bytes: Uint8Array): string {
  return crcValue(bytes).toString(16).padStart(8, '0');
}
/** The value of the 8 lowercase hex digits at `bytes[0..8)` followed by a space, or -1 when they are not that. */
function frameHead(bytes: Uint8Array): number {
  if (bytes.length < 9 || bytes[8] !== 32) return -1;
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const c = bytes[i]!, digit = c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : -1;
    if (digit < 0) return -1;
    value = value * 16 + digit;
  }
  return value;
}
/** C11: One framed line `<crc32 hex 8> <json>\n` (the journal format; the event log uses it too). */
export function frameLine(json: string): string { return `${crc32(Buffer.from(json))} ${json}\n`; }
/** C11: The JSON text of one framed line (without its newline), or undefined when its frame or checksum is wrong. */
export function unframeLine(line: Uint8Array): string | undefined {
  if (line.length < 10) return undefined;
  const head = frameHead(line), json = line.subarray(9);
  return head >= 0 && crcValue(json) === head ? Buffer.from(json.buffer, json.byteOffset, json.byteLength).toString() : undefined;
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
      const line = bytes.subarray(offset, end), json = line.subarray(9), head = frameHead(line);
      if (head < 0 || crcValue(json) !== head) throw new Error('CRC');
      const entry = JSON.parse(bytes.toString('utf8', offset + 9, end)) as Entry;
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
/** One read of a journal: its entries and the file they were read from. `length` is the committed bytes decoded; it
 *  is less than `size` while a torn or unfinished last line follows them. */
export type JournalRecord = { dev: number; ino: number; size: number; length: number; entries: readonly Entry[] };
const snapshots = new Map<string, JournalRecord>();
/** A1, C11: Read a committed snapshot without repairing or writing its tail. The result is shared and frozen. */
export function readJournalSnapshot(path: string): Entry[] {
  return (readJournalRecord(path)?.entries ?? []) as Entry[];
}
/** Drop a journal's cached entries (a reader that keeps what it derived from them no longer needs them in memory);
 *  the next read decodes the file again. */
export function forgetJournalSnapshot(path: string): void { snapshots.delete(path); }
/** Drop loaded snapshots selected by a compact reader; work is proportional to loaded journals, not settled history. */
export function forgetJournalSnapshotsIf(match: (path: string) => boolean): void {
  for (const path of snapshots.keys()) if (match(path)) snapshots.delete(path);
}
/** Whether a reader still retains this journal's decoded snapshot (for diagnostics). */
export function hasJournalSnapshot(path: string): boolean { return snapshots.has(path); }
/** readJournalSnapshot with the identity of what was read; undefined when the file does not exist. */
export function readJournalRecord(path: string): JournalRecord | undefined {
  let fd: number;
  try { fd = openSync(path, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { snapshots.delete(path); return undefined; } throw error; }
  try {
    const { dev, ino, size } = fstatSync(fd), cached = snapshots.get(path);
    if (cached && cached.dev === dev && cached.ino === ino && cached.size === size) return cached;
    const from = cached && cached.dev === dev && cached.ino === ino && size > cached.size ? cached.length : 0;
    const bytes = Buffer.alloc(size - from);
    for (let read = 0; read < bytes.length;) { const n = readSync(fd, bytes, read, bytes.length - read, from + read); if (!n) break; read += n; }
    const decoded = decode(bytes, from ? cached!.entries : []);
    const entries = Object.freeze(decoded.entries) as readonly Entry[];
    const record = { dev, ino, size, length: from + decoded.length, entries };
    snapshots.set(path, record);
    return record;
  } finally { closeSync(fd); }
}
/** A committed snapshot with the file identity it was read at, without keeping it in the shared snapshot cache (a
 *  cached snapshot of the same file is reused): for one-off scans over many journals whose entries are not needed
 *  again. `undefined` when the file does not exist. */
export function readJournalUncached(path: string): { ino: number; size: number; entries: readonly Entry[] } | undefined {
  let fd: number;
  try { fd = openSync(path, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const { dev, ino, size } = fstatSync(fd), cached = snapshots.get(path);
    if (cached && cached.dev === dev && cached.ino === ino && cached.size === size) return { ino, size, entries: cached.entries };
    const bytes = Buffer.alloc(size);
    for (let read = 0; read < bytes.length;) { const n = readSync(fd, bytes, read, bytes.length - read, read); if (!n) break; read += n; }
    return { ino, size, entries: decode(bytes).entries };
  } finally { closeSync(fd); }
}
/** A compact reader's position, with no decoded history. `length` stops before an uncommitted tail. */
export type JournalFold<T> = { dev: number; ino: number; size: number; length: number; seen: number; state: T };
/** Find candidate byte positions once per chunk, then advance only as JSON lines pass them. Latin-1 preserves
 *  byte offsets for literal multi-needle searches. Pending partial lines are included in the next chunk. */
function lineCandidates(bytes: Buffer, needles: readonly Buffer[], pattern?: RegExp): (start: number, end: number) => boolean {
  if (pattern) {
    const text = bytes.toString('latin1');
    pattern.lastIndex = 0;
    let hit = pattern.exec(text);
    return (start, end) => {
      if (hit && hit.index < start) { pattern.lastIndex = start; hit = pattern.exec(text); }
      return hit !== null && hit.index < end && hit.index + hit[0].length <= end;
    };
  }
  const needle = needles[0];
  let next = needle ? bytes.indexOf(needle) : -1;
  return (start, end) => {
    if (next >= 0 && next < start) next = bytes.indexOf(needle!, start);
    return next >= start && next + needle!.length <= end;
  };
}
/** Fold a committed prefix a bounded chunk at a time. Only one record (possibly larger than a chunk) is buffered;
 *  newly appended bytes extend the state, and replacement or shrink rebuilds it. Never repairs the journal.
 *  With needles, every line is still framed and CRC-checked and counted in seen, but only JSON bytes containing a
 *  needle are parsed/applied. The caller guarantees that every entry apply can act on contains a needle in its JSON
 *  text (use JSON.stringify of a string field value, or a canonical key/value pair). False positives only cost a
 *  parse. Syntax/envelope validation applies to parsed lines; skipped lines still preserve framing/CRC corruption
 *  and torn-tail semantics. Keep the same needles and reducer when extending a prior fold. */
export function readJournalFold<T>(path: string, prior: JournalFold<T> | undefined, empty: () => T, apply: (state: T, entry: Entry, offset: number) => void,
  options: { needles?: readonly string[] } = {}): JournalFold<T> | undefined {
  let fd: number;
  try { fd = openSync(path, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const { dev, ino, size } = fstatSync(fd);
    if (prior && prior.dev === dev && prior.ino === ino && prior.size === size) return prior;
    const kept = prior && prior.dev === dev && prior.ino === ino && size >= prior.size;
    const record: JournalFold<T> = kept ? { ...prior, size } : { dev, ino, size, length: 0, seen: 0, state: empty() };
    // A literal newline cannot occur within one framed JSON line. Empty needles match every line.
    let needles = options.needles?.map(needle => Buffer.from(needle)).filter(needle => !needle.includes(10));
    if (needles?.some(needle => !needle.length)) needles = undefined;
    // One literal alternation scans a chunk once for a set of types/IDs, instead of once for every needle.
    const pattern = needles && needles.length > 1 ? new RegExp(needles.map(needle => needle.toString('latin1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : undefined;
    let offset = record.length, pending: Buffer[] = [];
    const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, size - offset)));
    while (offset < size) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!n) throw new Error(`Journal changed during read: ${path}`);
      offset += n;
      const part = buffer.subarray(0, n);
      if (pending.length && part.indexOf(10) < 0) { pending.push(Buffer.from(part)); continue; }
      const bytes = pending.length ? Buffer.concat([...pending, part]) : part;
      let candidate: ReturnType<typeof lineCandidates> | undefined;
      let start = 0, end: number;
      while ((end = bytes.indexOf(10, start)) >= 0) {
        let entry: Entry | undefined;
        try {
          const line = bytes.subarray(start, end), json = line.subarray(9), head = frameHead(line);
          if (line.length < 10 || head < 0 || crcValue(json) !== head) throw new Error('CRC');
          if (!needles || (candidate ??= lineCandidates(bytes, needles, pattern))(start + 9, end)) {
            entry = JSON.parse(json.toString('utf8')) as Entry;
            if (entry.seq !== record.seen + 1 || !Number.isFinite(entry.ts) || typeof entry.type !== 'string') throw new Error('Envelope');
          }
        } catch (cause) {
          if (offset - bytes.length + end !== size - 1) throw new Error(`Journal corruption at byte ${record.length}`, { cause });
          return record;
        }
        if (entry) apply(record.state, entry, record.length);
        record.seen++; record.length += end + 1 - start; start = end + 1;
      }
      pending = start < bytes.length ? [Buffer.from(bytes.subarray(start))] : [];
    }
    return record;
  } finally { closeSync(fd); }
}
/** Find the first matching record without retaining history. Needles have the same caller guarantee as
 *  readJournalFold: every entry match can accept must contain a needle in its JSON text. */
export function findJournalEntry(path: string, match: (entry: Entry) => boolean, options: { needles?: readonly string[] } = {}): Entry | undefined {
  return readJournalFold<{ found?: Entry }>(path, undefined, () => ({}), (state, entry) => { if (!state.found && match(entry)) state.found = entry; }, options)?.state.found;
}

/** Read one framed entry at an offset indexed by this journal's single writer. Never retains a snapshot. */
export function journalEntryAt(path: string, offset: number): Entry {
  const fd = openSync(path, 'r');
  try {
    const chunks: Buffer[] = [], buffer = Buffer.alloc(4096);
    for (let pos = offset; ;) {
      const n = readSync(fd, buffer, 0, buffer.length, pos);
      if (!n) throw new Error(`Missing journal entry at byte ${offset}`);
      const end = buffer.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buffer.subarray(0, end < 0 ? n : end)));
      if (end >= 0) break;
      pos += n;
    }
    const json = unframeLine(Buffer.concat(chunks));
    if (json === undefined) throw new Error(`Journal corruption at byte ${offset}`);
    return JSON.parse(json) as Entry;
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
  return (await openHandle(path))!;
}
/** A1, C11: The same durable writer with a streaming fold instead of resident history. The reducer must not throw. */
export async function openFoldedJournal(path: string, apply: (entry: Entry, offset: number) => void): Promise<Pick<JournalHandle, 'append' | 'close'>> {
  return (await openHandle(path, undefined, apply))!;
}
/** What a lazy open checks a journal against: its file identity and size, how many entries it has, and its last
 *  framed line (`tail`: its CRC-32, `tailLength`: its bytes with the newline). */
export interface JournalExpectation { ino: number; size: number; count: number; tail: string; tailLength: number }
/** The expectation a journal handle meets now (its committed bytes, read back from the file), for a later lazy open;
 *  undefined when the file has no complete entry or does not end at the committed length. */
export function journalExpectation(journal: JournalHandle): JournalExpectation | undefined {
  const entries = journal.committed?.() ?? journal.entries(), count = entries.length;
  if (!count) return undefined;
  let fd: number;
  try { fd = openSync(journal.path, 'r'); } catch { return undefined; }
  try {
    const { ino, size } = fstatSync(fd), tail = lastLine(fd, size);
    if (!tail) return undefined;
    // The last line must be the last committed entry (a torn tail is truncated by every open, never trusted).
    const json = unframeLine(tail.subarray(0, tail.length - 1));
    if (json === undefined || (JSON.parse(json) as Entry).seq !== count) return undefined;
    return { ino, size, count, tail: crc32(tail), tailLength: tail.length };
  } catch { return undefined; } finally { closeSync(fd); }
}
/** The last line of the file (with its newline), when the file ends with one. Reads from the end in chunks. */
function lastLine(fd: number, size: number): Buffer | undefined {
  if (!size) return undefined;
  let chunk = 4096, buffer = Buffer.alloc(0);
  for (let end = size; ;) {
    const start = Math.max(0, end - chunk), part = Buffer.alloc(end - start);
    for (let read = 0; read < part.length;) { const n = readSync(fd, part, read, part.length - read, start + read); if (!n) return undefined; read += n; }
    buffer = Buffer.concat([part, buffer]);
    if (buffer[buffer.length - 1] !== 10) return undefined;
    const previous = buffer.lastIndexOf(10, buffer.length - 2);
    if (previous >= 0) return buffer.subarray(previous + 1);
    if (start === 0) return buffer;
    end = start; chunk *= 2;
  }
}
/** A1, C11: A journal handle that decodes nothing yet: when the file still is what `expect` describes (same inode and
 *  size, the same last line), the handle reports `loaded: false` and `count()` from it, and decodes the whole file
 *  (verifying it as openJournal does) on the first access to its entries or the first append. Undefined when the file
 *  is not what was expected: the caller opens it eagerly. Decoding later finds the same bytes or throws (one writer). */
export async function openLazyJournal(path: string, expect: JournalExpectation): Promise<JournalHandle | undefined> {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return undefined; }
  try {
    const { ino, size } = fstatSync(fd);
    if (ino !== expect.ino || size !== expect.size || expect.count < 1 || expect.tailLength < 10 || expect.tailLength > size) return undefined;
    const tail = Buffer.alloc(expect.tailLength);
    for (let read = 0; read < tail.length;) { const n = readSync(fd, tail, read, tail.length - read, size - tail.length + read); if (!n) return undefined; read += n; }
    if (tail[tail.length - 1] !== 10 || tail.indexOf(10) !== tail.length - 1 || crc32(tail) !== expect.tail) return undefined;
    if (size > tail.length) {
      const before = Buffer.alloc(1);
      if (readSync(fd, before, 0, 1, size - tail.length - 1) !== 1 || before[0] !== 10) return undefined;
    }
  } catch { return undefined; } finally { closeSync(fd); }
  return openHandle(path, expect);
}
/** Decode a journal synchronously as openJournal does (a torn tail is truncated), for a lazy handle's first access. */
function loadSync(path: string, expect: JournalExpectation): { entries: Entry[]; size: number } {
  const fd = openSync(path, 'r+');
  try {
    const { ino, size } = fstatSync(fd);
    if (ino !== expect.ino || size !== expect.size) throw new Error(`Journal changed while not loaded: ${path} has ${size} bytes, ${expect.size} expected`);
    const bytes = readFileSync(fd), decoded = decode(bytes);
    if (decoded.entries.length !== expect.count) throw new Error(`Journal changed while not loaded: ${path} has ${decoded.entries.length} entries, ${expect.count} expected`);
    if (decoded.length !== bytes.length) { ftruncateSync(fd, decoded.length); fsyncSync(fd); }
    return { entries: decoded.entries, size: decoded.length };
  } finally { closeSync(fd); }
}
async function openHandle(path: string, lazy?: JournalExpectation, apply?: (entry: Entry, offset: number) => void): Promise<JournalHandle | undefined> {
  let entries: Entry[] | undefined, size: number, file: FileHandle | undefined, count = lazy?.count ?? 0;
  if (lazy) size = lazy.size;
  else {
  await mkdir(dirname(path), { recursive: true });
  let created = false;
  const first = await open(path, 'ax+').then(f => { created = true; return f; }, async error => {
    if (error.code !== 'EEXIST') throw error;
    return open(path, 'a+');
  });
  try {
    if (apply) {
      const folded = readJournalFold(path, undefined, () => undefined, (_state, entry, offset) => apply(freeze(entry), offset))!;
      size = folded.length; count = folded.seen;
    } else {
      const decoded = decode(await first.readFile());
      entries = decoded.entries; size = decoded.length; count = entries.length;
    }
    if (size !== (await first.stat()).size) { await first.truncate(size); await first.sync(); }
    if (created) { await first.sync(); await syncDirectory(dirname(path)); }
  } catch (error) { await first.close(); throw error; }
  file = first;
  descriptors++;
  }
  /** The entries, decoding a lazy handle's file first. */
  const all = (): Entry[] => {
    if (apply) throw new Error('Folded journal does not retain entries');
    if (!entries) { const loaded = loadSync(path, lazy!); entries = loaded.entries; size = loaded.size; }
    return entries;
  };
  let queue: Promise<unknown> = Promise.resolve(), closed = false, failed: unknown, view: Entry[] | undefined;
  let resting = lazy !== undefined, restTimer: ReturnType<typeof setTimeout> | undefined;
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
    entries: () => view ??= Object.freeze(all().slice()) as Entry[],
    // The growing array itself (no copy): it is only ever appended to, so a reader may keep it and read below a length
    // it saw (the event pump reads new entries per tick without copying the journal).
    committed: () => all(),
    get loaded() { return entries !== undefined; },
    count: () => count,
    onAppend: undefined,
    append<T extends string>(type: T, fields: Record<string, unknown>): Promise<Entry<T>> {
      if (closed) return Promise.reject(new Error('Journal closed'));
      const frozen = structuredClone(fields);
      const operation = queue.then(async () => {
        if (failed) throw failed;
        if (!apply) all();
        const entry = { ...frozen, seq: count + 1, ts: Date.now(), type } as Entry<T>;
        const json = JSON.stringify(entry), bytes = Buffer.from(json), line = `${crc32(bytes)} ${json}\n`;
        let target: FileHandle;
        try { target = await reopen(); }
        catch (error) { unwritten.add(error as object); throw error; }
        await target.writeFile(line);
        await target.sync();
        const offset = size;
        size += Buffer.byteLength(line);
        const committed = freeze(JSON.parse(json)) as Entry;
        if (apply) apply(committed, offset); else entries!.push(committed);
        count++; view = undefined; appends++;
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
