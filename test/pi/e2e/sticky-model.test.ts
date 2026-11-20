import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FAUX, REPO, script, tempRoot } from "../../harness/pi.ts";
import { sessionRows } from "../../harness/session-lines.ts";
import { callSession, journalPath, orchInbox, orchLedger } from "../../../src/paths.ts";
import { readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { publishRequest } from "../../../src/kernel/mailbox.ts";
import { main } from "../../../src/orchestrator/main.ts";
import { compactWorkflow, statusDetail } from "../../../src/orchestrator/snapshot.ts";
import { JT, type Request } from "../../../src/types.ts";

async function until<T>(fn: () => T | Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + 20000;
  for (;;) { const value = await fn(); if (value) return value as NonNullable<T>; if (Date.now() > deadline) throw new Error("Timed out waiting for sticky model evidence"); await delay(20); }
}

async function fixture(t: TestContext, task: string, sibling = false) {
  const root = tempRoot("dsa-sticky-e2e-"), home = join(root, "dsa"), cwd = join(root, "work"), agentDir = join(root, "agent");
  const old = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK, PROBE_DIR: process.env.PROBE_DIR };
  Object.assign(process.env, { PATH: `${join(REPO, "node_modules/.bin")}:${process.env.PATH}`, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PROBE_DIR: root });
  await mkdir(join(cwd, ".pi/agents"), { recursive: true }); await mkdir(agentDir, { recursive: true }); await mkdir(home, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [FAUX] }));
  await writeFile(join(cwd, ".pi/agents/test.md"), "---\nname: test\ndescription: test\nmodel: probe/scripted\n---\nTest.");
  await writeFile(join(home, "config.json"), JSON.stringify({ writerLock: "off", pools: { writer: ["probe/scripted", "probe/scripted2"], alt: ["probe/scripted2", "probe/scripted"] }, k: { trackerMs: 20, hibernateMs: 60, idleExitMs: 60000 } }));
  let controller = new AbortController(), running = main({ home, signal: controller.signal, discovery: { home: root } });
  t.after(async () => { controller.abort(); await running; for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {}); });
  const restart = async () => { controller.abort(); await running; controller = new AbortController(); running = main({ home, signal: controller.signal, discovery: { home: root } }); };
  const call = `runs.run('a', {agent:'test',model:'writer',writer:false,task:${JSON.stringify(task)}})`;
  const source = sibling ? `return await Promise.all([${call}, runs.run('b', {command:['sleep','60']})]);` : `return await ${call};`;
  await publishRequest(orchInbox(home), { rid: "run", from: "main:test", to: "orch", sseq: 1, kind: "run", body: { cwd, source } } as Request);
  const orch = () => readJournalSnapshot(orchLedger(home));
  const wid = String((await until(() => orch().find(e => e.type === JT.created))).wid);
  const entries = () => readJournalSnapshot(journalPath(home, wid));
  const sealed = async (gen: number) => {
    const e = await until(() => entries().find(e => e.type === JT.sealed && e.call === `${wid}@1/a@${gen}`));
    return e.result as { status: string; output: string };
  };
  let sseq = 1;
  const requests = new Map<string, Request>();
  const request = async (kind: Request["kind"], body: Record<string, unknown>, rid = `req-${sseq + 1}`) => {
    const req = requests.get(rid) ?? { rid, from: "main:test", to: "orch", sseq: ++sseq, kind, body };
    requests.set(rid, req); await publishRequest(orchInbox(home), req);
    return until(() => orch().find(e => (e.type === JT.applied || e.type === JT.rejected) && e.rid === rid));
  };
  const send = (body: Record<string, unknown>, rid?: string) => request("send", { to: `${wid}/a`, ...body }, rid);
  const follow = async (gen: number, model?: string) => {
    assert.equal((await send({ kind: "follow-up", message: script([{ text: `generation ${gen}` }]), ...(model ? { model } : {}) })).type, JT.applied);
    assert.equal((await sealed(gen)).status, "ok");
    const rows = sessionRows(await readFile(callSession(home, wid, "a", gen), "utf8"));
    return rows.findLast(e => e.type === "message" && e.message.role === "assistant").message.model as string;
  };
  return { home, wid, entries, orch, sealed, restart, request, send, follow };
}

test("MP1/MP3 E2E: live manual switch on a pool survives seal, restart, g+1 and g+2; follow-up model replaces it", { timeout: 90000 }, async t => {
  const f = await fixture(t, script([{ tool: "bash", args: { command: "sleep 2" } }, { text: "first complete" }]));
  await until(() => f.entries().some(e => e.type === "observation" && (e.event as { type?: string }).type === "tool_execution_start"));
  assert.equal((await f.send({ kind: "model", model: "probe/scripted2" }, "live-model")).type, JT.applied);
  const forward = f.entries().find(e => e.type === "forward" && e.rid === "live-model")!;
  assert.equal(forward.choice, "probe/scripted2");
  assert.equal((await f.sealed(1)).status, "ok");
  await until(() => f.entries().some(e => e.type === JT.done));
  const used = sessionRows(await readFile(callSession(f.home, f.wid, "a", 1), "utf8"));
  assert.equal(used.findLast(e => e.type === "message" && e.message.role === "assistant").message.model, "scripted2");
  await f.restart();
  assert.equal(await f.follow(2), "scripted2"); assert.equal(await f.follow(3), "scripted2");
  assert.equal(await f.follow(4, "probe/scripted"), "scripted"); assert.equal(await f.follow(5), "scripted");
});

for (const state of ["done", "running", "stopped"] as const) test(`MP2/MP3 E2E: sealed call in ${state} workflow records without launching and opens next generation on choice`, { timeout: 90000 }, async t => {
  const f = await fixture(t, script(state === "stopped" ? [{ tool: "ask", args: { question: "Stop me?" } }] : [{ text: "first" }]), state === "running");
  if (state === "stopped") {
    await until(() => f.entries().some(e => e.type === "hibernated"));
    assert.equal((await f.request("stop", { target: f.wid })).type, JT.applied);
    assert.equal((await f.sealed(1)).status, "stopped");
  } else assert.equal((await f.sealed(1)).status, "ok");
  await until(() => state === "running" ? f.entries().some(e => e.type === "command-started") : f.entries().some(e => e.type === JT.done));
  if (state === "running") assert.ok(!f.entries().some(e => e.type === JT.done));
  const launches = f.entries().filter(e => e.type === JT.exec).length, holds = f.orch().filter(e => e.type === "hold").length;
  assert.equal((await f.send({ kind: "model", model: "probe/scripted2" }, "sealed-model")).type, JT.applied);
  assert.equal(f.entries().filter(e => e.type === JT.exec).length, launches);
  assert.equal(f.orch().filter(e => e.type === "hold").length, holds);
  assert.equal(f.entries().filter(e => e.type === "generation").length, 0);
  const note = f.orch().find(e => e.type === "send-note" && e.rid === "sealed-model")!;
  assert.deepEqual([note.model, note.effect], ["probe/scripted2", "next-generation"]);
  const status = compactWorkflow(statusDetail(f.home, f.wid)).calls.find(c => c.key === "a")!;
  assert.equal(status.model, "probe/scripted"); assert.equal(status.switching, "probe/scripted2");
  await f.restart();
  assert.equal((await f.send({ kind: "model", model: "probe/scripted2" }, "sealed-model")).type, JT.applied);
  assert.equal(f.entries().filter(e => e.type === "model-choice").length, 1);
  assert.equal(await f.follow(2), "scripted2"); assert.equal(await f.follow(3), "scripted2");
  if (state === "running") await f.request("stop", { target: `${f.wid}/b` });
});

test("MP1 E2E: a live pool-name choice stays a pool through later generations", { timeout: 90000 }, async t => {
  const f = await fixture(t, script([{ tool: "bash", args: { command: "sleep 2" } }, { text: "first" }]));
  await until(() => f.entries().some(e => e.type === "observation" && (e.event as { type?: string }).type === "tool_execution_start"));
  assert.equal((await f.send({ kind: "model", model: "alt" }, "pool-model")).type, JT.applied);
  assert.equal(f.entries().find(e => e.type === "forward" && e.rid === "pool-model")!.choice, "alt");
  assert.equal((await f.sealed(1)).status, "ok");
  assert.equal(await f.follow(2), "scripted2"); assert.equal(await f.follow(3), "scripted2");
  const generation = f.entries().findLast(e => e.type === "generation")!;
  assert.equal((generation.spec as { model: string }).model, "alt"); assert.equal(generation.model, undefined);
  assert.equal(f.entries().findLast(e => e.type === "selected")!.pool, "alt");
});
