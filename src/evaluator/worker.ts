import { parentPort, workerData } from 'node:worker_threads';
import { createContext, Script } from 'node:vm';
import type { OrchToEval } from '../types.ts';

const port = parentPort!;
const { start, script, inputs, shared } = workerData;
const identity = { wid: start.wid, ev: start.ev };
const signal = new Int32Array(shared, 0, 1);
const number = new Float64Array(shared, 8, 1);
let finished = false;
let scheduled = false;
let idle = false;
let nextValue = 0;
const exposures: Extract<OrchToEval, { t: 'expose' }>[] = [];
const proposed = new Set<number>();
const settled = new Set<number>();

function post(message: Record<string, unknown>) {
  port.postMessage({ ...message, ...identity });
}
function segment() {
  const usage = process.threadCpuUsage();
  post({ t: 'segment', cpu: usage.user + usage.system });
}
function fail(error: unknown) {
  if (finished) return;
  finished = true;
  segment();
  post({ t: 'error', kind: 'script', error: String(error) });
}
// P10: only JSON crosses the context boundary; all script-visible objects and
// promises are created in the context's own realm.
const context = createContext(Object.assign(Object.create(null), {
  bridge: (json: string) => {
    const message = JSON.parse(json);
    if (finished) return;
    if (message.t === 'call') proposed.add(message.pos);
    if (message.t === 'done' || message.t === 'error') { segment(); finished = true; }
    post(message);
  },
  recorded: (kind: 'now' | 'random') => {
    Atomics.store(signal, 0, 0);
    post({ t: 'need', n: nextValue++, kind });
    while (Atomics.load(signal, 0) === 0) Atomics.wait(signal, 0, 0);
    return number[0];
  },
  initial: JSON.stringify({ args: start.args, inputs }),
}), { codeGeneration: { strings: false, wasm: false } });
const receive = new Script(`(() => {
  'use strict';
  const send = bridge, value = recorded, pinned = JSON.parse(initial);
  delete globalThis.bridge; delete globalThis.recorded; delete globalThis.initial;
  const freeze = object => {
    if (object && typeof object === 'object') {
      for (const child of Object.values(object)) freeze(child);
      Object.freeze(object);
    }
    return object;
  };
  let pos = 0;
  const waiting = new Map();
  const publish = message => send(JSON.stringify(message));
  globalThis.args = freeze(pinned.args);
  globalThis.runs = Object.freeze({
    run(key, spec) {
      const at = pos++;
      return new Promise(resolve => {
        waiting.set(at, resolve);
        publish({t:'call', pos:at, key, spec});
      });
    },
    all(calls) { return Promise.all(calls.map(({key, ...spec}) => runs.run(key, spec))); },
    input(name) {
      if (!Object.hasOwn(pinned.inputs, name)) throw new Error('Undeclared input: ' + name);
      return pinned.inputs[name];
    }
  });
  globalThis.emit = result => publish({t:'emit', pos:pos++, value:result === undefined ? null : result});
  globalThis.now = () => value('now');
  globalThis.random = () => value('random');
  globalThis.console = Object.freeze(Object.fromEntries(['log','info','warn','error','debug'].map(level =>
    [level, (...args) => publish({t:'log', level, text:args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')})]
  )));
  // P10/P11: Intl defaults an omitted/undefined date to the ambient clock.
  // Guard the shared prototype so constructed, callable and borrowed APIs agree.
  const dateFormat = Intl.DateTimeFormat.prototype;
  const getFormat = Object.getOwnPropertyDescriptor(dateFormat, 'format').get;
  const formatToParts = dateFormat.formatToParts;
  const boundFormats = new WeakMap();
  const explicitDate = date => {
    if (date === undefined) throw new Error('use now() for time');
    return date;
  };
  Object.defineProperty(dateFormat, 'format', {
    configurable: false,
    get() {
      const nativeFormat = getFormat.call(this);
      if (!boundFormats.has(this)) boundFormats.set(this, date => nativeFormat(explicitDate(date)));
      return boundFormats.get(this);
    }
  });
  Object.defineProperty(dateFormat, 'formatToParts', {
    configurable: false, writable: false,
    value(date) { return formatToParts.call(this, explicitDate(date)); }
  });
  // Date is unreachable; JSON-only inputs cannot introduce Date instances.
  // Intl range APIs require both dates, and RelativeTimeFormat requires a value.
  // The vm has no performance, timers, process, crypto or Temporal globals.
  // P10: prevent accidental use of ambient clocks, entropy and GC observations.
  globalThis.Date = undefined;
  globalThis.WeakRef = undefined;
  globalThis.FinalizationRegistry = undefined;
  globalThis.SharedArrayBuffer = undefined;
  globalThis.Atomics = undefined;
  Math.random = () => { throw new Error('Use recorded random()'); };
  Object.freeze(Math);
  globalThis.complete = result => publish({t:'done', result:result === undefined ? null : result});
  globalThis.failure = error => publish({t:'error', kind:'script', error:String(error)});
  return json => {
    const {pos, result} = JSON.parse(json);
    const resolve = waiting.get(pos);
    waiting.delete(pos);
    resolve(result);
  };
})()`).runInContext(context) as (json: string) => void;

// P10/P11: a fresh immediate gives all promise reactions (including nested
// .then chains and Promise.race continuations) a full drain between exposures.
function schedule() {
  if (scheduled || finished) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    if (finished) return;
    segment();
    const head = exposures[0];
    if (head && (proposed.has(head.pos) || settled.has(head.pos))) {
      exposures.shift();
      idle = false;
      if (!settled.has(head.pos)) {
        settled.add(head.pos);
        try { receive(JSON.stringify(head)); } catch (error) { fail(error); }
      }
      schedule();
    } else if (!idle) {
      idle = true;
      post({ t: 'idle' });
    }
  });
}
port.on('message', (message: Extract<OrchToEval, { t: 'expose' }>) => {
  exposures.push(message);
  schedule();
});
process.on('unhandledRejection', fail);
try {
  segment();
  new Script(`(() => {
    const done = complete, failed = failure;
    delete globalThis.complete; delete globalThis.failure;
    (async () => { 'use strict';\n${script}\n})().then(done, failed);
  })()`, { filename: start.scriptPath }).runInContext(context);
  schedule();
} catch (error) { fail(error); }
