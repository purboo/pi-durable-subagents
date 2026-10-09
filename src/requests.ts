// R1: Caller-chosen request ids. A program names a run/send/stop with `<id>`; its kernel rid is `req:<id>` (fits the
// mailbox rid pattern), unique per DSA_HOME across kinds and senders. A retry with the same id and the same content
// (spec_digest) gets the first outcome; a different content is a request-conflict and is never published.
// The check-and-send is serialized per home by the OS lock <home>/requests.lock (CLI and tool senders alike); no
// journal entry type is added: the admitted orch `request` entry and the senders' outbox `sent` entries are the record.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { contentHash } from './kernel/ids.ts';
import { readJournalSnapshot } from './kernel/journal.ts';
import { publishRequest, type Outbox } from './kernel/mailbox.ts';
import { OsLock } from './platform/lock.ts';
import { orchInbox, orchLedger, outboxRoot } from './paths.ts';
import type { Conditions, Request, RequestKind } from './types.ts';

export const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$/;
const PREFIX = 'req:';
/** R1: `<id>` → its rid `req:<id>`; ids are 1–124 chars `[A-Za-z0-9][A-Za-z0-9._:-]*`. */
export function requestRid(id: string): string {
  if (!REQUEST_ID.test(id)) throw new Error(`invalid request id ${JSON.stringify(id)}: 1-124 characters [A-Za-z0-9][A-Za-z0-9._:-]*`);
  return PREFIX + id;
}
/** R1: The request id of a `req:<id>` rid; undefined for any other rid (ULIDs never contain ':'). */
export function requestId(rid: string): string | undefined { return rid.startsWith(PREFIX) ? rid.slice(PREFIX.length) : undefined; }
/** R1: spec_digest = contentHash({kind, body, cond}) (cond omitted when absent). A run's body.origin (the pi session
 *  branch offered for context:"fork") is delivery metadata, not spec: it differs on every turn, so it is not hashed. */
export function specDigest(req: Pick<Request, 'kind' | 'body' | 'cond'>): string {
  let body = req.body;
  if (req.kind === 'run' && body && typeof body === 'object' && !Array.isArray(body)) { const { origin: _, ...rest } = body as Record<string, unknown>; body = rest; }
  return contentHash({ kind: req.kind, body, cond: req.cond });
}
/** R1: The envelope recorded for `rid`: the orchestrator's admitted copy (ledger `request`, kept after prune), else any
 *  sender's outbox `sent` entry (published or about to be). Read-only. */
export async function findRequest(home: string, rid: string): Promise<{ request: Request; admitted: boolean } | undefined> {
  const admitted = readJournalSnapshot(orchLedger(home)).find(e => e.type === 'request' && (e.request as Request).rid === rid);
  if (admitted) return { request: admitted.request as Request, admitted: true };
  const dir = join(outboxRoot(home), 'outbox');
  const names = await readdir(dir).catch(error => { if (error.code === 'ENOENT') return [] as string[]; throw error; });
  for (const name of names.filter(n => n.endsWith('.jsonl')).sort()) {
    const sent = readJournalSnapshot(join(dir, name)).find(e => e.type === 'sent' && (e.request as Request).rid === rid);
    if (sent) return { request: sent.request as Request, admitted: false };
  }
  return undefined;
}
/** A lock was not free within 10 s: nothing was submitted by this attempt; a retry with the same id is safe. */
export class RequestsBusy extends Error { override name = 'RequestsBusy'; }
export type Identified = { request: Request; digest: string; sent: boolean } | { conflict: Request; digest: string };
/** R1, P5: Check-then-send under the home-wide request-id lock (innermost: taken after a sender's own lock), so no two
 *  senders publish one rid and no second envelope with an existing rid and other content reaches the inbox (it would
 *  stall its sender's sequence). Same content: the recorded envelope stands (republished when it is this sender's and
 *  pending; `sent` false). */
export async function sendIdentified(home: string, outbox: Outbox, sender: string, rid: string, kind: RequestKind, body: unknown, cond?: Conditions): Promise<Identified> {
  const digest = specDigest({ kind, body, cond }), path = join(home, 'requests.lock'), locker = new OsLock(), deadline = performance.now() + 10_000;
  let lock = await locker.tryAcquire(path);
  while (!lock && performance.now() < deadline) { await delay(25); lock = await locker.tryAcquire(path); }
  if (!lock) throw new RequestsBusy('request ids are busy; retry the command');
  try {
    const prior = await findRequest(home, rid);
    if (prior && specDigest(prior.request) !== digest) return { conflict: prior.request, digest: specDigest(prior.request) };
    if (prior) {
      // Its own envelope is re-offered verbatim (Outbox.send returns it and republishes it while pending).
      // Another sender's envelope not admitted yet is published verbatim (publishing is idempotent per rid): a sender
      // that died between recording and publishing it would otherwise leave the id pending for ever.
      let request = prior.request;
      if (prior.request.from === sender) request = await outbox.send(prior.request.to, prior.request.kind, prior.request.body, prior.request.cond, { rid });
      else if (!prior.admitted) await publishRequest(orchInbox(home), prior.request);
      return { request, digest, sent: false };
    }
    return { request: await outbox.send('orch', kind, body, cond, { rid }), digest, sent: true };
  } finally { await lock.release(); }
}
