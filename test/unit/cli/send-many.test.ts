// A send to several calls (CLI repeated --to, tool `to: string[]`): one request per target, each decided on its own,
// per-target outcomes, and request-id idempotency over the whole list. In-process engine with the fake executor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../../src/cli/main.ts';
import { openJournal, readJournalSnapshot } from '../../../src/kernel/journal.ts';
import { journalPath, orchLedger } from '../../../src/paths.ts';
import { Engine } from '../../../src/orchestrator/engine.ts';
import { JT } from '../../../src/types.ts';
import { fakeExecutor } from '../orchestrator/engine/fake.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsa-many-')), home = join(root, 'dsa'), cwd = join(root, 'work');
  await mkdir(join(cwd, '.pi/agents'), { recursive: true }); await mkdir(home, { recursive: true });
  await writeFile(join(cwd, '.pi/agents/echo.md'), '---\nname: echo\ndescription: echo\n---\nEcho.');
  const noop = join(root, 'noop.mjs'); await writeFile(noop, '');
  const env = { DSA_HOME: home, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', DSA_ORCHESTRATOR_ENTRY: noop };
  const orch = await openJournal(orchLedger(home)), ledgers = { home, orch, config: { k: { idleExitMs: 30 } } };
  // The real evaluator runs the compiled tasks script; the fake executor seals every call but `held` at once.
  const engine = new Engine(ledgers, fakeExecutor(ledgers, { hold: 'held' }), { discovery: { home: root, agentDir: join(root, 'agent'), globalNpmRoot: null } });
  await engine.recover();
  const timer = setInterval(() => void engine.intake(), 20);
  const cleanups: (() => unknown)[] = [];
  t.after(async () => {
    clearInterval(timer);
    for (const fn of cleanups.reverse()) await fn();
    await engine.close().catch(() => {}); await orch.close(); await rm(root, { recursive: true, force: true });
  });
  const cli = async (args: string[]) => {
    const lines: string[] = [];
    const code = await main(args, { env, cwd, write: line => lines.push(line), starter: async () => {}, waitMs: 5000 });
    return { code, out: lines.join('\n') };
  };
  const spec = join(root, 'spec.json');
  await writeFile(spec, JSON.stringify({ tasks: [{ agent: 'echo', task: 'h', key: 'held' }, { agent: 'echo', task: 'q', key: 'q' }] }));
  const started = await cli(['run', '--request', 'two', '--spec', spec, '--json']);
  assert.equal(started.code, 0, started.out);
  const wid = JSON.parse(started.out).wid as string;
  const journal = () => readJournalSnapshot(journalPath(home, wid));
  for (const end = Date.now() + 10_000; !journal().some(e => e.type === JT.sealed && String(e.call).endsWith('/q@1'));) {
    if (Date.now() > end) throw new Error('q did not seal'); await new Promise(r => setTimeout(r, 20));
  }
  return { root, home, cwd, env, wid, cli, journal, cleanups, ledger: () => readJournalSnapshot(orchLedger(home)) };
}

test('CLI: repeated --to sends one notify per call; one bad target does not affect the others; a retry is idempotent', async t => {
  const f = await fixture(t);
  const args = ['send', '--request', 'm1', '--to', `${f.wid}/held`, '--to', `${f.wid}/q`, '--to', `${f.wid}/nope`, '--kind', 'notify', '--message', 'use TOML', '--json'];
  const first = await f.cli(args);
  assert.equal(first.code, 1, first.out);
  const reply = JSON.parse(first.out);
  assert.equal(reply.request, 'm1');
  assert.deepEqual(reply.targets.map((r: Record<string, unknown>) => [r.to, r.request, r.applied, r.delivery ?? r.reason]), [
    [`${f.wid}/held`, 'm1:1', true, undefined],
    [`${f.wid}/q`, 'm1:2', true, 'noted'],
    [`${f.wid}/nope`, 'm1:3', false, `unknown-call: use one of ${f.wid}/held, ${f.wid}/q`],
  ]);
  assert.match(reply.targets[1].note, /not running/);
  // The same list again: the same outcomes, nothing recorded twice.
  const retry = await f.cli(args);
  assert.equal(retry.code, 1); assert.deepEqual(JSON.parse(retry.out), reply);
  assert.equal(f.journal().filter(e => e.type === 'pending-note').length, 1);
  assert.equal(f.journal().filter(e => e.type === 'fake-forward').length, 1);
  for (const id of ['m1:1', 'm1:2', 'm1:3']) assert.equal(f.ledger().filter(e => e.type === JT.admitted && e.rid === `req:${id}`).length, 1, id);
  // Text mode: one line per target.
  const text = await f.cli(args.slice(0, -1));
  assert.deepEqual(text.out.split('\n').map(l => l.replace(/ \[m1:\d\]$/, '')), [
    `${f.wid}/held: applied`, `${f.wid}/q: applied (noted: the call is not running: recorded as a pending note for its next follow-up (nothing was started))`,
    `${f.wid}/nope: rejected unknown-call: use one of ${f.wid}/held, ${f.wid}/q`]);
  // Other content under the id: another message, a shorter list, a single target.
  const other = await f.cli([...args.slice(0, -2), 'different', '--json']);
  assert.equal(other.code, 3, other.out);
  assert.equal((await f.cli(['send', '--request', 'm1', '--to', `${f.wid}/held`, '--to', `${f.wid}/q`, '--kind', 'notify', '--message', 'use TOML', '--json'])).code, 3);
  assert.equal((await f.cli(['send', '--request', 'm1', '--to', `${f.wid}/held`, '--kind', 'notify', '--message', 'use TOML', '--json'])).code, 3);
  assert.equal(f.journal().filter(e => e.type === 'pending-note').length, 1);
  // answer stays single-target.
  const answer = await f.cli(['send', '--request', 'a1', '--to', `${f.wid}/held`, '--to', `${f.wid}/q`, '--kind', 'answer', '--message', 'x', '--json']);
  assert.equal(answer.code, 1); assert.match(JSON.parse(answer.out).reason, /answer goes to one call/);
  // All applied: exit 0; steer to a sealed call is still rejected for that target only.
  const steer = await f.cli(['send', '--request', 's1', '--to', `${f.wid}/held`, '--to', `${f.wid}/q`, '--kind', 'steer', '--message', 'x', '--json']);
  assert.equal(steer.code, 1);
  assert.deepEqual(JSON.parse(steer.out).targets.map((r: Record<string, unknown>) => r.applied), [true, false]);
});

test('Tool: to as a list sends one request per call with per-target results; retries are idempotent; answer takes one', async t => {
  const f = await fixture(t);
  const keys = ['HOME', 'DSA_HOME', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'DSA_ORCHESTRATOR_ENTRY'] as const;
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, f.env);
  f.cleanups.push(() => { for (const k of keys) if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; });
  let tool: { execute: (...args: unknown[]) => Promise<{ details: unknown }> } | undefined;
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const context = { cwd: f.cwd, hasUI: false, isIdle: () => false, ui: { notify() {} },
    sessionManager: { getSessionId: () => 'many-session', getSessionFile: () => undefined, getLeafId: () => undefined } };
  const { registerMain } = await import('../../../src/agent/main.ts');
  registerMain({ on(name: string, fn: never) { handlers.set(name, fn); }, registerTool(value: never) { tool = value; }, sendMessage() {} } as never);
  await handlers.get('session_start')!({}, context);
  f.cleanups.push(() => handlers.get('session_shutdown')!({ reason: 'reload' }, context));
  const call = async (args: Record<string, unknown>) => (await tool!.execute('id', args, undefined, undefined, context)).details as Record<string, unknown>;
  const args = { action: 'send', kind: 'notify', to: [`${f.wid}/held`, `${f.wid}/q`, `${f.wid}/nope`], message: 'decided', request: 't1' };
  const first = await call(args);
  const targets = first.targets as Record<string, unknown>[];
  assert.deepEqual(targets.map(r => [r.to, r.request, r.applied, r.delivery ?? r.reason]), [
    [`${f.wid}/held`, 't1:1', true, undefined], [`${f.wid}/q`, 't1:2', true, 'noted'], [`${f.wid}/nope`, 't1:3', false, `unknown-call: use one of ${f.wid}/held, ${f.wid}/q`]]);
  assert.equal(String(first.summary).split('\n').length, 3);
  assert.match(String(first.summary), new RegExp(`${f.wid}/q: applied \\(noted: the call is not running`));
  assert.deepEqual(await call(args), first, 'a retry gets the same outcomes');
  assert.equal(f.journal().filter(e => e.type === 'pending-note').length, 1);
  assert.equal((await call({ ...args, message: 'other' })).targets !== undefined, true);
  assert.ok(((await call({ ...args, message: 'other' })).targets as Record<string, unknown>[]).every(r => r.reason === 'request-conflict'));
  assert.equal((await call({ ...args, to: [`${f.wid}/held`, `${f.wid}/q`] })).reason, 'request-conflict');
  assert.equal((await call({ ...args, to: `${f.wid}/held` })).reason, 'request-conflict');
  await assert.rejects(call({ action: 'send', kind: 'answer', to: [`${f.wid}/held`, `${f.wid}/q`], message: 'x', qid: 'q', rev: 1 }), /answer goes to one call/);
  // Without a request id each target gets its own fresh request; a one-element list is a plain send.
  const plain = await call({ action: 'send', kind: 'notify', to: [`${f.wid}/q`], message: 'single' });
  assert.equal(plain.applied, true); assert.equal(plain.delivery, 'noted');
  assert.equal(f.journal().filter(e => e.type === 'pending-note').length, 2);
});
