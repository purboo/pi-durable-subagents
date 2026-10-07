// End-to-end, real orchestrator and child pi (faux provider): a hibernated asker shows as holding no slot, status
// counts provider slots, and a config.json change applies to the next slot acquisition without a restart.
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
import { statusBrief } from "../../../src/orchestrator/snapshot.ts";

test("E2E: hibernation releases its slot visibly; a config.json change applies without a restart", { timeout: 120_000 }, async t => {
  const root = tempRoot("dsa-e2e-config-"), home = join(root, "dsa"), cwd = join(root, "work"), agentDir = join(root, "agent");
  const old = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK, PROBE_DIR: process.env.PROBE_DIR };
  process.env.PATH = `${join(REPO, "node_modules/.bin")}:${process.env.PATH}`;
  Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PROBE_DIR: root });
  await mkdir(join(cwd, ".pi/agents"), { recursive: true }); await mkdir(agentDir, { recursive: true }); await mkdir(home, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [FAUX], defaultProvider: "probe", defaultModel: "scripted" }));
  await writeFile(join(cwd, ".pi/agents/echo.md"), "---\nname: echo\ndescription: echo\ntools: bash\n---\nYou echo.\n");
  const k = { hibernateMs: 300, trackerMs: 50, idleExitMs: 600_000 };
  await writeFile(join(home, "config.json"), JSON.stringify({ providers: { probe: { slots: 1 } }, k, ui: { dock: "line" } }));
  const controller = new AbortController();
  const orchestrator = main({ home, signal: controller.signal, discovery: { home: root } });
  t.after(async () => {
    controller.abort(); await orchestrator.catch(() => {});
    for (const [key, v] of Object.entries(old)) { if (v === undefined) delete process.env[key]; else process.env[key] = v; }
    await rm(root, { recursive: true, force: true });
  });

  let sseq = 0;
  const run = async (rid: string, task: string) => {
    const req: Request<RunBody> = { rid, from: "main:e2e", to: "orch", sseq: ++sseq, kind: "run", body: { cwd, call: { agent: "echo", task } } };
    await publishRequest(orchInbox(home), req);
    for (let i = 0; i < 600; i++) { const wid = readJournalSnapshot(orchLedger(home)).find(e => e.type === JT.created && e.rid === rid)?.wid; if (wid) return String(wid); await delay(100); }
    throw new Error(`no workflow for ${rid}`);
  };
  const entries = (wid: string) => readJournalSnapshot(journalPath(home, wid));
  const until = async (p: () => boolean, what: string, ms = 60_000) => { const end = Date.now() + ms; while (!p()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await delay(50); } };
  const done = (wid: string) => entries(wid).some(e => e.type === JT.done);
  const brief = () => statusBrief(home, { origin: "main:e2e" });
  const configs = () => readJournalSnapshot(orchLedger(home)).filter(e => e.type === "config");

  const a = await run("A", script([{ tool: "ask", args: { question: "Choose?" } }, { text: "answered" }]));
  await until(() => entries(a).some(e => e.type === "hibernated"), "A hibernates");
  await until(() => brief().slots?.[0] === "probe 0/1", `A's slot is released: ${JSON.stringify(brief().slots)}`);
  const asker = brief().active.find(w => w.wid === a)!;
  assert.equal(asker.calls[0]!.phase, "asking");
  assert.equal(asker.calls[0]!.hibernated, true, JSON.stringify(asker));
  assert.equal(asker.asking?.[0]?.hibernated, true);
  assert.equal(configs().length, 1); assert.match(String(brief().config), /^[0-9a-f]{12} since \d+s ago$/);

  // The released slot serves another call while A waits.
  const b = await run("B", script([{ text: "beta" }]));
  await until(() => done(b), "B runs on A's released slot");

  // No restart: lowering the limit to 0 holds the next call; raising it lets that call run.
  await writeFile(join(home, "config.json"), JSON.stringify({ providers: { probe: { slots: 0 } }, k }));
  await until(() => configs().length === 2, "the change is recorded");
  const c = await run("C", script([{ text: "gamma" }]));
  await delay(2000);
  assert.equal(done(c), false, "C waits: the new limit is in effect");
  assert.equal(brief().active.find(w => w.wid === c)?.calls[0]?.phase, "queued");
  assert.deepEqual(brief().slots, ["probe 0/0"]);
  await writeFile(join(home, "config.json"), JSON.stringify({ providers: { probe: { slots: "one" } }, k }));
  await until(() => brief().configRejected !== undefined, "an invalid change is reported");
  assert.equal(done(c), false);
  await writeFile(join(home, "config.json"), JSON.stringify({ providers: { probe: { slots: 1 } }, k }));
  await until(() => done(c), "C runs once the limit is raised");
  assert.equal(brief().configRejected, undefined);
  assert.equal(entries(c).filter(e => e.type === JT.sealed).length, 1);
});
