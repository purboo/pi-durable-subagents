// Chaos main-session observer, loaded AFTER the product extension: records the custom messages exactly as the
// product's late refresh (P15) left them, stamped with the time the first context handler ran (provider.ts).
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONTEXT_AT = Symbol.for("dsa-chaos.context-at");
/** AC4: Record main-session context content with a timestamp that precedes the product's refresh. */
export default function observer(pi: ExtensionAPI): void {
  if (process.env.DSA_EXEC) return;
  pi.on("context", event => {
    const at = Number((globalThis as Record<symbol, unknown>)[CONTEXT_AT] ?? Date.now());
    appendFileSync(join(process.env.DSA_CHAOS_ROOT!, "provider.jsonl"), JSON.stringify({ at, pid: process.pid, kind: "context", messages: event.messages.filter(m => m.role === "custom") }) + "\n");
  });
}
