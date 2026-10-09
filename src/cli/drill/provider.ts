// Offline providers for `drill failover`, loaded by the drill's isolated pi setup (never by a user's pi).
//   drill-a/m: while `$DSA_DRILL_ROOT/a-exhausted` exists it refuses every request like a gateway whose usage window
//     is used up; otherwise it answers.
//   drill-b/m: always answers.
// Every request is appended to `$DSA_DRILL_ROOT/requests.log` as the provider's name.
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The refusal text of a gateway with no account left; the executor classifies it as a used-up window. */
export const EXHAUSTED = '503 {"error":{"message":"No available accounts: no available accounts","type":"api_error"}}';

export default function drillProviders(pi: ExtensionAPI): void {
  const root = process.env.DSA_DRILL_ROOT;
  if (!root) return;
  for (const [provider, flag] of [["drill-a", "a-exhausted"], ["drill-b", undefined]] as const) {
    const faux = fauxProvider({ provider, api: `${provider}-faux`, models: [{ id: "m", name: `${provider} model` }], tokensPerSecond: 500 });
    faux.setResponses(Array.from({ length: 200 }, () => async () => {
      appendFileSync(join(root, "requests.log"), `${provider}\n`);
      if (flag && existsSync(join(root, flag))) return fauxAssistantMessage([], { stopReason: "error", errorMessage: EXHAUSTED });
      return fauxAssistantMessage(`answered by ${provider}`);
    }));
    pi.registerProvider(faux.provider);
  }
}
