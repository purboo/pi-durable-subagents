// Baseline c63ff88 consume oracle, independent of the incremental engine path.
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { scanInbox } from '../../../../src/kernel/mailbox.ts';
import { contentHash } from '../../../../src/kernel/ids.ts';
import { orchInbox } from '../../../../src/paths.ts';
import { planDecisions, reduceLifecycle, type DecisionRecord, type Decision } from '../../kernel/lifecycle-oracle.ts';
import type { Ledgers } from '../../../../src/orchestrator/contract.ts';
import type { Store } from '../../../../src/orchestrator/store.ts';
import type { DiscoveryOptions } from '../../../../src/compat/agents.ts';
import type { Request, RunBody } from '../../../../src/types.ts';
interface IntakeEngine {
  passes: number[]; ledgers: Ledgers; store: Store; discovery?: DiscoveryOptions;
  consumed?: { length: number; pending: boolean };
  decide(request: Request): Promise<Decision>;
  withdraw(request: Request): Promise<void>;
}
function lifecycle(ledgers: Ledgers): DecisionRecord[] {
  return ledgers.orch.entries().filter(e => ['admitted', 'applied', 'rejected', 'withdrawn'].includes(e.type)) as unknown as DecisionRecord[];
}
export async function baselineConsume(this: IntakeEngine) {
    this.passes.push(Date.now());
    const scanned = (await scanInbox(orchInbox(this.ledgers.home))).filter(r => r.to === 'orch');
    const before = reduceLifecycle(lifecycle(this.ledgers)), staged = new Set<string>();
    // Only unresolved admitted envelopes can still be decided: a resolved one only re-binds its own rid (A1), so the
    // pass hashes and clones what is open, not the whole request history.
    const retained = this.ledgers.orch.entries().filter(e => e.type === 'request' && !before.resolved.has((e.request as Request).rid)).map(e => e.request as Request);
    const candidates = [...retained, ...scanned];
    for (const request of candidates) {
      if (!['run', 'revise'].includes(request.kind) || before.admitted.has(request.rid) || before.tombstones.has(request.rid) || staged.has(request.rid)) continue;
      await this.store.stage(request as Request<RunBody>, this.discovery);
      staged.add(request.rid);
    }
    const records = planDecisions(lifecycle(this.ledgers), candidates, () => ({ action: 'defer' }));
    for (const [index, record] of records.entries()) {
      if (record.type === 'admitted') {
        const request = candidates.find(r => r.rid === record.rid && contentHash(r) === record.hash)!;
        await this.ledgers.orch.append('request', { request });
      }
      if (record.type === 'applied') {
        const req = candidates.find(r => r.rid === record.rid);
        if (req?.kind === 'withdraw') await this.withdraw(req);
      }
      const { type, ...fields } = record;
      const withdrawal = type === 'withdrawn' ? records.slice(index + 1).find(r => r.type === 'applied') : undefined;
      await this.ledgers.orch.append(type, { ...fields, ...(withdrawal && 'rid' in withdrawal ? { rid: withdrawal.rid } : {}) });
    }
    for (;;) {
      let selected: Request | undefined;
      planDecisions(lifecycle(this.ledgers), candidates, req => { selected ??= req; return { action: 'defer' }; });
      if (!selected) break;
      const decision = await this.decide(selected);
      if (decision.action === 'defer') break;
      const resolution = planDecisions(lifecycle(this.ledgers), candidates, req => req.rid === selected!.rid ? decision : { action: 'defer' });
      for (const { type, ...fields } of resolution) await this.ledgers.orch.append(type, fields);
    }
    const view = reduceLifecycle(lifecycle(this.ledgers));
    for (const [rid, resolution] of view.resolved) {
      if (resolution.type === 'rejected' && ['run', 'revise'].includes(view.admitted.get(rid)?.kind ?? '')) await this.store.discardStage(rid);
    }
    for (const rid of view.tombstones) await this.store.discardStage(rid);
    for (const req of scanned) {
      if (view.resolved.has(req.rid) || (view.admitted.has(req.rid) && view.admitted.get(req.rid)!.hash !== contentHash(req))) {
        await unlink(join(orchInbox(this.ledgers.home), `${req.rid}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
    const after = reduceLifecycle(lifecycle(this.ledgers));
    this.consumed = { length: this.ledgers.orch.entries().length, pending: [...after.admitted.keys()].some(rid => !after.resolved.has(rid)) };
  }
