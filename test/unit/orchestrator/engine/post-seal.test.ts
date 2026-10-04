import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { orchLedger } from "../../../../src/paths.ts";
import { Engine } from "../../../../src/orchestrator/engine.ts";
import { Store } from "../../../../src/orchestrator/store.ts";
import createExecutor from "../../../../src/orchestrator/executor/index.ts";
import createEffects from "../../../../src/orchestrator/executor/effects/index.ts";
import { JT, type Request, type RunBody, type ReviseBody } from "../../../../src/types.ts";
import type { CallTicket } from "../../../../src/orchestrator/contract.ts";
import { git } from "../effects/helpers.ts";

for (const revised of [false, true]) test(`P32 finished workflow recovers post-seal cleanup from ${revised ? "historical" : "current"} pins exactly once`, async t => {
  const root = await mkdtemp(join(tmpdir(), "dsa-post-seal-")), cwd = join(root, "repo"), home = join(root, "state");
  await mkdir(join(cwd, ".pi/agents"), { recursive: true });
  await writeFile(join(cwd, ".pi/agents/test.md"), "---\nname: test\ndescription: original\n---\nOriginal pinned agent.");
  await git(cwd, "init");
  await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "base");
  const ledgers = { home, orch: await openJournal(orchLedger(home)), config: {} };
  const store = new Store(ledgers), discovery = { home: root, agentDir: join(root, "pi"), globalNpmRoot: null };
  const req: Request<RunBody> = { rid: "run", from: "main:test", to: "orch", kind: "run", sseq: 1, body: { cwd, source: "return 1;", usageBudget: { tokens: 100 } } };
  await store.stage(req, discovery); const wf = await store.create(req);
  const spec = { agent: "test", task: "task", isolation: "worktree" as const };
  await wf.journal.append("call", { pos: 0, key: "a", gen: 1, spec });
  const ticket: CallTicket = { wid: wf.wid, widRev: `${wf.wid}@1`, callId: `${wf.wid}@1/a@1`, key: "a", gen: 1, spec, cwd, journal: wf.journal, agent: wf.pins.agents.find(a => a.name === "test")!, workflowBudget: wf.pins.usageBudget };
  const effects = createEffects(ledgers), prepared = await effects.prepare(ticket, { sessionPath: join(root, "session.jsonl") });
  const exec = `${ticket.callId}#1.1`, result = { key: "a", gen: 1, status: "ok" as const, ok: true, output: "done" };
  await wf.journal.append(JT.exec, { call: ticket.callId, exec });
  await wf.journal.append(JT.fenced, { exec });
  await wf.journal.append(JT.sealed, { call: ticket.callId, exec, result });
  // Crash window: the durable seal exists, but afterSeal was never entered.
  await wf.journal.append(JT.done, { status: "done" });
  if (revised) {
    await writeFile(join(cwd, ".pi/agents/test.md"), "---\nname: test\ndescription: changed\n---\nChanged pinned agent.");
    const revision: Request<ReviseBody> = { rid: "revise", from: "main:test", to: "orch", sseq: 2, kind: "revise", body: { wid: wf.wid, source: "return 2;" } };
    await store.stage(revision, discovery);
    await store.revise(await store.revisionIntent(revision, wf));
    await wf.journal.append(JT.done, { status: "done" });
  }
  await store.close();
  let after = 0, engine: Engine | undefined;
  t.after(async () => { await engine?.close(); await ledgers.orch.close(); await rm(root, { recursive: true, force: true }); });
  const recover = async () => {
    const actual = createEffects(ledgers);
    const executor = createExecutor(ledgers, { effects: {
      ...actual,
      prepare: async () => { throw new Error("sealed recovery must not prepare or spawn"); },
      beforeSeal: async () => { throw new Error("sealed recovery must not rerun beforeSeal"); },
      afterSeal: async (original, seal) => {
        after++;
        assert.equal(original.widRev, `${wf.wid}@1`);
        assert.equal(original.agent.body, ticket.agent.body);
        assert.deepEqual(original.workflowBudget, ticket.workflowBudget);
        await actual.afterSeal(original, seal);
      },
    } });
    engine = new Engine(ledgers, executor, { evaluator: {
      start: async () => { await assert.rejects(access(prepared.cwd)); },
      send: () => { throw new Error("finished workflow must not start a script"); }, close: async () => {},
    }, discovery });
    await engine.recover();
    const journal = engine.store.workflows.get(wf.wid)!.journal;
    assert.equal(journal.entries().filter(e => e.type === "wt-removed").length, 1);
    assert.equal(journal.entries().filter(e => e.type === JT.exec).length, 1);
    assert.equal(journal.entries().filter(e => e.type === JT.sealed).length, 1);
    await engine.close(); engine = undefined;
  };
  await recover(); await recover();
  assert.equal(after, 1);
  assert.equal((await git(cwd, "worktree", "list", "--porcelain")).includes(prepared.cwd), false);
  assert.ok(await git(cwd, "rev-parse", `dsa/${wf.wid}/a`));
});
