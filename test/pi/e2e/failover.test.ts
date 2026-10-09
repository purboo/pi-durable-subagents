// End-to-end provider failover through the public surface: the real CLI, a detached orchestrator in an isolated temp
// home (HOME, DSA_HOME, agent dir under one root), child pi with faux providers whose first one answers like a gateway
// whose usage window is used up. The pool is configured in config.json as a user does; pi keeps its default retries.
// Assertions read only CLI outputs (run, describe, status, events) and the faux providers' own request log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { FAUX, REPO, tempRoot } from "../../harness/pi.ts";
import { orchLedger } from "../../../src/paths.ts";
import { readJournalSnapshot } from "../../../src/kernel/journal.ts";

const CLI = join(REPO, "src/cli/main.ts");
const QUOTA = fileURLToPath(new URL("../executor/quota-providers.ts", import.meta.url));
type Result = { code: number | null; out: string; err: string };

test("E2E failover: a pool run on a used-up provider finishes on the next candidate; status lists it; the next run starts there", { timeout: 180_000 }, async t => {
  const root = tempRoot("dsa-e2e-failover-"), home = join(root, "dsa"), cwd = join(root, "work"), agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi/agents"), { recursive: true }); await mkdir(agentDir, { recursive: true }); await mkdir(home, { recursive: true });
  // pi's settings as a user has them: no retry override (pi's default retries apply).
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [FAUX, QUOTA], defaultProvider: "probe", defaultModel: "scripted" }));
  await writeFile(join(cwd, ".pi/agents/worker.md"), "---\nname: worker\ndescription: worker\ntools: bash\n---\nYou work.\n");
  await writeFile(join(home, "config.json"), JSON.stringify({ pools: { top: ["qa/m", "qb/m"] } }));
  await writeFile(join(root, "qa-exhausted"), ""); // qa refuses every request with `503 … No available accounts`
  const env: NodeJS.ProcessEnv = { PATH: `${join(REPO, "node_modules/.bin")}:${process.env.PATH}`, HOME: root, DSA_HOME: home,
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PROBE_DIR: root };
  const cli = (args: string[]) => new Promise<Result>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { err += d; });
    child.once("error", reject); child.once("close", code => resolve({ code, out: out.trim(), err: err.trim() }));
  });
  const json = async (args: string[]) => { const r = await cli([...args, "--json"]); assert.equal(r.code, 0, `${args.join(" ")}: ${r.out} ${r.err}`); return JSON.parse(r.out); };
  // Only orchestrators started on this temp home are signalled.
  const pids = () => readJournalSnapshot(orchLedger(home)).filter(e => e.type === "orchestrator").map(e => Number(e.pid));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(async () => {
    for (const pid of pids()) if (alive(pid)) process.kill(pid, "SIGTERM");
    const end = Date.now() + 15_000;
    while (pids().some(alive) && Date.now() < end) await delay(100);
    for (const pid of pids()) if (alive(pid)) process.kill(pid, "SIGKILL");
    if (process.env.DSA_KEEP) t.diagnostic(`kept: ${root}`); else await rm(root, { recursive: true, force: true });
  });
  const requests = async () => (await readFile(join(root, "quota.log"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  const run = async (id: string) => {
    const spec = join(root, `${id}.json`);
    await writeFile(spec, JSON.stringify({ agent: "worker", task: "work", model: "top" }));
    const reply = await json(["run", "--request", id, "--spec", spec]);
    assert.equal(reply.created, true);
    const end = Date.now() + 90_000;
    for (;;) {
      const d = await json(["describe", "--key", id]);
      if (d.state === "sealed") return d;
      if (Date.now() > end) throw new Error(`${id} did not seal: ${JSON.stringify(d)}`);
      await delay(250);
    }
  };
  /** The models `events <wid>` reports the workflow's executions launched on. */
  const models = async (wid: string) => {
    const r = await cli(["events", wid, "--json"]);
    assert.equal(r.code, 0, r.err);
    return r.out.split("\n").filter(Boolean).map(l => JSON.parse(l)).filter((e: { event: string }) => e.event === "model").map((e: { model: string }) => e.model);
  };

  const first = await run("failover-1");
  assert.equal(first.status, "done", JSON.stringify(first));
  assert.equal(first.calls.length, 1);
  assert.deepEqual([first.calls[0].status, first.calls[0].ok, first.calls[0].output, first.calls[0].model], ["ok", true, "answered by qb", "qb/m"], JSON.stringify(first.calls[0]));
  assert.equal(first.lastFence, undefined, "a used-up window is not reported as a cut-off execution");
  const firstModels = await models(first.wid);
  assert.equal(firstModels[0], "qa/m", `the call launched on the pool's first candidate: ${firstModels}`);
  const log1 = await requests();
  assert.equal(log1[0], "qa"); assert.equal(log1.at(-1), "qb", log1.join(","));
  assert.ok(!log1.slice(log1.indexOf("qb")).includes("qa"), `no request goes back to qa once the call moved: ${log1}`);

  // status (text and JSON) lists the used-up provider with its next try, and the call on the model it finished on.
  const text = await cli(["status"]);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /^qa exhausted since \d+s ago \(503 .*No available accounts.*\), next try in 1[45]m$/m, text.out);
  assert.match(text.out, /^ {2}\S+@1 ok qb\/m /m, text.out);
  assert.doesNotMatch(text.out, /^qb exhausted/m);
  const view = await json(["status"]);
  assert.equal(view.exhausted?.length, 1, JSON.stringify(view.exhausted)); assert.match(view.exhausted[0], /^qa exhausted /);

  // A second run on the pool starts directly on qb: qa gets no request before its next try.
  const second = await run("failover-2");
  assert.deepEqual([second.status, second.calls[0].status, second.calls[0].output, second.calls[0].model], ["done", "ok", "answered by qb", "qb/m"], JSON.stringify(second));
  assert.deepEqual(await models(second.wid), ["qb/m"], "launched on qb, no switch");
  assert.deepEqual((await requests()).slice(log1.length), ["qb"], "the second run sent one request, to qb");
  assert.match((await cli(["status"])).out, /^qa exhausted /m, "qa stays used up until its next try");
});
