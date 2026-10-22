// Test extension: provider "rec" (model "model") records each request's conversation to $PROBE_DIR/requests.jsonl
// and answers "recorded".
import * as fs from "node:fs";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROBE_DIR = process.env.PROBE_DIR || "/tmp/conductor-probe";

export default function (pi: ExtensionAPI) {
  const faux = fauxProvider({ provider: "rec", api: "rec-faux", models: [{ id: "model", name: "Recorder" }], tokensPerSecond: 1000 });
  const record = (context: any) => {
    fs.appendFileSync(`${PROBE_DIR}/requests.jsonl`, JSON.stringify({ pid: process.pid, messages: context.messages ?? [] }) + "\n");
    return fauxAssistantMessage([fauxText("recorded")]);
  };
  faux.setResponses(Array.from({ length: 50 }, () => record as any));
  pi.registerProvider(faux.provider as any);
}
