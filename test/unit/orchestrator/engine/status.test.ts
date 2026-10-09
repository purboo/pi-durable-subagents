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
import { compactWorkflow, eventsFromEntries, plannedFromScript, progressOf, renderEvent, snapshotFromEntries, pausedElsewhere, statusBrief, statusCallDetail, statusCompactDetail, statusDetail, statusView, widOfRid, workflowSnapshot, outputSelect, selectLines, writerWaits } from '../../../../src/orchestrator/snapshot.ts';
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

test('tool status: brief lists only what runs, asks or failed; one line per finished workflow; details clip outputs', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-brief-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const ledger = await openJournal(orchLedger(home));
  const write = async (wid: string, origin: string, list: Entry[]) => {
    await ledger.append(JT.created, { rid: `r-${wid}`, wid, origin });
    const journal = await openJournal(journalPath(home, wid));
    for (const { seq: _s, ts: _t, type, ...fields } of list) await journal.append(type, fields);
    await journal.close();
  };
  const big = `${'y'.repeat(5000)}\nend`;
  for (let i = 0; i < 8; i++) await write(`01F${i}`, 'main:me', [e(1, 'wf-created', { revision: 1, origin: 'main:me' }),
    e(2, 'call', { key: 'k', gen: 1, spec: { agent: 'x' } }), e(3, 'sealed', { call: `01F${i}@1/k@1`, result: res('k', 'ok', { output: big }) }), e(4, 'workflow-done', { status: 'done' })]);
  await write('01R', 'main:me', [e(1, 'wf-created', { revision: 1, origin: 'main:me', name: 'wave' }),
    e(2, 'call', { key: 'done', gen: 1, spec: { agent: 'x' } }), e(3, 'sealed', { call: '01R@1/done@1', result: res('done', 'ok', { output: big, usage: u(9, 1, 0) }) }),
    e(4, 'call', { key: 'bad', gen: 1, spec: { agent: 'x' } }), e(5, 'sealed', { call: '01R@1/bad@1', result: res('bad', 'failed', { error: 'Provider error: quota' }) }),
    e(6, 'call', { key: 'run', gen: 1, spec: { agent: 'w' } }), e(7, 'exec', { call: '01R@1/run@1', exec: '01R@1/run@1#1.1' }),
    e(8, 'selected', { exec: '01R@1/run@1#1.1', model: { provider: 'p', id: 'm' } }),
    e(9, 'call', { key: 'ask', gen: 1, spec: { agent: 'w' } }), e(10, 'exec', { call: '01R@1/ask@1', exec: '01R@1/ask@1#1.1' }),
    e(11, JT.attention, { item: { id: 'q:01R@1/ask@1:Q1', rev: 1, kind: 'question', text: 'Which base?', wid: '01R', call: '01R@1/ask@1', qid: 'Q1' } }),
    e(12, JT.attention, { item: { id: 'noprogress:01R@1/run@1', rev: 1, kind: 'stall', text: '01R/run: running but no progress for 10m', wid: '01R', call: '01R@1/run@1' } })]);
  await write('01O', 'main:other', [e(1, 'wf-created', { revision: 1, origin: 'main:other' }), e(2, 'call', { key: 'k', gen: 1, spec: { agent: 'x' } })]);
  await ledger.close();
  const now = Date.now() + 15 * 60_000; // journal.append stamps entries with the real clock
  const brief = statusBrief(home, { origin: 'main:me', now });
  assert.deepEqual(brief.active, [{ wid: '01R', name: 'wave', status: 'running', progress: '2/4+', tokens: '10',
    calls: [
      { key: 'bad', agent: 'x', phase: 'sealed', status: 'failed', error: 'Provider error: quota' },
      { key: 'run', agent: 'w', phase: 'running', model: 'p/m', for: '15m', quiet: '15m', tokens: '0' },
      { key: 'ask', agent: 'w', phase: 'asking', for: '15m', tokens: '0' }],
    asking: [{ to: '01R/ask', qid: 'Q1', question: 'Which base?' }],
    alerts: ['stall 01R/run: 01R/run: running but no progress for 10m'] }]);
  assert.equal(brief.otherSessions?.length, 1); assert.match(brief.otherSessions![0]!, /^01O · running · 0\/1\+ done · started 15m ago$/);
  assert.equal(brief.finished.length, 5); assert.equal(brief.olderFinished, 3);
  assert.match(brief.finished[0]!, /^01F7 · done · 1\/1 done · ended /);
  assert.ok(JSON.stringify(brief).length < 2000, 'no outputs in the brief');
  const compact = statusCompactDetail(home, '01R');
  const done = compact.calls.find(c => c.key === 'done')!;
  assert.equal(done.output, `${'y'.repeat(600)}… [${big.length - 600} more chars: status wid key=done]`);
  assert.ok(JSON.stringify(compact).length < 4000);
  assert.equal(statusCallDetail(home, '01R', 'done').result!.output, big);
  assert.equal(statusDetail(home, '01R').calls.find(c => c.key === 'done')!.result!.output, big);
  assert.throws(() => statusCallDetail(home, '01R', 'nope'), /No call "nope" in 01R; calls: done, bad, run, ask/);
});

test('tool status: paused workflows of this session and of other sessions are told apart', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-brief-held-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const ledger = await openJournal(orchLedger(home));
  for (const [wid, origin] of [['01A', 'main:me'], ['01B', 'main:other']] as const) {
    await ledger.append(JT.created, { rid: `r-${wid}`, wid, origin });
    const journal = await openJournal(journalPath(home, wid));
    await journal.append('wf-created', { revision: 1, origin }); await journal.close();
  }
  await ledger.append('drain', { rid: 'd1', origin: 'main:other', fence: true });
  assert.equal(statusBrief(home, { origin: 'main:me' }).paused, '1 workflow of other sessions paused (01B); resume wid=<wid> continues one');
  assert.deepEqual(pausedElsewhere(home, 'main:me'), ['01B']); assert.deepEqual(pausedElsewhere(home, 'main:other'), []);
  await ledger.append('drain', { rid: 'd2', origin: 'main:me', fence: true });
  await ledger.close();
  assert.equal(statusBrief(home, { origin: 'main:me' }).paused,
    "1 workflow of this session is paused (stop-all, drain or a quit pi); resume continues it; 1 workflow of other sessions paused (01B); resume wid=<wid> continues one");
});

test('labels: the brief status line, the compact view and the detail carry the run labels (clipped on a line)', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-labels-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const ledger = await openJournal(orchLedger(home));
  const labels = { node: 'A3', attempt: '2', role: 'writer' }, long = { note: 'z'.repeat(200) };
  for (const [wid, lab, done] of [['01L', labels, false], ['01M', long, true], ['01N', undefined, false]] as const) {
    await ledger.append('request', { request: { rid: `r-${wid}`, kind: 'run', from: 'main:me', to: 'orch', body: { cwd: '/', call: { agent: 'x', task: 't' }, ...(lab ? { labels: lab } : {}) } } });
    await ledger.append(JT.created, { rid: `r-${wid}`, wid, origin: 'main:me' });
    const journal = await openJournal(journalPath(home, wid));
    await journal.append('wf-created', { revision: 1, origin: 'main:me', name: 'job' });
    await journal.append('call', { key: 'k', gen: 1, spec: { agent: 'x' } });
    if (done) { await journal.append('sealed', { call: `${wid}@1/k@1`, result: res('k', 'ok') }); await journal.append('workflow-done', { status: 'done' }); }
    await journal.close();
  }
  // A rejected labelled run leaves nothing behind.
  await ledger.append('request', { request: { rid: 'r-x', kind: 'run', from: 'main:me', to: 'orch', body: { cwd: '/', labels: { a: 'b' } } } });
  await ledger.append(JT.rejected, { rid: 'r-x', reason: 'no' });
  await ledger.close();
  const brief = statusBrief(home, { origin: 'main:me' });
  assert.equal(brief.active.find(w => w.wid === '01L')!.labels, '[node=A3 attempt=2 role=writer]');
  assert.equal(brief.active.find(w => w.wid === '01N')!.labels, undefined);
  const finished = brief.finished.find(l => l.startsWith('01M'))!;
  assert.match(finished, /^01M · \[note=z+…\] · job · done/);
  assert.ok(finished.split(' · ')[1]!.length <= 60, 'clipped to 60 characters');
  const view = statusView(home);
  assert.deepEqual(view.workflows.find(w => w.wid === '01L')!.labels, labels);
  assert.equal(view.workflows.find(w => w.wid === '01N')!.labels, undefined);
  assert.deepEqual(statusDetail(home, '01L').labels, labels);
  assert.deepEqual(statusCompactDetail(home, '01L').labels, labels);
  const { renderView } = await import('../../../../src/cli/main.ts');
  assert.match(renderView(view), /^01L@1 \[node=A3 attempt=2 role=writer\] job: running/m);
});

test('status wid with tail/grep: each call\'s selected lines, unclipped up to a cap; invalid selections are errors', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-select-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const ledger = await openJournal(orchLedger(home));
  await ledger.append(JT.created, { rid: 'r-01S', wid: '01S', origin: 'main:me' });
  await ledger.close();
  const journal = await openJournal(journalPath(home, '01S'));
  await journal.append('wf-created', { revision: 1, origin: 'main:me' });
  const out = ['intro', 'x'.repeat(700), 'RECEIPT a=1', 'middle', 'RECEIPT b=2', 'last line', ''].join('\n');
  await journal.append('call', { key: 'a', gen: 1, spec: { agent: 'x' } });
  await journal.append('sealed', { call: '01S@1/a@1', result: res('a', 'ok', { output: out }) });
  await journal.append('call', { key: 'big', gen: 1, spec: { agent: 'x' } });
  await journal.append('sealed', { call: '01S@1/big@1', result: res('big', 'ok', { output: Array.from({ length: 100 }, (_, i) => `${i} ${'q'.repeat(80)}`).join('\n') }) });
  await journal.append('call', { key: 'run', gen: 1, spec: { agent: 'x' } });
  await journal.close();
  const pick = (select: Parameters<typeof outputSelect>) => Object.fromEntries(statusCompactDetail(home, '01S', outputSelect(...select)).calls.map(c => [c.key, c.output]));
  assert.deepEqual(pick([2, undefined]).a, 'RECEIPT b=2\nlast line');
  assert.equal(pick([2, undefined]).run, undefined, 'a call without a result has no output');
  assert.equal(pick([undefined, '^RECEIPT']).a, 'RECEIPT a=1\nRECEIPT b=2');
  assert.equal(pick([1, '^RECEIPT']).a, 'RECEIPT b=2', 'grep first, then tail');
  assert.equal(pick([undefined, 'receipt']).a, '', 'case-sensitive; no match is an empty output');
  assert.equal(pick([3, undefined]).a, 'middle\nRECEIPT b=2\nlast line');
  const whole = pick([2, 'x{700}']).a!;
  assert.equal(whole.length, 700, 'not clipped to the 600 characters of the plain view');
  const capped = pick([100, undefined]).big!;
  assert.match(capped, /^\[\d+ earlier chars clipped\]\.\.\./); assert.ok(capped.endsWith(`99 ${'q'.repeat(80)}`));
  assert.equal(capped.length - capped.indexOf('...') - 3, 4000);
  // grep tests only the first 2000 characters of a line (the matched line is returned whole) and the last 5000 lines.
  const longLine = `${'a'.repeat(2500)}END`;
  assert.equal(selectLines(longLine, { grep: 'END' }), '', 'a match past 2000 characters is not tested');
  assert.equal(selectLines(longLine, { grep: '^a{2000}' }), longLine);
  const many = Array.from({ length: 6000 }, (_, i) => `L${i}`).join('\n');
  assert.equal(selectLines(many, { grep: '^L(0|5999)$' }), '[1000 earlier lines not searched]\nL5999');
  assert.equal(selectLines(many, { tail: 1 }), 'L5999', 'tail alone scans nothing');
  assert.throws(() => outputSelect(undefined, '(unclosed'), /grep is not a valid regular expression/);
  for (const tail of [0, -1, 1.5, '3']) assert.throws(() => outputSelect(tail, undefined), /tail must be a positive integer/);
  assert.equal(outputSelect(undefined, undefined), undefined);
  // CLI: status <wid> --tail/--grep; only with a wid; an invalid regex is a usage error.
  const { main, parseArgs } = await import('../../../../src/cli/main.ts');
  const lines: string[] = [];
  assert.equal(await main(['status', '01S', '--grep', '^RECEIPT', '--tail', '1'], { env: { DSA_HOME: home }, write: l => lines.push(l) }), 0);
  assert.match(lines.join('\n'), /\n  a@1 ok\n    \| RECEIPT b=2\n  big@1 ok\n  run@1 queued$/);
  lines.length = 0;
  await main(['status', '01S', '--tail', '1', '--json'], { env: { DSA_HOME: home }, write: l => lines.push(l) });
  assert.equal(JSON.parse(lines.join('')).calls[0].output, 'last line');
  assert.throws(() => parseArgs(['status', '--tail', '2']), /--tail and --grep select lines of one workflow's outputs/);
  assert.throws(() => parseArgs(['status', '01S', '--grep', '[']), /grep is not a valid regular expression/);
  assert.throws(() => parseArgs(['status', '01S', '--tail', '0']), /--tail needs a positive number/);
  assert.throws(() => parseArgs(['tail', '01S', '--tail', '2']), /only supported by status/);
});

test('writerWaits: unsealed calls queued behind a writer lock, with holder and worktree root', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsa-ww-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const journal = await openJournal(journalPath(home, '01W'));
  await journal.append('wf-created', { revision: 1, origin: 'main:me' });
  for (const key of ['a', 'b', 'c']) await journal.append('call', { key, gen: 1, spec: { agent: 'x' } });
  await journal.append('writer-wait', { call: '01W@1/b@1', root: '/repo', holder: '01H@1/w@1' });
  await journal.append('writer-wait', { call: '01W@1/c@1', root: '/repo', holder: '01H@1/w@1' });
  await journal.append('writer-acquired', { call: '01W@1/c@1', root: '/repo' });
  await journal.close();
  assert.deepEqual(writerWaits(home, '01W'), [{ call: '01W/b', heldBy: '01H/w', cwd: '/repo' }]);
  assert.deepEqual(writerWaits(home, 'nope'), []);
});

test('a run rid stands for its wid once the workflow exists; other values pass through', () => {
  const ledger = [e(1, JT.created, { rid: 'main:s:7', wid: '01W' })];
  assert.equal(widOfRid(ledger, 'main:s:7'), '01W');
  assert.equal(widOfRid(ledger, 'main:s:7/review'), '01W/review');
  assert.equal(widOfRid(ledger, '01W/review'), '01W/review');
  assert.equal(widOfRid(ledger, 'main:s:8'), 'main:s:8');
});

test('P28 a hibernated asker shows hibernated until its answer is bound, and never after it ends', () => {
  const call = 'w@1/a@1', exec = `${call}#1.1`;
  const asked = [
    e(1, 'wf-created', { revision: 1 }), e(2, 'call', { key: 'a', gen: 1, spec: { agent: 'x' } }),
    e(3, 'exec', { call, exec }), e(4, 'selected', { exec, model: { provider: 'p', id: 'm' } }),
    e(5, 'attention', { item: { id: `q:${call}:q1`, rev: 1, kind: 'question', text: 'Choose?', call, qid: 'q1' } }),
    e(6, 'hibernated', { call, exec, qid: 'q1', rev: 1 }), e(7, 'fenced', { exec }),
  ];
  // The decision precedes the fence: until the execution is fenced it still holds its slot (and a failed fence keeps it).
  const deciding = snapshotFromEntries('w', asked.slice(0, 6)).calls[0]!;
  assert.equal(deciding.phase, 'asking'); assert.equal(deciding.hibernated, undefined);
  const a = snapshotFromEntries('w', asked).calls[0]!;
  assert.equal(a.phase, 'asking'); assert.equal(a.hibernated, true);
  assert.equal(compactWorkflow(snapshotFromEntries('w', asked)).calls[0]!.hibernated, true);
  // A hibernation recorded for an earlier execution says nothing about the current one.
  assert.equal(snapshotFromEntries('w', [...asked, e(8, 'exec', { call, exec: `${call}#1.2` })]).calls[0]!.hibernated, undefined);
  const bound = [...asked, e(8, 'answer-bound', { call, qid: 'q1', rev: 1, rid: 'r', rid2: 'r2', message: 'yes', hash: 'h' }), e(9, 'attention-resolved', { id: `q:${call}:q1`, rev: 1 })];
  assert.equal(snapshotFromEntries('w', bound).calls[0]!.hibernated, undefined);
  assert.equal(snapshotFromEntries('w', [...asked, e(8, 'sealed', { call, exec, result: res('a', 'stopped') })]).calls[0]!.hibernated, undefined);
});

test('events: a model switch names its target, and a failover also the used-up provider it left', () => {
  const env = (body: Record<string, unknown>) => ({ to: 'w@1/b@1', kind: 'model', body });
  const list = [
    e(1, 'wf-created', { revision: 1 }), e(2, 'call', { key: 'b', gen: 1, spec: { agent: 'x' } }), e(3, 'exec', { call: 'w@1/b@1', exec: 'w@1/b@1#1.1' }),
    e(4, 'selected', { exec: 'w@1/b@1#1.1', model: { provider: 'pa', id: 'm' }, pool: 'top' }),
    e(5, 'forward', { rid: 'fo', rid2: 'x-fo', dest: 'w@1/b@1', hash: 'h', envelope: env({ provider: 'pb', model: 'm', exec: 'w@1/b@1#1.1' }), failover: 'pa' }),
    e(6, 'forward', { rid: 'manual', rid2: 'x-manual', dest: 'w@1/b@1', hash: 'h', envelope: env({ provider: 'pc', model: 'n', thinking: 'high' }) }),
    e(7, 'forward', { rid: 's', rid2: 'x-s', dest: 'w@1/b@1', hash: 'h', envelope: { to: 'w@1/b@1', kind: 'steer', body: { message: 'm' } } }),
  ];
  const forwards = eventsFromEntries(list).filter(x => x.event === 'forward');
  assert.deepEqual(forwards.map(({ seq: _s, ts: _t, ...rest }) => rest), [
    { event: 'forward', rid: 'fo', kind: 'model', dest: 'w@1/b@1', model: 'pb/m', failover: 'pa' },
    { event: 'forward', rid: 'manual', kind: 'model', dest: 'w@1/b@1', model: 'pc/n' },
    { event: 'forward', rid: 's', kind: 'steer', dest: 'w@1/b@1' },
  ]);
  assert.match(renderEvent(forwards[0]!), /forward +rid=fo kind=model dest=w@1\/b@1 model=pb\/m failover=pa$/);
});
