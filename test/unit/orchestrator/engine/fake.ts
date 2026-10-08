import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { main } from '../../../../src/orchestrator/main.ts';
import { JT, type CallResult } from '../../../../src/types.ts';
import type { CallTicket, Executor, Ledgers } from '../../../../src/orchestrator/contract.ts';

/** P9, P14: Seal synthetic outcomes and model retirement without launching pi. */
export function fakeExecutor(ledgers: Ledgers, opts: { delay?: (key: string) => number; hold?: string } = {}): Executor {
  if (process.env.DSA_FAKE_CRASH_WINDOW === 'admitted') {
    const append = ledgers.orch.append.bind(ledgers.orch);
    ledgers.orch.append = async (type, fields) => {
      const entry = await append(type, fields);
      if (type === JT.admitted && fields.kind === 'run') await new Promise(() => {});
      return entry;
    };
  }
  const pending = new Map<string, Promise<CallResult>>();
  // Restart: a call is live from its fake-run to its end; while paused none starts running.
  const live = new Set<string>(), unpaused = new Set<() => void>(), since = Date.now();
  let paused = false;
  const active = new Map<string, { ticket: CallTicket; end: (reason: string) => void }>();
  async function execute(ticket: CallTicket) {
    let end!: (reason: string) => void;
    const ended = new Promise<string>(resolve => { end = resolve; });
    active.set(ticket.callId, { ticket, end });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await ticket.journal.append('fake-invoke', { call: ticket.callId, key: ticket.key, workflowBudget: ticket.workflowBudget });
      const old = ticket.journal.entries().find(e => e.type === JT.sealed && e.call === ticket.callId);
      if (old) return old.result as CallResult;
      while (paused) await new Promise<void>(resolve => { unpaused.add(resolve); });
      live.add(ticket.callId);
      await ticket.journal.append('fake-run', { call: ticket.callId, key: ticket.key });
      const ready = new Promise<string>(resolve => {
        if (ticket.key !== opts.hold) timer = setTimeout(() => resolve('ready'), opts.delay?.(ticket.key) ?? 0);
      });
      const reason = await Promise.race([ended, ready]);
      if (reason === 'suspend') { const error = new Error('suspended'); error.name = 'ExecutorShutdown'; throw error; }
      const result: CallResult = { key: ticket.key, gen: ticket.gen, status: reason === 'retired' ? 'stopped' : 'ok', ok: reason !== 'retired', output: ticket.spec.task,
        ...(reason === 'retired' ? { error: 'retired' } : {}) };
      if (reason !== 'retired') await ticket.journal.append(JT.sealed, { call: ticket.callId, exec: `${ticket.callId}#1.1`, result });
      return result;
    } finally { clearTimeout(timer); live.delete(ticket.callId); active.delete(ticket.callId); pending.delete(ticket.callId); }
  }
  return {
    run(ticket) { let run = pending.get(ticket.callId); if (!run) { run = execute(ticket); pending.set(ticket.callId, run); } return run; },
    async forward(req, ctx) { await ctx.journal.append('fake-forward', { rid: req.rid, key: ctx.key }); return { action: 'apply' }; },
    async stop(target) { await ledgers.orch.append('fake-stop', { target }); },
    async recover(wid) { await ledgers.orch.append('fake-recover', { wid }); },
    async retire(widRev) {
      await ledgers.orch.append('fake-retire', { widRev });
      if (process.env.DSA_FAKE_CRASH_WINDOW === 'retire') await new Promise(() => {});
      const runs: Promise<CallResult>[] = [];
      for (const [call, a] of active) if (a.ticket.widRev === widRev) {
        await a.ticket.journal.append('retired', { call });
        runs.push(pending.get(call)!); a.end('retired');
      }
      await Promise.allSettled(runs);
    },
    busy: () => active.size > 0,
    quiesce() {
      paused = true;
      return { live: [...live].map(call => { const t = active.get(call)!.ticket; return { wid: t.wid, key: t.key, gen: t.gen, callId: call, exec: `${call}#1.1`, since, phase: 'child' as const }; }),
        resume: () => { paused = false; for (const fn of unpaused) fn(); unpaused.clear(); } };
    },
    async suspend(only?: (wid: string) => boolean) {
      await ledgers.orch.append('fake-suspend', only ? { scoped: true } : {});
      const runs: Promise<CallResult>[] = [];
      for (const [call, a] of active) if (!only || only(a.ticket.wid)) {
        runs.push(pending.get(call)!); await a.ticket.journal.append('fake-fenced', { call }); a.end('suspend');
      }
      await Promise.allSettled(runs);
    },
    async shutdown() { await this.suspend(); },
  };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const home = process.env.DSA_HOME!;
  main({ home, config: { k: { idleExitMs: 100 } }, executor: ledgers => fakeExecutor(ledgers, { hold: process.env.DSA_FAKE_HOLD }),
    discovery: { home, agentDir: `${home}/config`, globalNpmRoot: null },
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
