// First failing stage of a real-pi e2e case, with the state that explains it. The smallest cases run first and each
// stage is bounded; a stage that fails is summarised from its own temp root (orchestrator ledger, per-workflow journals,
// the orchestrator's DSA_ORCHESTRATOR_LOG) before the run continues, so one job captures the first failure and its
// neighbours. Everything is printed redacted: temp paths are shortened, credential-looking values are masked.
//   node scripts/diagnose-e2e.mjs [stage ...]        stages: chaos (default first), drill, events; no stage = all
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { setEnvPath, withBinPath } from "./lib/platform.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(REPO, "node_modules", ".bin");
const root = mkdtempSync(join(tmpdir(), "dsa-diag-"));
const STAGES = {
  // The single smallest real-pi case: one offline chaos scenario through the public CLI.
  chaos: { command: process.execPath, args: [join(REPO, "src/cli/main.ts"), "chaos", "--scenario", "3", "--keep"], ms: 180_000 },
  // The public failover drill: five steps on real orchestrator, real subagents and two offline providers.
  drill: { command: process.execPath, args: [join(REPO, "src/cli/main.ts"), "drill", "failover", "--keep", "--json"], ms: 240_000 },
  // The event log through the real CLI and a detached orchestrator (four cases, the first is the smallest).
  events: { command: process.execPath, args: ["--test", "--test-concurrency=1", join(REPO, "test/pi/e2e/events.test.ts")], ms: 420_000 },
};
const wanted = process.argv.slice(2).filter(a => !a.startsWith("-"));
const stages = (wanted.length ? wanted : Object.keys(STAGES)).map(name => {
  if (!STAGES[name]) { console.error(`unknown stage ${name}; use: ${Object.keys(STAGES).join(", ")}`); process.exit(2); }
  return name;
});

const clip = (value, n) => { const text = typeof value === "string" ? value : JSON.stringify(value); return text.length > n ? `${text.slice(0, n)}…` : text; };
/** Credential-looking values never reach the log, and temp paths are shortened to the diag root. */
function redact(text) {
  return String(text)
    .replace(new RegExp(escape(root), "g"), "<diag>")
    .replace(/((?:api[_-]?key|token|secret|password)"?\s*[:=]\s*"?)[A-Za-z0-9_\-.]{8,}/gi, "$1<redacted>")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, m => (/^[0-9a-f]{16}:\d+$/.test(m) ? m : "<id>"));
}
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Journal, ledger and event-log lines are framed `<crc32 8 hex> <json>`; a torn or unframed line is skipped. */
function jsonl(file) {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap(line => {
      const framed = /^[0-9a-f]{8} (.*)$/.exec(line);
      if (!framed) return [];
      try { return [JSON.parse(framed[1])]; } catch { return []; }
    });
  } catch { return []; }
}
function tail(file, lines) {
  try { return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines); } catch { return []; }
}
/** Every DSA home under the diag root (each case makes its own temp root with a `dsa` state directory). */
function homes(dir, depth = 0) {
  if (depth > 4) return [];
  const found = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  for (const name of names) {
    const path = join(dir, name);
    try { if (!statSync(path).isDirectory()) continue; } catch { continue; }
    if (name === "dsa" || existsSync(join(path, "orchestrator.jsonl"))) found.push(path);
    else found.push(...homes(path, depth + 1));
  }
  return found;
}
const short = path => relative(root, path) || ".";

/** What the ledger and journals say happened: the orchestrator's start, recovery and exit, then each workflow's tail. */
function state(home) {
  const ledger = jsonl(join(home, "orchestrator.jsonl"));
  const of = type => ledger.filter(e => e.type === type);
  const started = of("orchestrator").at(-1), recovered = of("recovered").at(-1), exited = of("orchestrator-exit").at(-1);
  const exhausted = ledger.filter(e => e.type === "provider-exhausted").map(e => `${e.provider} (next try ${Math.round((Number(e.nextTry) - Date.now()) / 1000)}s)`);
  const workflows = [];
  let wids = [];
  try { wids = readdirSync(join(home, "w")); } catch { /* no workflow yet */ }
  for (const wid of wids) {
    const entries = jsonl(join(home, "w", wid, "journal.jsonl"));
    if (!entries.length) continue;
    const kinds = entries.map(e => e.type === "call" ? `call:${e.key ?? "?"}@${e.gen ?? "?"}` : e.type === "sealed" ? `sealed:${(e.result ?? {}).status ?? "?"}` : e.type);
    workflows.push({ wid, count: entries.length, last: kinds.slice(-12), tail: entries.slice(-4).map(e => `${e.type} ${clip(e.reason ?? e.error ?? (e.result ?? {}).error ?? "", 120)}`) });
  }
  return { started, recovered, exited, exhausted, workflows };
}
function verdict(s) {
  if (!s.started) return "no `orchestrator` entry: the detached orchestrator never recorded a start (it never launched, could not take its lock, or crashed before its first append) — see the orchestrator log";
  if (!s.recovered) return "the orchestrator recorded its start but never finished recovery (no `recovered` entry): it hung or died in recovery";
  if (s.exited?.reason === "error") return `the orchestrator exited with an error: ${clip(String(s.exited.error ?? ""), 300)}`;
  if (s.exited) return `the orchestrator exited (reason ${s.exited.reason}) after recovery — the workflow below stopped, not the orchestrator`;
  return "the orchestrator was still recorded as running when the stage ended: the workflow below stopped";
}
function report(name, code, ms, out, stageRoot) {
  console.log(`\n===== ${name}: ${code === 0 ? "passed" : `FAILED (exit ${code})`} in ${ms} ms =====`);
  const kept = [...out.matchAll(/^\s*kept: (.+)$/gm)].map(m => m[1].trim());
  for (const line of kept) console.log(`kept: ${redact(line)}`);
  if (code === 0) return true;
  const found = homes(stageRoot);
  if (!found.length) console.log("no DSA home was left under the diag root: the stage failed before it created state");
  for (const home of found) {
    const s = state(home);
    console.log(`\n-- home ${short(home)}`);
    console.log(`   orchestrator: ${s.started ? `version ${clip(s.started.version, 20)}, pid ${s.started.pid}, pi ${clip(s.started.pi ?? "(none)", 80)}` : "(no start recorded)"}`);
    console.log(`   recovery: ${s.recovered ? `${s.recovered.ms} ms` : "(none recorded)"}`);
    console.log(`   exit: ${s.exited ? `${s.exited.reason}${s.exited.error ? `: ${clip(String(s.exited.error), 300)}` : ""}` : "(none recorded)"}`);
    if (s.exhausted.length) console.log(`   provider-exhausted: ${s.exhausted.join(", ")}`);
    for (const wf of s.workflows) {
      console.log(`   workflow ${wf.wid}: ${wf.count} entries, last ${wf.last.join(" → ")}`);
      for (const line of wf.tail) if (line.trim().length > 6) console.log(`     ${clip(line, 200)}`);
    }
    const log = join(home, "..", "orchestrator.log");
    for (const line of tail(log, 30)) console.log(`   log | ${clip(redact(line), 300)}`);
    for (const extra of ["host-errors.log", "pi-stderr.log", "readiness.jsonl", "pi-startup-retries.jsonl"])
      for (const line of tail(join(home, "..", extra), 10)) console.log(`   ${extra} | ${clip(redact(line), 300)}`);
    console.log(`   verdict: ${clip(verdict(s), 500)}`);
  }
  return false;
}

const env = setEnvPath({ ...process.env, TMPDIR: root, TEMP: root, TMP: root, DSA_KEEP: "1" }, withBinPath(BIN, process.platform, process.env.PATH ?? ""));
let failed = [];
for (const name of stages) {
  const stage = STAGES[name], started = Date.now();
  const stageRoot = mkdtempSync(join(root, `${name}-`));
  const run = spawnSync(stage.command, stage.args, { cwd: REPO, env: { ...env, TMPDIR: stageRoot, TEMP: stageRoot, TMP: stageRoot }, encoding: "utf8", timeout: stage.ms, maxBuffer: 32 * 1024 * 1024 });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`, ms = Date.now() - started;
  if (out) console.log(redact(out.trimEnd()));
  if (run.error) console.log(`stage ${name}: ${run.error.message}`);
  if (!report(name, run.status ?? 1, ms, out, stageRoot)) failed.push(name);
}
console.log(`\nstages: ${stages.map(n => `${n} ${failed.includes(n) ? "FAILED" : "ok"}`).join(", ")}`);
if (failed.length) console.log(`first failing stage: ${failed[0]}`);
else console.log("every stage passed");
process.exit(failed.length ? 1 : 0);
