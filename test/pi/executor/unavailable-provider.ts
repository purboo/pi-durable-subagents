import { appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A registered model with missing ambient auth; its stream must never be reached. */
export default function unavailableProvider(pi: ExtensionAPI) {
  const faux = fauxProvider({ provider: "missing-auth", api: "missing-auth-faux", models: [{ id: "m", name: "Missing auth" }] });
  faux.setResponses([async () => { appendFileSync(`${process.env.PROBE_DIR}/quota.log`, "FORBIDDEN\n"); return fauxAssistantMessage("unselected"); }]);
  pi.registerProvider({ ...faux.provider, auth: { apiKey: { name: "Missing environment key", resolve: async () => undefined } } });
  pi.registerVirtualModel({ provider: "router", id: "auto", name: "Auto", route: (_request, ctx) => ({ model: ctx.modelRegistry.find("qb", "m")!, thinkingLevel: "off" }) });
}
