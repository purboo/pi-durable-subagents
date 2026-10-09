// End-to-end request ids (R1–R3) through the real CLI processes, a detached orchestrator and child pi with the faux
// provider: concurrent retries across an orchestrator SIGKILL, conflicts, prune tombstones, concurrent follow-ups,
// describe states and answers addressed by run id. Everything lives under one temp root (HOME, DSA_HOME, agent dir).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FAUX, REPO, script, tempRoot } from "../../harness/pi.ts";
import { journalPath, orchLedger } from "../../../src/paths.ts";
import { readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { JT, type Entry } from "../../../src/types.ts";

const CLI = join(REPO, "src/cli/main.ts");
type Result = { code: number | null; out: string; err: string };

async function stack(t: TestContext) {
  const root = tempRoot("dsa-e2e-req-"), home = join(root, "dsa"), cwd = join(root, "work"), agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi/agents"), { recursive: true }); await mkdir(agentDir, { recursive: true }); await mkdir(home, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [FAUX], defaultProvider: "probe", defaultModel: "scripted" }));
  await writeFile(join(cwd, ".pi/agents/echo.md"), "---\nname: echo\ndescription: echo\n---\nYou echo.\n");
  const noop = join(root, "noop.mjs"); await writeFile(noop, "");
  const base: NodeJS.ProcessEnv = { PATH: `${join(REPO, "node_modules/.bin")}:${process.env.PATH}`, HOME: root, DSA_HOME: home,
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PROBE_DIR: root };
  const cli = (args: string[], extra: NodeJS.ProcessEnv = {}) => new Promise<Result>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...base, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { err += d; });
    child.once("error", reject); child.once("close", code => resolve({ code, out: out.trim(), err: err.trim() }));
  });
  const json = (r: Result) => { try { return JSON.parse(r.out); } catch { throw new Error(`not JSON (exit ${r.code}): ${r.out} ${r.err}`); } };
  const spec = async (name: string, value: unknown) => { const path = join(root, name); await writeFile(path, JSON.stringify(value)); return path; };
  const ledger = () => readJournalSnapshot(orchLedger(home));
  const journal = (wid: string) => readJournalSnapshot(journalPath(home, wid));
  const pids = () => ledger().filter(e => e.type === "orchestrator").map(e => Number(e.pid));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const until = async <T>(get: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 60_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) { const v = await get(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await delay(50); }
  };
  const describe = async (key: string) => json(await cli(["describe", "--key", key, "--json"]));
  t.after(async () => {
    for (const pid of pids()) if (alive(pid)) process.kill(pid, "SIGTERM");
    await until(() => pids().every(pid => !alive(pid)), "orchestrators exit", 15_000).catch(() => { for (const pid of pids()) if (alive(pid)) process.kill(pid, "SIGKILL"); });
    if (process.env.DSA_KEEP) t.diagnostic(`kept: ${root}`); else await rm(root, { recursive: true, force: true });
  });
  return { root, home, cwd, noop, cli, json, spec, ledger, journal, pids, alive, until, describe };
}
const of = (entries: Entry[], type: string) => entries.filter(e => e.type === type);

test("E2E R1/R2: 20 concurrent retries across an orchestrator SIGKILL create one workflow; conflicts and prune keep the identity", { timeout: 240_000 }, async t => {
  const s = await stack(t);
  const path = await s.spec("x.json", { agent: "echo", task: script([{ delayMs: 1_500, text: "X done" }]) });
  const wave = () => Array.from({ length: 10 }, () => s.cli(["run", "--request", "X", "--spec", path, "--json"]));
  const first = wave();
  // Kill the orchestrator the first wave started as soon as it is up; the second wave restarts it.
  const pid = await s.until(() => s.pids()[0], "orchestrator started");
  process.kill(pid, "SIGKILL");
  await s.until(() => !s.alive(pid), "orchestrator killed");
  const results = await Promise.all([...first, ...wave()]);
  for (const r of results) assert.equal(r.code, 0, `${r.out} ${r.err}`);
  const replies = results.map(s.json);
  const wid = replies[0].wid;
  assert.ok(replies.every(r => r.wid === wid && r.request === "X" && r.spec_digest === replies[0].spec_digest), JSON.stringify(replies));
  assert.ok(replies.some(r => r.created === true));
  assert.ok(s.pids().length >= 2, "the orchestrator was restarted");
  const created = () => of(s.ledger(), JT.created);
  assert.deepEqual(created().map(e => e.wid), [wid], "exactly one workflow");
  const done = await s.until(() => s.journal(wid).find(e => e.type === JT.done), "X done");
  assert.equal(done.status, "done", JSON.stringify(done));
  assert.deepEqual([...new Set(of(s.journal(wid), JT.exec).map(e => String(e.call).replace(/@\d+$/, "")))].length, 1, "one call");
  assert.ok(of(s.journal(wid), JT.exec).every(e => /@1$/.test(String(e.call))), "one generation");
  // A later retry reports the existing run; another spec under the id is a conflict and creates nothing.
  const again = s.json(await s.cli(["run", "--request", "X", "--spec", path, "--json"]));
  assert.deepEqual(again, { request: "X", wid, created: false, spec_digest: replies[0].spec_digest });
  const other = await s.spec("y.json", { agent: "echo", task: script([{ text: "Y" }]) });
  const conflict = await s.cli(["run", "--request", "X", "--spec", other, "--json"]);
  assert.equal(conflict.code, 3, conflict.out + conflict.err);
  assert.deepEqual(s.json(conflict), { request: "X", error: "request-conflict", wid, spec_digest: replies[0].spec_digest, state: "sealed" });
  assert.equal(created().length, 1);
  // Prune: describe reports the tombstone; the id keeps resolving to the same wid and the same digest.
  const prune = await s.cli(["prune", wid]);
  assert.equal(prune.code, 0, prune.out + prune.err);
  const pruned = await s.describe("X");
  assert.equal(pruned.state, "pruned"); assert.equal(pruned.wid, wid); assert.equal(pruned.pruned.status, "done");
  assert.equal(pruned.spec_digest, replies[0].spec_digest);
  const tomb = s.ledger().find(e => e.type === "pruned" && e.wid === wid)!;
  assert.equal(tomb.status, "done"); assert.equal(tomb.request, "X"); assert.equal(tomb.spec_digest, replies[0].spec_digest);
  assert.deepEqual(s.json(await s.cli(["run", "--request", "X", "--spec", path, "--json"])), again);
  const late = await s.cli(["run", "--request", "X", "--spec", other, "--json"]);
  assert.equal(late.code, 3); assert.equal(s.json(late).state, "pruned"); assert.equal(s.json(late).wid, wid);
  assert.equal(created().length, 1, "no new workflow after prune");
  assert.ok(!(await readdir(join(s.home, "w")).catch(() => [] as string[])).includes(wid));
});

test("E2E R2/R3: describe states, full questions, answers by run id, and 10 concurrent follow-ups create one generation", { timeout: 240_000 }, async t => {
  const s = await stack(t);
  assert.deepEqual(await s.describe("D"), { state: "absent", request: "D" });
  // Pending: submitted, but no orchestrator decides it (the starter launches a no-op entry).
  const question = `Which colour? ${"Please consider every option carefully. ".repeat(12)}End.`;
  assert.ok(question.length > 300);
  const path = await s.spec("d.json", {
    agent: "echo", schema: { type: "object", required: ["colour"], properties: { colour: { type: "string" } } },
    task: script([{ delayMs: 1_500, tool: "ask", args: { question } }, { tool: "report", args: { outcome: "ok", data: { colour: "blue" } } }]),
  });
  const early = await s.cli(["run", "--request", "D", "--spec", path, "--json", "--wait-ms", "300"], { DSA_ORCHESTRATOR_ENTRY: s.noop });
  assert.equal(early.code, 75, early.out + early.err); assert.deepEqual(s.json(early), { request: "D", pending: true });
  const pending = await s.describe("D");
  assert.equal(pending.state, "pending"); assert.equal(pending.request, "D"); assert.equal(typeof pending.spec_digest, "string");
  // The retry with the same bytes starts the real orchestrator and gets the wid.
  const started = await s.cli(["run", "--request", "D", "--spec", path, "--json"]);
  assert.equal(started.code, 0, started.out + started.err);
  const wid = s.json(started).wid;
  assert.equal(s.json(started).spec_digest, pending.spec_digest);
  const running = await s.describe("D");
  assert.ok(["running", "asking"].includes(running.state), JSON.stringify(running));
  assert.equal(running.wid, wid); assert.equal(running.calls.length, 1);
  const asking = await s.until(async () => { const d = await s.describe("D"); return d.state === "asking" && d; }, "asking");
  assert.equal(asking.questions.length, 1);
  const open = asking.questions[0];
  assert.equal(open.text, question, "full question text, not clipped"); assert.equal(typeof open.qid, "string");
  assert.equal(open.to, `${wid}/${asking.calls[0].key}`);
  // Answer addressed by the run id, with the qid/rev from describe.
  const answer = await s.cli(["send", "--request", "A1", "--to", "D", "--kind", "answer", "--qid", open.qid, "--rev", String(open.rev), "--message", "blue", "--json"]);
  assert.equal(answer.code, 0, answer.out + answer.err); assert.equal(s.json(answer).applied, true);
  const otherRev = await s.cli(["send", "--request", "A1", "--to", "D", "--kind", "answer", "--qid", open.qid, "--rev", String(Number(open.rev) + 1), "--message", "blue", "--json"]);
  assert.equal(otherRev.code, 3, "same id, other rev: conflict");
  const sealed = await s.until(async () => { const d = await s.describe("D"); return d.state === "sealed" && d; }, "sealed");
  assert.equal(sealed.status, "done"); assert.deepEqual(sealed.calls[0].data, { colour: "blue" }); assert.equal(sealed.calls[0].ok, true);
  assert.equal(sealed.questions, undefined, "no open question once answered");
  assert.equal(sealed.lastFence, undefined, "every execution ended normally (settled or hibernated): no interruption to report");
  // Ten concurrent follow-ups with one id on the sealed call: exactly one new generation.
  const follow = script([{ text: "again" }]);
  const sends = await Promise.all(Array.from({ length: 10 }, () => s.cli(["send", "--request", "F", "--to", "D", "--kind", "follow-up", "--message", follow, "--json"])));
  for (const r of sends) assert.equal(r.code, 0, r.out + r.err);
  const generations = of(s.journal(wid), "generation").filter(e => e.rid === "req:F");
  assert.equal(generations.length, 1, JSON.stringify(generations));
  assert.ok(sends.map(s.json).every(r => r.applied === true && r.generation === 2), sends.map(r => r.out).join("\n"));
  await s.until(() => of(s.journal(wid), JT.exec).some(e => /@2$/.test(String(e.call))), "generation 2 runs");
  assert.equal(of(s.journal(wid), "generation").length, 1);
});
