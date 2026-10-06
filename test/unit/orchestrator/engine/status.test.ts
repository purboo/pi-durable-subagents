import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJournal } from '../../../../src/kernel/journal.ts';
import { journalPath, orchLedger, pinnedDir } from '../../../../src/paths.ts';
import { compileFanout } from '../../../../src/compat/fanout.ts';
import { finishedText } from '../../../../src/orchestrator/engine.ts';
import { compactWorkflow, eventsFromEntries, plannedFromScript, progressOf, renderEvent, snapshotFromEntries, statusDetail, statusView, workflowSnapshot } from '../../../../src/orchestrator/snapshot.ts';
import { JT, type Entry } from '../../../../src/types.ts';

const e = (seq: number, type: string, f: Record<string, unknown> = {}) => ({ seq, ts: 1_700_000_000_000 + seq, type, ...f }) as Entry;
const u = (input: number, output: number, costUsd: number) => ({ input, output, costUsd });
const res = (key: string, status: string, extra: Record<string, unknown> = {}) => ({ key, gen: 1, status, ok: status === 'ok', output: '', ...extra });

// One revision boundary, a reused seal, deduplicated usage entries, a stopped seal carrying usage, and a live call.
const entries = [
  e(1, 'wf-created', { name: 'nightly', origin: 'main:o', cwd: '/', revision: 1 }),
  e(2, 'call', { key: 'old', gen: 1, spec: { agent: 'x' } }),
  e(3, 'usage', { call: 'w@1/old@1', id: 'm1', usage: u(100, 10, 0.01) }),
  e(4, 'sealed', { call: 'w@1/old@1', result: res('old', 'ok', { output: 'a\nfinal old\n', usage: u(100, 10, 0.01) }) }),
  e(5, 'revised', { revision: 2 }),
  e(6, 'reused', { key: 'old', gen: 1, from: 'w@1/old@1', spec: { agent: 'x' } }),
  e(7, 'call', { key: 'b', gen: 1, spec: { agent: 'x' } }),
  e(8, 'exec', { call: 'w@2/b@1', exec: 'w@2/b@1#1.1' }),
  e(9, 'selected', { exec: 'w@2/b@1#1.1', model: { provider: 'p', id: 'm' } }),
  e(10, 'observation', { exec: 'w@2/b@1#1.1', event: { type: 'tool_execution_start', toolName: 'bash' } }),
  e(11, 'observation', { exec: 'w@2/b@1#1.1', event: { type: 'tool_execution_end', toolName: 'bash' } }),
  e(12, 'usage', { call: 'w@2/b@1', id: 'm2', usage: u(1000, 50, 0.1) }),
  e(13, 'usage', { call: 'w@2/b@1', id: 'm2', usage: u(1000, 50, 0.1) }),
  e(14, 'loss', { exec: 'w@2/b@1#1.1' }),
  e(15, 'time', { exec: 'w@2/b@1#1.1', active: 5 }),
  e(16, 'stop-intent', { call: 'w@2/b@1' }),
  e(17, 'sealed', { call: 'w@2/b@1', exec: 'w@2/b@1#1.1', result: res('b', 'stopped', { usage: u(1200, 60, 0.12) }) }),
  e(18, 'call', { key: 'c', gen: 1, spec: { agent: 'x' } }),
  e(19, 'exec', { call: 'w@2/c@1', exec: 'w@2/c@1#1.1' }),
  e(20, 'usage', { call: 'w@2/c@1', id: 'm3', usage: u(7, 3, 0) }),
  e(21, 'workflow-done', { status: 'stopped' }),
];

test('P31: snapshots carry per-call and workflow usage from seals and deduplicated usage entries', () => {
  const snap = snapshotFromEntries('w', entries);
  const by = Object.fromEntries(snap.calls.map(c => [c.key, c]));
  assert.deepEqual(by.old!.usage, u(100, 10, 0.01));
  assert.deepEqual(by.b!.usage, u(1200, 60, 0.12), 'the seal is authoritative over partial usage entries');
  assert.deepEqual(by.c!.usage, u(7, 3, 0), 'live usage before a seal');
  assert.equal(by.b!.tools, 1); assert.equal(by.b!.model, 'p/m');
  assert.equal(snap.usage!.input, 1307); assert.equal(snap.usage!.output, 73); assert.ok(Math.abs(snap.usage!.costUsd - 0.13) < 1e-9);
  assert.equal(finishedText('w', entries), 'nightly (w) stopped: 1 ok; 1 stopped; 1 unknown\nold: ok\n  a\nfinal old\nb: stopped (edits it made so far are left in place)\nc: unknown\nUsage: 1.3K in / 73 out, $0.13\nFull output: subagents status wid:w');
});

test('T10: events keep the meaningful timeline only', () => {
  const events = eventsFromEntries(entries);
  assert.deepEqual(events.map(x => x.event), ['created', 'call', 'sealed', 'revised', 'reused', 'call', 'exec', 'model', 'loss', 'stop', 'sealed', 'call', 'exec', 'done']);
  assert.deepEqual(events.find(x => x.event === 'sealed' && x.call === 'w@2/b@1'), { seq: 17, ts: entries[16]!.ts, event: 'sealed', call: 'w@2/b@1', status: 'stopped', ok: false, usage: u(1200, 60, 0.12) });
  assert.match(renderEvent(events.at(-1)!), /^2023-\S+Z #21 done\s+status=stopped$/);
  assert.match(renderEvent(events[10]!), /usage="1.2K in \/ 60 out, \$0.12"/);
});

test('T10: status view is compact, own first, newest first, collapses older finished workflows; detail has no entries', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-status-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const ledger = await openJournal(orchLedger(home));
  const write = async (wid: string, origin: string, list: Entry[]) => {
    await ledger.append(JT.created, { rid: `r-${wid}`, wid, origin });
    const journal = await openJournal(journalPath(home, wid));
    for (const { seq: _s, ts: _t, type, ...fields } of list) await journal.append(type, fields);
    await journal.close();
  };
  const long = `${'x'.repeat(400)}\nlast line`;
  for (let i = 0; i < 12; i++) await write(`01F${String(i).padStart(2, '0')}`, 'main:other', [e(1, 'wf-created', { revision: 1, origin: 'main:other' }), e(2, 'workflow-done', { status: 'done' })]);
  await write('01A00', 'main:me', [e(1, 'wf-created', { revision: 1, origin: 'main:me' }), e(2, 'workflow-done', { status: 'done' })]);
  await write('01Z00', 'main:other', [e(1, 'wf-created', { revision: 1, origin: 'main:other' }), e(2, 'call', { key: 'k', gen: 1, spec: { agent: 'x' } }),
    e(3, 'sealed', { call: '01Z00@1/k@1', result: res('k', 'ok', { output: long, usage: u(5, 6, 0) }) })]);
  await ledger.close();
  const view = statusView(home, { origin: 'main:me' });
  // 01A00 is own (first, kept) although it is the oldest; finished ones beyond the first 10 in that order collapse.
  assert.deepEqual(view.workflows.map(w => w.wid), ['01A00', '01Z00', ...Array.from({ length: 9 }, (_, i) => `01F${String(11 - i).padStart(2, '0')}`)]);
  assert.equal(view.olderFinished, 3);
  const running = view.workflows[1]!;
  assert.deepEqual(running.calls, [{ key: 'k', gen: 1, callId: '01Z00@1/k@1', phase: 'sealed', status: 'ok', ok: true, usage: u(5, 6, 0), lastLine: 'last line' }]);
  assert.deepEqual(running.usage, u(5, 6, 0));
  assert.ok(!JSON.stringify(view).includes('xxxx'), 'no full outputs in the compact view');
  assert.ok(!('entries' in running));
  const detail = statusDetail(home, '01Z00');
  assert.equal(detail.calls[0]!.result!.output, long);
  assert.ok(!('entries' in detail)); assert.equal(detail.scriptLog, undefined);
  assert.throws(() => statusDetail(home, '../escape'), /Unknown workflow/);
});

test('P7 P27: sends per call are pending until the child receipt, then delivered or retired; status counts pending messages', () => {
  const fwd = (seq: number, rid: string, kind: string, dest = 'w@1/b@1') => e(seq, 'forward', { rid, rid2: `x-${rid}`, dest, hash: 'h', envelope: { to: dest, kind, body: { message: 'm' } } });
  const list = [
    e(1, 'wf-created', { revision: 1 }), e(2, 'call', { key: 'b', gen: 1, spec: { agent: 'x' } }), e(3, 'exec', { call: 'w@1/b@1', exec: 'w@1/b@1#1.1' }),
    fwd(4, 's1', 'steer'), fwd(5, 's2', 'steer'), fwd(6, 'm1', 'model'), fwd(7, 'f1', 'follow-up'), fwd(8, 'old', 'steer', 'w@1/b@2'),
    e(9, 'forward-delivered', { rid: 's1', rid2: 'x-s1', call: 'w@1/b@1' }),
    e(10, 'forward-delivered', { rid: 's1', rid2: 'x-s1', call: 'w@1/b@1' }), // a duplicate never moves `at`
    e(11, 'forward-delivered', { rid: 'f1', rid2: 'x-f1', call: 'w@1/b@1', reason: 'withdrawn' }),
    e(12, 'forward-delivered', { rid: 'old', rid2: 'x-old', call: 'w@1/b@2' }), // another generation: not this call's send
  ];
  let snap = snapshotFromEntries('w', list), b = snap.calls[0]!;
  assert.deepEqual(b.sends, [
    { rid: 's1', kind: 'steer', state: 'delivered', at: list[8]!.ts },
    { rid: 's2', kind: 'steer', state: 'pending', at: list[4]!.ts },
    { rid: 'm1', kind: 'model', state: 'pending', at: list[5]!.ts },
    { rid: 'f1', kind: 'follow-up', state: 'delivered', at: list[10]!.ts, reason: 'withdrawn' },
  ]);
  assert.equal(b.pending, 1, 'a pending model switch is a control, not a message');
  assert.equal(compactWorkflow(snap).calls[0]!.pending, 1);
  // The seal retires what has no receipt; a delivered message disappears from the pending count.
  list.push(e(13, 'sealed', { call: 'w@1/b@1', exec: 'w@1/b@1#1.1', result: res('b', 'stopped') }), e(14, 'forward-retired', { rid: 's2', rid2: 'x-s2', reason: 'retired-without-child-receipt' }));
  snap = snapshotFromEntries('w', list); b = snap.calls[0]!;
  assert.deepEqual(b.sends!.map(s => s.state), ['delivered', 'retired', 'pending', 'delivered']);
  assert.equal(b.pending, undefined); assert.equal(compactWorkflow(snap).calls[0]!.pending, undefined);
  const events = eventsFromEntries(list).filter(x => ['forward', 'delivered', 'retired'].includes(x.event));
  assert.deepEqual(events.map(x => [x.event, x.kind, x.key ?? x.dest]), [
    ['forward', 'steer', 'w@1/b@1'], ['forward', 'steer', 'w@1/b@1'], ['forward', 'model', 'w@1/b@1'], ['forward', 'follow-up', 'w@1/b@1'], ['forward', 'steer', 'w@1/b@2'],
    ['delivered', 'steer', 'b'], ['delivered', 'steer', 'b'], ['delivered', 'follow-up', 'b'], ['delivered', 'steer', 'b@2'], ['retired', 'steer', 'b'],
  ]);
  const text = events.map(renderEvent);
  assert.match(text[5]!, /^2023-\S+Z #9 delivered  steer delivered to b rid=s1$/);
  assert.match(text[7]!, /follow-up delivered to b \(rejected: withdrawn\) rid=f1$/);
  assert.match(text[9]!, /#14 retired    steer retired \(call ended first\) key=b rid=s2$/);
});

test('v12 §4: plannedFromScript counts only compiled tasks/chain fanouts', () => {
  const step = { agent: 'x', task: 't' };
  assert.equal(plannedFromScript(compileFanout({ tasks: [step, { ...step }, { ...step }] }).source), 3);
  assert.equal(plannedFromScript(compileFanout({ chain: [step, { ...step }] }).source), 2);
  assert.equal(plannedFromScript(compileFanout({ tasks: [step] }).source), 1, 'a single-agent run is a one-step fanout');
  assert.equal(plannedFromScript('const steps = [{key:"a"}];\ncomplete(1);\n'), undefined, 'a user script that happens to start with const steps is not a fanout');
  assert.equal(plannedFromScript('complete(1);\n'), undefined);
});

test('v12 §4: planned totals come from the pinned run body; follow-ups never change the denominator', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-planned-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const step = { agent: 'x', task: 't' };
  const fanout = (n: number, kind: 'tasks' | 'chain' = 'tasks') => compileFanout({ [kind]: Array.from({ length: n }, () => ({ ...step })) } as never).source;
  const append = async (wid: string, list: Entry[]) => {
    const journal = await openJournal(journalPath(home, wid));
    for (const { seq: _s, ts: _t, type, ...fields } of list) await journal.append(type, fields);
    await journal.close();
  };
  const open = async (wid: string, list: Entry[], script: string) => {
    const pinned = pinnedDir(home, wid);
    mkdirSync(pinned, { recursive: true }); writeFileSync(join(pinned, 'script.js'), script);
    await append(wid, list);
  };
  // tasks of three: one sealed, one running -> 1/3; the planned total is fixed at admission
  await open('01T00', [
    e(1, 'wf-created', { revision: 1, origin: 'main:o' }),
    e(2, 'call', { key: 'a', gen: 1, spec: step }),
    e(3, 'sealed', { call: '01T00@1/a@1', result: res('a', 'ok') }),
    e(4, 'call', { key: 'b', gen: 1, spec: step }),
    e(5, 'exec', { call: '01T00@1/b@1', exec: '01T00@1/b@1#1.1' }),
  ], fanout(3));
  let wf = workflowSnapshot(home, '01T00');
  assert.equal(wf.planned, 3);
  let compact = compactWorkflow(wf);
  assert.equal(compact.planned, 3); assert.equal(compact.done, 1); assert.equal(compact.counts.sealed, 1);
  // a follow-up reopens the sealed key as generation 2: done drops, the denominator stays 3
  await append('01T00', [
    e(6, 'generation', { key: 'a', gen: 2, from: '01T00@1/a@1', rid: 'r1', opening: { kind: 'follow-up' } }),
    e(7, 'exec', { call: '01T00@1/a@2', exec: '01T00@1/a@2#1.1' }),
  ]);
  wf = workflowSnapshot(home, '01T00');
  assert.equal(wf.planned, 3, 'the pinned run body never changes');
  compact = compactWorkflow(wf);
  assert.equal(compact.done, 0, 'the followed-up key runs again');
  assert.equal(compact.planned, 3);
  // a script has no planned total: proposed so far, `plus` while it runs
  await open('01S00', [
    e(1, 'wf-created', { revision: 1 }),
    e(2, 'call', { key: 's1', gen: 1, spec: step }),
    e(3, 'exec', { call: '01S00@1/s1@1', exec: '01S00@1/s1@1#1.1' }),
  ], 'complete(1);\n');
  const script = workflowSnapshot(home, '01S00');
  assert.equal(script.planned, undefined);
  assert.equal(progressOf(script).plus, true);
  assert.equal(progressOf({ ...script, status: 'done' }).plus, false, 'a finished script drops the +');
  assert.equal(compactWorkflow(script).planned, undefined);
  // an impostor `const steps` script is not a fanout
  await open('01X00', [e(1, 'wf-created', { revision: 1 })], 'const steps = [{key:"a"}];\ncomplete(1);\n');
  assert.equal(workflowSnapshot(home, '01X00').planned, undefined);
  // the status view carries the same projection
  const byWid = new Map(statusView(home).workflows.map(w => [w.wid, w]));
  assert.equal(byWid.get('01T00')!.planned, 3); assert.equal(byWid.get('01T00')!.done, 0);
  assert.equal(byWid.get('01S00')!.planned, undefined);
  assert.equal(statusDetail(home, '01T00').planned, 3);
});

test('ops: a pruned workflow is gone for status, even while its directory removal is unfinished', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-pruned-')); t.after(() => rm(home, { recursive: true, force: true }));
  const orch = await openJournal(orchLedger(home));
  await orch.append(JT.created, { rid: 'r1', wid: 'W1', origin: 's' }); await orch.append(JT.created, { rid: 'r2', wid: 'W2', origin: 's' });
  for (const wid of ['W1', 'W2']) { const j = await openJournal(journalPath(home, wid)); await j.append(JT.done, { result: {}, status: 'done' }); await j.close(); }
  await orch.append('pruned', { rid: 'p', wid: 'W1', endedAt: 1, bytes: 10 }); await orch.close();
  assert.deepEqual(statusView(home).workflows.map(w => w.wid), ['W2']);
  assert.throws(() => statusDetail(home, 'W1'), /Workflow W1 was pruned/);
  assert.throws(() => statusDetail(home, 'W9'), /Unknown workflow: W9/);
});

test('drain: status and snapshots mark the workflows a drain holds; later runs are not held', async t => {
  const { allWorkflows } = await import('../../../../src/orchestrator/snapshot.ts');
  const home = await mkdtemp(join(tmpdir(), 'dsa-drained-')); t.after(() => rm(home, { recursive: true, force: true }));
  const orch = await openJournal(orchLedger(home)); await orch.append(JT.created, { rid: 'r1', wid: 'W1' });
  const j = await openJournal(journalPath(home, 'W1')); await j.append('wf-created', { rid: 'r1' }); await j.close();
  assert.equal(statusView(home).paused, undefined); assert.equal(allWorkflows(home)[0]!.paused, undefined);
  await orch.append('drain', { rid: 'd', fence: true });
  await orch.append(JT.created, { rid: 'r2', wid: 'W2' });
  const j2 = await openJournal(journalPath(home, 'W2')); await j2.append('wf-created', { rid: 'r2' }); await j2.close();
  assert.match(statusView(home).paused!, /^1 workflow paused \(stop-all, drain or a quit pi\) since .*; resume continues them \(new runs are not affected\)$/);
  assert.deepEqual(allWorkflows(home).map(w => [w.wid, w.paused]), [['W2', undefined], ['W1', true]]);
  await orch.append('undrain', { rid: 'u' }); await orch.close();
  assert.equal(statusView(home).paused, undefined);
});

test('drain: work a drain holds is not pending for the starters (no start/idle-exit loop); later work is', async t => {
  const { unfinishedWorkflow } = await import('../../../../src/agent/main/snapshots.ts');
  const home = await mkdtemp(join(tmpdir(), 'dsa-held-')); t.after(() => rm(home, { recursive: true, force: true }));
  const orch = await openJournal(orchLedger(home)); await orch.append(JT.created, { rid: 'r1', wid: 'W1' });
  const j = await openJournal(journalPath(home, 'W1')); await j.append('wf-created', { rid: 'r1' }); await j.close();
  assert.equal(unfinishedWorkflow(home), true);
  await orch.append('drain', { rid: 'd', fence: true }); assert.equal(unfinishedWorkflow(home), false);
  await orch.append(JT.created, { rid: 'r2', wid: 'W2' });
  const j2 = await openJournal(journalPath(home, 'W2')); await j2.append('wf-created', { rid: 'r2' }); await j2.close();
  assert.equal(unfinishedWorkflow(home), true); await orch.close();
});
