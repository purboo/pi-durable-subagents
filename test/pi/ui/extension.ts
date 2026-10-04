import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMain } from "../../../src/agent/main.ts";
import { registerUi } from "../../../src/ui/index.ts";

/** P16, P21, P38: Exercise the parent wiring and UI action dependency in an isolated real RPC pi. */
export default function probe(pi: ExtensionAPI) {
  registerMain(pi, (api, deps) => {
    registerUi(api, deps);
    api.on("session_start", async () => {
      await deps.submit({ action: "send", to: "workflow@1/E02@1", kind: "steer", message: "keep tests" });
      deps.presentNote('[user] steered E02: "keep tests"');
    });
  });
}
