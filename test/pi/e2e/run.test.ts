// End-to-end: a run request -> real orchestrator (engine + executor + evaluator host) -> real child pi
// sessions (faux provider) -> sealed results -> workflow-done. No ~/.pi access (isolated agent dir and home).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FAUX, REPO, script, tempRoot } from "../../harness/pi.ts";
import { journalPath, orchInbox, orchLedger } from "../../../src/paths.ts";
import { readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { publishRequest } from "../../../src/kernel/mailbox.ts";
import { JT, type Request, type RunBody } from "../../../src/types.ts";
import { main } from "../../../src/orchestrator/main.ts";
import { workflowSnapshot } from "../../../src/orchestrator/snapshot.ts";

test("E2E: chain of two real child calls runs to workflow-done with the previous output threaded", { timeout: 120_000 }, async t => {
  const root = tempRoot("dsa-e2e-"), home = join(root, "dsa"), cwd = join(root, "work"), agentDir = join(root, "agent");
  const old = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK, PROBE_DIR: process.env.PROBE_DIR };
  process.env.PATH = `${join(REPO, "node_modules/.bin")}:${process.env.PATH}`;
  Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PROBE_DIR: root });
  await mkdir(join(cwd, ".pi/agents"), { recursive: true }); await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [FAUX], defaultProvider: "probe", defaultModel: "scripted" }));
  await writeFile(join(cwd, ".pi/agents/echo.md"), "---\nname: echo\ndescription: echo\ntools: bash\n---\nYou echo.\n");
  const controller = new AbortController();
  const orchestrator = main({ home, signal: controller.signal, discovery: { home: root } });
  t.after(async () => {
    controller.abort(); await orchestrator.catch(() => {});
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(root, { recursive: true, force: true });
  });

  const body: RunBody = { cwd, chain: [
    { agent: "echo", task: script([{ text: "alpha" }]) },
    { agent: "echo", task: "after {previous}: " + script([{ text: "beta" }]) },
  ] };
  const req: Request<RunBody> = { rid: "e2e-run-1", from: "test:e2e", to: "orch", sseq: 1, kind: "run", body };
  await publishRequest(orchInbox(home), req);

  let wid: string | undefined;
  const deadline = Date.now() + 100_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`timeout; ledger=${JSON.stringify(readJournalSnapshot(orchLedger(home)).map(e => e.type))}`);
    wid ??= readJournalSnapshot(orchLedger(home)).find(e => e.type === JT.created && e.rid === req.rid)?.wid as string | undefined;
    if (wid && readJournalSnapshot(journalPath(home, wid)).some(e => e.type === JT.done)) break;
    await delay(100);
  }
  const entries = readJournalSnapshot(journalPath(home, wid!));
  const done = entries.find(e => e.type === JT.done)!;
  assert.equal(done.status, "done", JSON.stringify(done));
  const seals = entries.filter(e => e.type === JT.sealed);
  assert.deepEqual(seals.map(e => (e.result as { status: string }).status), ["ok", "ok"]);
  assert.deepEqual(seals.map(e => (e.result as { output: string }).output), ["alpha", "beta"]);
  // The workflow result carries both results in order; each call ran exactly once.
  assert.equal(entries.filter(e => e.type === JT.exec).length, 2);
  const second = entries.filter(e => e.type === "call")[1]!;
  assert.match((second.spec as { task: string }).task, /^after alpha: /);
  const snap = workflowSnapshot(home, wid!);
  assert.equal(snap.status, "done"); assert.equal(snap.counts.sealed, 2); assert.equal(snap.calls[0]!.model, "probe/scripted");
  assert.deepEqual(snap.calls.map(c => c.result?.output), ["alpha", "beta"]);
});
