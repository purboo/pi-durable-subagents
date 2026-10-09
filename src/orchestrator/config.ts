// $DSA_HOME/config.json for the orchestrator: read at start and again whenever the file changes, so a new slot limit,
// pool order or K-parameter needs no orchestrator restart (a restart at the wrong moment used to cost a dispatch).
// Orchestrator ledger entries: config{hash,config} — the settings in effect from then on (at start, or after a change);
// config-rejected{hash,error} — a changed file that was not applied; the settings before it stay in effect.
// A reload changes the shared config object in place: every later read sees it (the next slot acquisition, model
// resolution or check). Slots already held are kept when a limit drops; timers of running executions keep their period, and the waiting check
// period (k.waitCheckMs) is read once at orchestrator start.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { contentHash } from "../kernel/ids.ts";
import type { JournalHandle } from "../types.ts";
import type { OrchestratorConfig } from "./contract.ts";

/** The keys the orchestrator reads; config.json also holds pi-side settings (ui, onQuit) that it ignores. */
const KEYS = ["defaultModel", "pools", "providers", "memory", "writerLock", "k"] as const;
const K = ["lossBound", "checkpointMs", "stallMs", "progressMs", "switchTimeoutMs", "idleExitMs", "trackerMs", "hibernateMs", "spawnBudget", "probeMs", "eventRetentionMs", "waitCheckMs"];

export const configPath = (home: string) => join(home, "config.json");

/** The orchestrator's part of a parsed config.json. */
export function orchestratorSettings(raw: unknown): OrchestratorConfig {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return Object.fromEntries(KEYS.filter(k => value[k] !== undefined).map(k => [k, value[k]])) as OrchestratorConfig;
}
export const configHash = (config: OrchestratorConfig) => contentHash(orchestratorSettings(config)).slice(0, 12);

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
/** What is wrong with a parsed config.json for the orchestrator, or undefined. Unknown keys are allowed. */
export function configProblem(raw: unknown): string | undefined {
  if (!record(raw)) return "config.json must be a JSON object";
  const { defaultModel, pools, providers, memory, writerLock, k } = raw;
  if (writerLock !== undefined && writerLock !== "queue" && writerLock !== "off") return 'writerLock must be "queue" or "off"';
  if (defaultModel !== undefined && typeof defaultModel !== "string") return "defaultModel must be a string";
  if (pools !== undefined) {
    if (!record(pools)) return "pools must map names to model lists";
    for (const [name, list] of Object.entries(pools))
      if (!Array.isArray(list) || !list.length || !list.every(m => typeof m === "string" && m)) return `pools.${name} must be a nonempty list of "provider/id[:thinking]"`;
  }
  if (providers !== undefined) {
    if (!record(providers)) return "providers must map provider names to { slots }";
    for (const [name, p] of Object.entries(providers))
      if (!record(p) || !Number.isSafeInteger(p.slots) || Number(p.slots) < 0) return `providers.${name}.slots must be a nonnegative integer`;
  }
  if (memory !== undefined) {
    if (!record(memory)) return "memory must be { reserveMb?, perChildMb? }";
    for (const key of ["reserveMb", "perChildMb"]) if (memory[key] !== undefined && !count(memory[key])) return `memory.${key} must be a nonnegative number`;
  }
  if (k !== undefined) {
    if (!record(k)) return "k must map K-parameters to numbers";
    for (const [key, v] of Object.entries(k)) {
      if (!K.includes(key)) return `k.${key} is not a K-parameter (${K.join(", ")})`;
      if (!count(v) || (key !== "lossBound" && key !== "spawnBudget" && v === 0)) return `k.${key} must be a positive number`;
    }
  }
}

/** Parse config.json; a missing file is the empty config. A JSON error throws. */
export async function readConfig(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}

/** Record the settings in effect unless the ledger already ends on the same ones (a restart with an unchanged file).
 *  After a rejection they are recorded again: that confirms the file is back to settings in effect. */
export async function recordConfig(orch: JournalHandle, config: OrchestratorConfig): Promise<string> {
  const hash = configHash(config), last = orch.entries().findLast(e => e.type === "config" || e.type === "config-rejected");
  if (last?.type !== "config" || last.hash !== hash) await orch.append("config", { hash, config: orchestratorSettings(config) });
  return hash;
}

/** Replace the contents of the shared config object; readers hold the object, not a copy. */
function applyInPlace(target: OrchestratorConfig, next: OrchestratorConfig) {
  const t = target as Record<string, unknown>;
  for (const key of KEYS) delete t[key];
  Object.assign(t, orchestratorSettings(next));
}

/** Identity of the file's current version (taken before a read, so a change during the read is seen next time). */
/** The version of config.json: its content. File times are too coarse to tell two quick writes of the same size apart
 *  (a change could be missed for good), and the file is small enough to read once a second. */
export async function configStamp(path: string): Promise<string> {
  try { return `=${await readFile(path, "utf8")}`; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}

/** The settings of a version read by `configStamp`; invalid JSON throws, as `readConfig` does. */
export function stampedConfig(stamp: string): unknown { return stamp === "missing" ? {} : JSON.parse(stamp.slice(1)); }

/** Watch config.json from the version `stamp` (read at start) and apply each valid change in place. */
/** `apply` runs the change where readers cannot observe half of it (the executor's admission section). */
export function watchConfig(options: { path: string; stamp: string; config: OrchestratorConfig; orch: JournalHandle; intervalMs?: number; onApplied?: () => void; apply?: (change: () => Promise<void>) => Promise<void> }): { stop: () => Promise<void>; check: () => Promise<void> } {
  const { path, config, orch } = options;
  let stamp = options.stamp, running: Promise<void> | undefined, rejected: string | undefined, stopped = false;
  const once = async () => {
    const now = await configStamp(path);
    if (now === stamp || stopped) return;
    let raw: unknown;
    // The content compared is the content applied: a second read could see another version than the stamp.
    try { raw = stampedConfig(now); }
    catch (error) {
      // A half-written file reads as invalid JSON: retry on the next change of the file, report it once per version.
      stamp = now;
      const hash = `invalid:${now}`;
      if (rejected !== hash) { rejected = hash; await orch.append("config-rejected", { error: `config.json is not valid JSON: ${(error as Error).message}` }); }
      return;
    }
    stamp = now;
    // Validate the content first: `[]` or `null` project to no settings and must not pass as "unchanged".
    const problem = configProblem(raw), next = orchestratorSettings(raw), hash = configHash(next);
    if (problem) {
      if (rejected !== hash) { rejected = hash; await orch.append("config-rejected", { hash, error: problem }); }
      return;
    }
    rejected = undefined;
    let changed = false;
    await (options.apply ?? (change => change()))(async () => {
      changed = hash !== configHash(config);
      if (changed) applyInPlace(config, next);
      await recordConfig(orch, config); // also confirms a return to the settings in effect after a rejection
    });
    if (changed) options.onApplied?.();
  };
  const check = () => running ??= once().catch(error => console.error(`durable-subagents: config.json check failed: ${String(error)}`)).finally(() => { running = undefined; });
  const timer = setInterval(check, options.intervalMs ?? 1000);
  timer.unref();
  return { stop: async () => { stopped = true; clearInterval(timer); await running; }, check };
}
