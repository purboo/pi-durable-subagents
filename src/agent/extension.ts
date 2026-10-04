// pi extension entry (P2): the same extension runs in every pi session.
// Child mode when DSA_EXEC is set (spawned by the orchestrator), main mode otherwise.
// The orchestrator always passes `-e <this file>` to children; if the package is also installed,
// pi may load it twice in one load pass, so a process-global guard keeps registration single. The guard is
// cleared on session_shutdown, which pi emits before /reload replaces the extension runtime.
// Upgrade safety (AC5): pi surfaces are probed through namespace imports (never a link error) before the modules
// that use them are loaded; DSA_PROBE=<file> only writes the capability report (used by `smoke`).
import { writeFileSync, writeSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as coding from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import * as ai from "@earendil-works/pi-ai";
import { ENV } from "../types.ts";
import { checkCapabilities, type CapabilityReport } from "./capabilities.ts";

const LOADED = Symbol.for("pi-durable-subagents.loaded");

/** P21: A child (DSA_EXEC set) without its execution surfaces cannot do its call; it reports the exact message on
 *  stderr and exits 3, so the executor records the message per call and counts a loss (failed after K2) instead of
 *  waiting on a child that will never act. Returns the stderr text, or undefined when the child may proceed. */
export function childRefusal(report: CapabilityReport, env: NodeJS.ProcessEnv): string | undefined {
  if (!env[ENV.exec] || report.execution) return undefined;
  return report.messages.join("\n");
}

export default async function (pi: ExtensionAPI) {
  const modules = { "@earendil-works/pi-coding-agent": coding, "@earendil-works/pi-tui": tui, "@earendil-works/pi-ai": ai } as unknown as Record<string, Record<string, unknown>>;
  const report = checkCapabilities(modules, pi, typeof (coding as Record<string, unknown>).VERSION === "string" ? String((coding as Record<string, unknown>).VERSION) : undefined);
  if (process.env.DSA_PROBE) { writeFileSync(process.env.DSA_PROBE, JSON.stringify(report)); return; }
  const refusal = childRefusal(report, process.env);
  // Synchronous write: process.exit must not drop the message on an asynchronous pipe.
  if (refusal !== undefined) { writeSync(2, `${refusal}\n`); process.exit(3); }
  const g = globalThis as Record<symbol, unknown>;
  if (g[LOADED]) return;
  g[LOADED] = true;
  for (const message of report.messages) console.error(message);
  if (typeof pi.on === "function") {
    pi.on("session_shutdown", () => { delete g[LOADED]; });
    if (report.messages.length && !process.env[ENV.exec]) pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
      for (const message of report.messages) ctx.ui?.notify?.(message, report.execution ? "warning" : "error");
    });
  }
  if (!report.execution) return;
  if (process.env[ENV.exec]) (await import("./child.ts")).registerChild(pi);
  else (await import("./main.ts")).registerMain(pi, report.ui ? (await import("../ui/index.ts")).registerUi : undefined);
}
