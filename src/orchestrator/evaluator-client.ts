// Private orch entries: eval-host {exec} records launch intent; eval-tracked
// {exec,process} persists process identity; eval-fenced {exec} proves retirement.
// Script console lines (host stderr JSON {t:'log',wid,ev,level,text}) go to w/<wid>/script.log, bounded per workflow.
import { appendFile, open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Containment } from '../platform/containment.ts';
import { ulid } from '../kernel/ids.ts';
import type { EvalToOrch, OrchToEval, ProcInfo, Spawned } from '../types.ts';
import type { Ledgers } from './contract.ts';
import { scriptLogPath } from './snapshot.ts';

const LOG_LIMIT = 1 << 20, LOG_LINE = 8192, LOG_FULL = '[script.log limit (1 MiB) reached; further console output is dropped]\n';
const LOG_FULL_BYTES = Buffer.byteLength(LOG_FULL);

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
  private logs: Promise<void> = Promise.resolve();
  private logSizes = new Map<string, number>();
  constructor(ledgers: Ledgers) { this.ledgers = ledgers; }
  /** P10/P11: Persist one script console line per log event; diagnostics never fail the orchestrator. */
  private log(line: string) {
    let event: { t?: unknown; wid?: unknown; ev?: unknown; level?: unknown; text?: unknown };
    try { event = JSON.parse(line); } catch { return; }
    const wid = event?.t === 'log' ? event.wid : undefined;
    if (typeof wid !== 'string' || !/^[^/\\.\0][^/\\\0]*$/.test(wid)) return;
    let text = String(event.text ?? '').replace(/\r?\n/g, '\\n');
    if (text.length > LOG_LINE) text = `${text.slice(0, LOG_LINE)}…`;
    const record = `${new Date().toISOString()} ev=${String(event.ev)} ${String(event.level ?? 'log')}: ${text}\n`;
    this.logs = this.logs.then(() => this.append(wid, record)).catch(() => {});
  }
  private async append(wid: string, record: string) {
    const path = scriptLogPath(this.ledgers.home, wid);
    let size = this.logSizes.get(wid);
    if (size === undefined) {
      size = await stat(path).then(s => s.size, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return 0; throw error; });
      if (size >= LOG_FULL_BYTES) {
        const file = await open(path, 'r'), tail = Buffer.alloc(LOG_FULL_BYTES);
        try { await file.read(tail, 0, LOG_FULL_BYTES, size - LOG_FULL_BYTES); } finally { await file.close(); }
        if (tail.toString() === LOG_FULL) size = LOG_LIMIT;
      }
    }
    if (size >= LOG_LIMIT) { this.logSizes.set(wid, size); return; }
    const bytes = Buffer.byteLength(record), fits = size + bytes + LOG_FULL_BYTES <= LOG_LIMIT;
    await appendFile(path, fits ? record : LOG_FULL);
    this.logSizes.set(wid, fits ? size + bytes : LOG_LIMIT);
  }
  private async retire() {
    clearInterval(this.timer);
    this.stopping = true;
    await this.scan;
    await this.logs;
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
    createInterface({ input: child.stderr }).on('line', line => this.log(line));
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
