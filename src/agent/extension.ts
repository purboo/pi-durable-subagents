// pi extension entry (P2): the same extension runs in every pi session.
// Child mode when DSA_EXEC is set (spawned by the orchestrator), main mode otherwise.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENV } from "../types.ts";
import { registerChild } from "./child.ts";
import { registerMain } from "./main.ts";

export default function (pi: ExtensionAPI) {
  if (process.env[ENV.exec]) registerChild(pi);
  else registerMain(pi);
}
