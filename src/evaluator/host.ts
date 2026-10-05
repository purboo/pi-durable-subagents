// P10/P11: console diagnostics are stderr JSON lines and never consume proposal positions.
// start.inputs maps names to pinned UTF-8 file paths, read only by this host.
// Limits default to 2000ms CPU per active segment and 256MiB heap; override with
// DSA_EVALUATOR_CPU_MS / DSA_EVALUATOR_HEAP_MB. Waiting time is not CPU time.
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Worker } from 'node:worker_threads';
import type { EvalToOrch, OrchToEval } from '../types.ts';

type Start = Extract<OrchToEval, { t: 'start' }>;
type Slot = { ev: number; worker?: Worker; shared: SharedArrayBuffer; baseline?: number; need?: number; ended: boolean; retired?: Promise<number> };
const slots = new Map<string, Slot>();
const cpuMs = setting('DSA_EVALUATOR_CPU_MS', 2000);
const heapMb = setting('DSA_EVALUATOR_HEAP_MB', 256);
let closed = false;
let sampling = false;

function setting(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}
function send(message: EvalToOrch) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function finish(wid: string, slot: Slot, message?: EvalToOrch) {
  if (slot.ended) return;
  slot.ended = true;
  if (message && slots.get(wid) === slot) send(message);
  slot.retired = slot.worker?.terminate();
}
async function start(message: Start) {
  const old = slots.get(message.wid);
  if (old && old.ev >= message.ev) return;
  if (old) finish(message.wid, old);
  const slot: Slot = { ev: message.ev, shared: new SharedArrayBuffer(16), ended: false };
  slots.set(message.wid, slot);
  try {
    const [script, inputEntries] = await Promise.all([
      readFile(message.scriptPath, 'utf8'),
      Promise.all(Object.entries(message.inputs).map(async ([name, path]) => [name, await readFile(path, 'utf8')])),
    ]);
    if (old?.retired) await old.retired;
    if (closed || slot.ended) return;
    const worker = slot.worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url), {
      workerData: { start: message, script, inputs: Object.fromEntries(inputEntries), shared: slot.shared },
      resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: Math.min(16, heapMb / 4), stackSizeMb: 4, codeRangeSizeMb: 16 },
    });
    worker.on('message', (event) => {
      if (slot.ended || slots.get(message.wid) !== slot) return;
      if (event.t === 'segment') {
        if (slot.baseline !== undefined && (event.cpu - slot.baseline) / 1000 > cpuMs) {
          finish(message.wid, slot, { t: 'error', wid: message.wid, ev: message.ev, kind: 'limit', error: `Evaluator CPU segment exceeded ${cpuMs}ms` });
        }
        slot.baseline = event.cpu;
        return;
      }
      if (event.t === 'log') { process.stderr.write(`${JSON.stringify(event)}\n`); return; }
      if (event.t === 'need') slot.need = event.n;
      // P10: an idle script waits for exposures; CPU spent by the idle thread (GC, housekeeping) is not a segment.
      if (event.t === 'idle') slot.baseline = undefined;
      if (event.t === 'done' || event.t === 'error') finish(message.wid, slot, event);
      else send(event);
    });
    worker.on('error', (error: Error & { code?: string }) => finish(message.wid, slot, {
      t: 'error', wid: message.wid, ev: message.ev, error: error.message,
      kind: error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'limit' : 'script',
    }));
    worker.on('exit', (code) => finish(message.wid, slot, {
      t: 'error', wid: message.wid, ev: message.ev, kind: 'internal', error: `Worker exited unexpectedly (${code})`,
    }));
    for (const exposure of pending.get(slot) ?? []) worker.postMessage(exposure);
    pending.delete(slot);
  } catch (error) {
    finish(message.wid, slot, { t: 'error', wid: message.wid, ev: message.ev, kind: 'internal', error: String(error) });
  }
}
const pending = new WeakMap<Slot, OrchToEval[]>();
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  let message: OrchToEval;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message.wid !== 'string' || !Number.isInteger(message.ev)) return;
  if (message.t === 'start') { void start(message); return; }
  const slot = slots.get(message.wid);
  if (!slot || slot.ended || slot.ev !== message.ev) return;
  if (message.t === 'stop') finish(message.wid, slot);
  else if (message.t === 'expose') {
    if (slot.worker) slot.worker.postMessage(message);
    else pending.set(slot, [...pending.get(slot) ?? [], message]);
  } else if (message.t === 'value' && message.n === slot.need && Number.isFinite(message.value)) {
    slot.need = undefined;
    new Float64Array(slot.shared, 8, 1)[0] = message.value;
    Atomics.store(new Int32Array(slot.shared, 0, 1), 0, 1);
    Atomics.notify(new Int32Array(slot.shared, 0, 1), 0);
  }
});
const timer = setInterval(async () => {
  if (sampling) return;
  sampling = true;
  try {
    await Promise.all([...slots].map(async ([wid, slot]) => {
      if (!slot.worker || slot.ended || slot.baseline === undefined) return;
      try {
        const usage = await slot.worker.cpuUsage();
        if ((usage.user + usage.system - slot.baseline) / 1000 > cpuMs) {
          finish(wid, slot, { t: 'error', wid, ev: slot.ev, kind: 'limit', error: `Evaluator CPU segment exceeded ${cpuMs}ms` });
        }
      } catch { /* A worker may have retired during the sample. */ }
    }));
  } finally { sampling = false; }
}, 25);
input.on('close', () => {
  closed = true;
  clearInterval(timer);
  for (const [wid, slot] of slots) finish(wid, slot);
});
