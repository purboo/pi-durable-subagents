// `drill failover`: rehearse pool failover on this machine without a real outage. Everything runs in a temporary
// root: its own DSA_HOME, HOME and pi agent dir, the real CLI (as a child process), the real orchestrator it starts,
// real subagent pi processes and two offline providers (provider.ts). The user's home, providers and credentials are
// never read: the child environment carries only PATH and the variables set here.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { readJournalSnapshot } from "../../kernel/journal.ts";
import { journalPath, orchLedger } from "../../paths.ts";
import { captureStart, ProcessTable } from "../../platform/proctable.ts";
import { Containment } from "../../platform/containment.ts";
import { JT } from "../../types.ts";

export interface DrillOptions { keep: boolean; json: boolean }
export interface DrillStep { step: number; name: string; ok: boolean; ms: number; detail: string }
export interface DrillReport { drill: "failover"; passed: boolean; steps: DrillStep[]; ms: number; probeMs: number; interrupted?: NodeJS.Signals; evidence?: string }

const A = "drill-a", B = "drill-b", POOL = "failover";
/** Steps 1-3 (about 5 s here) must finish before it; 25 s leaves room for a loaded or several times slower machine
 *  and keeps the drill well under a minute. Step 3 says so explicitly when the machine was too slow. */
export const DRILL_PROBE_MS = 25_000;
const STEPS = [
  `a pool call starts on ${A}, hits the used-up error, moves to ${B} and ends ok there`,
  `status lists ${A} as used up with its next probe time; describe/events show the move ${A} -> ${B}`,
  `a second call while ${A} is out starts directly on ${B}`,
  `${A} answers again; after the probe interval the next call probes it and it is marked available`,
  `the third call (the probe) starts on ${A} and ends ok there`,
];

/** Validate drill arguments before allocating a temporary root or starting anything. */
export function parseDrill(args: string[]): DrillOptions {
  if (args[0] !== "failover") throw new Error(`Invalid drill: ${args[0] ?? "(none)"}; use: drill failover [--keep] [--json]`);
  const options: DrillOptions = { keep: false, json: false }, seen = new Set<string>();
  for (const arg of args.slice(1)) {
    if (seen.has(arg)) throw new Error(`Repeated drill option: ${arg}`); seen.add(arg);
    if (arg === "--keep") options.keep = true;
    else if (arg === "--json") options.json = true;
    else throw new Error(`Invalid drill argument: ${arg}; use: drill failover [--keep] [--json]`);
  }
  return options;
}

const sibling = (name: string) => fileURLToPath(new URL(name + (import.meta.url.endsWith(".ts") ? ".ts" : ".js"), import.meta.url));
class StepFailure extends Error {}
const check = (ok: unknown, detail: string) => { if (!ok) throw new StepFailure(detail); };

/** Run the failover drill; exit code 0 only when every step passed. */
export async function drill(args: string[], inherited: NodeJS.ProcessEnv = process.env, write: (text: string) => void = console.log): Promise<number> {
  const options = parseDrill(args), started = performance.now();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsa-drill-")));
  const home = join(root, "dsa"), cwd = join(root, "work"), agent = join(root, "agent");
  for (const dir of [home, agent, join(root, "home"), join(cwd, ".pi/agents")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ extensions: [sibling("./provider")], defaultProvider: B, defaultModel: "m",
    // pi's retries stay on (a used-up window is noticed while pi retries, as on a real setup), with a short backoff.
    retry: { enabled: true, baseDelayMs: 200 }, compaction: { enabled: false }, defaultProjectTrust: "always" }));
  writeFileSync(join(cwd, ".pi/agents/worker.md"), "---\nname: worker\ndescription: Failover drill worker\ntools: bash\n---\nAnswer the task.\n");
  writeFileSync(join(home, "config.json"), JSON.stringify({ pools: { [POOL]: [`${A}/m`, `${B}/m`] }, k: { probeMs: DRILL_PROBE_MS } }));
  writeFileSync(join(root, "a-exhausted"), "");
  const env: NodeJS.ProcessEnv = { PATH: inherited.PATH, HOME: join(root, "home"), TMPDIR: root, PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", DSA_HOME: home, DSA_DRILL_ROOT: root };
  const entry = sibling("../main");

  const cli = (argv: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...argv], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { err += d; });
    child.once("error", reject); child.once("close", code => resolve({ code, out: out.trim(), err: err.trim() }));
  });
  const json = async (argv: string[]) => {
    const r = await cli([...argv, "--json"]);
    check(r.code === 0, `${argv.join(" ")} exited ${r.code}: ${r.err || r.out}`);
    return JSON.parse(r.out);
  };
  const requests = () => existsSync(join(root, "requests.log")) ? readFileSync(join(root, "requests.log"), "utf8").split("\n").filter(Boolean) : [];
  const ledger = () => readJournalSnapshot(orchLedger(home));
  const submit = async (id: string) => {
    const spec = join(root, `${id}.json`);
    writeFileSync(spec, JSON.stringify({ agent: "worker", task: "Answer briefly.", model: POOL }));
    const reply = await json(["run", "--request", id, "--spec", spec]);
    check(reply.created === true && reply.wid, `run ${id}: ${JSON.stringify(reply)}`);
    return String(reply.wid);
  };
  const sealed = async (id: string, ms = 60_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const d = await json(["describe", "--key", id]);
      if (d.state === "sealed") return d;
      check(Date.now() < end, `${id} did not finish within ${ms / 1000} s: ${JSON.stringify(d).slice(0, 400)}`);
      await delay(250);
    }
  };
  /** The models `events <wid>` reports the workflow's executions on (launch and switch). */
  const models = async (wid: string) => {
    const r = await cli(["events", wid, "--json"]);
    check(r.code === 0, `events ${wid} exited ${r.code}: ${r.err}`);
    return r.out.split("\n").filter(Boolean).map(l => JSON.parse(l)).filter((e: { event: string }) => e.event === "model").map((e: { model: string }) => e.model);
  };
  const statusLine = async () => ((await json(["status"])).exhausted ?? []).find((l: string) => l.startsWith(`${A} `)) as string | undefined;
  const call = (d: any) => d.calls?.[0] ?? {};
  const summary = (d: any) => `status ${d.status}, call ${call(d).status} on ${call(d).model}, output ${JSON.stringify(call(d).output)}${call(d).error ? `, error ${JSON.stringify(String(call(d).error).slice(0, 200))}` : ""}`;

  const steps: DrillStep[] = [];
  let failed = false;
  const step = async (n: number, run: () => Promise<string>) => {
    const t0 = performance.now();
    if (failed) { steps.push({ step: n, name: STEPS[n - 1]!, ok: false, ms: 0, detail: "not run: an earlier step failed" }); return; }
    try { steps.push({ step: n, name: STEPS[n - 1]!, ok: true, ms: Math.round(performance.now() - t0), detail: await run() }); }
    catch (error) { failed = true; steps.push({ step: n, name: STEPS[n - 1]!, ok: false, ms: Math.round(performance.now() - t0), detail: error instanceof Error ? error.message : String(error) }); }
    steps.at(-1)!.ms = Math.round(performance.now() - t0);
    if (!options.json) { const s = steps.at(-1)!; write(`  ${s.step}. ${s.ok ? "pass" : "FAIL"} ${(s.ms / 1000).toFixed(1).padStart(5)} s  ${s.name}\n${" ".repeat(16)}${s.detail}`); }
  };

  let first: any, firstWid = "", nextTry = 0, before2 = 0, wid3 = "";
  // An interrupted drill cleans up as a finished one: stop its orchestrator, fence what its calls left, and remove the
  // root (with --keep, print it). The handlers are removed when the drill ends.
  let stopping = false;
  const interrupted = (signal: NodeJS.Signals) => {
    if (stopping) return; stopping = true;
    void (async () => {
      try { await cleanup(home); } catch (error) { write(`  cleanup after ${signal} failed: ${String(error)}`); }
      if (!options.keep) rmSync(root, { recursive: true, force: true });
      if (options.json) write(JSON.stringify({ drill: "failover", passed: false, interrupted: signal, steps, ms: Math.round(performance.now() - started), probeMs: DRILL_PROBE_MS, ...(options.keep ? { evidence: root } : {}) }));
      else { if (options.keep) write(`  kept: ${root}`); write(`failover drill: interrupted by ${signal}`); }
      process.exit(signal === "SIGINT" ? 130 : 143);
    })();
  };
  const onInt = () => interrupted("SIGINT"), onTerm = () => interrupted("SIGTERM");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  try {
    if (!options.json) write(`failover drill (isolated home ${home}, probe interval ${DRILL_PROBE_MS / 1000} s)`);
    await step(1, async () => {
      firstWid = await submit("drill-1");
      first = await sealed("drill-1", 90_000);
      check(first.status === "done" && call(first).status === "ok" && call(first).ok === true, summary(first));
      check(call(first).model === `${B}/m` && call(first).output === `answered by ${B}`, `expected to end on ${B}/m: ${summary(first)}`);
      const log = requests();
      check(log[0] === A && log.at(-1) === B && !log.slice(log.indexOf(B)).includes(A), `provider requests: ${log.join(",")}`);
      const x = ledger().find(e => e.type === "provider-exhausted" && e.provider === A);
      check(x, `no provider-exhausted entry for ${A} in the orchestrator ledger`);
      nextTry = Number(x!.nextTry);
      return `requests ${log.join(" -> ")}; ${summary(first)}`;
    });
    await step(2, async () => {
      const text = await cli(["status"]);
      check(text.code === 0, `status exited ${text.code}: ${text.err}`);
      const line = text.out.split("\n").find(l => l.startsWith(`${A} exhausted`));
      check(line && /No available accounts/.test(line) && /next try in \d+s$/.test(line), `status does not list ${A} as used up with a next try:\n${text.out}`);
      check(!text.out.split("\n").some(l => l.startsWith(`${B} exhausted`)), `status lists ${B} as used up:\n${text.out}`);
      // `events` shows the launch on A and the model switch delivered to the running call; describe shows where it ended.
      const r = await cli(["events", firstWid, "--json"]);
      check(r.code === 0, `events ${firstWid} exited ${r.code}: ${r.err}`);
      const events = r.out.split("\n").filter(Boolean).map(l => JSON.parse(l));
      const launched = events.filter(e => e.event === "model").map(e => e.model);
      const forward = events.find(e => e.event === "forward" && e.kind === "model");
      check(forward?.model === `${B}/m` && forward.failover === A, `events show no failover ${A} -> ${B}/m: ${JSON.stringify(forward ?? null)}`);
      const delivered = forward && events.find(e => e.event === "delivered" && e.kind === "model" && e.rid === forward.rid);
      check(launched.length === 1 && launched[0] === `${A}/m`, `events show launches on ${launched.join(", ") || "(none)"}`);
      check(delivered, `events show no model switch delivered to the call: ${events.map(e => e.event).join(" ")}`);
      const d = await json(["describe", firstWid]);
      check(d.calls?.length === 1 && call(d).model === `${B}/m`, `describe ${firstWid}: ${summary(d)}`);
      return `status: ${line}; events: launched on ${launched[0]}, failover from ${forward.failover} to ${forward.model} (#${forward.seq}, delivered #${delivered.seq})`;
    });
    await step(3, async () => {
      before2 = requests().length;
      const wid = await submit("drill-2"), d = await sealed("drill-2");
      check(d.status === "done" && call(d).status === "ok" && call(d).model === `${B}/m`, summary(d));
      const launched = await models(wid), log = requests().slice(before2);
      const admitted = readJournalSnapshot(journalPath(home, wid)).find(e => e.type === "selected");
      check(admitted && Number(admitted.ts) < nextTry, `the second call was admitted after ${A}'s next try; this machine is too slow for the ${DRILL_PROBE_MS / 1000} s probe interval`);
      check(launched.length === 1 && launched[0] === `${B}/m`, `events show models ${launched.join(", ")}`);
      check(log.length > 0 && log.every(p => p === B), `provider requests during the second call: ${log.join(",")}`);
      check(await statusLine(), `${A} no longer listed as used up before its next try`);
      return `events: ${launched.join(" -> ")}; requests ${log.join(", ")}; ${A} still used up`;
    });
    await step(4, async () => {
      unlinkSync(join(root, "a-exhausted"));
      while (Date.now() < nextTry + 100) await delay(Math.min(500, Math.max(10, nextTry + 100 - Date.now())));
      const due = await statusLine();
      check(due && /next call probes it$/.test(due), `after the probe interval status says: ${due ?? "(not listed)"}`);
      const n = requests().length;
      wid3 = await submit("drill-3");
      const end = Date.now() + 60_000;
      let probe: any, available: any;
      while (!(probe && available) && Date.now() < end) {
        const entries = ledger();
        probe = entries.find(e => e.type === "provider-probe" && e.provider === A && String(e.exec).startsWith(wid3));
        available = entries.find(e => e.type === "provider-available" && e.provider === A);
        if (!(probe && available)) await delay(200);
      }
      check(probe, `the third call was not admitted to ${A} as its probe (requests since: ${requests().slice(n).join(",")})`);
      check(available, `${A} was probed but not marked available (requests since: ${requests().slice(n).join(",")})`);
      const after = await statusLine();
      check(!after, `status still lists ${A}: ${after}`);
      return `status before: ${due}; probe by ${String(probe.exec).split("#")[0]}; ${A} available ${Math.round((Number(available.ts) - nextTry) / 100) / 10} s after its next try`;
    });
    await step(5, async () => {
      const n = requests().length, d = await sealed("drill-3");
      check(d.status === "done" && call(d).status === "ok" && call(d).model === `${A}/m` && call(d).output === `answered by ${A}`, summary(d));
      const launched = await models(wid3);
      check(launched.length === 1 && launched[0] === `${A}/m`, `events show models ${launched.join(", ")}`);
      check(!requests().slice(n).includes(B), `${B} received a request during the third call: ${requests().join(",")}`);
      return `events: ${launched.join(" -> ")}; ${summary(d)}`;
    });
  } finally {
    if (stopping) await new Promise(() => {}); // the signal handler owns cleanup and exits
    process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm);
    await cleanup(home);
  }

  const passed = steps.length === STEPS.length && steps.every(s => s.ok), ms = Math.round(performance.now() - started);
  const report: DrillReport = { drill: "failover", passed, steps, ms, probeMs: DRILL_PROBE_MS, ...(options.keep ? { evidence: root } : {}) };
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
  if (options.json) write(JSON.stringify(report));
  else {
    if (options.keep) write(`  kept: ${root}`);
    write(`failover drill: ${passed ? "pass" : "FAILED"} (${steps.filter(s => s.ok).length}/${STEPS.length} steps, ${(ms / 1000).toFixed(1)} s)${passed || options.keep ? "" : "; rerun with --keep to retain the evidence"}`);
  }
  if (!options.keep) rmSync(root, { recursive: true, force: true });
  return passed ? 0 : 1;
}

/** Stop every orchestrator started on the drill's home and fence any process its executions left. */
async function cleanup(home: string): Promise<void> {
  const ledger = () => readJournalSnapshot(orchLedger(home));
  const hosts = ledger().filter(e => e.type === "orchestrator" && e.pid).map(e => ({ pid: Number(e.pid), start: e.start ? String(e.start) : undefined }));
  const same = async (h: { pid: number; start?: string }) => { const now = await captureStart(h.pid); return now !== "" && (h.start === undefined || now === h.start); };
  for (const h of hosts) if (await same(h)) { try { process.kill(h.pid, "SIGTERM"); } catch {} }
  const end = Date.now() + 15_000;
  for (const h of hosts) {
    while (await same(h) && Date.now() < end) await delay(100);
    if (await same(h)) { try { process.kill(h.pid, "SIGKILL"); } catch {} }
  }
  const containment = new Containment(new ProcessTable());
  for (const created of ledger().filter(e => e.type === JT.created)) {
    const journal = readJournalSnapshot(journalPath(home, String(created.wid)));
    for (const exec of journal.filter(e => e.type === JT.exec))
      await containment.fence(String(exec.exec), journal.filter(e => e.type === "tracked" && e.exec === exec.exec).map(e => ({ pid: Number(e.pid), ppid: 0, start: String(e.start) })));
  }
}
