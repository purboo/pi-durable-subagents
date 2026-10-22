import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { binDir, dsaHome, orchLedger, orchLock } from '../paths.ts';
import { removeStaleTemps, writeShim } from '../platform/lease.ts';
import { launchOrchestrator, PER_CALL_ENV, resolvePi } from '../platform/launch.ts';
import { openJournal } from '../kernel/journal.ts';
import { OsLock } from '../platform/lock.ts';
import { captureStart } from '../platform/proctable.ts';
import type { Executor, Ledgers, OrchestratorConfig } from './contract.ts';
import { Engine, type EngineOptions } from './engine.ts';
import { configPath, configProblem, configStamp, recordConfig, stampedConfig, watchConfig } from './config.ts';
import { CAPTURE_RETENTION_MS, pruneCaptures } from '../agent/exact/capture.ts';
import { packageVersion } from '../version.ts';

export interface MainOptions extends EngineOptions {
  home?: string;
  config?: OrchestratorConfig;
  executor?: (ledgers: Ledgers, options?: { pi?: string }) => Executor;
  /** Aborted to stop it; a string reason is the signal's name, recorded in `orchestrator-exit`. */
  signal?: AbortSignal;
}

/** Why an orchestrator ended (`orchestrator-exit`): no work for the idle-exit time, an applied restart request, a signal
 *  (or another abort), or an error. A process killed outright (SIGKILL, a crash) records nothing. */
export type ExitReason = { reason: 'idle' | 'restart' | 'signal' | 'error'; signal?: string; error?: string };

/** P2, C4, K6: Acquire the single authority before opening ledgers, recover, and idle-exit. Resolves `restart` when an
 *  applied restart request ended it (the caller starts the successor once the lock is released). */
export async function main(options: MainOptions = {}): Promise<{ restart?: true }> {
  // Serves every session: whichever pi session started it, its children and their CLI runs must not name that session.
  // Nor any call's identity, should it have been started from inside one (its processes inherit this environment).
  for (const name of PER_CALL_ENV) delete process.env[name];
  const home = options.home ?? dsaHome();
  await mkdir(home, { recursive: true });
  const lock = await new OsLock().tryAcquire(orchLock(home));
  if (!lock) return {};
  let engine: Engine | undefined, ledgers: Ledgers | undefined, watcher: ReturnType<typeof watchConfig> | undefined;
  let exit: ExitReason = { reason: 'error', error: 'ended before its loop' };
  try {
    let config = options.config, stamp: string | undefined;
    if (!config) {
      // One read gives both the version and the settings: with two, a file changed and changed back in between kept
      // the second version in effect while the watcher saw no change.
      stamp = await configStamp(configPath(home));
      const raw = stampedConfig(stamp);
      const problem = configProblem(raw);
      if (problem) console.error(`durable-subagents: config.json: ${problem}`);
      config = raw as OrchestratorConfig;
    }
    ledgers = { home, config, orch: await openJournal(orchLedger(home)) };
    // Which version runs is visible to every pi session (status; a notice when it differs from the one pi loaded).
    // `start` (Linux) tells this process from a later one given the same pid after a crash.
    const start = await captureStart(process.pid).catch(() => '');
    // Partial writes of earlier starts (a full disk, say): best effort, never fails the start.
    removeStaleTemps(binDir(home), 10 * 60_000);
    // Subagents reach `pi-durable-subagents hold …` through this shim, written before the start is recorded (executor puts its directory first on PATH).
    try { writeShim(binDir(home), process.execPath, fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../cli/main.ts' : '../cli/main.js', import.meta.url))); }
    catch (error) { console.error(`durable-subagents: cannot write ${binDir(home)}: ${String(error)}`); }
    // The pi subagents run: resolved once (an executable DSA_PI_BIN from the starter, else this PATH), not per launch from an inherited
    // PATH; null when there is none (each launch then runs a bare `pi`, and fails as an environment error until it works).
    const pi = resolvePi(process.env).path ?? resolvePi({ PATH: process.env.PATH }).path;
    if (!pi) console.error('durable-subagents: pi not found (DSA_PI_BIN unset or not executable, not on PATH); subagents launch `pi` from PATH');
    // `recovery: true` announces the `recovered` entry this pid appends once its recovery ends (none if it fails first).
    await ledgers.orch.append('orchestrator', { version: packageVersion(), pid: process.pid, ...(start ? { start } : {}), restart: true, pi: pi ?? null, recovery: true });
    const recoveryStarted = performance.now();
    const factory = options.executor ?? (await import(new URL(import.meta.url.endsWith('.ts') ? './executor/index.ts' : './executor/index.js', import.meta.url).href)).default as NonNullable<MainOptions['executor']>;
    const executor = factory(ledgers, pi ? { pi } : {});
    engine = new Engine(ledgers, executor, options);
    // A4: admission reads the settings recorded last, so the ones this run starts with are recorded (given ones too).
    await recordConfig(ledgers.orch, config);
    // EX1: the captures of the top-level pi sessions are kept for 7 days; the old ones go when the orchestrator starts.
    await pruneCaptures(home, CAPTURE_RETENTION_MS).catch(() => 0);
    if (stamp !== undefined) {
      // A change applies between slot admissions, so one admission never mixes two versions of the limits.
      watcher = watchConfig({ path: configPath(home), stamp, config, orch: ledgers.orch, intervalMs: Math.min(1000, config.k?.trackerMs ?? 1000),
        apply: change => executor.reconfigure ? executor.reconfigure(change) : change() });
    }
    const recovered = await engine.recover();
    await ledgers.orch.append('recovered', { pid: process.pid, ms: Math.round(performance.now() - recoveryStarted), ...recovered });
    await engine.loop(options.signal);
    const reason = options.signal?.reason;
    exit = engine.restartRequested ? { reason: 'restart' }
      : options.signal?.aborted ? { reason: 'signal', ...(typeof reason === 'string' ? { signal: reason } : {}) } : { reason: 'idle' };
    return engine.restartRequested ? { restart: true } : {};
  } catch (error) {
    exit = { reason: 'error', error: String(error).slice(0, 300) };
    throw error;
  } finally {
    try { await watcher?.stop(); await engine?.close(); }
    finally {
      try { await ledgers?.orch.append('orchestrator-exit', { pid: process.pid, ...exit }).catch(() => {}); await ledgers?.orch.close(); }
      finally { await lock.release(); }
    }
  }
}

// Started through a symlinked path (macOS /var is /private/var; a linked install), argv names the link while
// import.meta.url is the real file: compare real paths, as the CLI does.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, () => controller.abort(signal));
  main({ signal: controller.signal }).then(async ({ restart }) => {
    // Restart: the successor runs this same entry, which an update replaced in place; any pi session or CLI would start
    // it too (whoever takes the lock first wins, the others exit at once).
    if (restart) await launchOrchestrator(process.argv[1]!, process.env, { home: dsaHome() });
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
