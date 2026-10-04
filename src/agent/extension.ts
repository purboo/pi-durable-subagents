// pi extension entry (P2): the same extension runs in every pi session.
// Child mode when DSA_EXEC is set (spawned by the orchestrator), main mode otherwise.
// The orchestrator always passes `-e <this file>` to children; if the package is also installed,
// pi may load it twice in one process, so a process-global guard keeps registration single.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENV } from "../types.ts";
import { registerChild } from "./child.ts";
import { registerMain } from "./main.ts";

const LOADED = Symbol.for("pi-durable-subagents.loaded");

export default function (pi: ExtensionAPI) {
  const g = globalThis as Record<symbol, unknown>;
  if (g[LOADED]) return;
  g[LOADED] = true;
  if (process.env[ENV.exec]) registerChild(pi);
  else registerMain(pi);
}
