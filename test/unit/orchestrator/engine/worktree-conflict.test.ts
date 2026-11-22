// A successful isolated call whose worktree path someone moved to another branch (or a detached HEAD) keeps its result
// and its worktree, and records one durable `worktree-conflict:<call>` note plus a `wt-kept`. Before this, a recovery of
// that call retired the note it had just read (retireAttention resolves every item of a sealed call), so an operator saw
// nothing on the next start; and `pendingRecovery` counted the open note as recovery work due, so the workflow never
// read as settled. The note now survives a seal and every start, and an open one no longer holds the digest back.
// Everything else about a kept worktree is unchanged: unknown, fence, output and dirty keeps behave as before.
import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { openJournal, readJournalSnapshot } from "../../../../src/kernel/journal.ts";
import { publishRequest } from "../../../../src/kernel/mailbox.ts";
import { callDir, callSession, journalPath, orchInbox, orchLedger } from "../../../../src/paths.ts";
import type { CallTicket } from "../../../../src/orchestrator/contract.ts";
import { CT, JT, attentionEntries, type CallResult, type Containment, type EvalToOrch, type OrchToEval, type Request, type RunBody, type ProcInfo, type SpawnSpec } from "../../../../src/types.ts";
import { Engine } from "../../../../src/orchestrator/engine.ts";
import { pendingRecovery, unresolvedAttention, workflowDigest } from "../../../../src/orchestrator/snapshot.ts";
import { worktreeConflictId } from "../../../../src/orchestrator/executor/worktree.ts";
import createExecutor from "../../../../src/orchestrator/executor/index.ts";
import createEffects from "../../../../src/orchestrator/executor/effects/index.ts";

/** Poll a condition of a running orchestrator; the engine dispatches on its own serial queue. */
async function until<T>(fn: () => T | Promise<T>, what = "condition", ms = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) { const value = await fn(); if (value) return value as NonNullable<T>; if (Date.now() >= end) throw new Error(`Timed out waiting for ${what}`); await delay(5); }
}
const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)("git", args, { cwd, timeout: 10_000,
  env: { ...process.env, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } })).stdout.trim();
const lines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
/** A child that writes its answer into the session of the call it was launched for; the test moves the worktree from
 *  the launch hook, so a live seal and a restart both see a path holding another identity. */
class Child implements Containment {
  readonly home: string;
  /** Run when the child of `key` launches: before the seal (a live cleanup sees the moved path). */
  before = new Map<string, () => Promise<void>>();
  /** Keys whose child leaves its worktree clean (a clean successful worktree is removed at the seal). */
  clean = new Set<string>();
  async spawn(s: SpawnSpec) {
    // The child answers on the session of the call it was launched for: <wid>@<rev>/<key>@<gen>.
    const [wid, revKey] = String(s.env?.DSA_CALL ?? "").split("@"), key = revKey!.split("/")[1]!.split("@")[0]!;
    await mkdir(callDir(this.home, wid!, key, 1), { recursive: true });
    await appendFile(callSession(this.home, wid!, key, 1), lines([
      { type: "custom", customType: CT.exec, data: { exec: s.exec } },
      { type: "message", message: { role: "assistant", provider: "qa", model: "m", content: "answered", stopReason: "stop" } },
    ]));
    if (!this.clean.has(key)) await writeFile(join(s.cwd, "work.txt"), `${key} wrote this\n`);
    await this.before.get(key)?.();
    const out = new PassThrough(), err = new PassThrough();
    out.end('{"type":"agent_settled"}\n'); err.end();
    return { pid: 0, start: "", stdin: new PassThrough(), stdout: out, stderr: err, exited: Promise.resolve({ code: 0, signal: null }) };
  }
  async scan(known: ReadonlyMap<string, readonly ProcInfo[]>) { return new Map([...known.keys()].map(id => [id, []])); }
  async fence() {}
  constructor(home: string) { this.home = home; }
}
class Evaluator {
  messages: OrchToEval[] = [];
  receive!: (message: EvalToOrch) => void;
  async start(message: (message: EvalToOrch) => void) { this.receive = message; }
  send(message: OrchToEval) { this.messages.push(message); }
  async close() {}
  of(wid: string) { return this.messages.findLast(m => m.t === "start" && m.wid === wid) as Extract<OrchToEval, { t: "start" }>; }
}

/** One orchestrator start over `home`, with the real executor and its real effects (worktree preparation and cleanup).
 *  `noCleanup` reproduces a process that died between the seal and the cleanup its recovery then replays. */
async function boot(t: test.TestContext, home: string, child: Child, options: { noCleanup?: boolean } = {}) {
  const ledgers = { home, config: { k: { idleExitMs: 30 } }, orch: await openJournal(orchLedger(home)) };
  if (t) t.after(() => ledgers.orch.close());
  const real = createEffects(ledgers, child);
  const effects = options.noCleanup ? { ...real, afterSeal: async (ticket: CallTicket, result: CallResult) => {
    if (result.status === "ok") return; // the seal's cleanup never ran: the next start replays it
    await real.afterSeal(ticket, result);
  } } : real;
  const executor = createExecutor(ledgers, { effects, containment: child, memory: async () => 1e6, sweepMs: 60_000, pi: "/nonexistent-pi" });
  const evaluator = new Evaluator();
  const engine = new Engine(ledgers, executor, { evaluator, discovery: { home, agentDir: join(home, "config"), globalNpmRoot: null } });
  const closes = async () => { await engine.close(); await ledgers.orch.close(); };
  t.after(closes);
  // A start: recovery of every workflow first, then the evaluator host that runs their scripts.
  await engine.recover();
  await until(() => evaluator.receive !== undefined, "the evaluator host");
  return { home, ledgers, engine, executor, evaluator, closes };
}
type Booted = Awaited<ReturnType<typeof boot>>;
/** A run of `project` through the engine; the workflow is created (pinned) before anything is dispatched. */
async function run(b: Booted, project: string, source: string, sseq: number) {
  const rid = `run-${sseq}`;
  await publishRequest(orchInbox(b.home), { rid, from: "main:s", to: "orch", sseq, kind: "run", body: { cwd: project, source } } as Request<RunBody>);
  await b.engine.intake();
  return b.ledgers.orch.entries().find(e => e.type === JT.created && e.rid === rid)!.wid as string;
}
/** End the workflow `wid` with `done` through its own evaluator, so it is terminal and its finished note is recorded. */
async function finish(b: Booted, wid: string) {
  const wf = b.engine.store.workflows.get(wid)!;
  b.evaluator.receive({ t: "done", wid, ev: b.evaluator.of(wid).ev, result: "ran" });
  await b.engine.intake();
  assert.ok(wf.journal.entries().some(e => e.type === JT.done), "the workflow ended");
  return wf;
}
async function home(t: test.TestContext, name = "project") {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "dsa-wt-conflict-"))), project = join(dir, name);
  await mkdir(join(project, ".pi/agents"), { recursive: true });
  await writeFile(join(project, ".pi/agents/test.md"), "---\nname: test\ndescription: Test agent\n---\nSynthetic.");
  await git(project, "init");
  await git(project, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, project };
}
const attention = (b: Booted, wid: string) => attentionEntries(b.engine.store.workflows.get(wid)!.journal.entries()).map(e => e.item);
const kept = (b: Booted, wid: string) => b.engine.store.workflows.get(wid)!.journal.entries().filter(e => e.type === "wt-kept");
const notes = (b: Booted, wid: string, call: string) => attention(b, wid).filter(i => i.id === worktreeConflictId(call));

/** The sealed call of `wid` with its worktree path, branch and commit (recorded before the run). */
function worktreeOf(b: Booted, wid: string) {
  const intent = b.engine.store.workflows.get(wid)!.journal.entries().find(e => e.type === "wt-intent")!;
  return { path: String(intent.path), branch: String(intent.branch), base: String(intent.base), call: String(intent.call) };
}

const isolated = { agent: "test", task: "task", isolation: "worktree" } as const;
type Moved = { path: string; base: string; branch: string; call: string };
/** Move the path to another branch (or a detached HEAD) at `base`: the identity the intent recorded is gone. */
const move = (wt: Moved, how: "branch" | "detached") => git(wt.path, ...(how === "branch" ? ["checkout", "-b", "moved"] : ["checkout", "--detach", wt.base]));
const SCENARIOS = [
  { how: "branch", when: "live" }, { how: "detached", when: "live" },
  { how: "branch", when: "restart" }, { how: "detached", when: "restart" },
] as const;

for (const { how, when } of SCENARIOS) test(`a moved worktree of an ok isolated call keeps one diagnostic across a live seal and two recoveries (${when} ${how})`, { timeout: 40_000 }, async t => {
  const f = await home(t), child = new Child(f.dir);
  // A `restart` conflict needs the seal's cleanup to have not run: this start dies between the seal and the cleanup.
  const first = await boot(t, f.dir, child, { noCleanup: when === "restart" });
  const wid = await run(first, f.project, "unused", 1);
  const ev = (await until(() => first.evaluator.messages.find(m => m.t === "start" && m.wid === wid), "the evaluator start") as { ev: number }).ev;
  // The path is moved from the launch hook: a `live` conflict meets the live cleanup before the call seals.
  let moved: Moved | undefined;
  child.before.set("a", async () => { if (when === "live") await move(moved!, how); });
  first.evaluator.receive({ t: "call", wid, ev, pos: 0, key: "a", spec: isolated });
  const wf = first.engine.store.workflows.get(wid)!;
  await until(() => wf.journal.entries().some(e => e.type === "wt-intent"), "the worktree intent");
  const wt = worktreeOf(first, wid); moved = wt;
  const result = await until(() => wf.journal.entries().find(e => e.type === JT.sealed)?.result, "the seal") as { status: string; error?: string; output: string };
  assert.equal(result.status, "ok", `the call succeeded: ${JSON.stringify(result)}`);
  if (when === "restart") await move(wt, how);
  // A live seal writes the diagnostic right after the seal; the restart scenario's cleanup is still missing here.
  if (when === "live") await until(() => kept(first, wid).length === 1, "the live keep");
  assert.equal(attention(first, wid).filter(i => i.id.startsWith("worktree-conflict:")).length, when === "live" ? 1 : 0,
    `${when}: the diagnostic exists after the seal`);
  await finish(first, wid);
  await first.closes();

  // Two starts over the same home: each recovers the workflow with a fresh real executor (a restart makes one).
  for (const round of [1, 2]) {
    const b = await boot(t, f.dir, new Child(f.dir));
    // The replayed cleanup records the keep and then its one note; wait for both before reading the journal.
    await until(() => kept(b, wid).length === 1, `round ${round}: the keep of the replayed cleanup`);
    await until(() => attentionEntries(readJournalSnapshot(journalPath(b.home, wid)), worktreeConflictId(wt.call)).length === 1,
      `round ${round}: the diagnostic of the replayed cleanup`);
    const log = b.engine.store.workflows.get(wid)!.journal.entries();
    // One diagnostic, naming the call, the path and the branch it needs; the keep is recorded once and never repeated.
    const open = notes(b, wid, wt.call);
    assert.deepEqual(open.map(i => i.id), [worktreeConflictId(wt.call)], `round ${round}: exactly one diagnostic stays open`);
    assert.equal(open[0]!.kind, "unknown", "the diagnostic is a note for a person, not a cross-call conflict reminder");
    for (const part of [wt.call, wid, wt.path, wt.branch]) assert.ok(String(open[0]!.text).includes(part), `the note names ${part}: ${open[0]!.text}`);
    // The advice is prose a person acts on: no shell command a copy-paste could run with the wrong quoting.
    assert.doesNotMatch(String(open[0]!.text), /git\s+(-C|worktree|checkout)/, "no copyable shell command");
    assert.match(String(open[0]!.text), /restore the path/);
    assert.equal(kept(b, wid).length, 1, `round ${round}: one keep`);
    assert.equal(log.filter(e => e.type === "wt-removed").length, 0, "nothing was removed");
    assert.deepEqual(unresolvedAttention(log).map(i => i.id).filter(id => String(id).startsWith("finished:")), [`finished:${wid}`], "the workflow's own finished note is untouched");
    // The result stands, and the person's work, branch and worktree registration are exactly as they were left.
    const sealed = log.find(e => e.type === JT.sealed)!.result as { status: string; output: string };
    assert.deepEqual({ status: sealed.status, output: sealed.output }, { status: "ok", output: result.output });
    assert.equal(await readFile(join(wt.path, "work.txt"), "utf8"), "a wrote this\n", "the call's work is preserved");
    // The recovery writes nothing into the path: the call's own file is all it holds, on the branch the person chose.
    assert.deepEqual((await git(wt.path, "status", "--porcelain", "--untracked-files=all")).split("\n").filter(Boolean), ["?? work.txt"]);
    assert.equal(await git(f.project, "rev-parse", wt.branch), wt.base, "the expected branch still points at its base");
    assert.equal(await git(wt.path, "rev-parse", "--abbrev-ref", "HEAD").catch(() => ""), how === "branch" ? "moved" : "HEAD", "the path keeps the identity the person gave it");
    assert.ok((await git(f.project, "worktree", "list", "--porcelain")).includes(wt.path), "the worktree is still registered");
    // The open diagnostic is not recovery work due, so the digest still settles and keeps listing it for whoever asks.
    assert.equal(pendingRecovery(wid, log), false, `round ${round}: an open diagnostic is not recovery work due`);
    const digest = workflowDigest(b.home, wid);
    assert.ok(digest.settled, `round ${round}: the digest settles although the diagnostic is open`);
    assert.deepEqual(digest.settled!.attention.map(i => i.id).sort(), [worktreeConflictId(wt.call), `finished:${wid}`].sort());
    assert.deepEqual(unresolvedAttention(log).map(i => i.id).sort(), [worktreeConflictId(wt.call), `finished:${wid}`].sort());
    await b.closes();
  }
  // Nothing was appended by the second start's recovery of the worktree step (the keep is already recorded).
  const final = await boot(t, f.dir, new Child(f.dir));
  assert.equal(kept(final, wid).length, 1);
  assert.equal(notes(final, wid, wt.call).length, 1);
  await final.closes();
  t.diagnostic(`${when} ${how}: ${wt.path}`);
});

test("an engine that recovered a kept conflict still admits and completes an independent workflow", { timeout: 40_000 }, async t => {
  const f = await home(t), child = new Child(f.dir);
  const first = await boot(t, f.dir, child);
  const wid = await run(first, f.project, "unused", 1);
  const ev = (await until(() => first.evaluator.messages.find(m => m.t === "start" && m.wid === wid), "the evaluator start") as { ev: number }).ev;
  let moved: Moved | undefined;
  child.before.set("a", async () => { await move(moved!, "branch"); });
  first.evaluator.receive({ t: "call", wid, ev, pos: 0, key: "a", spec: isolated });
  const wf = first.engine.store.workflows.get(wid)!;
  await until(() => wf.journal.entries().some(e => e.type === "wt-intent"), "the worktree intent");
  moved = worktreeOf(first, wid);
  await until(() => kept(first, wid).length === 1, "the live keep");
  await finish(first, wid);
  await first.closes();

  // A restart that recovers the conflicted workflow first, then takes a new run on the same engine.
  const siblingChild = new Child(f.dir);
  siblingChild.clean.add("b");
  const b = await boot(t, f.dir, siblingChild);
  await until(() => kept(b, wid).length === 1, "the recovered keep");
  const healthy = await run(b, f.project, "unused", 2);
  assert.notEqual(healthy, wid, "a separate workflow");
  const ev2 = (await until(() => b.evaluator.messages.find(m => m.t === "start" && m.wid === healthy), "the sibling's evaluator start") as { ev: number }).ev;
  b.evaluator.receive({ t: "call", wid: healthy, ev: ev2, pos: 0, key: "b", spec: isolated });
  await until(() => b.engine.store.workflows.get(healthy)!.journal.entries().some(e => e.type === JT.sealed), "the sibling's seal");
  const sibling = b.engine.store.workflows.get(healthy)!;
  const sealed = sibling.journal.entries().find(e => e.type === JT.sealed)!.result as { status: string };
  assert.equal(sealed.status, "ok", "the sibling's isolated call ran and succeeded");
  // Its clean worktree is removed as always: the kept conflict of the other workflow does not reach it.
  await until(() => sibling.journal.entries().some(e => e.type === "wt-removed"), "the sibling's cleanup");
  assert.equal(sibling.journal.entries().filter(e => e.type === "wt-removed").length, 1);
  assert.equal(sibling.journal.entries().filter(e => e.type === "wt-kept").length, 0);
  assert.equal(sibling.journal.entries().filter(e => e.type === JT.attention).length, 0, "the sibling raises no note");
  // The kept conflict is exactly as the recovery left it.
  assert.equal(notes(b, wid, moved.call).length, 1);
  assert.equal(await readFile(join(moved.path, "work.txt"), "utf8"), "a wrote this\n", "the kept work still holds the call's work");
});

test("a preparation conflict fails only its own isolated call; its sibling in the same workflow runs", { timeout: 40_000 }, async t => {
  // The project path holds a space and a quote: the advice must still be usable without shell quoting games.
  const f = await home(t, "my project's dir"), child = new Child(f.dir);
  child.clean.add("a");
  const b = await boot(t, f.dir, child);
  const wid = await run(b, f.project, "unused", 1);
  const ev = (await until(() => b.evaluator.messages.find(m => m.t === "start" && m.wid === wid), "the evaluator start") as { ev: number }).ev;
  const wf = b.engine.store.workflows.get(wid)!;
  const base = await git(f.project, "rev-parse", "HEAD");
  const takenPath = join(f.project, ".dsa", wid, "taken");
  // The second call's path already holds a worktree on another branch, as a person's stray worktree would after a crash
  // between recording the intent and reconciling it: its preparation must fail that call alone, before anything runs.
  await git(f.project, "worktree", "add", "-b", `dsa/${wid}/taken`, takenPath, base);
  await git(takenPath, "checkout", "-b", "someone-elses");
  await writeFile(join(takenPath, "keep.txt"), "a person's work\n");
  await wf.journal.append("wt-intent", { call: `${wid}@1/taken@1`, path: takenPath, branch: `dsa/${wid}/taken`, base });
  await wf.journal.append("wt-created", { call: `${wid}@1/taken@1` });
  b.evaluator.receive({ t: "call", wid, ev, pos: 0, key: "a", spec: isolated });
  await until(() => wf.journal.entries().some(e => e.type === JT.exec && String(e.call).endsWith("/a@1")), "the sibling's execution");
  b.evaluator.receive({ t: "call", wid, ev, pos: 1, key: "taken", spec: isolated });
  await until(() => wf.journal.entries().filter(e => e.type === JT.sealed).length === 2, "both calls sealing");
  const sealedOf = (key: string) => wf.journal.entries().find(e => e.type === JT.sealed && String(e.call).endsWith(`/${key}@1`))!.result as { status: string; error?: string };
  assert.equal(sealedOf("a").status, "ok", "the healthy sibling ran and succeeded");
  const failed = sealedOf("taken");
  assert.equal(failed.status, "failed", "the conflicted call failed alone");
  assert.match(String(failed.error), /Worktree identity conflict/, "the failure names the conflict");
  assert.match(String(failed.error), new RegExp(`dsa/${wid}/taken`), "and the branch it needs");
  assert.match(String(failed.error), /restore the path/, "with prose advice a person acts on");
  assert.doesNotMatch(String(failed.error), /git\s+(-C|worktree|checkout)/, "no copyable shell command: a path may hold spaces");
  assert.ok(String(failed.error).includes(takenPath), "the path appears verbatim, with its space and quote, for the person to read");
  // The person's stray worktree and its files are exactly as they were; the healthy sibling's worktree went as usual.
  assert.equal(await readFile(join(takenPath, "keep.txt"), "utf8"), "a person's work\n");
  assert.equal(await git(takenPath, "rev-parse", "--abbrev-ref", "HEAD"), "someone-elses");
  assert.equal(await git(f.project, "rev-parse", `dsa/${wid}/taken`), base, "its branch keeps its commit");
  assert.equal(wf.journal.entries().filter(e => e.type === "wt-intent").length, 2, "each call has its recorded intent");
  assert.equal(wf.journal.entries().filter(e => e.type === "wt-created").length, 2);
  await until(() => wf.journal.entries().some(e => e.type === "wt-removed"), "the sibling's cleanup");
  assert.equal(wf.journal.entries().filter(e => e.type === "wt-kept").length, 0);
  assert.equal(wf.journal.entries().filter(e => e.type === JT.attention).length, 0, "a failed preparation raises no kept-worktree note");
});
