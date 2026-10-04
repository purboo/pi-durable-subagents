import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMain, presentNote } from "../../../../src/agent/main.ts";

/** P16: Exercise UI-to-main imports within the product's single extension graph. */
export default function notes(pi: ExtensionAPI): void {
  registerMain(pi);
  pi.on("before_agent_start", event => { if (event.prompt.includes("QUEUE-NOTE")) presentNote("UI action recorded"); });
}
