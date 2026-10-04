import { pathToFileURL } from 'node:url';
import { main } from '../../../../src/orchestrator/main.ts';
import { JT, type CallResult } from '../../../../src/types.ts';
import type { CallTicket, Executor, Ledgers } from '../../../../src/orchestrator/contract.ts';

/** P9 test double: seal synthetic outcomes without launching pi. */
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
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let busy = 0;
  async function execute(ticket: CallTicket) {
    await ticket.journal.append('fake-invoke', { call: ticket.callId, key: ticket.key });
    const old = ticket.journal.entries().find(e => e.type === JT.sealed && e.call === ticket.callId);
    if (old) return old.result as CallResult;
    busy++;
    await ticket.journal.append('fake-run', { call: ticket.callId, key: ticket.key });
    if (ticket.key === opts.hold) await new Promise(() => {});
    const ms = opts.delay?.(ticket.key) ?? 0;
    if (ms) await new Promise<void>(resolve => { const timer = setTimeout(() => { timers.delete(timer); resolve(); }, ms); timers.add(timer); });
    const result: CallResult = { key: ticket.key, gen: ticket.gen, status: 'ok', ok: true, output: ticket.spec.task };
    await ticket.journal.append(JT.sealed, { call: ticket.callId, exec: `${ticket.callId}#1.1`, result });
    busy--;
    return result;
  }
  return {
    run(ticket) { let run = pending.get(ticket.callId); if (!run) { run = execute(ticket); pending.set(ticket.callId, run); } return run; },
    async forward(req, ctx) { await ctx.journal.append('fake-forward', { rid: req.rid, key: ctx.key }); return { action: 'apply' }; },
    async stop(target) { await ledgers.orch.append('fake-stop', { target }); },
    async recover(wid) { await ledgers.orch.append('fake-recover', { wid }); },
    busy: () => busy > 0,
    async shutdown() { for (const timer of timers) clearTimeout(timer); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const home = process.env.DSA_HOME!;
  main({ home, config: { k: { idleExitMs: 100 } }, executor: ledgers => fakeExecutor(ledgers, { hold: process.env.DSA_FAKE_HOLD }),
    discovery: { home, agentDir: `${home}/config`, globalNpmRoot: null },
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
