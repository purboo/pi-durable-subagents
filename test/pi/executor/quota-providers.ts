import * as fs from "node:fs";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Provider failover fixture: providers "qa", "qb" and "qc" (model "m"). While `$PROBE_DIR/<provider>-exhausted` exists,
 *  that provider answers like a gateway whose usage window is used up; while `$PROBE_DIR/slow-qb` exists, qb answers
 *  after 3 s. Every request is logged to `$PROBE_DIR/quota.log` as its provider. */
const DIR = process.env.PROBE_DIR || "/tmp/conductor-probe";
export const EXHAUSTED = '503 {"error":{"message":"No available accounts: no available accounts","type":"api_error"}}';

export default function quotaProviders(pi: ExtensionAPI) {
  for (const provider of ["qa", "qb", "qc"]) {
    const faux = fauxProvider({ provider, api: `${provider}-faux`, models: [{ id: "m", name: `${provider} model` }], tokensPerSecond: 500 });
    faux.setResponses(Array.from({ length: 200 }, () => async () => {
      fs.appendFileSync(`${DIR}/quota.log`, `${provider}\n`);
      if (provider === "qb" && fs.existsSync(`${DIR}/slow-qb`)) await new Promise(resolve => setTimeout(resolve, 3000));
      if (fs.existsSync(`${DIR}/${provider}-exhausted`)) return fauxAssistantMessage([], { stopReason: "error", errorMessage: EXHAUSTED });
      return fauxAssistantMessage(`answered by ${provider}`);
    }));
    pi.registerProvider(faux.provider);
  }
}
