import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import type { EvalToOrch, OrchToEval, CallResult } from '../../../src/types.ts';

const hostPath = new URL('../../../src/evaluator/host.ts', import.meta.url);
async function harness(source: string, env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsa-evaluator-'));
  const scriptPath = join(dir, 'workflow.js');
  await writeFile(scriptPath, source);
  const child = spawn(process.execPath, [hostPath.pathname], {
    env: { ...process.env, DSA_HOME: dir, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: EvalToOrch[] = [];
  const queue: EvalToOrch[] = [];
  let wake: (() => void) | undefined;
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line) as EvalToOrch;
    messages.push(message); queue.push(message); wake?.();
  });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  function send(...messages: OrchToEval[]) { child.stdin.write(messages.map(m => JSON.stringify(m) + '\n').join('')); }
  async function next(): Promise<EvalToOrch> {
    if (!queue.length) await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { wake = undefined; reject(new Error(`Host timeout: ${stderr}\n${JSON.stringify(messages)}`)); }, 6000);
      wake = () => { clearTimeout(timeout); wake = undefined; resolve(); };
    });
    return queue.shift()!;
  }
  return {
    dir, messages, send, next, stderr: () => stderr,
    start(args: unknown = {}, inputs: Record<string, string> = {}, ev = 1, wid = 'w') {
      send({ t: 'start', wid, ev, scriptPath, args, inputs });
    },
    async terminal() {
      for (;;) { const message = await next(); if (message.t === 'done' || message.t === 'error') return message; }
    },
    async close() { child.stdin.end(); await exited; await rm(dir, { recursive: true, force: true }); },
  };
}
function result(key: string, ok = true): CallResult { return { key, gen: 1, status: ok ? 'ok' : 'failed', ok, output: 'result:' + key }; }
function exposure(pos: number, key: string, ok = true): Extract<OrchToEval, { t: 'expose' }> {
  return { t: 'expose', wid: 'w', ev: 1, pos, result: result(key, ok) };
}

for (const expression of [
  'new Intl.DateTimeFormat().format()',
  'Intl.DateTimeFormat().format(undefined)',
  'new Intl.DateTimeFormat().formatToParts()',
  'new Intl.DateTimeFormat().formatToParts(undefined)',
  'Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format").get.call(new Intl.DateTimeFormat())()',
  'Intl.DateTimeFormat.prototype.formatToParts.call(new Intl.DateTimeFormat())',
]) {
  test('implicit Intl clock is a reproducible script error: ' + expression, { timeout: 10000 }, async () => {
    const runs: EvalToOrch[][] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const h = await harness(`emit(${expression}); return 'unreachable';`);
      try {
        h.start();
        assert.deepEqual(await h.terminal(), {
          t:'error', wid:'w', ev:1, kind:'script', error:'Error: use now() for time',
        });
        assert.equal(h.messages.some(m => m.t === 'emit' || m.t === 'call'), false);
        runs.push(h.messages);
      } finally { await h.close(); }
    }
    assert.deepEqual(runs[0], runs[1]);
  });
}

test('explicit Intl dates replay identically and other ambient clocks are absent', { timeout: 10000 }, async () => {
  const runs: EvalToOrch[][] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const h = await harness(`
      const fmt = new Intl.DateTimeFormat('en-US', {timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'});
      const date = now();
      const blocked = [];
      for (const method of ['formatRange', 'formatRangeToParts']) {
        for (const dates of [[], [0], [undefined, 0], [0, undefined]]) {
          try { fmt[method](...dates); blocked.push(false); } catch { blocked.push(true); }
        }
      }
      emit({text:fmt.format(date), parts:fmt.formatToParts(date), stableBound:fmt.format === fmt.format,
        range:fmt.formatRange(date,date), relative:new Intl.RelativeTimeFormat('en-US').format(1,'day'),
        blocked, absent:[typeof Date, typeof performance, typeof setTimeout, typeof setInterval,
          typeof setImmediate, typeof process, typeof crypto, typeof Temporal]});
      return fmt.format(0);
    `);
    try {
      h.start();
      assert.equal((await h.next()).t, 'need');
      h.send({t:'value',wid:'w',ev:1,n:0,value:0});
      assert.deepEqual(await h.terminal(), {t:'done',wid:'w',ev:1,result:'01/01/1970'});
      const emitted = h.messages.find(m => m.t === 'emit');
      assert.ok(emitted?.t === 'emit');
      const value = emitted.value as { text: string; stableBound: boolean; blocked: boolean[]; absent: string[] };
      assert.equal(value.text, '01/01/1970');
      assert.equal(value.stableBound, true);
      assert.deepEqual(value.blocked, Array(8).fill(true));
      assert.deepEqual(value.absent, Array(8).fill('undefined'));
      runs.push(h.messages);
    } finally { await h.close(); }
  }
  assert.deepEqual(runs[0], runs[1]);
});

test('rolling DAG preserves proposals with repeated live delivery and eager replay', { timeout: 20000 }, async () => {
  const source = await readFile(new URL('./fixtures/rolling-dag.js', import.meta.url), 'utf8');
  async function execute(order?: Extract<OrchToEval, { t: 'expose' }>[], fast = false) {
    const h = await harness(source);
    const delivered: Extract<OrchToEval, { t: 'expose' }>[] = [];
    const ready = new Map<number, string>();
    try {
      h.start();
      if (fast) h.send(...order!);
      for (;;) {
        const message = await h.next();
        if (message.t === 'call') ready.set(message.pos, message.key);
        if (message.t === 'error') assert.fail(message.error);
        if (message.t === 'done') return { proposals: h.messages.filter(m => m.t === 'call' || m.t === 'emit'), delivered, result: message.result };
        if (message.t === 'idle' && !fast) {
          assert.ok(ready.size, 'idle has outstanding work');
          const [pos, key] = [...ready].at(-1)!;
          const item = order ? order[delivered.length]! : exposure(pos, key, key !== 'c');
          assert.ok(ready.has(item.pos));
          ready.delete(item.pos);
          delivered.push(item);
          h.send(item);
        }
      }
    } finally { await h.close(); }
  }
  const live = await execute();
  const repeat = await execute(live.delivered);
  const replay = await execute(live.delivered, true);
  assert.deepEqual(repeat.proposals, live.proposals);
  assert.deepEqual(replay.proposals, live.proposals);
  assert.deepEqual(replay.result, live.result);
  assert.deepEqual(new Set((live.result as { failed: string[] }).failed), new Set(['c', 'e', 'f']));
  assert.ok(live.proposals.length >= 10);
});

test('top-level return, frozen args, pinned inputs and restricted globals', { timeout: 10000 }, async () => {
  const h = await harness(`
    let frozen = false;
    try { args.nested.value = 9; } catch { frozen = true; }
    let entropy = false; try { Math.random(); } catch { entropy = true; }
    let generated = false; try { Function('return process')(); } catch { generated = true; }
    console.log('diagnostic', {ok:true});
    emit({seen: args.nested.value});
    const values = await runs.all([{key:'x',agent:'a',task:'x'}, {key:'y',agent:'a',task:'y'}]);
    return { frozen, entropy, generated, value:args.nested.value, input:runs.input('data'),
      absent:[typeof require, typeof process, typeof setTimeout, typeof setInterval, typeof fetch, typeof Date],
      keys:values.map(v => v.key) };
  `);
  try {
    const input = join(h.dir, 'pinned.txt'); await writeFile(input, 'pinned contents');
    h.start({ nested: { value: 3 } }, { data: input });
    assert.equal((await h.next()).t, 'emit');
    const x = await h.next(), y = await h.next();
    assert.equal(x.t, 'call'); assert.equal(y.t, 'call');
    if (x.t !== 'call' || y.t !== 'call') return;
    assert.deepEqual([x.pos, y.pos], [1, 2]);
    assert.equal((await h.next()).t, 'idle');
    h.send(exposure(y.pos, 'y'), exposure(x.pos, 'x'));
    const done = await h.terminal();
    assert.equal(done.t, 'done');
    if (done.t === 'done') assert.deepEqual(done.result, { frozen:true, entropy:true, generated:true, value:3,
      input:'pinned contents', absent:Array(6).fill('undefined'), keys:['x','y'] });
  } finally { await h.close(); }
  assert.deepEqual(JSON.parse(h.stderr().trim()), {t:'log',wid:'w',ev:1,level:'log',text:'diagnostic {"ok":true}'});
});

test('now/random use numbered recorded values and replay exactly', { timeout: 10000 }, async () => {
  async function run() {
    const h = await harness('const a = now(); const b = random(); return [a,b,now()];');
    try {
      h.start();
      const values = [123456, 0.375, 987654];
      for (let n = 0; n < values.length; n++) {
        assert.deepEqual(await h.next(), {t:'need',wid:'w',ev:1,n,kind:n === 1 ? 'random' : 'now'});
        h.send({t:'value',wid:'w',ev:0,n,value:99}, {t:'value',wid:'w',ev:1,n:n+1,value:99});
        h.send({t:'value',wid:'w',ev:1,n,value:values[n]!});
      }
      assert.deepEqual(await h.terminal(), {t:'done',wid:'w',ev:1,result:values});
      return h.messages;
    } finally { await h.close(); }
  }
  assert.deepEqual(await run(), await run());
});

test('idle is emitted only after nested microtasks drain; exposures settle one at a time', { timeout: 10000 }, async () => {
  const h = await harness(`
    const seen = [];
    const a = runs.run('a',{agent:'a',task:'a'}).then(async () => {
      for (let i=0;i<100;i++) await Promise.resolve();
      seen.push('a'); emit('a');
    });
    const b = runs.run('b',{agent:'a',task:'b'}).then(() => { seen.push('b'); emit('b'); });
    await Promise.all([a,b]); return seen;
  `);
  try {
    h.start(); h.send(exposure(0, 'a'), exposure(1, 'b'));
    assert.deepEqual(await h.terminal(), {t:'done',wid:'w',ev:1,result:['a','b']});
    assert.deepEqual(h.messages.filter(m => m.t === 'emit').map(m => m.value), ['a','b']);
  } finally { await h.close(); }
});

for (const source of ['while(true) {}', 'await runs.run("a",{agent:"a",task:"a"}); while(true) {}', 'await Promise.resolve(); while(true) {}']) {
  test('CPU limit terminates runaway sync or async segment: ' + source.slice(0, 30), { timeout: 10000 }, async () => {
    const h = await harness(source, { DSA_EVALUATOR_CPU_MS: '150' });
    try {
      h.start(); h.send(exposure(0, 'a'));
      const terminal = await h.terminal();
      assert.equal(terminal.t, 'error');
      if (terminal.t === 'error') assert.equal(terminal.kind, 'limit');
    } finally { await h.close(); }
  });
}

for (const source of ['throw new Error("broken")', 'await Promise.resolve(); throw new Error("broken")', 'return runs.input("missing")', 'return import("node:fs")', 'return )']) {
  test('script errors are terminal: ' + source, { timeout: 10000 }, async () => {
    const h = await harness(source);
    try {
      h.start(); const terminal = await h.terminal();
      assert.equal(terminal.t, 'error');
      if (terminal.t === 'error') assert.equal(terminal.kind, 'script');
    } finally { await h.close(); }
  });
}

test('independent workflows share one host; stopping one leaves the other live', { timeout: 10000 }, async () => {
  const h = await harness('return (await runs.run("a",{agent:"a",task:"a"})).key;');
  try {
    h.start({}, {}, 1, 'left'); h.start({}, {}, 1, 'right');
    const idle = new Set();
    while (idle.size < 2) { const m = await h.next(); if (m.t === 'idle') idle.add(m.wid); }
    h.send({t:'stop',wid:'left',ev:1}, {...exposure(0, 'right'),wid:'right'});
    assert.deepEqual(await h.terminal(), {t:'done',wid:'right',ev:1,result:'right'});
  } finally { await h.close(); }
});

test('recorded-value waits and idle waits do not consume CPU budget', { timeout: 10000 }, async () => {
  const h = await harness('const n = now(); await runs.run("a",{agent:"a",task:"a"}); return n;', {DSA_EVALUATOR_CPU_MS:'200'});
  try {
    h.start(); assert.equal((await h.next()).t, 'need');
    await new Promise(resolve => setTimeout(resolve, 350));
    h.send({t:'value',wid:'w',ev:1,n:0,value:42});
    assert.equal((await h.next()).t, 'call'); assert.equal((await h.next()).t, 'idle');
    await new Promise(resolve => setTimeout(resolve, 350));
    h.send(exposure(0, 'a'));
    assert.deepEqual(await h.terminal(), {t:'done',wid:'w',ev:1,result:42});
  } finally { await h.close(); }
});

test('CPU budget resets between eagerly replayed exposure segments', { timeout: 10000 }, async () => {
  const h = await harness(`
    let checksum = 0;
    for (let step=0;step<40;step++) {
      await runs.run(String(step),{agent:'a',task:'a'});
      for (let i=0;i<8000000;i++) checksum ^= i;
    }
    return checksum;
  `, {DSA_EVALUATOR_CPU_MS:'200'});
  try {
    h.start(); h.send(...Array.from({length:40}, (_, pos) => exposure(pos, String(pos))));
    assert.deepEqual(await h.terminal(), {t:'done',wid:'w',ev:1,result:0});
  } finally { await h.close(); }
});

test('heap limit reports limit without killing the host', { timeout: 10000 }, async () => {
  const h = await harness('const held = []; while(true) held.push(new Array(100000).fill(42));', {
    DSA_EVALUATOR_HEAP_MB:'32', DSA_EVALUATOR_CPU_MS:'5000',
  });
  try {
    h.start(); const terminal = await h.terminal();
    assert.equal(terminal.t, 'error');
    if (terminal.t === 'error') assert.equal(terminal.kind, 'limit');
    await writeFile(join(h.dir, 'workflow.js'), 'return 42');
    h.start({}, {}, 2);
    assert.deepEqual(await h.terminal(), {t:'done',wid:'w',ev:2,result:42});
  } finally { await h.close(); }
});

test('stale incarnations and duplicate exposures cannot settle current promises', { timeout: 10000 }, async () => {
  const h = await harness('return (await runs.run("a",{agent:"a",task:"a"})).output;');
  try {
    h.start(); assert.equal((await h.next()).t, 'call'); assert.equal((await h.next()).t, 'idle');
    h.start({}, {}, 2);
    h.send(exposure(0, 'stale'), {t:'stop',wid:'w',ev:1});
    assert.deepEqual(await h.next(), {t:'call',wid:'w',ev:2,pos:0,key:'a',spec:{agent:'a',task:'a'}});
    assert.equal((await h.next()).t, 'idle');
    h.send({...exposure(0, 'current'),ev:2}, {...exposure(0, 'duplicate'),ev:2});
    assert.deepEqual(await h.terminal(), {t:'done',wid:'w',ev:2,result:'result:current'});
  } finally { await h.close(); }
});
