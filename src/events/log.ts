// The cross-workflow event log, `<home>/events.jsonl`. Single writer: the orchestrator (under its OS lock). Each line
// is CRC-framed like the journals (`<crc32 hex 8> <json>\n`, kernel/journal.ts); a reader ignores a torn final line, a
// bad line before the last one is corruption. Records (`k`):
//   log  {v, epoch, dropped}   first line, written when the file is created or compacted. `epoch` (16 hex chars, random)
//                              names this log: cursors of another epoch are expired. `dropped` = highest seq ever dropped
//                              by retention (monotone; carried over by compaction).
//   ev   {seq, at, e}          one event: `e` is the draft (everything but the cursor, which is `<epoch>:<seq>`); `at` =
//                              append time (ms), which retention measures (not the milestone `e.ts`).
//   head {seq}                 an orchestrator start: the head jumps EVENT_SEQ_SKIP ahead (fsynced before any event of
//                              that start), so a seq that a reader saw in a write a power loss undid is never reused.
//                              Also written alone after failed writes: seqs a failed write spent (a reader may have
//                              seen them) become durable before a write would go past durable + EVENT_SEQ_SKIP.
//   mark {head, src}           deriver watermarks, source -> highest source seq derived ("orch" = orchestrator ledger,
//                              else a wid); later records override earlier ones per source. Compaction writes them all.
// Every record's position (log 0, ev/head seq, mark head) is non-decreasing in file order: the last record gives the
// head, and readers binary-search byte offsets for `--since`. Seqs grow strictly but may have gaps.
// Compaction writes a new file (header, kept events, full mark), fsyncs it, renames it over the log and fsyncs the
// directory; a failure after the rename leaves the writer broken (its handle may name the replaced file), and the
// pump reopens the log. A log that is unreadable beyond a torn tail is renamed aside (`events.jsonl.corrupt-<ms>`) and
// a new epoch begins; it is never truncated in the middle. Open removes temp files a crashed compaction left.
// Seq invariant: the highest seq any reader can have seen <= the last durable position + EVENT_SEQ_SKIP, so the start
// skip of the next open is past it.
import { closeSync, fstatSync, fsyncSync, openSync, readSync, writeSync } from "node:fs";
import { open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { frameLine, syncDirectory, unframeLine } from "../kernel/journal.ts";
import { EVENT_SEQ_SKIP, type Event, type EventDraft } from "./types.ts";

export type LogRecord =
  | { k: "log"; v: number; epoch: string; dropped: number }
  | { k: "ev"; seq: number; at: number; e: EventDraft }
  | { k: "head"; seq: number }
  | { k: "mark"; head: number; src: Record<string, number> };
export const EPOCH = /^[0-9a-f]{16}$/;
const CHUNK = 1 << 16, NEWLINE = Buffer.from("\n");

/** A framed line's record, or undefined when its frame, checksum or shape is wrong. */
export function parseRecord(line: Uint8Array): LogRecord | undefined {
  const json = unframeLine(line);
  if (json === undefined) return undefined;
  let r: Record<string, unknown>;
  try { r = JSON.parse(json); } catch { return undefined; }
  const n = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (r?.k === "log" && typeof r.epoch === "string" && EPOCH.test(r.epoch) && n(r.dropped)) return r as LogRecord;
  if (r?.k === "ev" && n(r.seq) && typeof r.at === "number" && r.e && typeof r.e === "object") return r as LogRecord;
  if (r?.k === "head" && n(r.seq)) return r as LogRecord;
  if (r?.k === "mark" && n(r.head) && r.src && typeof r.src === "object") return r as LogRecord;
  return undefined;
}
export const position = (r: LogRecord) => r.k === "ev" || r.k === "head" ? r.seq : r.k === "mark" ? r.head : 0;
/** The public form of a logged event: id and cursor first. */
export function publicEvent(epoch: string, r: Extract<LogRecord, { k: "ev" }>): Event {
  const { id, ...rest } = r.e as EventDraft & { cursor?: string };
  delete rest.cursor;
  return { id, cursor: `${epoch}:${r.seq}`, ...rest } as Event;
}
export class LogCorrupt extends Error { override name = "LogCorrupt"; }

/** Visit the complete lines of `fd` in [from, to) in order (`visit` returns false to stop). Returns the offset after
 *  the last complete line visited (the end of the readable prefix). */
export function scanLines(fd: number, from: number, to: number, visit: (line: Buffer, start: number) => boolean | void): number {
  let carry = Buffer.alloc(0), start = from, offset = from;
  while (offset < to) {
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK, to - offset)), read = readSync(fd, buffer, 0, buffer.length, offset);
    if (!read) break;
    offset += read;
    const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, read)]) : buffer.subarray(0, read);
    let pos = 0;
    for (;;) {
      const nl = data.indexOf(10, pos);
      if (nl < 0) break;
      if (visit(data.subarray(pos, nl), start + pos) === false) return start + nl + 1;
      pos = nl + 1;
    }
    carry = Buffer.from(data.subarray(pos)); start += pos;
  }
  return start;
}

/** What a full scan of a log file finds. `end` = length of its valid prefix (a torn tail starts there). */
interface Scan { epoch: string; dropped: number; head: number; marks: Map<string, number>; end: number; records: number; events: number }
function scanFile(fd: number, size: number): Scan {
  let header: Extract<LogRecord, { k: "log" }> | undefined, head = 0, bad: number | undefined, records = 0, events = 0;
  const marks = new Map<string, number>();
  const end = scanLines(fd, 0, size, (line, start) => {
    if (bad !== undefined) throw new LogCorrupt(`event log corrupt at byte ${bad}`);
    const r = parseRecord(line);
    if (!r) { bad = start; return; }
    if (!header) { if (r.k !== "log") throw new LogCorrupt("event log has no header"); header = r; return; }
    if (r.k === "log") throw new LogCorrupt(`event log has a second header at byte ${start}`);
    const p = position(r);
    if (p < head || (r.k === "ev" && p === head && events)) throw new LogCorrupt(`event log out of order at byte ${start}`);
    head = p; records++;
    if (r.k === "ev") events++;
    if (r.k === "mark") for (const [source, seq] of Object.entries(r.src)) if (typeof seq === "number") marks.set(source, seq);
  });
  if (!header) throw new LogCorrupt("event log has no header");
  return { epoch: header.epoch, dropped: header.dropped, head: Math.max(head, header.dropped), marks, end: bad ?? end, records, events };
}

/** The writer. Appends, compaction and close are serialized; an append resolves only after fsync. */
export class EventLog {
  readonly path: string;
  readonly epoch: string;
  /** The last seq handed out (spent: also by a write that failed), or the start skip's head. */
  head: number;
  /** The position of the last record durably in the file (head >= durable; head <= durable + EVENT_SEQ_SKIP). */
  private durable: number;
  /** Highest seq dropped by retention. */
  dropped: number;
  private file: FileHandle;
  private size: number;
  private queue: Promise<unknown> = Promise.resolve();
  /** Set when the file is in an unknown state (a failed cut-back, a failure after a compaction's rename): every later
   *  operation throws it; the owner reopens the log (EventLog.open). */
  private failed?: unknown;
  private redundant: number;
  private constructor(path: string, file: FileHandle, scan: Pick<Scan, "epoch" | "dropped" | "head" | "end" | "records" | "events">) {
    this.path = path; this.file = file; this.epoch = scan.epoch; this.head = this.durable = scan.head; this.dropped = scan.dropped; this.size = scan.end;
    this.redundant = scan.records - scan.events;
  }
  /** The writer cannot be used any more: reopen the log. */
  get broken(): boolean { return this.failed !== undefined; }
  /** Open the log at orchestrator start: repair a torn tail, skip the head ahead (durably), or create a new log (new
   *  epoch) when it is missing or corrupt; `created` tells the caller to derive everything still on disk (backfill). */
  static async open(path: string): Promise<{ log: EventLog; created: boolean; marks: Map<string, number>; corrupt?: string }> {
    // A compaction that crashed before its rename left its temp file (single writer: none is in progress now).
    const base = basename(path), stale = (name: string) => name.startsWith(base) && /^\.[0-9a-f]{8}\.tmp$/.test(name.slice(base.length));
    for (const name of await readdir(dirname(path)).catch(() => [] as string[])) if (stale(name)) await rm(join(dirname(path), name), { force: true });
    let scan: Scan | undefined, corrupt: string | undefined;
    let fd: number | undefined;
    try { fd = openSync(path, "r"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (fd !== undefined) {
      try { scan = scanFile(fd, fstatSync(fd).size); }
      catch (error) { if (!(error instanceof LogCorrupt)) throw error; corrupt = error.message; }
      finally { closeSync(fd); }
    }
    if (corrupt) {
      const aside = `${path}.corrupt-${Date.now()}`;
      await rename(path, aside); await syncDirectory(dirname(path));
      corrupt = `${corrupt}; kept as ${aside}`;
    }
    if (!scan) {
      const epoch = randomBytes(8).toString("hex"), text = frameLine(JSON.stringify({ k: "log", v: 1, epoch, dropped: 0 }));
      await replace(path, async file => { await file.writeFile(text); });
      const file = await open(path, "a");
      return { log: new EventLog(path, file, { epoch, dropped: 0, head: 0, end: Buffer.byteLength(text), records: 0, events: 0 }), created: true, marks: new Map(), ...(corrupt ? { corrupt } : {}) };
    }
    const file = await open(path, "r+");
    try {
      if (scan.end !== (await file.stat()).size) { await file.truncate(scan.end); await file.sync(); }
    } finally { await file.close(); }
    const log = new EventLog(path, await open(path, "a"), scan);
    // The pump retries a broken log's reopen every second: a failed start skip must not leak the handle.
    try { await log.write(frameLine(JSON.stringify({ k: "head", seq: log.head + EVENT_SEQ_SKIP })), log.head + EVENT_SEQ_SKIP); }
    catch (error) { await log.file.close().catch(() => {}); throw error; }
    log.head += EVENT_SEQ_SKIP; log.redundant++;
    return { log, created: false, marks: scan.marks };
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => { if (this.failed) throw this.failed; return fn(); });
    this.queue = run.catch(() => {});
    return run;
  }
  /** Write and fsync records whose last position is `position`; on failure cut the file back to its last good length
   *  (or break the log when that fails too). */
  private async write(text: string, position: number): Promise<void> {
    try { await this.file.write(text); await this.file.sync(); }
    catch (error) {
      try { await this.file.truncate(this.size); await this.file.sync(); } catch (cause) { this.failed = cause; }
      throw error;
    }
    this.size += Buffer.byteLength(text); this.durable = Math.max(this.durable, position);
  }
  /** Append events (in writes of at most EVENT_SEQ_SKIP, each fsynced) and, with the last write, watermarks. Returns
   *  the events as logged (callers pass at most EVENT_SEQ_SKIP drafts at a time, so this stays small). */
  append(drafts: readonly EventDraft[], marks?: ReadonlyMap<string, number>): Promise<Event[]> {
    return this.serial(async () => {
      const out: Event[] = [];
      for (let i = 0; i < drafts.length || (i === 0 && marks?.size); i += EVENT_SEQ_SKIP) {
        const chunk = drafts.slice(i, i + EVENT_SEQ_SKIP), at = Date.now(), last = i + EVENT_SEQ_SKIP >= drafts.length;
        // Failed writes spent seqs past the durable head: make them durable (a lone head record) before this write could
        // spend beyond durable + EVENT_SEQ_SKIP, which the next open's skip would not clear. If that fails, no events.
        if (this.head + chunk.length > this.durable + EVENT_SEQ_SKIP) { await this.write(frameLine(JSON.stringify({ k: "head", seq: this.head })), this.head); this.redundant++; }
        let text = "", seq = this.head;
        for (const e of chunk) {
          const r = { k: "ev" as const, seq: ++seq, at, e };
          text += frameLine(JSON.stringify(r)); out.push(publicEvent(this.epoch, r));
        }
        if (last && marks?.size) text += frameLine(JSON.stringify({ k: "mark", head: seq, src: Object.fromEntries(marks) }));
        // The seqs are spent even when the write fails: a reader may have seen part of it.
        const spent = seq;
        try { await this.write(text, spent); }
        finally { this.head = spent; }
        if (last && marks?.size) this.redundant++;
      }
      return out;
    });
  }
  /** Retention: rewrite the log without the events `drop` selects (when there are any, or when superseded head/mark
   *  records pile up), keeping the header's epoch, a monotone `dropped`, every other event and the watermarks. */
  compact(drop: (r: Extract<LogRecord, { k: "ev" }>) => boolean, marks: ReadonlyMap<string, number>): Promise<number> {
    return this.serial(async () => {
      const fd = openSync(this.path, "r");
      let count = 0, highest = this.dropped;
      try {
        scanLines(fd, 0, this.size, line => {
          const r = parseRecord(line);
          if (r?.k === "ev" && drop(r)) { count++; highest = Math.max(highest, r.seq); }
        });
        if (!count && this.redundant < 1000) return 0;
        // Synchronous copy (bounded buffer): the kept lines are copied verbatim, never all held in memory.
        let size = 0;
        const temp = `${this.path}.${randomBytes(4).toString("hex")}.tmp`, out = openSync(temp, "wx", 0o600);
        try {
          let pending: Buffer[] = [], bytes = 0;
          const put = (chunk: Buffer, force = false) => {
            if (chunk.length) { pending.push(Buffer.from(chunk)); bytes += chunk.length; }
            if (bytes >= CHUNK * 16 || (force && bytes)) {
              const all = Buffer.concat(pending);
              for (let at = 0; at < all.length;) at += writeSync(out, all, at, all.length - at);
              size += all.length; pending = []; bytes = 0;
            }
          };
          put(Buffer.from(frameLine(JSON.stringify({ k: "log", v: 1, epoch: this.epoch, dropped: highest }))));
          scanLines(fd, 0, this.size, line => {
            const r = parseRecord(line);
            if (r?.k === "ev" && !drop(r)) { put(line); put(NEWLINE); }
          });
          put(Buffer.from(frameLine(JSON.stringify({ k: "mark", head: this.head, src: Object.fromEntries(marks) }))), true);
          fsyncSync(out);
        } catch (error) { closeSync(out); await rm(temp, { force: true }); throw error; }
        closeSync(out);
        try { await rename(temp, this.path); } catch (error) { await rm(temp, { force: true }); throw error; }
        // Past the rename this handle names the replaced file: any failure breaks the writer (the owner reopens).
        try {
          await syncDirectory(dirname(this.path));
          await this.file.close();
          this.file = await open(this.path, "a");
        } catch (error) { this.failed = error; throw error; }
        this.size = size; this.dropped = highest; this.redundant = 1; this.durable = this.head;
        return count;
      } finally { closeSync(fd); }
    });
  }
  close(): Promise<void> { return this.queue.then(() => this.file.close()).catch(() => {}); }
}

/** Write a file by temp + fsync + rename + directory fsync (atomic replacement). */
async function replace(path: string, fill: (file: FileHandle) => Promise<void>): Promise<void> {
  const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`, file = await open(temp, "wx", 0o600);
  try { await fill(file); await file.sync(); }
  catch (error) { await file.close().catch(() => {}); await rm(temp, { force: true }); throw error; }
  await file.close();
  try { await rename(temp, path); } catch (error) { await rm(temp, { force: true }); throw error; }
  await syncDirectory(dirname(path));
}

// ---------------------------------------------------------------------------------------------------------------------
// Reader (CLI `events --all`): read-only, never repairs; one fstat bounds what it reads, so a concurrent append or
// compaction (a rename: the open file stays the old one) never mixes two versions.
// ---------------------------------------------------------------------------------------------------------------------
export interface LogHead { epoch: string; dropped: number; head: number }
export interface Page extends LogHead { events: Event[]; more: boolean }

/** The first complete line starting at or after `offset` (offset 0: the first line), with its start. */
function lineAt(fd: number, offset: number, size: number): { start: number; line: Buffer } | undefined {
  let found: { start: number; line: Buffer } | undefined, skipped = offset === 0;
  scanLines(fd, offset, size, (line, start) => {
    if (!skipped) { skipped = true; return; }
    found = { start, line: Buffer.from(line) }; return false;
  });
  return found;
}
/** The last valid record within the first `size` bytes (a torn or partial final line is ignored). */
function lastRecord(fd: number, size: number): LogRecord | undefined {
  for (let window = CHUNK; ; window *= 4) {
    const from = Math.max(0, size - window);
    let last: LogRecord | undefined, lines = 0;
    scanLines(fd, from, size, (line, start) => {
      if (start === from && from > 0) return; // possibly the middle of a line
      lines++;
      const r = parseRecord(line); if (r) last = r;
    });
    if (last || from === 0) return last;
    if (lines > 1) return last;
  }
}
function header(fd: number, size: number): Extract<LogRecord, { k: "log" }> {
  const first = lineAt(fd, 0, size), r = first && parseRecord(first.line);
  if (r?.k !== "log") throw new LogCorrupt("event log has no valid header");
  return r;
}
/** The log's epoch, dropped and head; undefined when there is no log yet. */
export function readHead(path: string): LogHead | undefined {
  let fd: number;
  try { fd = openSync(path, "r"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const size = fstatSync(fd).size, h = header(fd, size), last = lastRecord(fd, size);
    return { epoch: h.epoch, dropped: h.dropped, head: Math.max(h.dropped, last ? position(last) : 0) };
  } finally { closeSync(fd); }
}
/** Events with seq > `since`, in order, at most `limit`; `more` when the log has further events. The caller checks the
 *  cursor against the head first (`readHead` values are returned again, from the same read). */
export function readPage(path: string, since: number, limit: number, check?: (head: LogHead) => void): Page | undefined {
  let fd: number;
  try { fd = openSync(path, "r"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const size = fstatSync(fd).size, h = header(fd, size), last = lastRecord(fd, size);
    const view: LogHead = { epoch: h.epoch, dropped: h.dropped, head: Math.max(h.dropped, last ? position(last) : 0) };
    check?.(view);
    // Binary search for a line start before which every record's position is <= since (positions never decrease).
    let lo = 0, hi = size;
    while (hi - lo > CHUNK * 4) {
      const mid = lo + Math.floor((hi - lo) / 2), at = lineAt(fd, mid, size);
      if (!at || at.start >= hi) { hi = mid; continue; }
      const r = parseRecord(at.line);
      if (r && position(r) <= since) lo = at.start; else hi = mid;
    }
    const events: Event[] = [];
    let more = false, bad: number | undefined;
    scanLines(fd, lo, size, (line, start) => {
      if (bad !== undefined) throw new LogCorrupt(`event log corrupt at byte ${bad}`);
      const r = parseRecord(line);
      if (!r) { bad = start; return; }
      if (r.k !== "ev" || r.seq <= since) return;
      if (events.length >= limit) { more = true; return false; }
      events.push(publicEvent(h.epoch, r));
    });
    return { ...view, events, more };
  } finally { closeSync(fd); }
}
