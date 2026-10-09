// End-to-end event log through the real CLI, a detached orchestrator and child pi with the faux provider:
// per-workflow milestone order with labels, a forced restart as a `fenced` event, a reader
// that persists its cursor across a restart and a kill -9, and cursor expiry with recovery. Everything lives under one
// temp root (HOME, DSA_HOME, agent dir); only orchestrators started on that home are signalled.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FAUX, REPO, script, tempRoot } from "../../harness/pi.ts";
import { journalPath, orchInbox, orchLedger } from "../../../src/paths.ts";
import { readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { publishRequest } from "../../../src/kernel/mailbox.ts";
import { JT, type Entry, type Request, type RunBody } from "../../../src/types.ts";

const CLI = join(REPO, "src/cli/main.ts");
type Result = { code: number | null; out: string; err: string };
type Ev = Record<string, any> & { id: string; cursor: string; type: string; wid: string };

async function stack(t: TestContext, config?: unknown) {
  const root = tempRoot("dsa-e2e-ev-"), home = join(root, "dsa"), cwd = join(root, "work"), agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi/agents"), { recursive: true }); await mkdir(agentDir, { recursive: true }); await mkdir(home, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [FAUX], defaultProvider: "probe", defaultModel: "scripted" }));
  await writeFile(join(cwd, ".pi/agents/echo.md"), "---\nname: echo\ndescription: echo\ntools: bash\n---\nYou echo.\n");
  if (config) await writeFile(join(home, "config.json"), JSON.stringify(config));
  const base: NodeJS.ProcessEnv = { PATH: `${join(REPO, "node_modules/.bin")}:${process.env.PATH}`, HOME: root, DSA_HOME: home,
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PROBE_DIR: root };
  const cli = (args: string[]) => new Promise<Result>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: base, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { err += d; });
    child.once("error", reject); child.once("close", code => resolve({ code, out: out.trim(), err: err.trim() }));
  });
  const lines = (r: Result) => r.out.split("\n").filter(Boolean).map(l => JSON.parse(l));
  const ledger = () => readJournalSnapshot(orchLedger(home));
  const journal = (wid: string) => readJournalSnapshot(journalPath(home, wid));
  const pids = () => ledger().filter(e => e.type === "orchestrator").map(e => Number(e.pid));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const running = () => { const last = ledger().findLast(e => e.type === "orchestrator"); return last && alive(Number(last.pid)) ? Number(last.pid) : undefined; };
  const until = async <T>(get: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 60_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) { const v = await get(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await delay(100); }
  };
  /** One `events --all` page (exit code checked by the caller when it matters). */
  const page = async (since?: string, limit?: number) => {
    const r = await cli(["events", "--all", ...(since ? ["--since", since] : []), ...(limit ? ["--limit", String(limit)] : []), "--json"]);
    return { code: r.code, out: r.out, err: r.err, lines: r.code === 0 || r.code === 4 || r.code === 75 ? lines(r) : [] };
  };
  /** Read everything after `since` (all pages); returns the events and the cursor to continue from. */
  const drain = async (since: string): Promise<{ events: Ev[]; cursor: string }> => {
    const events: Ev[] = [];
    for (let cursor = since; ;) {
      const p = await page(cursor, 50);
      assert.equal(p.code, 0, `${p.out} ${p.err}`);
      const last = p.lines.at(-1);
      events.push(...p.lines.slice(0, -1)); cursor = last.head;
      if (!last.more) return { events, cursor };
    }
  };
  let sseq = 0;
  /** A run request published directly (bypassing the CLI --labels flag): sender main:e2e. */
  const runWith = async (rid: string, body: Partial<RunBody>) => {
    const req: Request = { rid, from: "main:e2e", to: "orch", sseq: ++sseq, kind: "run", body: { cwd, ...body } };
    await publishRequest(orchInbox(home), req);
    const started = await cli(["start"]);
    assert.equal(started.code, 0, started.out + started.err);
    return until(() => ledger().find(e => e.type === JT.created && e.rid === rid)?.wid as string | undefined, `created ${rid}`);
  };
  t.after(async () => {
    for (const pid of pids()) if (alive(pid)) process.kill(pid, "SIGTERM");
    await until(() => pids().every(pid => !alive(pid)), "orchestrators exit", 15_000).catch(() => { for (const pid of pids()) if (alive(pid)) process.kill(pid, "SIGKILL"); });
    if (process.env.DSA_KEEP) t.diagnostic(`kept: ${root}`); else await rm(root, { recursive: true, force: true });
  });
  return { root, home, cwd, cli, lines, ledger, journal, pids, alive, running, until, page, drain, runWith };
}
const of = (entries: readonly Entry[], type: string) => entries.filter(e => e.type === type);

test("E2E events: ask → answer → seal gives submitted, started, asking, answered, sealed, workflow-done in order, labels on each", { timeout: 180_000 }, async t => {
  const s = await stack(t);
  const head = await s.page();
  assert.equal(head.code, 0, head.out + head.err); // no log yet: the command starts the orchestrator and waits for it
  const start = head.lines[0].head as string;
  assert.match(start, /^[0-9a-f]{16}:\d+$/);
  const question = `Which colour? ${"Think about it. ".repeat(40)}`;
  const labels = { node: "n1", attempt: "2", role: "writer" };
  const wid = await s.runWith("run-ask", { name: "asker", labels, call: { agent: "echo", task: script([{ tool: "ask", args: { question } }, { text: "the answer was heard" }]) } });
  const asking = await s.until(async () => (await s.drain(start)).events.find(e => e.wid === wid && e.type === "asking"), "asking event", 60_000);
  assert.equal(asking.question, question, "full question text");
  assert.equal(asking.to, `${wid}/${asking.key}`);
  const answer = await s.cli(["send", "--request", "ans-1", "--to", asking.to, "--kind", "answer", "--qid", asking.qid, "--rev", String(asking.rev), "--message", "blue", "--json"]);
  assert.equal(answer.code, 0, answer.out + answer.err);
  const done = await s.until(async () => { const r = await s.drain(start); return r.events.some(e => e.wid === wid && e.type === "workflow-done") && r; }, "workflow-done event", 90_000);
  const mine = done.events.filter(e => e.wid === wid);
  assert.deepEqual(mine.map(e => e.type), ["submitted", "started", "asking", "answered", "sealed", "workflow-done"], JSON.stringify(mine, null, 1));
  for (const e of mine) { assert.deepEqual(e.labels, labels, `${e.type} echoes labels`); assert.equal(e.request, undefined, "not a request-id run"); }
  assert.equal(mine[0]!.name, "asker");
  const answered = mine[3]!;
  assert.equal(answered.qid, asking.qid); assert.equal(answered.rev, asking.rev);
  assert.match(answered.by, /^cli:[^@]+@.+$/); assert.equal(answered.length, 4);
  assert.equal(answered.digest, "16477688c0e00699c6cfa4497a3612d7e83c532062b64b250fed8908128ed548");
  assert.equal(mine[4]!.status, "ok"); assert.equal(mine[5]!.status, "done");
  assert.equal(new Set(mine.map(e => e.id)).size, mine.length);
  // Cursors grow in log order.
  const seqs = done.events.map(e => Number(e.cursor.split(":")[1]));
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
});

test("E2E events: restart --force while a call runs → fenced{restart-force}; the call continues and seals ok; describe shows the same fence", { timeout: 180_000 }, async t => {
  const s = await stack(t);
  const spec = join(s.root, "f.json");
  await writeFile(spec, JSON.stringify({ agent: "echo", task: script([{ tool: "bash", args: { command: "sleep 8; echo slept" } }, { text: "finished after the fence" }]) }));
  const submitted = await s.cli(["run", "--request", "F1", "--spec", spec, "--json"]);
  assert.equal(submitted.code, 0, submitted.out + submitted.err);
  const wid = JSON.parse(submitted.out).wid as string;
  await s.until(() => s.journal(wid).some(e => e.type === "tracked"), "child tracked", 60_000);
  await delay(1_500); // inside the bash sleep
  const refused = await s.cli(["restart"]);
  assert.equal(refused.code, 1, refused.out + refused.err);
  const token = /token: ([a-f0-9]{12})/.exec(refused.out)?.[1];
  assert.ok(token, refused.out);
  const forced = await s.cli(["restart", "--force", token!, "--reason", "e2e forced restart"]);
  assert.equal(forced.code, 0, forced.out + forced.err);
  const fenced = await s.until(async () => (await s.drain(`${(await s.page()).lines[0].head.split(":")[0]}:0`)).events.find(e => e.wid === wid && e.type === "fenced"), "fenced event", 60_000);
  assert.equal(fenced.reason, "restart-force"); assert.equal(fenced.request, "F1");
  assert.equal(fenced.key, "tasks:0"); assert.equal(fenced.gen, 1);
  const sealed = await s.until(async () => (await s.drain(`${fenced.cursor.split(":")[0]}:0`)).events.find(e => e.wid === wid && e.type === "sealed"), "sealed event", 90_000);
  assert.equal(sealed.status, "ok");
  const all = (await s.drain(`${fenced.cursor.split(":")[0]}:0`)).events.filter(e => e.wid === wid).map(e => e.type);
  assert.deepEqual(all.filter(t => t !== "workflow-done"), ["submitted", "started", "fenced", "sealed"], all.join(","));
  const described = JSON.parse((await s.cli(["describe", "--key", "F1", "--json"])).out);
  assert.deepEqual(described.lastFence, { at: fenced.at, exec: fenced.exec, reason: "restart-force" });
  assert.equal(of(s.journal(wid), JT.exec).length, 2, "one execution fenced, one resumed");
});

test("E2E events: a reader persisting its cursor per page sees every sealed and asking, across a restart and a kill -9", { timeout: 300_000 }, async t => {
  const s = await stack(t, { k: { idleExitMs: 1500 } });
  const seen = new Map<string, Ev>();
  let cursor = (await s.page()).lines[0].head as string;
  // One page at a time, the cursor "persisted" after each page.
  const readPage = async () => {
    const p = await s.page(cursor, 3);
    assert.equal(p.code, 0, `${p.out} ${p.err}`);
    for (const e of p.lines.slice(0, -1)) seen.set(e.id, e);
    cursor = p.lines.at(-1).head;
    return p.lines.at(-1).more as boolean;
  };
  const spec = async (name: string, steps: unknown[]) => { const path = join(s.root, `${name}.json`); await writeFile(path, JSON.stringify({ agent: "echo", task: script(steps) })); return path; };
  const submit = async (id: string, steps: unknown[]) => {
    const r = await s.cli(["run", "--request", id, "--spec", await spec(id, steps), "--json"]);
    assert.equal(r.code, 0, r.out + r.err); return JSON.parse(r.out).wid as string;
  };
  const w1 = await submit("W1", [{ text: "one" }]);
  const w2 = await submit("W2", [{ tool: "ask", args: { question: "Proceed?" } }, { text: "two" }]);
  const w3 = await submit("W3", [{ tool: "bash", args: { command: "sleep 6; echo three" } }, { text: "three" }]);
  await readPage();
  // kill -9 while W3 runs and W2 asks.
  await s.until(() => s.journal(w3).some(e => e.type === "tracked") && of(s.journal(w2), JT.attention).length > 0, "W3 running, W2 asking", 60_000);
  await readPage();
  const killed = s.running()!;
  process.kill(killed, "SIGKILL");
  await s.until(() => !s.alive(killed), "orchestrator killed");
  await readPage();
  assert.equal((await s.cli(["start"])).code, 0);
  await s.until(() => s.running() && s.running() !== killed, "restarted after kill -9");
  const q = await s.until(() => of(s.journal(w2), JT.attention).find(e => (e.item as { kind: string }).kind === "question")?.item as { qid: string; rev: number } | undefined, "question");
  const answered = await s.cli(["send", "--request", "A2", "--to", "W2", "--kind", "answer", "--qid", q.qid, "--rev", String(q.rev), "--message", "yes", "--json"]);
  assert.equal(answered.code, 0, answered.out + answered.err);
  while (await readPage()) { /* pages */ }
  await s.until(() => [w1, w2, w3].every(w => s.journal(w).some(e => e.type === JT.done)), "all done", 120_000);
  // A clean restart: wait for the idle exit, then new work starts a new orchestrator.
  const before = s.running();
  if (before) await s.until(() => !s.alive(before), "idle exit", 30_000);
  const w4 = await submit("W4", [{ text: "four" }]);
  await s.until(() => s.journal(w4).some(e => e.type === JT.done), "W4 done", 60_000);
  await delay(500);
  while (await readPage()) { /* pages */ }
  await readPage();
  // Ground truth from the journals: every seal and every question appears at least once among the events read.
  for (const wid of [w1, w2, w3, w4]) {
    for (const seal of of(s.journal(wid), JT.sealed)) assert.ok([...seen.values()].some(e => e.type === "sealed" && e.call === seal.call), `sealed ${String(seal.call)} seen`);
    for (const a of of(s.journal(wid), JT.attention).filter(e => (e.item as { kind: string }).kind === "question"))
      assert.ok([...seen.values()].some(e => e.type === "asking" && e.qid === (a.item as { qid: string }).qid), `asking ${wid} seen`);
  }
  assert.ok(s.pids().length >= 3, "the reads spanned a kill -9 and a clean restart");
});

test("E2E events: with a tiny retention an old cursor is cursor-expired (exit 4); from the reported head the reader continues", { timeout: 240_000 }, async t => {
  const s = await stack(t, { k: { eventRetentionMs: 1, idleExitMs: 1500 } });
  const spec = async (name: string, steps: unknown[]) => { const path = join(s.root, `${name}.json`); await writeFile(path, JSON.stringify({ agent: "echo", task: script(steps) })); return path; };
  const first = await s.cli(["run", "--request", "OLD", "--spec", await spec("old", [{ text: "old" }]), "--json"]);
  assert.equal(first.code, 0, first.out + first.err);
  const old = JSON.parse(first.out).wid as string;
  const epoch = (await s.page()).lines[0].head.split(":")[0] as string;
  const stale = `${epoch}:0`;
  const read = await s.until(async () => { const r = await s.drain(stale); return r.events.some(e => e.wid === old && e.type === "workflow-done") && r; }, "OLD done", 60_000);
  assert.ok(read.events.some(e => e.wid === old && e.type === "sealed"));
  const pid = s.running();
  if (pid) await s.until(() => !s.alive(pid), "idle exit", 30_000);
  // The next start compacts: OLD is quiet and its events are older than the window.
  const next = await s.cli(["run", "--request", "NEW", "--spec", await spec("new", [{ delayMs: 4_000, text: "new" }]), "--json"]);
  assert.equal(next.code, 0, next.out + next.err);
  const fresh = JSON.parse(next.out).wid as string;
  const expired = await s.page(stale);
  assert.equal(expired.code, 4, expired.out + expired.err);
  assert.equal(expired.lines.length, 1);
  const reply = expired.lines[0];
  assert.equal(reply.error, "cursor-expired");
  assert.match(reply.oldest, new RegExp(`^${epoch}:\\d+$`)); assert.ok(Number(reply.oldest.split(":")[1]) > 0);
  // Recovery as the README describes: describe --key for every open attempt, then continue from the reported head.
  const described = JSON.parse((await s.cli(["describe", "--key", "OLD", "--json"])).out);
  assert.equal(described.state, "sealed");
  const after = await s.until(async () => { const r = await s.drain(reply.head); return r.events.some(e => e.wid === fresh && e.type === "sealed") && r; }, "NEW sealed after the head", 60_000);
  assert.ok(after.events.every(e => e.wid !== old), "no event of the dropped workflow after the head");
  assert.equal((await s.page(reply.head)).code, 0, "the reported head is a valid cursor");
});
