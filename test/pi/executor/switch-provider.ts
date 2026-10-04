import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** P12, C8: Exercise a real provider change through Pi's model registry and RPC events. */
export default function switchProvider(pi: ExtensionAPI) {
  const faux = fauxProvider({ provider: "switch-probe", api: "switch-probe-faux", models: [{ id: "target", name: "Switch target" }] });
  faux.setResponses([async () => fauxAssistantMessage("switched to Y")]);
  pi.registerProvider(faux.provider);
}
