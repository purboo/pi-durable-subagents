// Private orch entries: eval-host {exec} records launch intent; eval-tracked
// {exec,process} persists process identity; eval-fenced {exec} proves retirement.
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Containment } from '../platform/containment.ts';
import { ulid } from '../kernel/ids.ts';
import type { EvalToOrch, OrchToEval, ProcInfo, Spawned } from '../types.ts';
import type { Ledgers } from './contract.ts';

export interface EvaluatorTransport {
  start(message: (message: EvalToOrch) => void, death: (error?: unknown) => void): Promise<void>;
  send(message: OrchToEval): void;
  close(): Promise<void>;
}

/** P10, P22: One contained evaluator host, retired before any replacement starts. */
export class EvaluatorClient implements EvaluatorTransport {
  private ledgers: Ledgers;
  private containment = new Containment();
  private child?: Spawned;
  private timer?: ReturnType<typeof setInterval>;
  private scan: Promise<void> = Promise.resolve();
  private stopping = false;
  constructor(ledgers: Ledgers) { this.ledgers = ledgers; }
  private async retire() {
    clearInterval(this.timer);
    this.stopping = true;
    await this.scan;
    this.child?.stdin.end();
    const entries = this.ledgers.orch.entries();
    for (const entry of entries.filter(e => e.type === 'eval-host' && !entries.some(f => f.type === 'eval-fenced' && f.exec === e.exec))) {
      const exec = entry.exec as string;
      const tracked = entries.filter(e => e.type === 'eval-tracked' && e.exec === exec).map(e => e.process as ProcInfo);
      await this.containment.fence(exec, tracked);
      await this.ledgers.orch.append('eval-fenced', { exec });
    }
    this.child = undefined;
  }
  /** A2, P10: Fence a previous host, commit launch intent, and attach IPC readers. */
  async start(message: (message: EvalToOrch) => void, death: (error?: unknown) => void): Promise<void> {
    await this.retire();
    const exec = `eval:${ulid()}`;
    await this.ledgers.orch.append('eval-host', { exec });
    const child = await this.containment.spawn({ exec, command: process.execPath,
      args: [fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../evaluator/host.ts' : '../evaluator/host.js', import.meta.url))], cwd: this.ledgers.home, env: { DSA_HOME: this.ledgers.home } });
    this.child = child;
    this.stopping = false;
    const known: ProcInfo[] = child.start ? [{ pid: child.pid, ppid: process.pid, start: child.start, tag: exec }] : [];
    for (const process of known) await this.ledgers.orch.append('eval-tracked', { exec, process });
    let notified = false;
    const died = (error?: unknown) => { if (!notified && !this.stopping && this.child === child) { notified = true; death(error); } };
    child.stdin.on('error', died);
    child.stderr.resume();
    createInterface({ input: child.stdout }).on('line', line => {
      try { message(JSON.parse(line) as EvalToOrch); } catch (error) { died(error); }
    });
    void child.exited.then(died, died);
    let scanning = false;
    this.timer = setInterval(() => {
      if (scanning) return;
      scanning = true;
      this.scan = (async () => {
        const found = await this.containment.scan(new Map([[exec, known]]));
        for (const process of found.get(exec) ?? []) {
          if (known.some(p => p.pid === process.pid && p.start === process.start)) continue;
          await this.ledgers.orch.append('eval-tracked', { exec, process });
          known.push(process);
        }
      })().catch(died).finally(() => { scanning = false; });
    }, this.ledgers.config.k?.trackerMs ?? 1000);
  }
  /** V3, P10: Send only through the current host's ordered input stream. */
  send(message: OrchToEval): void {
    if (!this.child || this.stopping) throw new Error('Evaluator unavailable');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  /** A2: Stop tracking and prove retirement before releasing journal authority. */
  async close(): Promise<void> { await this.retire(); }
}
