import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { publishRequest } from "../../../../src/kernel/mailbox.ts";
import { orchInbox, orchLedger } from "../../../../src/paths.ts";
import { Store, revisionEntries, terminalEntry } from "../../../../src/orchestrator/store.ts";
import { Engine } from "../../../../src/orchestrator/engine.ts";
import type { EvaluatorTransport } from "../../../../src/orchestrator/evaluator-client.ts";
import { JT, type Request, type RunBody } from "../../../../src/types.ts";
import { fakeExecutor } from "../engine/fake.ts";

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "dsa-store-")), cwd = join(home, "project"), agents = join(home, "config", "agents");
  await mkdir(cwd, { recursive: true }); await mkdir(agents, { recursive: true });
  const orch = await openJournal(orchLedger(home)), ledgers = { home, orch, config: {} }, store = new Store(ledgers);
  t.after(async () => {
    for (const dir of [["staging"], ["staging", "eacces"], ["staging", "eacces", "inputs"], ["config", "agents", "secret.md"]]) await chmod(join(home, ...dir), 0o700).catch(() => {});
    await orch.close(); await rm(home, { recursive: true, force: true });
  });
  await writeFile(join(agents, "worker.md"), "---\nname: worker\ndescription: Works\n---\nWork.\n");
  await writeFile(join(agents, "broken.md"), "---\nname: broken\ndescription: Broken\nfallbackModels: a, b\n---\nBroken.\n");
  const discovery = { home, agentDir: join(home, "config"), globalNpmRoot: null };
  const run = (rid: string, body: Partial<RunBody>): Request<RunBody> => ({ rid, from: "cli:test", to: "orch", sseq: 1, kind: "run", body: { cwd, ...body } as RunBody });
  const warnings = async (rid: string) => JSON.parse(await readFile(join(home, "staging", rid, "snapshot.json"), "utf8")).warnings as string[] | undefined;
  return { home, cwd, agents, ledgers, store, discovery, run, warnings, staging: (rid: string) => join(home, "staging", rid) };
}
test("A1 terminal memoization follows done, resume and revision appends", async t => {
  const f = await fixture(t), req = f.run("cache", { source: "return 1;" });
  await f.store.stage(req, f.discovery); const wf = await f.store.create(req);
  t.after(() => f.store.close());
  const initial = revisionEntries(wf);
  assert.strictEqual(revisionEntries(wf), initial); assert.equal(terminalEntry(initial), undefined);
  const done = await wf.journal.append(JT.done, { result: 1 });
  const complete = revisionEntries(wf); assert.notStrictEqual(complete, initial);
  assert.deepEqual(terminalEntry(complete), done); assert.strictEqual(terminalEntry(complete), terminalEntry(complete));
  await wf.journal.append("resumed", {}); assert.equal(terminalEntry(revisionEntries(wf)), undefined);
  await wf.journal.append(JT.done, { result: 2 }); assert.ok(terminalEntry(revisionEntries(wf)));
  const revised = await wf.journal.append("revised", { revision: 2 });
  const revisedView = revisionEntries(wf);
  assert.deepEqual(revisedView, [revised]); assert.strictEqual(revisionEntries(wf), revisedView);
  assert.equal(terminalEntry(revisedView), undefined);
  assert.deepEqual(terminalEntry(complete), done, "prior immutable views retain their meaning");
});

const root = process.getuid?.() === 0;

test("E3 an agent diagnostic is a warning unless the run could use its name", async t => {
  const f = await fixture(t);
  const ok = f.run("unrelated", { tasks: [{ agent: "worker", task: "go" }], args: { note: "broken agents elsewhere" } });
  await f.store.stage(ok, f.discovery);
  assert.ok((await f.store.staged(ok)).agents.some(a => a.name === "worker"));
  assert.equal((await f.warnings("unrelated"))!.length, 1); assert.match((await f.warnings("unrelated"))![0]!, /broken\.md: .*fallbackModels/);
  for (const [rid, body] of [
    ["source", { source: "return await runs.run('k', { agent: 'broken', task: 'x' });" }],
    ["args", { source: "return await runs.run('k', { agent: args.pick[0].name, task: 'x' });", args: { pick: [{ name: "broken" }] } }],
  ] as const) {
    const req = f.run(rid, body);
    await f.store.stage(req, f.discovery);
    await assert.rejects(f.store.staged(req), /broken\.md: .*fallbackModels/, rid);
  }
});

test("E3 a broken file naming an agent that is also pinned blocks the run", async t => {
  const f = await fixture(t);
  await writeFile(join(f.agents, "worker-old.md"), "---\nname: worker\ndescription: Old\nfallbackModels: a\n---\nOld.\n");
  const req = f.run("shadowed", { source: "return 1;" });
  await f.store.stage(req, f.discovery);
  await assert.rejects(f.store.staged(req), /worker-old\.md: .*fallbackModels/);
});

test("E3 an unreadable agent file is named by its file name", { skip: root ? "root reads mode 000 files" : false }, async t => {
  const f = await fixture(t), secret = join(f.agents, "secret.md");
  await writeFile(secret, "---\nname: other\ndescription: x\n---\n"); await chmod(secret, 0);
  const unused = f.run("unused", { source: "return 1;" });
  await f.store.stage(unused, f.discovery);
  await f.store.staged(unused);
  assert.ok((await f.warnings("unused"))!.some(w => /secret\.md: .*EACCES/.test(w)));
  const used = f.run("used", { source: "return await runs.run('k', { agent: \"secret\", task: 'x' });" });
  await f.store.stage(used, f.discovery);
  await assert.rejects(f.store.staged(used), /secret\.md: .*EACCES/);
});

test("E3 deterministic validation errors are pinned durably", async t => {
  const f = await fixture(t);
  const missing = f.run("missing", { workflow: join(f.home, "absent.js") });
  await f.store.stage(missing, f.discovery);
  await assert.rejects(f.store.staged(missing), /ENOENT/);
  const invalid = f.run("invalid", { source: "return 1;", tasks: [{ agent: "worker", task: "x" }] });
  await f.store.stage(invalid, f.discovery);
  await assert.rejects(f.store.staged(invalid), /invalid-run/);
});

class IdleEvaluator implements EvaluatorTransport {
  async start() {} send() {} async close() {}
}
test("E3 an overlong (32 CJK chars) input name is a deterministic pin failure, never an intake crash", async t => {
  const f = await fixture(t), input = join(f.home, "input.txt"), name = "\u8f93".repeat(32);
  await writeFile(input, "data");
  const req = f.run("cjk", { source: "return 1;", inputs: { [name]: input } });
  await f.store.stage(req, f.discovery); await f.store.stage(req, f.discovery);
  assert.match(JSON.parse(await readFile(join(f.staging("cjk"), "failure.json"), "utf8")).error, /invalid-input-name/);
  await assert.rejects(f.store.staged(req), /invalid-input-name/);
  const engine = new Engine(f.ledgers, fakeExecutor(f.ledgers), { evaluator: new IdleEvaluator(), discovery: f.discovery });
  try {
    await engine.recover();
    const request = { ...req, rid: "cjk-intake" };
    await publishRequest(orchInbox(f.home), request);
    await engine.intake(); await engine.intake();
    const rejected = f.ledgers.orch.entries().find(e => e.type === JT.rejected && e.rid === request.rid);
    assert.match(String(rejected?.reason), /^pin-failed: .*invalid-input-name/);
  } finally { await engine.close(); }
});

test("E3 EACCES on a staging temp file is deterministic: failure.json, rejected, no throw", { skip: root ? "root bypasses EACCES" : false }, async t => {
  const f = await fixture(t), input = join(f.home, "input.txt"), dir = f.staging("eacces");
  await writeFile(input, "data");
  const req = f.run("eacces", { source: "return 1;", inputs: { data: input } });
  await f.store.stage(req, f.discovery);
  await rm(join(dir, "inputs", "data")); await chmod(join(dir, "inputs"), 0o500);
  await f.store.stage(req, f.discovery);
  assert.match(JSON.parse(await readFile(join(dir, "failure.json"), "utf8")).error, /EACCES/);
  await assert.rejects(f.store.staged(req), /EACCES/);
});

const prlimit = spawnSync("prlimit", ["--version"]).status === 0;
test("E3 a transient error (EMFILE) propagates without pinning; the next intake stages the request", { skip: process.platform !== "linux" || !prlimit ? "needs Linux prlimit" : false, timeout: 30000 }, async t => {
  const f = await fixture(t), input = join(f.home, "input.txt");
  await writeFile(input, "data");
  const worker = fileURLToPath(new URL("emfile-worker.ts", import.meta.url));
  const out = execFileSync("prlimit", ["--nofile=256:256", process.execPath, worker], { env: { ...process.env, TEST_HOME: f.home, TEST_INPUT: input }, encoding: "utf8", timeout: 20000 });
  assert.deepEqual(JSON.parse(out.trim().split("\n").at(-1)!), { first: "EMFILE", failure: false, snapshot: false, second: "ok", source: "return 1;" });
});
