// R2: journal → event drafts. Pure functions of durable sources: the entry at journal index i (seq i+1) is derived from
// that journal's entries up to it and from orchestrator-ledger entries durable before it, so a re-derivation after a
// crash gives the same events with the same ids (`<wid>:<journal seq>:<type>`, `<wid>:submitted`).
import { createHash } from "node:crypto";
import { requestId } from "../requests.ts";
import { JT, isEntry, type CallResult, type Entry, type Request, type SendBody } from "../types.ts";
import { fenceReason, interruptingFence } from "./fence.ts";
import { EVENT_DATA_INLINE_MAX, type EventDraft } from "./types.ts";

/** The run request id and labels a workflow's events echo. */
export interface Identity { request?: string; labels?: Record<string, string> }

/** `<wid>@<rev>/<key>@<gen>` → key and gen (a key may itself contain '/' or '@'). */
export function callParts(call: string): { key: string; gen: number } | undefined {
  const m = /^[^@/]+@\d+\/(.*)@(\d+)$/s.exec(call);
  return m ? { key: m[1]!, gen: Number(m[2]) } : undefined;
}
const echo = (id: Identity) => ({ ...(id.request !== undefined ? { request: id.request } : {}), ...(id.labels ? { labels: id.labels } : {}) });
const onCall = (call: string) => { const p = callParts(call); return p ? { key: p.key, gen: p.gen, call } : { call }; };

/** The labels of a run body: a plain object of strings (anything else is not echoed). */
export function labelsOf(body: unknown): Record<string, string> | undefined {
  const labels = (body as { labels?: unknown } | null)?.labels;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return undefined;
  const entries = Object.entries(labels as Record<string, unknown>);
  return entries.every(([, v]) => typeof v === "string") ? Object.fromEntries(entries) as Record<string, string> : undefined;
}

/** `answered.by` from the answer request's sender: a pi session `main:<id>` → `session:<id>` (+ via "ui" when the
 *  subagent list sent it, SendBody.by "user"); the CLI sender `cli:<user>@<host>` as is; anything else `unknown`. */
export function answeredBy(req: Request | undefined): { by: string; via?: "ui" } {
  const from = req?.from ?? "";
  if (from.startsWith("main:")) return { by: `session:${from.slice(5)}`, ...((req!.body as SendBody | undefined)?.by === "user" ? { via: "ui" as const } : {}) };
  if (/^cli:[^@]+@.+$/.test(from)) return { by: from };
  return { by: "unknown" };
}

/** `submitted` from the orchestrator ledger's `created {rid, wid}` at index `i` (name from its create-intent). */
export function deriveCreated(orch: readonly Entry[], i: number, id: Identity): EventDraft {
  const e = orch[i]!, wid = String(e.wid), rid = String(e.rid);
  let name: unknown;
  for (let j = i - 1; j >= 0; j--) { const c = orch[j]!; if (c.type === "create-intent" && c.rid === rid) { name = c.name; break; } }
  return { id: `${wid}:submitted`, ts: e.ts, type: "submitted", wid, ...echo({ ...id, request: requestId(rid) ?? id.request }), ...(typeof name === "string" ? { name } : {}) };
}

/** The request the answer to question (call, qid, rev) came with: an `answer-bound` (a hibernated asker) or a `forward`
 *  of kind answer (a live one) before index `limit` names its rid; the orchestrator ledger keeps the admitted envelope. */
function answerOf(entries: readonly Entry[], limit: number, orch: readonly Entry[], call: string, qid: string, rev: number): { request?: Request; text: string } {
  let rid: string | undefined, forwarded: string | undefined;
  for (let j = limit - 1; j >= 0 && rid === undefined; j--) {
    const e = entries[j]!;
    if (e.type === "answer-bound" && e.call === call && e.qid === qid && e.rev === rev) rid = String(e.rid);
    else if (e.type === "forward" && e.dest === call) {
      const env = e.envelope as { kind?: string; cond?: { qid?: string; rev?: number }; body?: { message?: unknown } } | undefined;
      if (env?.kind === "answer" && env.cond?.qid === qid && env.cond?.rev === rev) { rid = String(e.rid); forwarded = typeof env.body?.message === "string" ? env.body.message : undefined; }
    }
  }
  const request = rid === undefined ? undefined : orch.findLast(e => e.type === "request" && (e.request as Request | undefined)?.rid === rid)?.request as Request | undefined;
  const message = (request?.body as SendBody | undefined)?.message;
  return { request, text: typeof message === "string" ? message : forwarded ?? "" };
}

/** The ledger entries durable before journal entry `e` (by time: the ledger and the journal are separate files). */
function before(orch: readonly Entry[], e: Entry): readonly Entry[] {
  let n = orch.length;
  while (n > 0 && Number(orch[n - 1]!.ts) > e.ts) n--;
  return n === orch.length ? orch : orch.slice(0, n);
}

/** The events of journal entry `i` of workflow `wid` (usually none). Reads only that journal's entries up to `i` and
 *  the ledger entries durable before it, so a re-derivation gives the same events. */
export function deriveEntry(wid: string, entries: readonly Entry[], i: number, orch: readonly Entry[], id: Identity): EventDraft[] {
  const e = entries[i]!, base = (type: string) => ({ id: `${wid}:${e.seq}:${type}`, ts: e.ts, wid, ...echo(id) });
  if (isEntry(e, JT.exec)) {
    // `started` once per call (generation): its first execution. A later execution follows a fence; `fenced` when
    // that fence interrupted work (the classification `describe` uses for lastFence).
    let previous: Entry | undefined;
    for (let j = i - 1; j >= 0 && !previous; j--) { const p = entries[j]!; if (p.type === JT.exec && p.call === e.call) previous = p; }
    if (!previous) return [{ ...base("started"), type: "started", ...onCall(e.call), exec: e.exec }];
    const fence = interruptingFence(entries, String(previous.exec), i);
    if (!fence) return [];
    return [{ ...base("fenced"), type: "fenced", ...onCall(e.call), exec: String(previous.exec), reason: fenceReason(entries.slice(0, i), before(orch, e), fence), at: fence.ts }];
  }
  if (isEntry(e, JT.attention)) {
    const item = e.item;
    if (item?.kind !== "question" || !item.call || item.qid === undefined) return [];
    const parts = callParts(item.call);
    return [{ ...base("asking"), type: "asking", ...onCall(item.call), qid: item.qid, rev: item.rev, question: item.text, to: `${wid}/${parts?.key ?? ""}` }];
  }
  if (isEntry(e, JT.attentionResolved)) {
    if (e.resolution !== "answered") return [];
    let item: Entry | undefined;
    for (let j = i - 1; j >= 0 && !item; j--) { const a = entries[j]!; if (isEntry(a, JT.attention) && a.item.id === e.id && a.item.rev === e.rev) item = a; }
    const q = (item as Entry & { item: { kind: string; call?: string; qid?: string; rev: number } } | undefined)?.item;
    if (!q || q.kind !== "question" || !q.call || q.qid === undefined) return [];
    const answer = answerOf(entries, i, before(orch, e), q.call, q.qid, q.rev);
    return [{ ...base("answered"), type: "answered", ...onCall(q.call), qid: q.qid, rev: q.rev, ...answeredBy(answer.request),
      digest: createHash("sha256").update(answer.text, "utf8").digest("hex"), length: answer.text.length }];
  }
  if (isEntry(e, JT.sealed)) {
    const r = (e.result ?? {}) as Partial<CallResult>, data = Object.hasOwn(r, "data") && r.data !== undefined ? JSON.stringify(r.data) : undefined;
    const bytes = data === undefined ? 0 : Buffer.byteLength(data);
    return [{ ...base("sealed"), type: "sealed", ...onCall(e.call), status: String(r.status ?? "unknown"), ...(r.error ? { error: String(r.error) } : {}),
      ...(data === undefined ? {} : bytes <= EVENT_DATA_INLINE_MAX ? { data: r.data } : { data_omitted: bytes }) }];
  }
  if (e.type === JT.done) return [{ ...base("workflow-done"), type: "workflow-done", status: String(e.status), ...(e.error !== undefined ? { error: String(e.error) } : {}) }];
  return [];
}
