import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dsaHome, orchLedger, orchLock } from '../paths.ts';
import { openJournal } from '../kernel/journal.ts';
import { OsLock } from '../platform/lock.ts';
import { captureStart } from '../platform/proctable.ts';
import type { Executor, Ledgers, OrchestratorConfig } from './contract.ts';
import { Engine, type EngineOptions } from './engine.ts';
import { configPath, configProblem, configStamp, recordConfig, stampedConfig, watchConfig } from './config.ts';
import { packageVersion } from '../version.ts';

export interface MainOptions extends EngineOptions {
  home?: string;
  config?: OrchestratorConfig;
  executor?: (ledgers: Ledgers) => Executor;
  signal?: AbortSignal;
}

/** P2, C4, K6: Acquire the single authority before opening ledgers, recover, and idle-exit. Resolves `restart` when an
 *  applied restart request ended it (the caller starts the successor once the lock is released). */
export async function main(options: MainOptions = {}): Promise<{ restart?: true }> {
  const home = options.home ?? dsaHome();
  await mkdir(home, { recursive: true });
  const lock = await new OsLock().tryAcquire(orchLock(home));
  if (!lock) return {};
  let engine: Engine | undefined, ledgers: Ledgers | undefined, watcher: ReturnType<typeof watchConfig> | undefined;
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
    await ledgers.orch.append('orchestrator', { version: packageVersion(), pid: process.pid, ...(start ? { start } : {}), restart: true });
    const factory = options.executor ?? (await import(new URL(import.meta.url.endsWith('.ts') ? './executor/index.ts' : './executor/index.js', import.meta.url).href)).default as (ledgers: Ledgers) => Executor;
    const executor = factory(ledgers);
    engine = new Engine(ledgers, executor, options);
    // A4: admission reads the settings recorded last, so the ones this run starts with are recorded (given ones too).
    await recordConfig(ledgers.orch, config);
    if (stamp !== undefined) {
      // A change applies between slot admissions, so one admission never mixes two versions of the limits.
      watcher = watchConfig({ path: configPath(home), stamp, config, orch: ledgers.orch, intervalMs: Math.min(1000, config.k?.trackerMs ?? 1000),
        apply: change => executor.reconfigure ? executor.reconfigure(change) : change() });
    }
    await engine.recover();
    await engine.loop(options.signal);
    return engine.restartRequested ? { restart: true } : {};
  } finally {
    try { await watcher?.stop(); await engine?.close(); }
    finally {
      try { await ledgers?.orch.append('orchestrator-exit', { pid: process.pid }).catch(() => {}); await ledgers?.orch.close(); }
      finally { await lock.release(); }
    }
  }
}

// Started through a symlinked path (macOS /var is /private/var; a linked install), argv names the link while
// import.meta.url is the real file: compare real paths, as the CLI does.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  main({ signal: controller.signal }).then(({ restart }) => {
    // Restart: the successor runs this same entry, which an update replaced in place; any pi session or CLI would start
    // it too (whoever takes the lock first wins, the others exit at once).
    if (restart) spawn(process.execPath, [process.argv[1]!], { detached: true, stdio: 'ignore', env: process.env }).unref();
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
