// R2: `events --all`: head, paging with more, cursor-expired (exit 4), malformed input (exit 1), and a missing log
// (start the orchestrator, wait, else 75). Through the CLI entry with an isolated DSA_HOME.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../../src/cli/main.ts';
import { eventsLog } from '../../../src/paths.ts';
import { EventLog } from '../../../src/events/log.ts';
import { EVENT_SEQ_SKIP, EVENTS_PAGE_MAX, EXIT_CURSOR_EXPIRED, type EventDraft } from '../../../src/events/types.ts';

async function cli(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'dsa-events-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let starts = 0;
  const run = async (args: string[], starter?: (home: string) => Promise<void>, waitMs = 300) => {
    const lines: string[] = [];
    const code = await main(['events', ...args], { env: { DSA_HOME: home }, write: line => lines.push(line), waitMs,
      starter: async h => { starts++; await starter?.(h); } });
    return { code, lines, json: lines.map(l => JSON.parse(l)) };
  };
  return { home, path: eventsLog(home), run, starts: () => starts };
}
const draft = (n: number): EventDraft => ({ id: `W:${n}:sealed`, ts: n, type: 'sealed', wid: 'W', status: 'ok' });

test('R2 CLI: events --all prints the head; --since pages with --limit and more; the last page ends at the log head', async t => {
  const s = await cli(t);
  const { log } = await EventLog.open(s.path);
  const e = log.epoch;
  await log.append([draft(1), draft(2), draft(3)]);
  assert.deepEqual((await s.run(['--all'])).json, [{ head: `${e}:3`, more: false }]);
  assert.deepEqual((await s.run(['--all', '--json'])).json, [{ head: `${e}:3`, more: false }], '--json accepted, same output');
  const page1 = await s.run(['--all', '--since', `${e}:0`, '--limit', '2']);
  assert.equal(page1.code, 0);
  assert.deepEqual(page1.json.map(x => x.cursor ?? x), [`${e}:1`, `${e}:2`, { head: `${e}:2`, more: true }]);
  assert.equal(page1.json[0].id, 'W:1:sealed');
  const page2 = await s.run(['--all', '--since', page1.json.at(-1).head, '--limit', '2']);
  assert.deepEqual(page2.json.map(x => x.cursor ?? x), [`${e}:3`, { head: `${e}:3`, more: false }]);
  const empty = await s.run(['--all', '--since', `${e}:3`]);
  assert.deepEqual(empty.json, [{ head: `${e}:3`, more: false }]);
  await log.close();
  // After a start skip the head names a seq without an event: still a valid cursor.
  const next = await EventLog.open(s.path);
  const head = (await s.run(['--all'])).json[0].head;
  assert.equal(head, `${e}:${3 + EVENT_SEQ_SKIP}`);
  await next.log.append([draft(4)]); await next.log.close();
  const after = await s.run(['--all', '--since', head]);
  assert.deepEqual(after.json.map(x => x.cursor ?? x), [`${e}:${4 + EVENT_SEQ_SKIP}`, { head: `${e}:${4 + EVENT_SEQ_SKIP}`, more: false }]);
  assert.equal(s.starts(), 0, 'never starts the orchestrator when the log exists');
});

test('R2 CLI: cursor-expired for another epoch, a seq below dropped or beyond the head (exit 4, head and oldest)', async t => {
  const s = await cli(t);
  const { log } = await EventLog.open(s.path);
  const e = log.epoch;
  await log.append([draft(1), draft(2), draft(3)]);
  await log.compact(r => r.seq <= 2, new Map());
  await log.close();
  const expired = { error: 'cursor-expired', head: `${e}:3`, oldest: `${e}:2` };
  for (const since of [`${'0'.repeat(16)}:2`, `${e}:1`, `${e}:4`]) {
    const r = await s.run(['--all', '--since', since]);
    assert.equal(r.code, EXIT_CURSOR_EXPIRED, since); assert.deepEqual(r.json, [expired], since);
  }
  const oldest = await s.run(['--all', '--since', `${e}:2`]);
  assert.equal(oldest.code, 0);
  assert.deepEqual(oldest.json.map(x => x.cursor ?? x), [`${e}:3`, { head: `${e}:3`, more: false }]);
});

test('R2 CLI: malformed cursor or options exit 1; a missing log starts the orchestrator and waits, else 75 pending', async t => {
  const s = await cli(t);
  for (const args of [['--all', '--since', 'abc'], ['--all', '--since', 'ABCDEF0123456789:1'], ['--all', '--since', '0123456789abcdef:-1'],
    ['--all', '--limit', '0'], ['--all', '--limit', String(EVENTS_PAGE_MAX + 1)], ['--all', '--bogus'], ['--all', 'wid'], ['--all', '--since']]) {
    const r = await s.run(args);
    assert.equal(r.code, 1, args.join(' ')); assert.equal(r.lines.length, 1);
  }
  assert.equal(s.starts(), 0, 'invalid input starts nothing');
  const pending = await s.run(['--all'], undefined, 200);
  assert.equal(pending.code, 75); assert.deepEqual(pending.json, [{ pending: true }]);
  assert.equal(s.starts(), 1);
  // A starter whose orchestrator creates the log: the command waits for it.
  const ok = await s.run(['--all', '--wait-ms', '5000'], async () => { setTimeout(() => { void EventLog.open(s.path).then(o => o.log.close()); }, 100); });
  assert.equal(ok.code, 0); assert.match(ok.json[0].head, /^[0-9a-f]{16}:0$/);
  // `events <wid>` is unchanged (an unknown workflow is still an error).
  await assert.rejects(main(['events', 'nope'], { env: { DSA_HOME: s.home }, write: () => {} }), /Unknown workflow/);
});
