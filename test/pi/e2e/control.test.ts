// End-to-end control paths on the real stack (engine + executor + evaluator + child pi, faux provider):
// revision with reuse (P14) and stop-all = drain{fence} then resume (journals stay resumable).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FAUX, REPO, script, tempRoot } from "../../harness/pi.ts";
import { journalPath, orchInbox, orchLedger } from "../../../src/paths.ts";
import { readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { publishRequest } from "../../../src/kernel/mailbox.ts";
import { JT, type Entry, type Request } from "../../../src/types.ts";
import { main } from "../../../src/orchestrator/main.ts";

async function stack(t: TestContext) {
  const root = tempRoot("dsa-e2e-ctl-"), home = join(root, "dsa"), cwd = join(root, "work"), agentDir = join(root, "agent");
  const old = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK, PROBE_DIR: process.env.PROBE_DIR };
  process.env.PATH = `${join(REPO, "node_modules/.bin")}:${process.env.PATH}`;
  Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PROBE_DIR: root });
  await mkdir(join(cwd, ".pi/agents"), { recursive: true }); await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [FAUX], defaultProvider: "probe", defaultModel: "scripted" }));
  await writeFile(join(cwd, ".pi/agents/echo.md"), "---\nname: echo\ndescription: echo\ntools: bash\n---\nYou echo.\n");
  let controller = new AbortController(), orchestrator = main({ home, signal: controller.signal, discovery: { home: root } });
  let seq = 0;
  const send = async (kind: Request["kind"], body: unknown) => {
    const req: Request = { rid: `ctl-${++seq}`, from: "test:ctl", to: "orch", sseq: seq, kind, body };
    await publishRequest(orchInbox(home), req); return req;
  };
  const ledger = () => readJournalSnapshot(orchLedger(home));
  const journal = (wid: string) => readJournalSnapshot(journalPath(home, wid));
  const until = async <T>(get: () => T | undefined | false, what: string, ms = 60_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) { const v = get(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await delay(50); }
  };
  const created = (rid: string) => until(() => ledger().find(e => e.type === JT.created && e.rid === rid)?.wid as string | undefined, `created ${rid}`);
  const restart = async () => { controller.abort(); await orchestrator; controller = new AbortController(); orchestrator = main({ home, signal: controller.signal, discovery: { home: root } }); };
  t.after(async () => {
    controller.abort(); await orchestrator.catch(() => {});
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (process.env.DSA_KEEP) t.diagnostic(`kept: ${root}`); else await rm(root, { recursive: true, force: true });
  });
  return { cwd, home, send, ledger, journal, until, created, restart };
}
const of = (entries: Entry[], type: string) => entries.filter(e => e.type === type);

test("E2E P14: revise retires the running call, reuses the sealed one, and finishes with the new script", { timeout: 120_000 }, async t => {
  const s = await stack(t);
  const program = (b: unknown[]) => `const a = await runs.run("a", {agent: "echo", task: ${JSON.stringify(script([{ text: "A" }]))}});\n` +
    `const b = await runs.run("b", {agent: "echo", task: ${JSON.stringify(script(b))}});\nreturn [a.output, b.output];`;
  const run = await s.send("run", { cwd: s.cwd, source: program([{ delayMs: 60_000, text: "slow B" }]) });
  const wid = await s.created(run.rid);
  await s.until(() => of(s.journal(wid), JT.exec).some(e => String(e.call).includes("/b@")), "b running");
  await s.send("revise", { wid, source: program([{ text: "B2" }]) });
  const done = await s.until(() => s.journal(wid).find(e => e.type === JT.done), "workflow done");
  assert.equal(done.status, "done", JSON.stringify(done));
  assert.deepEqual(done.result, ["A", "B2"]);
  const entries = s.journal(wid);
  assert.equal(of(entries, JT.exec).filter(e => String(e.call).includes("/a@")).length, 1, "a ran once and was reused");
  assert.ok(of(entries, "reused").some(e => e.key === "a"));
  const oldB = of(entries, JT.exec).find(e => String(e.call).includes("/b@1"))!;
  assert.ok(of(entries, JT.fenced).some(e => e.exec === oldB.exec), "old b fenced");
  assert.ok(!of(entries, JT.sealed).some(e => e.call === oldB.call), "old b never sealed");
});

test("E2E stop-all: drain{fence} fences without sealing; restart stays drained; resume finishes the call", { timeout: 120_000 }, async t => {
  const s = await stack(t);
  const run = await s.send("run", { cwd: s.cwd, call: { agent: "echo", task: script([{ delayMs: 2_500, text: "survived" }, { text: "survived" }]) } });
  // The fenced turn may persist as an aborted assistant message; the faux script then answers from its next step.
  const wid = await s.created(run.rid);
  const first = await s.until(() => of(s.journal(wid), JT.exec)[0], "exec");
  await s.send("drain", { fence: true });
  await s.until(() => of(s.journal(wid), JT.fenced).some(e => e.exec === first.exec), "fenced");
  await delay(3_000);
  assert.equal(of(s.journal(wid), JT.sealed).length, 0); assert.ok(!s.journal(wid).some(e => e.type === JT.done));
  await s.restart(); await delay(2_000);
  assert.equal(of(s.journal(wid), JT.exec).length, 1, "no new execution while drained, even after restart");
  await s.send("resume", {});
  const done = await s.until(() => s.journal(wid).find(e => e.type === JT.done), "workflow done after resume");
  assert.equal(done.status, "done", JSON.stringify(done));
  const seal = of(s.journal(wid), JT.sealed)[0]!;
  assert.equal((seal.result as { output: string }).output, "survived");
  assert.equal(of(s.journal(wid), JT.sealed).length, 1);
});
