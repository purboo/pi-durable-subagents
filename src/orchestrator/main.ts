import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dsaHome, orchLedger, orchLock } from '../paths.ts';
import { openJournal } from '../kernel/journal.ts';
import { OsLock } from '../platform/lock.ts';
import type { Executor, Ledgers, OrchestratorConfig } from './contract.ts';
import { Engine, type EngineOptions } from './engine.ts';
import { configPath, configProblem, configStamp, readConfig, recordConfig, watchConfig } from './config.ts';

export interface MainOptions extends EngineOptions {
  home?: string;
  config?: OrchestratorConfig;
  executor?: (ledgers: Ledgers) => Executor;
  signal?: AbortSignal;
}

/** P2, C4, K6: Acquire the single authority before opening ledgers, recover, and idle-exit. */
export async function main(options: MainOptions = {}): Promise<void> {
  const home = options.home ?? dsaHome();
  await mkdir(home, { recursive: true });
  const lock = await new OsLock().tryAcquire(orchLock(home));
  if (!lock) return;
  let engine: Engine | undefined, ledgers: Ledgers | undefined, watcher: ReturnType<typeof watchConfig> | undefined;
  try {
    let config = options.config, stamp: string | undefined;
    if (!config) {
      // The stamp is taken before the read: a change made while reading is applied by the first check.
      stamp = await configStamp(configPath(home));
      const raw = await readConfig(configPath(home));
      const problem = configProblem(raw);
      if (problem) console.error(`durable-subagents: config.json: ${problem}`);
      config = raw as OrchestratorConfig;
    }
    ledgers = { home, config, orch: await openJournal(orchLedger(home)) };
    if (stamp !== undefined) {
      await recordConfig(ledgers.orch, config);
      watcher = watchConfig({ path: configPath(home), stamp, config, orch: ledgers.orch, intervalMs: Math.min(1000, config.k?.trackerMs ?? 1000) });
    }
    const factory = options.executor ?? (await import(new URL(import.meta.url.endsWith('.ts') ? './executor/index.ts' : './executor/index.js', import.meta.url).href)).default as (ledgers: Ledgers) => Executor;
    engine = new Engine(ledgers, factory(ledgers), options);
    await engine.recover();
    await engine.loop(options.signal);
  } finally {
    try { await watcher?.stop(); await engine?.close(); } finally { try { await ledgers?.orch.close(); } finally { await lock.release(); } }
  }
}

// Started through a symlinked path (macOS /var is /private/var; a linked install), argv names the link while
// import.meta.url is the real file: compare real paths, as the CLI does.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  main({ signal: controller.signal }).catch(error => { console.error(error); process.exitCode = 1; });
}
