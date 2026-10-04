import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from '@earendil-works/pi-coding-agent';
import { CT, ENV, JT, type MessageBody, type ModelBody } from '../types.ts';
import { readJournalSnapshot } from '../kernel/journal.ts';
import { scanInbox } from '../kernel/mailbox.ts';
import { contentHash } from '../kernel/ids.ts';
import { planDecisions, type DecisionRecord } from '../kernel/lifecycle.ts';
import { openness } from '../kernel/guards.ts';
import { recover, type Question } from './child/history.ts';
import { validate } from './child/schema.ts';

type Mode = 'idle' | 'boundary' | 'ask';
type Delivery = { content: { type: 'text'; text: string }[]; details: Record<string, unknown> };
/** P4, P8, P23, P24: Consume the child mailbox at serialized pi boundaries, retaining native session receipts. */
export function registerChild(pi: ExtensionAPI): void {
  const exec = process.env[ENV.exec]!, call = process.env[ENV.call]!, inbox = process.env[ENV.inbox]!, journal = process.env[ENV.journal]!;
  let active = false, watcher: FSWatcher | undefined, queue: Promise<unknown> = Promise.resolve();
  let state = recover([]), blocked: (Question & { resolve: (result: Delivery) => void; reject: (error: Error) => void }) | undefined;
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = queue.then(fn); queue = result.catch(() => {}); return result;
  };
  const fail = (ctx: ExtensionContext, error: unknown) => {
    console.error('Child mailbox failed:', error); active = false; watcher?.close();
    blocked?.reject(error instanceof Error ? error : new Error(String(error))); blocked = undefined; ctx.shutdown();
  };
  async function consume(ctx: ExtensionContext, mode: Mode): Promise<SessionBoundaryDraft[]> {
    if (!active || (mode === 'idle' && !ctx.isIdle())) return [];
    const candidates = await scanInbox(inbox), byRid = new Map(candidates.map(req => [req.rid, req]));
    // Scan is asynchronous: recheck before using the idle delivery API.
    if (!active || (mode === 'idle' && !ctx.isIdle())) return [];
    let delivered = false;
    const plans = planDecisions(state.records, candidates, req => {
      if (req.to !== call) return { action: 'reject', reason: 'wrong-recipient' };
      if (['task', 'steer', 'continue', 'answer'].includes(req.kind) && typeof (req.body as MessageBody)?.message !== 'string') return { action: 'reject', reason: 'malformed' };
      if (req.kind === 'answer') {
        const qid = req.cond?.qid, rev = req.cond?.rev, question = qid ? state.questions.get(qid) : undefined;
        if (state.answered.has(`${qid}@${rev}`)) return { action: 'reject', reason: 'already-answered' };
        if (!question || question.rev !== rev) return { action: 'reject', reason: 'stale-rev' };
        if (mode !== 'ask' || delivered || !openness({ open: [...state.questions.values()], blocked }, { qid: qid!, rev: rev! })) return { action: 'defer' };
        delivered = true; return { action: 'apply' };
      }
      if (mode === 'ask' && (req.kind !== 'steer' || delivered)) return { action: 'defer' };
      if (req.kind === 'model') {
        const body = req.body as ModelBody;
        return body && ctx.modelRegistry.find(body.provider, body.model) ? { action: 'apply' } : { action: 'reject', reason: 'unknown-model' };
      }
      if (['task', 'steer', 'continue'].includes(req.kind)) {
        if (mode === 'idle' && delivered) return { action: 'defer' };
        delivered = true; return { action: 'apply' };
      }
      return { action: 'reject', reason: 'unsupported' };
    });
    // Idle delivery starts pi immediately. Commit only through that message's receipt;
    // later decisions must be reconsidered at the next boundary, in history order.
    if (mode === 'idle') {
      const firstMessage = plans.findIndex(d => d.type === 'applied' && ['task', 'steer', 'continue'].includes(byRid.get(d.rid)!.kind));
      if (firstMessage >= 0) plans.splice(firstMessage + 1);
    }
    const entries: SessionBoundaryDraft[] = [];
    const record = (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data });
    let answer: Delivery | undefined, waiter = blocked;
    for (let i = 0; i < plans.length; i++) {
      const decision = plans[i]!;
      if (decision.type === 'admitted' || decision.type === 'rejected') {
        const { type, ...data } = decision; record(type === 'admitted' ? CT.admitted : CT.rejected, data);
      } else if (decision.type === 'withdrawn') {
        // The kernel emits target rejections between tombstones and the withdrawal receipt.
        const receipt = plans.slice(i + 1).find(d => d.type === 'applied' && byRid.get(d.rid)?.kind === 'withdraw')! as Extract<DecisionRecord, { type: 'applied' }>;
        record(CT.withdrawn, { rid: receipt.rid, rids: decision.rids });
      } else {
        const req = byRid.get(decision.rid)!;
        if (req.kind === 'withdraw') continue;
        if (req.kind === 'model') {
          const body = req.body as ModelBody, model = ctx.modelRegistry.find(body.provider, body.model)!;
          if (!(await pi.setModel(model))) throw new Error(`Cannot activate model ${body.provider}/${body.model}`);
          record(CT.model, { rid: req.rid, provider: body.provider, model: body.model });
        } else if (mode === 'ask' && waiter) {
          const text = (req.body as MessageBody).message;
          answer = req.kind === 'answer'
            ? { content: [{ type: 'text', text }], details: { rid: req.rid, qid: waiter.qid, rev: waiter.rev } }
            : { content: [{ type: 'text', text: `${JSON.stringify({ interrupted_by: 'steer', open: waiter.qid })}\n${text}` }], details: { rid: req.rid, kind: 'steer' } };
          if (req.kind === 'answer') state.answered.add(`${waiter.qid}@${waiter.rev}`);
        } else {
          entries.push({ type: 'custom_message', customType: CT.msg, content: (req.body as MessageBody).message, display: true, details: { rid: req.rid, kind: req.kind, from: req.from } });
        }
      }
    }
    state.records.push(...plans);
    if (mode !== 'boundary') {
      // A single idle message is last: once it starts pi, further work waits for a boundary.
      const message = entries.find(e => e.type === 'custom_message');
      for (const entry of entries) if (entry.type === 'custom') pi.appendEntry(entry.customType, entry.data);
      if (message?.type === 'custom_message') pi.sendMessage(message, { triggerTurn: true });
      if (answer && waiter) { blocked = undefined; waiter.resolve(answer); }
      return [];
    }
    return entries;
  }
  pi.on('session_start', async (_event, ctx) => {
    await serial(async () => {
      const entries = await readJournalSnapshot(journal);
      if (entries.filter(e => e.type === JT.exec && e.call === call).at(-1)?.exec !== exec || entries.some(e => e.type === JT.fenced && e.exec === exec)) {
        ctx.shutdown();
        // P23: pi 1.0.2 rpc-mode.js:256-257/:632 honors shutdown only after another
        // RPC command. This owned child is inert and has written nothing; exit now.
        setImmediate(() => process.exit(0)); return;
      }
      state = recover(ctx.sessionManager.getEntries()); active = true; pi.appendEntry(CT.exec, { exec });
      watcher = watch(inbox, () => { void serial(async () => { await consume(ctx, blocked ? 'ask' : 'idle'); }).catch(error => fail(ctx, error)); });
      watcher.on('error', error => fail(ctx, error));
      await consume(ctx, 'idle');
    });
  });
  const boundary = async (_event: unknown, ctx: ExtensionContext) => {
    try { return await serial(async () => { const entries = await consume(ctx, 'boundary'); return { entries, continue: entries.some(e => e.type === 'custom_message' || (e.type === 'custom' && e.customType === CT.model)) }; }); }
    catch (error) { fail(ctx, error); }
  };
  pi.on('turn_end', boundary);
  pi.on('agent_before_settle', boundary);
  pi.on('session_shutdown', async () => {
    active = false; watcher?.close(); blocked?.reject(new Error('Session shut down')); blocked = undefined; await queue;
  });
  pi.registerTool({
    name: 'ask', label: 'Ask supervisor', description: 'Ask a question and wait for an answer or steering message.',
    parameters: Type.Object({ question: Type.String() }), executionMode: 'sequential', exposure: 'model-only',
    async execute(_id, { question }, signal, _update, ctx) {
      let resolve!: (value: Delivery) => void, reject!: (error: Error) => void;
      const result = new Promise<Delivery>((yes, no) => { resolve = yes; reject = no; });
      // Attach immediately so abort during the queued intake never produces an unhandled rejection.
      void result.catch(() => {});
      const abort = () => { void serial(async () => { if (blocked?.resolve === resolve) blocked = undefined; reject(new Error('Ask aborted')); }); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        await serial(async () => {
          if (!active || signal?.aborted) throw new Error('Ask aborted');
          if (blocked) throw new Error('Another question is already blocked');
          const qid = contentHash({ exec, question }), rev = (state.questions.get(qid)?.rev ?? 0) + 1;
          const q = { qid, rev, question }; state.questions.set(qid, q); pi.appendEntry(CT.question, q);
          blocked = { ...q, resolve, reject }; await consume(ctx, 'ask');
        });
        return await result;
      } finally { signal?.removeEventListener('abort', abort); }
    },
  });
  if (process.env[ENV.schema]) pi.registerTool({
    name: 'report', label: 'Report result', description: 'Submit a schema-validated final report and terminate the run.',
    parameters: Type.Object({ outcome: Type.Union([Type.Literal('ok'), Type.Literal('failed')]), summary: Type.Optional(Type.String()), data: Type.Optional(Type.Unknown()) }),
    executionMode: 'sequential', exposure: 'model-only',
    async execute(_id, payload, _signal, _update, _ctx) {
      return serial(async () => {
        if (!active) throw new Error('Execution is not current');
        const schema = JSON.parse(await readFile(process.env[ENV.schema]!, 'utf8')), errors = validate(schema, payload.data);
        if (errors.length) throw new Error(`Invalid report: ${errors.join('; ')}`);
        pi.appendEntry(CT.report, { exec, ...payload }); active = false; watcher?.close();
        return { content: [{ type: 'text' as const, text: payload.summary ?? JSON.stringify(payload.data) ?? payload.outcome }], details: { exec, ...payload }, terminate: true };
      });
    },
  });
}
