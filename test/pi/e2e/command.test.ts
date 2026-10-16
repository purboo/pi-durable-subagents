// End-to-end command calls on the real stack (engine + executor + evaluator), without pi: DSA_PI_BIN is /bin/false, so
// any launch of a subagent would fail. Real processes, an isolated DSA_HOME per test.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { detachedSleep, tempRoot } from "../../harness/pi.ts";
import { journalPath, orchInbox, orchLedger } from "../../../src/paths.ts";
import { readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { publishRequest } from "../../../src/kernel/mailbox.ts";
import { JT, type CallResult, type Entry, type Request } from "../../../src/types.ts";
import { main } from "../../../src/orchestrator/main.ts";
import { ProcessTable } from "../../../src/platform/proctable.ts";
import { Containment } from "../../../src/platform/containment.ts";
import type { OrchestratorConfig } from "../../../src/orchestrator/contract.ts";

const ORIGIN = "main:command-test";
async function stack(t: TestContext, config: OrchestratorConfig = { k: { idleExitMs: 600_000 } }) {
  const root = tempRoot("dsa-e2e-cmd-"), home = join(root, "dsa"), cwd = join(root, "work");
  await mkdir(cwd, { recursive: true });
  const old = { DSA_PI_BIN: process.env.DSA_PI_BIN };
  process.env.DSA_PI_BIN = "/bin/false";
  let controller = new AbortController(), orchestrator = main({ home, config, signal: controller.signal, discovery: { home: root } });
  let seq = 0;
  const send = async (kind: Request["kind"], body: unknown, rid?: string) => {
    const n = ++seq, req: Request = { rid: rid ?? `cmd-${n}`, from: ORIGIN, to: "orch", sseq: n, kind, body };
    await publishRequest(orchInbox(home), req); return req;
  };
  const ledger = () => readJournalSnapshot(orchLedger(home));
  const journal = (wid: string) => readJournalSnapshot(journalPath(home, wid));
  const until = async <T>(get: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 30_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) { const v = await get(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await delay(50); }
  };
  const created = (rid: string) => until(() => ledger().find(e => e.type === JT.created && e.rid === rid)?.wid as string | undefined, `created ${rid}`);
  const run = async (body: Record<string, unknown>) => created((await send("run", { cwd, ...body })).rid);
  const sealed = (wid: string, key = "tasks:0") => until(() => journal(wid).find(e => e.type === JT.sealed && String(e.call).includes(`/${key}@`))?.result as CallResult | undefined, `sealed ${wid}/${key}`);
  const started = (wid: string, n = 1) => until(() => of(journal(wid), "command-started").filter(e => String(e.id).endsWith(`#${n}`))[0], `command-started #${n} of ${wid}`);
  const stop = async () => { controller.abort(); await orchestrator; };
  const start = () => { controller = new AbortController(); orchestrator = main({ home, config, signal: controller.signal, discovery: { home: root } }); };
  t.after(async () => {
    controller.abort(); await orchestrator.catch(() => {});
    // Leave no process behind, whatever the test did.
    for (const wf of existsSync(join(home, "w")) ? readJournalSnapshot(orchLedger(home)).filter(e => e.type === JT.created) : [])
      for (const e of of(journal(String(wf.wid)), "command-intent")) await new Containment().fence(String(e.id), []).catch(() => {});
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (process.env.DSA_KEEP) t.diagnostic(`kept: ${root}`); else await rm(root, { recursive: true, force: true });
  });
  return { root, cwd, home, send, ledger, journal, until, created, run, sealed, started, stop, start, get orchestrator() { return orchestrator; } };
}
const of = (entries: Entry[], type: string) => entries.filter(e => e.type === type);
/** Live processes carrying the tag `id` (DSA_EXEC). */
const tagged = async (id: string) => (await new ProcessTable().list(new Set([id]), { fresh: true })).filter(p => p.tag === id);

test("command call: ok without pi or a provider slot; the origin's finished notice; zero usage", { timeout: 60_000 }, async t => {
  const s = await stack(t);
  const wid = await s.run({ call: { command: ["sh", "-c", "sleep 1; exit 0"] } });
  const first = await s.started(wid);
  assert.match(String(first.id), /^command:.*\/tasks:0@1#1$/);
  assert.ok(existsSync(join(String(first.dir), "output.log")));
  const result = await s.sealed(wid);
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.deepEqual(result.usage, { input: 0, output: 0, costUsd: 0 });
  assert.equal((result.data as { exitCode: number }).exitCode, 0);
  assert.equal((result.data as { signal: unknown }).signal, null);
  assert.ok((result.data as { durationMs: number }).durationMs >= 900, JSON.stringify(result.data));
  const done = await s.until(() => s.journal(wid).find(e => e.type === JT.done), "done");
  assert.equal(done.status, "done");
  const finished = await s.until(() => s.journal(wid).find(e => e.type === JT.attention && (e.item as { id: string }).id === `finished:${wid}`), "finished notice");
  assert.ok(finished);
  const entries = s.journal(wid);
  for (const type of [JT.exec, "tracked", JT.fenced, "selected", "usage"]) assert.equal(of(entries, type).length, 0, type);
  assert.deepEqual(of(entries, "command-intent").map(e => [e.id, e.n]), [[first.id, 1]]);
  assert.equal(s.ledger().filter(e => e.type === "hold" || e.type === "mem").length, 0, "no provider or memory slot");
});

test("command call: a failing command reports its status and both output streams", { timeout: 60_000 }, async t => {
  const s = await stack(t);
  const wid = await s.run({ call: { command: "echo out; echo err >&2; exit 3" } });
  const result = await s.sealed(wid);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "Command exited 3");
  assert.deepEqual(result.data && { ...(result.data as object), durationMs: 0 }, { exitCode: 3, signal: null, durationMs: 0 });
  assert.equal(result.output, "out\nerr\n");
  // A cwd that does not exist: the command cannot start, failed with the reason, never rerun.
  const missing = await s.run({ call: { command: "true", cwd: "nope", rerun: true } });
  const refused = await s.sealed(missing);
  assert.equal(refused.status, "failed");
  assert.match(String(refused.error), /^Command could not start: cwd .*nope is not a directory/);
  assert.equal(of(s.journal(missing), "command-intent").length, 1);
});

test("command call: timeout ends the whole tree, background and new-session descendants included", { timeout: 60_000 }, async t => {
  const s = await stack(t);
  const wid = await s.run({ call: { command: `${detachedSleep(60)}; nohup sleep 61 >/dev/null 2>&1 & sleep 62`, timeoutMs: 1000 } });
  const first = await s.started(wid);
  await s.until(async () => (await tagged(String(first.id))).length >= 3, "tree started");
  const result = await s.sealed(wid);
  assert.equal(result.status, "timeout");
  assert.equal(result.error, "Command timed out after 1000 ms");
  const entries = s.journal(wid);
  const decided = entries.find(e => e.type === "command-timeout")!, seal = entries.find(e => e.type === JT.sealed)!;
  assert.ok(decided.seq < seal.seq, "the timeout is recorded before the seal");
  assert.deepEqual(await tagged(String(first.id)), []);
});

test("command call: the same request submitted twice runs one process", { timeout: 60_000 }, async t => {
  const s = await stack(t);
  const marker = join(s.root, "marker");
  const body = { cwd: s.cwd, call: { command: ["sh", "-c", `echo run >> '${marker}'; sleep 1`] } };
  const req = await s.send("run", body, "twice");
  const wid = await s.created(req.rid);
  await publishRequest(orchInbox(s.home), req);
  await s.sealed(wid);
  await delay(1500);
  assert.equal(readFileSync(marker, "utf8"), "run\n");
  assert.equal(s.ledger().filter(e => e.type === JT.created).length, 1);
});

test("command call: stop ends the tree and seals stopped", { timeout: 60_000 }, async t => {
  const s = await stack(t);
  const wid = await s.run({ call: { command: `${detachedSleep(60)}; sleep 60` } });
  const first = await s.started(wid);
  await s.until(async () => (await tagged(String(first.id))).length >= 2, "tree started");
  await s.send("stop", { target: wid });
  const result = await s.sealed(wid);
  assert.equal(result.status, "stopped");
  assert.equal(result.ok, false);
  assert.deepEqual(await tagged(String(first.id)), []);
});

test("command call: restarts (normal and forced) adopt the running command; one that ended meanwhile seals from its exit record", { timeout: 90_000 }, async t => {
  const s = await stack(t);
  const long = await s.run({ call: { command: "sleep 4; echo survived" } });
  const short = await s.run({ call: { command: "sleep 1; echo meanwhile; exit 5" } });
  const first = await s.started(long);
  await s.started(short);
  // A normal restart: nothing is live for the refusal, so it applies at once; the command keeps running.
  const normal = await s.send("restart", { reason: "test" });
  assert.deepEqual(await s.orchestrator, { restart: true });
  assert.ok(s.ledger().some(e => e.type === "restart" && e.rid === normal.rid && e.force === false));
  assert.ok((await tagged(String(first.id))).length > 0, "the command survives the orchestrator's exit");
  // The short command ends while no orchestrator runs.
  await s.until(() => existsSync(join(String(of(s.journal(short), "command-started")[0]!.dir), "exit")), "short exit record");
  s.start();
  const meanwhile = await s.sealed(short);
  assert.equal(meanwhile.status, "failed");
  assert.equal(meanwhile.error, "Command exited 5");
  assert.equal(meanwhile.output, "meanwhile\n");
  // A forced restart (a token with nothing live) does not fence it either.
  await s.until(() => s.ledger().filter(e => e.type === "recovered").length >= 2, "second start recovered");
  await s.send("restart", { token: "0123456789ab", reason: "test force" });
  assert.deepEqual(await s.orchestrator, { restart: true });
  assert.ok((await tagged(String(first.id))).length > 0, "a forced restart leaves it running");
  s.start();
  const result = await s.sealed(long);
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal(result.output, "survived\n");
  for (const wid of [long, short]) {
    assert.equal(of(s.journal(wid), "command-intent").length, 1, "never started again");
    assert.equal(of(s.journal(wid), "command-started").length, 1);
  }
});

test("command call: a process gone without an exit record seals unknown; rerun starts it once more, never two at once", { timeout: 90_000 }, async t => {
  const s = await stack(t);
  const marks = (name: string) => join(s.root, name);
  // Each run records its start and end; the second attempt must start after the first one's processes ended.
  const program = (name: string) => `echo start >> '${marks(name)}'; sleep 2; echo end >> '${marks(name)}'`;
  const lost = await s.run({ call: { command: "sleep 30" } });
  const rerun = await s.run({ call: { command: program("rerun"), rerun: true } });
  const twice = await s.run({ call: { command: "echo start >> '" + marks("twice") + "'; sleep 30", rerun: true } });
  const ids = await Promise.all([lost, rerun, twice].map(async wid => String((await s.started(wid)).id)));
  const wrapper = Number((await s.started(rerun)).pid);
  await s.until(() => existsSync(marks("twice")) && existsSync(marks("rerun")), "commands started");
  await s.stop();
  // While no orchestrator runs: the whole tree of `lost` and `twice` is killed; of `rerun` only the wrapper (its
  // command goes on without anyone to record its status).
  await new Containment().fence(ids[0]!, []);
  await new Containment().fence(ids[2]!, []);
  process.kill(wrapper, "SIGKILL");
  s.start();
  const unknown = await s.sealed(lost);
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.error, "Command ended without an exit record");
  // The unknown attention item follows the seal (same serial section; this read may come between the two).
  await s.until(() => s.journal(lost).some(e => e.type === JT.attention && (e.item as { id: string }).id.startsWith("unknown:")), "unknown attention");
  const again = await s.sealed(rerun);
  assert.equal(again.status, "ok", JSON.stringify(again));
  assert.equal(readFileSync(marks("rerun"), "utf8"), "start\nend\nstart\nend\n", "the rerun started after the first run ended");
  assert.deepEqual(of(s.journal(rerun), "command-intent").map(e => e.n), [1, 2]);
  // `twice` reran once; lost again, it seals unknown: at most one rerun per call.
  const second = await s.started(twice, 2);
  await s.until(() => readFileSync(marks("twice"), "utf8") === "start\nstart\n", "second start");
  await s.stop();
  await new Containment().fence(String(second.id), []);
  s.start();
  const final = await s.sealed(twice);
  assert.equal(final.status, "unknown");
  assert.equal(readFileSync(marks("twice"), "utf8"), "start\nstart\n");
  assert.deepEqual(of(s.journal(twice), "command-intent").map(e => e.n), [1, 2]);
});

test("command call: a drain with fence of the session leaves it running; it seals, later steps wait, and the orchestrator stays", { timeout: 60_000 }, async t => {
  const s = await stack(t, { k: { idleExitMs: 300 } });
  const marker = join(s.root, "b-ran");
  const single = await s.run({ call: { command: "sleep 2; echo single" } });
  const chain = await s.run({ source: `const a = await runs.run("a", {command: "sleep 2; echo a"});\n` +
    `const b = await runs.run("b", {command: ["sh", "-c", "touch '${marker}'"]});\nreturn [a.output, b.output];` });
  const first = await s.started(single);
  await s.started(chain);
  await s.send("drain", { origin: ORIGIN, fence: true });
  await s.until(() => s.ledger().some(e => e.type === "drain"), "drain recorded");
  assert.ok((await tagged(String(first.id))).length > 0, "not fenced");
  const result = await s.sealed(single);
  assert.equal(result.status, "ok");
  assert.equal(result.output, "single\n");
  const finished = await s.until(() => s.journal(single).find(e => e.type === JT.attention && (e.item as { id: string }).id === `finished:${single}`), "finished notice");
  assert.equal((finished.item as { kind: string }).kind, "finished");
  const a = await s.sealed(chain, "a");
  assert.equal(a.status, "ok");
  await delay(1000);
  assert.ok(!existsSync(marker), "a held workflow starts nothing after the command");
  assert.ok(!s.journal(chain).some(e => e.type === "command-intent" && String(e.call).includes("/b@")));
  // Both seals came from the first orchestrator: with its workflows held and a 300 ms idle exit, it stayed while it
  // watched the commands.
  assert.equal(s.ledger().filter(e => e.type === "orchestrator").length, 1);
  const exit = s.ledger().find(e => e.type === "orchestrator-exit");
  const seals = [...of(s.journal(single), JT.sealed), ...of(s.journal(chain), JT.sealed)];
  assert.ok(!exit || seals.every(e => e.ts <= exit.ts), "sealed before any idle exit");
  // The session comes back: resume releases the held step.
  await s.stop(); s.start();
  await s.send("resume", { origin: ORIGIN });
  const done = await s.until(() => s.journal(chain).find(e => e.type === JT.done), "chain done after resume");
  assert.equal(done.status, "done", JSON.stringify(done));
  assert.ok(existsSync(marker));
});

test("command call: writer:true takes the writer lock (one at a time); without it commands run side by side", { timeout: 60_000 }, async t => {
  const s = await stack(t);
  const step = (file: string, writer?: boolean) => ({ command: ["sh", "-c", `echo s >> '${file}'; sleep 1; echo e >> '${file}'`], ...(writer ? { writer } : {}) });
  const locked = join(s.root, "locked"), free = join(s.root, "free");
  await mkdir(join(s.cwd, "other"), { recursive: true });
  const a = await s.run({ tasks: [step(locked, true), step(locked, true)] });
  const b = await s.run({ tasks: [{ ...step(free), cwd: "other" }, { ...step(free), cwd: "other" }] });
  for (const wid of [a, b]) await s.until(() => s.journal(wid).find(e => e.type === JT.done), `done ${wid}`);
  assert.equal(readFileSync(locked, "utf8"), "s\ne\ns\ne\n");
  assert.equal(readFileSync(free, "utf8"), "s\ns\ne\ne\n");
  assert.equal(s.ledger().filter(e => e.type === "writer-hold").length, 2);
  assert.equal(s.ledger().filter(e => e.type === "writer-release").length, 2);
});

test("command call: a revision retires it and ends its process tree", { timeout: 60_000 }, async t => {
  const s = await stack(t);
  const wid = await s.run({ source: `return (await runs.run("a", {command: "sleep 60"})).status;` });
  const first = await s.started(wid);
  await s.send("revise", { wid, source: "return 1;" });
  const done = await s.until(() => s.journal(wid).find(e => e.type === JT.done), "revised workflow done");
  assert.equal(done.status, "done", JSON.stringify(done));
  await s.until(async () => (await tagged(String(first.id))).length === 0, "process ended");
  assert.ok(s.journal(wid).some(e => e.type === "retired" && e.call === first.call));
  assert.ok(!s.journal(wid).some(e => e.type === JT.sealed && e.call === first.call));
});
