// Run with DSA_HOME=<home> node scripts/bench-ui.ts --owner=main:<pi session id> [--refreshes=20] [--every-ms=500]
// What a pi session's main thread pays for durable-subagents state, read-only against an existing home (nothing is
// written, no lock is taken, no orchestrator is started). Each part runs in a fresh process, so every "cold" number
// starts with empty caches:
//   ui     the UI poll: the first UiData.refresh (plus the list filter/order the UI applies), then --refreshes more at
//          --every-ms like the UI timer, with their p50/max, the event-loop delay p99 during them
//          (perf_hooks.monitorEventLoopDelay) and the process RSS after them.
//   start  the session-start path: the starter's pending-work decision (an orchestrator holding its lock means no scan;
//          without one, the scan for an unfinished workflow) and the paused-workflows notice for this session.
// The script runs against either tree: without `ownWorkflows` (before the pi process read only its own workflows) it
// times what that tree did: refresh() of every workflow, the scan before the lock check, and statusView.
import { spawnSync } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { dsaHome } from "../src/paths.ts";

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const owner = arg("owner"), part = arg("part"), refreshes = Number(arg("refreshes") ?? 20), every = Number(arg("every-ms") ?? 500);
if (!owner?.startsWith("main:")) throw new Error("--owner=main:<pi session id> is required");
const home = dsaHome();
// Measurement may read a live home, but its rebuildable caches always belong to this measurement.
const requestedCache = arg("cache-home") ?? process.env.DSA_CACHE_HOME;
const cacheHome = requestedCache ?? mkdtempSync(join(tmpdir(), "dsa-reader-cache-"));
process.env.DSA_CACHE_HOME = cacheHome;
if (!requestedCache) process.once("exit", () => rmSync(cacheHome, { recursive: true, force: true }));
const ms = (t: number) => Math.round(t * 10) / 10;
const mib = (bytes: number) => Math.round(bytes / 1048576);

if (part === "ui") {
  const { UiData } = await import("../src/ui/data.ts");
  const { orderWorkflows } = await import("../src/ui/view.ts");
  const snapshot = await import("../src/orchestrator/snapshot.ts") as Record<string, unknown>;
  const own = typeof snapshot.ownWorkflows === "function";
  const data = new UiData(home);
  let revision: unknown;
  const refresh = () => {
    const next = (data.refresh as (owner?: string) => unknown)(own ? owner : undefined);
    // Older trees return void and order in the caller; identity-returning readers already provide the ordered view.
    if (next === undefined) data.workflows = orderWorkflows(data.workflows, owner);
    revision = next;
  };
  let t = performance.now(); refresh(); const cold = performance.now() - t;
  const shown = data.workflows.length;
  const times: number[] = [], loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  for (let i = 0; i < refreshes; i++) { await delay(every); t = performance.now(); refresh(); times.push(performance.now() - t); }
  loop.disable();
  const rss = process.memoryUsage().rss;
  // Those refreshes also warm the history (finished sessions read a slice at a time). Once it is all read, the
  // steady state of a long-running session: --refreshes more.
  const calls = () => data.workflows.reduce((n, w) => n + w.calls.length, 0);
  const warmStart = performance.now();
  while (data.facts.size < calls() && performance.now() - warmStart < 600_000) { await delay(10); refresh(); }
  const warmup = performance.now() - warmStart, steady: number[] = [], steadyLoop = monitorEventLoopDelay({ resolution: 1 });
  // With --expose-gc, measure a long-lived process after released history has been collected too.
  globalThis.gc?.();
  const cpu = process.cpuUsage();
  steadyLoop.enable();
  for (let i = 0; i < refreshes; i++) { await delay(every); t = performance.now(); refresh(); steady.push(performance.now() - t); }
  steadyLoop.disable();
  const p50 = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const spent = process.cpuUsage(cpu);
  globalThis.gc?.();
  const memory = process.memoryUsage();
  console.log(JSON.stringify({ part, tree: own ? "own" : "all", workflows: shown, loadAverage: loadavg(), gc: !!globalThis.gc, coldMs: ms(cold), warmP50Ms: ms(p50(times)),
    warmMaxMs: ms(times.at(-1) ?? 0), loopP99Ms: ms(loop.percentile(99) / 1e6), rssMiB: mib(rss),
    historyReadMs: ms(warmup), steadyP50Ms: ms(p50(steady)), steadyMaxMs: ms(steady.at(-1) ?? 0), steadyLoopP99Ms: ms(steadyLoop.percentile(99) / 1e6),
    steadyRssMiB: mib(memory.rss), steadyHeapMiB: mib(memory.heapUsed), steadyExternalMiB: mib(memory.external), steadyCpuMs: ms((spent.user + spent.system) / 1000), retainedTranscripts: data.sessions.size, identityView: revision !== undefined }));
} else if (part === "start") {
  const snapshot = await import("../src/orchestrator/snapshot.ts") as Record<string, unknown> & typeof import("../src/orchestrator/snapshot.ts");
  const { unfinishedWorkflow } = await import("../src/agent/main/snapshots.ts");
  const own = typeof snapshot.ownWorkflows === "function";
  // Read-only stand-in for the lock probe: the ledger's running orchestrator whose process lives (the lock itself is
  // not touched, so a starting orchestrator never finds it taken by this script).
  let t = performance.now();
  const running = snapshot.runningOrchestrator(home).orchestrator !== undefined;
  // Before: the scan ran before the lock check; now only when no orchestrator runs.
  const scanned = !own || !running;
  const pending = scanned ? unfinishedWorkflow(home) : undefined;
  const starterMs = performance.now() - t;
  t = performance.now();
  const paused = own
    ? (snapshot.ownWorkflows as (h: string, o: string, opts: { started: boolean }) => ReturnType<typeof snapshot.allWorkflows>)(home, owner, { started: true }).filter(w => w.origin === owner && snapshot.isLive(w) && w.paused).length
    : snapshot.statusView(home, { origin: owner }).workflows.filter(w => w.origin === owner && snapshot.isLive(w) && w.paused).length;
  const noticeMs = performance.now() - t;
  console.log(JSON.stringify({ part, tree: own ? "own" : "all", orchestratorRunning: running, scanned, ...(pending !== undefined ? { pending } : {}),
    starterMs: ms(starterMs), noticeMs: ms(noticeMs), totalMs: ms(starterMs + noticeMs), paused, rssMiB: mib(process.memoryUsage().rss) }));
} else {
  const self = fileURLToPath(import.meta.url);
  for (const p of ["ui", "start"]) {
    const run = spawnSync(process.execPath, [...process.execArgv, self, `--part=${p}`, ...process.argv.slice(2)], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", timeout: 660_000, env: process.env });
    if (run.status !== 0) { process.exitCode = run.status ?? 1; break; }
    process.stdout.write(run.stdout);
  }
}
