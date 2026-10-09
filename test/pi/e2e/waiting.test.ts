// Waiting/moving end to end through the real CLI, a detached orchestrator and child pi with the faux provider: a call blocked on the
// writer lock (two writer runs in one worktree) and a call queued for a slot (provider limit 1). `describe` reports
// `waiting.reason`; the wait collector and `startWaiting` with a fake sink, run inside the test over the journals this real
// orchestrator writes (read from disk, as describe does — the in-memory wiring into the orchestrator is covered by the engine tests),
// produce `waiting` then `moving` drafts in order, with the run's request id and labels.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FAUX, REPO, script, tempRoot } from "../../harness/pi.ts";
import { journalPath, orchLedger } from "../../../src/paths.ts";
import { readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { waitCollector, startWaiting } from "../../../src/events/waiting.ts";
import type { EventDraft } from "../../../src/events/types.ts";
import { JT } from "../../../src/types.ts";

const CLI = join(REPO, "src/cli/main.ts");
type Result = { code: number | null; out: string; err: string };

async function stack(t: TestContext) {
  const root = tempRoot("dsa-e2e-waiting-"), home = join(root, "dsa"), cwd = join(root, "work"), agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi/agents"), { recursive: true }); await mkdir(agentDir, { recursive: true }); await mkdir(home, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [FAUX], defaultProvider: "probe", defaultModel: "scripted" }));
  await writeFile(join(cwd, ".pi/agents/echo.md"), "---\nname: echo\ndescription: echo\n---\nYou echo.\n");
  await writeFile(join(home, "config.json"), JSON.stringify({ providers: { probe: { slots: 1 } }, k: { waitCheckMs: 200 } }));
  const env: NodeJS.ProcessEnv = { PATH: `${join(REPO, "node_modules/.bin")}:${process.env.PATH}`, HOME: root, DSA_HOME: home,
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PROBE_DIR: root };
  const cli = (args: string[]) => new Promise<Result>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
  const run = async (id: string, value: unknown, labels?: Record<string, string>) => {
    const r = await cli(["run", "--request", id, "--spec", await spec(`${id}.json`, value), ...(labels ? ["--labels", JSON.stringify(labels)] : []), "--json"]);
    assert.equal(r.code, 0, r.out + r.err);
    return json(r).wid as string;
  };
  t.after(async () => {
    for (const pid of pids()) if (alive(pid)) process.kill(pid, "SIGTERM");
    await until(() => pids().every(pid => !alive(pid)), "orchestrators exit", 15_000).catch(() => { for (const pid of pids()) if (alive(pid)) process.kill(pid, "SIGKILL"); });
    if (process.env.DSA_KEEP) t.diagnostic(`kept: ${root}`); else await rm(root, { recursive: true, force: true });
  });
  return { root, home, cwd, cli, json, ledger, journal, until, describe, run };
}

test("E2E waiting: describe and the collector report writer-lock and slot waits; the tracker emits waiting, then moving", { timeout: 240_000 }, async t => {
  const s = await stack(t);
  // The collector over the journals the real orchestrator writes, read from disk (identity is kept while unchanged).
  const wids = () => { try { return readdirSync(join(s.home, "w")).filter(n => !n.startsWith(".")); } catch { return []; } };
  const collect = waitCollector({ home: s.home, orch: { entries: s.ledger }, workflows: () => wids().map(wid => ({ wid, journal: { entries: () => s.journal(wid) } })) });
  const drafts: EventDraft[] = [];
  const waiter = startWaiting({ collect: () => collect(), sink: { async emit(d) { drafts.push(...d); } }, intervalMs: 50 });
  t.after(() => waiter.stop());
  const of = (call: string) => drafts.filter(d => d.call === call).map(d => d.type === "waiting" ? `waiting:${d.reason}` : d.type === "moving" ? `moving:${d.after}` : d.type);
  const selected = (wid: string) => s.journal(wid).some(e => e.type === "selected");

  // Writer lock: W1 writes in the worktree (pi's default tools can write) for a while; W2, another writer there, waits.
  const w1 = await s.run("W1", { agent: "echo", task: script([{ delayMs: 6_000, text: "W1 done" }]) });
  await s.until(() => selected(w1), "W1 runs");
  const w2 = await s.run("W2", { agent: "echo", task: script([{ text: "W2 done" }]) }, { node: "n2" });
  const blocked = await s.until(async () => { const d = await s.describe("W2"); return d.calls?.[0]?.waiting?.reason === "writer-lock" && d; }, "W2 waits for the writer lock");
  const wait = blocked.calls[0].waiting, w2call = `${w2}@1/${blocked.calls[0].key}@1`;
  assert.match(wait.detail, /^waits for the writer lock of .*: .* holds it or is ahead in the queue$/);
  assert.equal(typeof wait.since, "number"); assert.ok(wait.writerWait, "the existing fields stay");
  assert.deepEqual(blocked.labels, { node: "n2" });
  assert.equal(collect().current.get(w2call)?.reason, "writer-lock", "the collector agrees");
  await s.until(() => s.journal(w2).find(e => e.type === JT.done), "W2 done", 90_000);
  await s.until(() => of(w2call).at(-1)?.startsWith("moving:"), "moving drafted");
  // Before its writer check runs, the queued call also waits for the full provider: a leading slot wait is real.
  const w2drafts = of(w2call);
  assert.equal(w2drafts.filter(d => d !== "waiting:slot")[0], "waiting:writer-lock", w2drafts.join(" "));
  assert.ok(w2drafts.every((d, i) => d.startsWith("waiting:") === i < w2drafts.length - 1), `waiting… then one moving: ${w2drafts.join(" ")}`);
  const first = drafts.find(d => d.call === w2call)!;
  assert.equal(first.request, "W2"); assert.deepEqual(first.labels, { node: "n2" }); assert.equal(first.wid, w2);

  // Slot: two calls that do not write, on a provider with one slot.
  const s1 = await s.run("S1", { agent: "echo", writer: false, task: script([{ delayMs: 6_000, text: "S1 done" }]) });
  await s.until(() => selected(s1), "S1 runs");
  const s2 = await s.run("S2", { agent: "echo", writer: false, model: "probe/scripted", task: script([{ text: "S2 done" }]) });
  const queued = await s.until(async () => { const d = await s.describe("S2"); return d.calls?.[0]?.waiting?.reason === "slot" && d; }, "S2 waits for a slot");
  assert.equal(queued.calls[0].waiting.detail, "waiting for a slot: probe 1/1");
  const s2call = `${s2}@1/${queued.calls[0].key}@1`;
  assert.equal(collect().current.get(s2call)?.reason, "slot");
  await s.until(() => s.journal(s2).find(e => e.type === JT.done), "S2 done", 90_000);
  await s.until(() => of(s2call).at(-1) === "moving:slot", "moving drafted");
  assert.deepEqual(of(s2call), ["waiting:slot", "moving:slot"]);
  t.diagnostic(`W2: ${of(w2call).join(" → ")}; S2: ${of(s2call).join(" → ")}`);
  assert.equal((await s.describe("S2")).calls[0].waiting, undefined, "a sealed call does not wait");
  // Neither first run waited for anything the wait sources name once it ran.
  for (const wid of [w1, s1]) assert.ok(!drafts.some(d => d.wid === wid && d.type === "waiting" && d.reason !== "slot"), JSON.stringify(drafts.filter(d => d.wid === wid)));

  // The orchestrator's own wiring (k.waitCheckMs 200): the same transitions reach `events --all`, with id, labels and cursor.
  const head = s.json(await s.cli(["events", "--all"])).head as string, epoch = head.split(":")[0]!;
  const logged = async () => (await s.cli(["events", "--all", "--since", `${epoch}:0`])).out.split("\n").map(l => JSON.parse(l));
  const waitsOf = (events: { type: string; call?: string; reason?: string; after?: string }[], call: string) =>
    events.filter(e => e.call === call && (e.type === "waiting" || e.type === "moving")).map(e => e.type === "waiting" ? `waiting:${e.reason}` : `moving:${e.after}`);
  const events = await s.until(async () => { const ev = await logged(); return waitsOf(ev, s2call).at(-1) === "moving:slot" && ev; }, "the log has S2's moving", 30_000);
  assert.deepEqual(waitsOf(events, s2call), ["waiting:slot", "moving:slot"]);
  const w2logged = waitsOf(events, w2call);
  assert.ok(w2logged.includes("waiting:writer-lock") && w2logged.at(-1)?.startsWith("moving:"), w2logged.join(" "));
  const w2wait = events.find(e => e.call === w2call && e.type === "waiting" && e.reason === "writer-lock");
  assert.equal(w2wait.request, "W2"); assert.deepEqual(w2wait.labels, { node: "n2" }); assert.match(w2wait.cursor, new RegExp(`^${epoch}:\\d+$`));
  t.diagnostic(`log: W2 ${w2logged.join(" → ")}; S2 ${waitsOf(events, s2call).join(" → ")}`);
});
