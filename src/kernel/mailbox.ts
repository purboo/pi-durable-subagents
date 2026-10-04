import { link, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Conditions, JournalHandle, Request, RequestKind } from '../types.ts';
import { contentHash, ulid } from './ids.ts';
import { openJournal, syncDirectory } from './journal.ts';

type Publication = 'published' | 'exists-identical' | 'conflict';
function safeName(name: string): string {
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) throw new Error('Invalid mailbox identity');
  return name;
}
/** P3, C11: Publish an immutable envelope with atomic no-replace semantics. */
export async function publishRequest(inboxDir: string, req: Request): Promise<Publication> {
  const bytes = JSON.stringify(req), target = join(inboxDir, `${safeName(req.rid)}.json`);
  await mkdir(inboxDir, { recursive: true });
  const temp = join(inboxDir, `.${ulid()}.tmp`), file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(bytes); await file.sync(); await file.close();
    try { await link(temp, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let identical = false;
      try { identical = contentHash(JSON.parse(await readFile(target, 'utf8'))) === contentHash(JSON.parse(bytes)); } catch { /* A malformed existing file is a conflict. */ }
      await syncDirectory(inboxDir);
      return identical ? 'exists-identical' : 'conflict';
    }
    await syncDirectory(inboxDir);
    return 'published';
  } finally { await file.close(); await unlink(temp).catch(() => {}); }
}
function isRequest(value: unknown): value is Request {
  if (!value || typeof value !== 'object') return false;
  const r = value as Request;
  return typeof r.rid === 'string' && typeof r.from === 'string' && typeof r.to === 'string' && Number.isSafeInteger(r.sseq) && r.sseq > 0 &&
    ['run','send','stop','revise','resume','drain','task','steer','answer','model','continue','withdraw','call','emit'].includes(r.kind) && Object.hasOwn(r, 'body');
}
/** P3: Scan immutable requests, reporting invalid files without admitting them. */
export async function scanInbox(inboxDir: string, report: (path: string, error: unknown) => void = (path, error) => console.warn(path, error)): Promise<Request[]> {
  const requests: Request[] = [];
  const names = await readdir(inboxDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const path = join(inboxDir, name);
    try {
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!isRequest(value) || `${value.rid}.json` !== name) throw new Error('Invalid request envelope');
      requests.push(value);
    } catch (error) { report(path, error); }
  }
  return requests;
}

/** P38: A single-authority durable sender; serialize send, replay and deletion. */
export class Outbox {
  private journal: JournalHandle;
  private sender: string;
  private inbox: (to: string) => string;
  private pending = new Map<string, Request>();
  private sent = new Map<string, Request>();
  private high = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private constructor(journal: JournalHandle, sender: string, inbox: (to: string) => string) {
    this.journal = journal; this.sender = sender; this.inbox = inbox;
    for (const entry of journal.entries()) {
      if (entry.type === 'sent') {
        const req = entry.request as Request;
        this.high.set(req.to, Math.max(this.high.get(req.to) ?? 0, req.sseq));
        this.pending.set(req.rid, req); this.sent.set(req.rid, req);
      } else if (entry.type === 'resolved') this.pending.delete(entry.rid as string);
    }
  }
  /** P38: Open outbox/<senderId>.jsonl; caller supplies recipient routing. */
  static async open(root: string, senderId: string, inbox: (to: string) => string): Promise<Outbox> {
    return new Outbox(await openJournal(join(root, 'outbox', `${safeName(senderId)}.jsonl`)), senderId, inbox);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Outbox closed'));
    const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result;
  }
  private async publish(req: Request): Promise<void> {
    if (await publishRequest(this.inbox(req.to), req) === 'conflict') throw new Error(`Outbox identity conflict: ${req.rid}`);
  }
  /** P5, P38, P7: Persist the next per-recipient sequence before publication. With opts.rid (a deterministic
   *  identity, e.g. a forward's rid2) the send is idempotent: a rid already sent returns the recorded envelope
   *  (same sseq) and republishes it if still pending; reusing it for a different recipient/kind/body is an error. */
  send(to: string, kind: RequestKind, body: unknown, cond?: Conditions, opts: { rid?: string } = {}): Promise<Request> {
    const payload = structuredClone({ body, cond });
    return this.serial(async () => {
      const prior = opts.rid ? this.sent.get(opts.rid) : undefined;
      if (prior) {
        if (prior.to !== to || prior.kind !== kind || contentHash({ body: prior.body, cond: prior.cond }) !== contentHash({ body: payload.body, cond: payload.cond }))
          throw new Error(`Outbox identity conflict: ${opts.rid}`);
        if (this.pending.has(prior.rid)) await this.publish(prior);
        return structuredClone(prior);
      }
      const req: Request = { rid: opts.rid ?? ulid(), from: this.sender, to, sseq: (this.high.get(to) ?? 0) + 1, kind, body: payload.body, ...(payload.cond ? { cond: payload.cond } : {}) };
      await this.journal.append('sent', { request: req });
      this.high.set(to, req.sseq); this.pending.set(req.rid, req); this.sent.set(req.rid, req);
      await this.publish(req); return structuredClone(req);
    });
  }
  /** P38: Re-publish every unresolved envelope under its original identity. */
  republishPending(): Promise<void> { return this.serial(async () => { for (const req of this.pending.values()) await this.publish(req); }); }
  /** P38: Record observed terminal resolution without deleting the sequence high-water. */
  markResolved(rid: string): Promise<void> { return this.serial(async () => {
    if (!this.pending.has(rid)) return;
    await this.journal.append('resolved', { rid }); this.pending.delete(rid);
  }); }
  /** C11: Drain outstanding operations before closing the durable log. */
  async close(): Promise<void> { this.closed = true; await this.queue; await this.journal.close(); }
}
