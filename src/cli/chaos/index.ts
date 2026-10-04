import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scenario } from "./scenario.ts";

export interface ChaosOptions { scenario?: number; keep: boolean; json: boolean }
/** Validate chaos arguments before allocating a temporary root or starting pi. */
export function parseChaos(args: string[]): ChaosOptions {
  const options: ChaosOptions = { keep: false, json: false }, seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) throw new Error(`Repeated chaos option: ${arg}`); seen.add(arg);
    if (arg === "--keep") options.keep = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--scenario" && /^[1-9]$/.test(args[i + 1] ?? "")) options.scenario = Number(args[++i]);
    else throw new Error(`Invalid chaos argument: ${arg}; use --scenario <1–9> --keep --json`);
  }
  return options;
}
/** Run the isolated AC2 suite, preserving evidence automatically whenever an invariant fails. */
export async function chaos(args: string[], env = process.env, write: (text: string) => void = console.log): Promise<number> {
  const options = parseChaos(args), root = mkdtempSync(join(tmpdir(), "dsa-chaos-"));
  const scenarios = options.scenario ? [options.scenario] : Array.from({ length: 9 }, (_, i) => i + 1);
  const results: Awaited<ReturnType<typeof scenario>>[] = [];
  let failure: { scenario: number; invariant: string; evidence: string[] } | undefined;
  for (const n of scenarios) {
    const evidence = join(root, String(n));
    try { results.push(await scenario(n, evidence, env)); }
    catch (error) { failure = { scenario: n, invariant: error instanceof Error ? error.message : String(error), evidence: [evidence, join(evidence, "dsa"), join(evidence, "main.jsonl"), join(evidence, "provider.jsonl")] }; break; }
  }
  // pi's own startup faults (scripted provider missing at start) are restarted by the driver and reported honestly.
  const piStartupRetries = scenarios.reduce((n, k) => { try { return n + readFileSync(join(root, String(k), "pi-startup-retries.jsonl"), "utf8").trim().split("\n").filter(Boolean).length; } catch { return n; } }, 0);
  const report = { passed: !failure, results, piStartupRetries, ...(failure ? { failure } : {}), ...((options.keep || failure) ? { evidence: root } : {}) };
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
  if (options.json) write(JSON.stringify(report));
  else {
    const has = (n: number) => results.some(r => r.scenario === n) ? 1 : 0;
    write(`  killed host ×${has(9)} · dropped streams ×${has(1)} · empty replies ×${has(3) + 5 * has(8)} · out-of-order steers ×${has(6)}`);
    if (piStartupRetries) write(`  pi startup retries ×${piStartupRetries} (pi started without the scripted provider; restarted before the scenario)`);
    if (failure) write(`  scenario ${failure.scenario} FAILED: ${failure.invariant}\n  evidence: ${failure.evidence.join("\n  ")}`);
    else write(`  duplicate runs ........ 0\n  lost results .......... 0\n  restarted from scratch  0\n  AC4 wakes / reminders . pass\n  ${options.scenario ? `scenario ${options.scenario}` : "all 9 scenarios"} ....... pass`);
    if (options.keep || failure) write(`  kept: ${root}`);
  }
  if (!options.keep && !failure) rmSync(root, { recursive: true, force: true });
  return failure ? 1 : 0;
}
