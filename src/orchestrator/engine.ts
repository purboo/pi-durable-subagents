// Private orch entries: request {request} retains immutable admitted envelopes;
// drain {rid,fence} and undrain {rid} record durable dispatch admission.
// Workflow entries: ev {n}; call {pos,key,gen,spec,fingerprint}; refused {pos,key,spec,fingerprint,reason};
// reused {pos,key,gen,spec,fingerprint,from}; exposed {pos}; value {n,kind,value};
// generation{rid,key,gen,from,spec,revision,opening} is a send resolution outside the script;
// its seal has a finished attention independent of workflow completion.
// resumed {rid,n} supersedes a terminal park. emit {pos,value} records script outputs.
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { contentHash } from '../kernel/ids.ts';
import { planDecisions, reduceLifecycle, type DecisionRecord, type Decision } from '../kernel/lifecycle.ts';
import { scanInbox } from '../kernel/mailbox.ts';
import { orchInbox, pinnedDir } from '../paths.ts';
import { JT, type Entry, type Request, type RunBody, type ReviseBody, type DrainBody, type SendBody, type EvalToOrch, type CallResult, type CallSpec } from '../types.ts';
import type { DiscoveryOptions } from '../compat/agents.ts';
import type { CallTicket, Executor, Ledgers } from './contract.ts';
import { EvaluatorClient, type EvaluatorTransport } from './evaluator-client.ts';
import { Store, revisionEntries, terminalEntry, type Workflow } from './store.ts';
import { snapshotFromEntries } from './snapshot.ts';

const clip = (text: string, n = 300) => text.length > n ? `${text.slice(0, n)}…` : text;
/** P15: A finished item tells the origin agent what happened without a status round trip: exceptions by key. */
export function finishedText(wid: string, entries: readonly Entry[], call?: string): string {
  const snap = snapshotFromEntries(wid, entries), label = snap.name ?? wid;
  if (call) {
    const c = snap.calls.find(x => x.callId === call), r = c?.result;
    return `${label}/${c?.key ?? call}@${c?.gen ?? '?'} (follow-up) ${r?.status ?? 'finished'}${r?.output ? `: ${clip(r.output.trim().split('\n').at(-1) ?? '')}` : r?.error ? `: ${clip(r.error)}` : ''}`;
  }
  const latest = new Map(snap.calls.map(c => [c.key, c]));
  const calls = [...latest.values()], ok = calls.filter(c => c.result?.ok).length;
  const bad = calls.filter(c => c.result && !c.result.ok && c.result.status !== 'skipped').map(c => `${c.key} ${c.result!.status}`);
  const skipped = calls.filter(c => c.result?.status === 'skipped').map(c => c.key);
  const parts = [`${ok} ok`, bad.length ? `${bad.join(', ')}` : '', skipped.length ? `${skipped.join(', ')} skipped` : ''].filter(Boolean);
  return `${label} (${wid}) ${snap.status}: ${parts.join('; ')}${snap.error ? `. Error: ${clip(snap.error)}` : ''}. Details: subagents status.`;
}

type State = { wf: Workflow; ev: number; calls: Map<number, Entry>; proposed: Set<number>; exposures: Entry[]; sent: number; replaying: boolean; ready: Map<number, CallResult>; running: Set<number>; outputs: Map<number, Entry>; values: Entry[]; needs: number };
export interface EngineOptions { evaluator?: EvaluatorTransport; discovery?: DiscoveryOptions }

/** A1, P2, P10, P11: Serialize decisions while executions run independently. */
export class Engine {
  readonly store: Store;
  private ledgers: Ledgers;
  private executor: Executor;
  private evaluator: EvaluatorTransport;
  private discovery?: DiscoveryOptions;
  private states = new Map<string, State>();
  private queue: Promise<void> = Promise.resolve();
  private failure?: unknown;
  private closed = false;
  private generations = new Set<string>();
  private draining = false;
  private watcher?: FSWatcher;
  private poll?: ReturnType<typeof setInterval>;
  constructor(ledgers: Ledgers, executor: Executor, options: EngineOptions = {}) {
    this.ledgers = ledgers; this.executor = executor; this.discovery = options.discovery;
    this.store = new Store(ledgers); this.evaluator = options.evaluator ?? new EvaluatorClient(ledgers);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.then(() => {}, error => { this.failure ??= error; });
    return result;
  }
  private background(fn: () => Promise<void>) { if (!this.closed) void this.serial(fn).catch(() => {}); }
  private terminal(wf: Workflow) { return terminalEntry(revisionEntries(wf)); }
  private lifecycle(): DecisionRecord[] { return this.ledgers.orch.entries().filter(e => ['admitted', 'applied', 'rejected', 'withdrawn'].includes(e.type)) as unknown as DecisionRecord[]; }
  /** A2, P10: Recover executor authority before replaying each unfinished workflow. */
  async recover(): Promise<void> {
    this.draining = this.ledgers.orch.entries().findLast(e => e.type === 'drain' || e.type === 'undrain')?.type === 'drain';
    await this.store.recover();
    for (const wf of this.store.workflows.values()) {
      await this.executor.recover(wf.wid, wf.journal);
      // A seal may survive a crash before post-seal effects, even after workflow completion.
      let revision = 1;
      for (const entry of wf.journal.entries()) {
        if (entry.type === 'revised') revision = Number(entry.revision);
        if (entry.type !== 'call' && entry.type !== 'generation') continue;
        const call = `${wf.wid}@${revision}/${entry.key}@${entry.gen}`;
        const log = wf.journal.entries();
        const result = log.find(e => e.type === JT.sealed && e.call === call)?.result as CallResult | undefined;
        if (result?.status !== 'ok' || !log.some(e => e.type === 'wt-intent' && e.call === call) ||
          log.some(e => ['wt-removed', 'wt-kept'].includes(e.type) && e.call === call)) continue;
        const original = await this.store.atRevision(wf, revision);
        await this.executor.run(this.ticket({ wf: original } as State, entry));
      }
    }
    await this.startHost();
    for (const intent of this.ledgers.orch.entries().filter(e => e.type === 'revise-intent')) await this.revise(intent);
    for (const wf of this.store.workflows.values()) {
      if (!this.terminal(wf)) await this.startWorkflow(wf);
      else await this.attention(wf);
      for (const entry of revisionEntries(wf).filter(e => e.type === 'generation')) this.dispatchGeneration(wf, entry);
    }
    await this.intake();
  }
  private async startHost() {
    await this.evaluator.start(message => this.background(() => this.message(message)), () => this.background(async () => {
      await this.startHost();
      for (const wf of this.store.workflows.values()) if (!this.terminal(wf)) await this.startWorkflow(wf);
    }));
  }
  private async startWorkflow(wf: Workflow) {
    if (this.terminal(wf)) return;
    await this.resolveFinished(wf);
    const log = revisionEntries(wf);
    const ev = Math.max(0, ...wf.journal.entries().filter(e => e.type === 'ev').map(e => e.n as number)) + 1;
    await wf.journal.append('ev', { n: ev });
    const calls = new Map(log.filter(e => ['call', 'refused', 'reused'].includes(e.type)).map(e => [e.pos as number, e]));
    const st: State = { wf, ev, calls, proposed: new Set(), exposures: log.filter(e => e.type === 'exposed'), sent: 0, replaying: true, ready: new Map(), running: new Set(), outputs: new Map(log.filter(e => ['call', 'refused', 'reused', 'emit'].includes(e.type)).map(e => [e.pos as number, e])), values: log.filter(e => e.type === 'value'), needs: 0 };
    this.states.set(wf.wid, st);
    this.evaluator.send({ t: 'start', wid: wf.wid, ev, scriptPath: wf.scriptPath, args: wf.pins.args, inputs: wf.inputs });
  }
  /** P5, P6, A3: Commit lifecycle decisions in kernel order before acknowledging intake. */
  intake(): Promise<void> { return this.serial(() => this.consume()); }
  private async consume() {
    const scanned = (await scanInbox(orchInbox(this.ledgers.home))).filter(r => r.to === 'orch');
    const retained = this.ledgers.orch.entries().filter(e => e.type === 'request').map(e => e.request as Request);
    const candidates = [...retained, ...scanned];
    const before = reduceLifecycle(this.lifecycle()), staged = new Set<string>();
    for (const request of candidates) {
      if (!['run', 'revise'].includes(request.kind) || before.admitted.has(request.rid) || before.tombstones.has(request.rid) || staged.has(request.rid)) continue;
      await this.store.stage(request as Request<RunBody>, this.discovery);
      staged.add(request.rid);
    }
    const records = planDecisions(this.lifecycle(), candidates, () => ({ action: 'defer' }));
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
      planDecisions(this.lifecycle(), candidates, req => { selected ??= req; return { action: 'defer' }; });
      if (!selected) break;
      const decision = await this.decide(selected);
      if (decision.action === 'defer') break;
      const resolution = planDecisions(this.lifecycle(), candidates, req => req.rid === selected!.rid ? decision : { action: 'defer' });
      for (const { type, ...fields } of resolution) await this.ledgers.orch.append(type, fields);
    }
    const view = reduceLifecycle(this.lifecycle());
    for (const [rid, resolution] of view.resolved) {
      if (resolution.type === 'rejected' && ['run', 'revise'].includes(view.admitted.get(rid)?.kind ?? '')) await this.store.discardStage(rid);
    }
    for (const rid of view.tombstones) await this.store.discardStage(rid);
    for (const req of scanned) {
      if (view.resolved.has(req.rid) || (view.admitted.has(req.rid) && view.admitted.get(req.rid)!.hash !== contentHash(req))) {
        await unlink(join(orchInbox(this.ledgers.home), `${req.rid}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
  }
  private findCall(to: string): { wf: Workflow; entry: Entry } | undefined {
    for (const wf of this.store.workflows.values()) {
      const calls = revisionEntries(wf).filter(e => e.type === 'call' || e.type === 'generation');
      const named = calls.findLast(e => to === `${wf.wid}@${wf.revision}/${e.key}@${e.gen}` || to === `${wf.wid}/${e.key}`);
      const entry = named && calls.findLast(e => e.key === named.key);
      if (entry) return { wf, entry };
    }
  }
  private context(wf: Workflow, entry: Entry) { return { journal: wf.journal, widRev: `${wf.wid}@${wf.revision}` as const, key: entry.key as string, gen: entry.gen as number }; }
  private async withdraw(req: Request) {
    const rids = (req.body as { rids: string[] }).rids;
    for (const wf of this.store.workflows.values()) {
      const requests = this.ledgers.orch.entries().filter(e => e.type === 'request').map(e => e.request as Request);
      const sent = requests.filter(r => r.kind === 'send' && rids.includes(r.rid));
      const visited = new Set<string>();
      for (const target of sent) {
        const found = this.findCall((target.body as SendBody).to);
        if (!found || found.wf !== wf || visited.has(found.entry.key as string)) continue;
        visited.add(found.entry.key as string);
        await this.executor.forward(req, this.context(wf, found.entry));
      }
    }
  }
  private async decide(req: Request): Promise<Decision> {
    const body = req.body as { to?: string; target?: string; wid?: string } | null;
    for (const address of [body?.to, body?.target, body?.wid, req.cond?.epoch]) {
      const match = typeof address === 'string' && /^([^/@]+)@(\d+)(?:\/|$)/.exec(address);
      if (match && this.store.workflows.has(match[1]!) && this.store.workflows.get(match[1]!)!.revision !== Number(match[2])) return { action: 'reject', reason: 'stale-revision' };
    }
    if (req.cond?.epoch) {
      const target = req.kind === 'send' ? this.findCall((req.body as SendBody).to) : undefined;
      if (!target || req.cond.epoch !== `${target.wf.wid}@${target.wf.revision}`) return { action: 'reject', reason: 'stale-epoch' };
    }
    if (req.kind === 'run') {
      const created = this.ledgers.orch.entries().find(e => e.type === JT.created && e.rid === req.rid);
      let wf = created ? this.store.workflows.get(created.wid as string) : undefined;
      if (!wf) {
        try { await this.store.staged(req as Request<RunBody>); }
        catch (error) { return { action: 'reject', reason: `pin-failed: ${String(error)}` }; }
        wf = await this.store.create(req as Request<RunBody>);
      }
      if (!this.states.has(wf!.wid) && !this.terminal(wf!)) await this.startWorkflow(wf!);
    } else if (req.kind === 'revise') {
      const wf = this.store.workflows.get((req.body as ReviseBody)?.wid);
      if (!wf) return { action: 'reject', reason: 'unknown-workflow' };
      try { await this.store.staged(req as Request<ReviseBody>); }
      catch (error) { return { action: 'reject', reason: `pin-failed: ${String(error)}` }; }
      await this.revise(await this.store.revisionIntent(req as Request<ReviseBody>, wf));
      if (!this.states.has(wf.wid) && !this.terminal(wf)) await this.startWorkflow(wf);
    } else if (req.kind === 'send') {
      const existing = [...this.store.workflows.values()].flatMap(wf => wf.journal.entries().filter(e => e.type === 'generation' && e.rid === req.rid).map(entry => ({ wf, entry })))[0];
      if (existing) { this.dispatchGeneration(existing.wf, existing.entry); return { action: 'apply' }; }
      const target = this.findCall((req.body as SendBody)?.to);
      if (!target) return { action: 'reject', reason: 'unknown-call' };
      const { wf, entry } = target, send = req.body as SendBody;
      const from = `${wf.wid}@${wf.revision}/${entry.key}@${entry.gen}`;
      if (['steer', 'follow-up'].includes(send.kind) && wf.journal.entries().some(e => e.type === JT.sealed && e.call === from)) {
        const gen = Math.max(0, ...wf.journal.entries().filter(e => ['call', 'generation'].includes(e.type) && e.key === entry.key).map(e => Number(e.gen))) + 1;
        const opened = await wf.journal.append('generation', { rid: req.rid, key: entry.key, gen, from, spec: entry.spec, revision: wf.revision, opening: { rid: req.rid, kind: send.kind, message: send.message ?? '' } });
        this.dispatchGeneration(wf, opened); return { action: 'apply' };
      }
      return this.executor.forward(req, this.context(wf, entry));
    } else if (req.kind === 'stop') {
      const target = (req.body as { target: string })?.target;
      const call = this.findCall(target), wf = call?.wf ?? this.store.workflows.get(target);
      if (!wf) return { action: 'reject', reason: 'unknown-workflow' };
      await this.executor.stop({ wid: wf.wid, ...(call ? { callId: `${wf.wid}@${wf.revision}/${call.entry.key}@${call.entry.gen}` } : {}) });
      if (!call) await this.finish(wf, 'stopped');
    } else if (req.kind === 'resume') {
      const wid = (req.body as { wid?: string })?.wid;
      if (wid && !this.store.workflows.has(wid)) return { action: 'reject', reason: 'unknown-workflow' };
      const wasDrained = this.draining;
      if (wasDrained) {
        await this.ledgers.orch.append('undrain', { rid: req.rid });
        this.draining = false;
      }
      for (const wf of this.store.workflows.values()) {
        const done = this.terminal(wf);
        if ((wid && wf.wid !== wid && (!wasDrained || done)) || (done && done.status !== 'parked')) continue;
        if (!wf.journal.entries().some(e => e.type === 'resumed' && e.rid === req.rid)) {
          const n = (!wasDrained ? this.states.get(wf.wid)?.ev : undefined) ?? Math.max(0, ...wf.journal.entries().filter(e => e.type === 'ev').map(e => Number(e.n))) + 1;
          await wf.journal.append('resumed', { rid: req.rid, n });
          await this.resolveFinished(wf);
        }
        if (wasDrained) {
          const st = this.states.get(wf.wid);
          if (st) this.evaluator.send({ t: 'stop', wid: wf.wid, ev: st.ev });
          this.states.delete(wf.wid);
        }
        if (!this.states.has(wf.wid)) await this.startWorkflow(wf);
      }
      for (const wf of this.store.workflows.values()) for (const entry of revisionEntries(wf).filter(e => e.type === 'generation')) this.dispatchGeneration(wf, entry);
    } else if (req.kind === 'drain') {
      const fence = (req.body as DrainBody)?.fence === true;
      if (!this.ledgers.orch.entries().some(e => e.type === 'drain' && e.rid === req.rid)) await this.ledgers.orch.append('drain', { rid: req.rid, fence });
      this.draining = true;
      if (fence) {
        await this.executor.suspend();
        for (const st of this.states.values()) st.running.clear();
      }
    } else return { action: 'reject', reason: 'unsupported-kind' };
    return { action: 'apply' };
  }
  private dispatchGeneration(wf: Workflow, entry: Entry) {
    const ticket = this.ticket({ wf } as State, entry), id = ticket.callId;
    if (this.generations.has(id) || this.draining || wf.journal.entries().some(e => e.type === 'retired' && e.call === id)) return;
    this.generations.add(id);
    void this.executor.run(ticket).then(() => this.background(async () => {
      if (!wf.journal.entries().some(e => e.type === JT.sealed && e.call === id)) throw new Error(`Generation returned without seal: ${id}`);
      if (!wf.journal.entries().some(e => e.type === JT.attention && (e.item as { id?: string }).id === `finished:${id}`))
        await wf.journal.append(JT.attention, { item: { id: `finished:${id}`, rev: 1, kind: 'finished', wid: wf.wid, call: id, text: finishedText(wf.wid, wf.journal.entries(), id), origin: wf.origin } });
      this.generations.delete(id);
    }), error => {
      this.generations.delete(id);
      if (error instanceof Error && error.name === 'ExecutorShutdown') return;
      this.background(async () => { throw error; });
    });
  }
  private ticket(st: State, entry: Entry): CallTicket {
    const spec = entry.spec as CallSpec, agent = st.wf.pins.agents.find(a => a.name === spec.agent);
    if (!agent) throw new Error(`Unknown pinned agent: ${spec.agent}`);
    return { wid: st.wf.wid, widRev: `${st.wf.wid}@${st.wf.revision}`, key: entry.key as string, gen: entry.gen as number,
      callId: `${st.wf.wid}@${st.wf.revision}/${entry.key}@${entry.gen}`, spec, agent, workflowBudget: st.wf.pins.usageBudget, cwd: resolve(st.wf.cwd, spec.cwd ?? '.'), journal: st.wf.journal,
      ...(st.wf.pins.origin !== undefined ? { originSession: join(pinnedDir(this.ledgers.home, st.wf.wid), ...(st.wf.revision === 1 ? [] : [`r${st.wf.revision}`]), 'origin.jsonl') } : {}),
      ...(entry.type === 'generation' ? { continueFrom: entry.from as CallTicket['continueFrom'], opening: entry.opening as CallTicket['opening'] } : {}) };
  }
  private sealed(st: State, entry: Entry): CallResult | undefined {
    if (entry.type === 'refused') return { key: String(entry.key), gen: 0, status: 'failed', ok: false, error: 'spawn budget exceeded', output: '' };
    const call = entry.type === 'reused' ? entry.from : `${st.wf.wid}@${st.wf.revision}/${entry.key}@${entry.gen}`;
    return st.wf.journal.entries().find(e => e.type === JT.sealed && e.call === call)?.result as CallResult | undefined;
  }
  private dispatch(st: State, entry: Entry) {
    const pos = entry.pos as number;
    if (st.running.has(pos)) return;
    const sealed = this.sealed(st, entry);
    if (sealed) { st.ready.set(pos, sealed); return; }
    if (this.draining) return;
    st.running.add(pos);
    void this.executor.run(this.ticket(st, entry)).then(() => this.background(async () => {
      if (this.states.get(st.wf.wid) !== st || this.terminal(st.wf)) return;
      const result = this.sealed(st, entry);
      if (!result) throw new Error(`Executor returned without seal: ${entry.key}`);
      st.ready.set(pos, result); await this.flush(st);
    }), error => {
      if (error instanceof Error && error.name === 'ExecutorShutdown') return;
      this.background(async () => { if (this.states.get(st.wf.wid) === st) throw error; });
    });
  }
  private async flush(st: State) {
    while (st.sent < st.exposures.length) {
      const pos = st.exposures[st.sent]!.pos as number;
      if (!st.proposed.has(pos)) return;
      const entry = st.calls.get(pos), result = entry && this.sealed(st, entry);
      if (!result) { await this.finish(st.wf, 'parked', undefined, `Missing sealed result at ${pos}`); return; }
      this.evaluator.send({ t: 'expose', wid: st.wf.wid, ev: st.ev, pos, result });
      st.ready.delete(pos); st.sent++;
    }
    if (st.replaying) return;
    for (const [pos, result] of st.ready) {
      await st.wf.journal.append('exposed', { pos });
      this.evaluator.send({ t: 'expose', wid: st.wf.wid, ev: st.ev, pos, result });
      st.ready.delete(pos);
    }
  }
  private async message(message: EvalToOrch) {
    const st = this.states.get(message.wid);
    if (!st || st.ev !== message.ev || this.terminal(st.wf)) return;
    const park = (error: string) => this.finish(st.wf, 'parked', undefined, error);
    if (message.t === 'call') {
      const agent = st.wf.pins.agents.find(a => a.name === message.spec.agent);
      if (!agent) return park(`Unknown pinned agent: ${message.spec.agent}`);
      const fingerprint = contentHash({ spec: message.spec, agent }), old = st.outputs.get(message.pos);
      if (st.proposed.has(message.pos) || (old && (!['call', 'refused', 'reused'].includes(old.type) || old.key !== message.key || old.fingerprint !== fingerprint))) return park(`Replay mismatch at ${message.pos}`);
      if (!old && [...st.calls.values()].some(e => e.key === message.key)) return park(`Duplicate call key: ${message.key}`);
      let entry = old;
      if (!entry) {
        const history = st.wf.journal.entries(), boundary = history.findLast(e => e.type === 'revised')?.seq ?? 0;
        let revision = 1;
        const matching: string[] = [];
        for (const e of history) {
          if (e.type === 'revised') revision = Number(e.revision);
          if (e.seq < boundary && e.type === 'call' && e.key === message.key && e.fingerprint === fingerprint) matching.push(`${st.wf.wid}@${revision}/${e.key}@${e.gen}`);
        }
        const reused = history.findLast(e => e.type === JT.sealed && matching.includes(String(e.call)));
        const fields = { pos: message.pos, key: message.key, spec: message.spec, fingerprint };
        if (reused) entry = await st.wf.journal.append('reused', { ...fields, from: reused.call, gen: (reused.result as CallResult).gen });
        else if (history.filter(e => e.type === 'call').length >= (st.wf.pins.maxCalls ?? 300)) {
          entry = await st.wf.journal.append('refused', { ...fields, reason: 'spawn-budget' });
        } else {
          const gen = Math.max(0, ...history.filter(e => ['call', 'generation'].includes(e.type) && e.key === message.key).map(e => Number(e.gen))) + 1;
          entry = await st.wf.journal.append('call', { ...fields, gen });
        }
      }
      st.calls.set(message.pos, entry); st.proposed.add(message.pos);
      if (!st.exposures.some(e => e.pos === message.pos)) this.dispatch(st, entry);
      await this.flush(st);
    } else if (message.t === 'need') {
      const old = st.values[message.n];
      if (message.n !== st.needs++ || (old && old.kind !== message.kind)) return park(`Value mismatch at ${message.n}`);
      const value = old?.value as number | undefined ?? (message.kind === 'now' ? Date.now() : Math.random());
      if (!old) await st.wf.journal.append('value', { n: message.n, kind: message.kind, value });
      this.evaluator.send({ t: 'value', wid: st.wf.wid, ev: st.ev, n: message.n, value });
    } else if (message.t === 'emit') {
      const old = st.outputs.get(message.pos);
      if (old && (old.type !== 'emit' || contentHash(old.value) !== contentHash(message.value))) return park(`Emit mismatch at ${message.pos}`);
      if (!old) await st.wf.journal.append('emit', { pos: message.pos, value: message.value });
      st.proposed.add(message.pos);
    } else if (message.t === 'idle') {
      if (st.replaying && st.sent === st.exposures.length && message.exposed >= st.sent) {
        if ([...st.outputs.keys()].some(pos => !st.proposed.has(pos)) || st.needs < st.values.length) return park('Missing output at replay frontier');
        st.replaying = false; await this.flush(st);
      }
    } else if (message.t === 'done') {
      if ([...st.outputs.keys()].some(pos => !st.proposed.has(pos)) || st.sent !== st.exposures.length || st.needs < st.values.length) return park('Missing output at replay completion');
      await this.finish(st.wf, 'done', message.result);
    } else if (message.t === 'error') await this.finish(st.wf, message.kind === 'script' ? 'failed' : 'parked', undefined, message.error);
  }
  private async attention(wf: Workflow) {
    const done = this.terminal(wf);
    const rev = wf.journal.entries().filter(e => e.type === JT.done).length;
    if (done && !wf.journal.entries().some(e => e.type === JT.attention && (e.item as { id: string; rev: number }).id === `finished:${wf.wid}` && (e.item as { rev: number }).rev === rev)) {
      await wf.journal.append(JT.attention, { item: { id: `finished:${wf.wid}`, rev, kind: 'finished', wid: wf.wid, text: finishedText(wf.wid, wf.journal.entries()) } });
    }
  }
  private async resolveFinished(wf: Workflow) {
    for (const e of wf.journal.entries().filter(e => e.type === JT.attention)) {
      const item = e.item as { id: string; rev: number; kind: string };
      if (item.kind === 'finished' && !wf.journal.entries().some(r => r.type === JT.attentionResolved && r.id === item.id && r.rev === item.rev)) {
        await wf.journal.append(JT.attentionResolved, { id: item.id, rev: item.rev, resolution: 'resumed' });
      }
    }
  }
  private async revise(intent: Entry) {
    const wf = this.store.workflows.get(String(intent.wid));
    if (!wf || wf.revision >= Number(intent.revision)) return;
    const st = this.states.get(wf.wid);
    this.states.delete(wf.wid); // Retired promises and queued evaluator events cannot mutate the new revision.
    await this.executor.retire(`${wf.wid}@${wf.revision}`);
    if (st) this.evaluator.send({ t: 'stop', wid: wf.wid, ev: st.ev });
    await this.store.revise(intent);
    await this.resolveFinished(wf);
  }
  private async finish(wf: Workflow, status: string, result?: unknown, error?: string) {
    if (!this.terminal(wf)) await wf.journal.append(JT.done, { status, ...(result !== undefined ? { result } : {}), ...(error ? { error } : {}) });
    await this.attention(wf);
    const st = this.states.get(wf.wid);
    if (st) this.evaluator.send({ t: 'stop', wid: wf.wid, ev: st.ev });
    this.states.delete(wf.wid);
  }
  /** K6, P5: Watch with polling fallback and exit only after continuous quiescence. */
  async loop(signal?: AbortSignal): Promise<void> {
    const inbox = orchInbox(this.ledgers.home);
    await mkdir(inbox, { recursive: true });
    this.watcher = watch(inbox, () => this.background(() => this.consume()));
    this.watcher.on('error', () => { this.watcher?.close(); });
    this.poll = setInterval(() => this.background(() => this.consume()), 1000);
    let idleSince = performance.now();
    try {
      while (!signal?.aborted && !this.closed) {
        await this.queue;
        if (this.failure) throw this.failure;
        const files = await readdir(inbox);
        if (this.draining || this.generations.size || [...this.store.workflows.values()].some(w => !this.terminal(w)) || this.executor.busy() || files.length) idleSince = performance.now();
        else if (performance.now() - idleSince >= (this.ledgers.config.k?.idleExitMs ?? 60_000)) return;
        await delay(Math.min(100, this.ledgers.config.k?.idleExitMs ?? 100));
      }
    } finally { this.watcher?.close(); clearInterval(this.poll); }
  }
  /** A1, A2: Retire asynchronous producers before closing their journals. */
  async close(): Promise<void> {
    this.closed = true; this.watcher?.close(); clearInterval(this.poll);
    await this.queue; await this.evaluator.close(); await this.executor.shutdown(); await this.store.close();
  }
}
