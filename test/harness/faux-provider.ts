// Test harness extension: a scripted faux provider (provider "probe", models "scripted", "scripted2").
// A user message containing `#script: [steps]` drives responses; see respond().
// Loaded with `pi -e test/harness/faux-provider.ts` in an isolated PI_CODING_AGENT_DIR.
import * as fs from "node:fs";
import { Type, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROBE_DIR = process.env.PROBE_DIR || "/tmp/conductor-probe";
const log = (...a: unknown[]) => { try { fs.appendFileSync(`${PROBE_DIR}/ext.log`, `${new Date().toISOString()} ${process.pid} ${a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}\n`); } catch {} };

function textOf(m: any): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.map((b: any) => b?.text ?? "").join("");
  return "";
}

// Script syntax inside a user message: #script: [step, step, ...]
// step: {"tool":"bash","args":{...}} | {"text":"..."} | {"error":"msg"} | {"empty":true} | {"delayMs":n, ...step}
function diskMarkers(): Record<string, boolean> {
  try {
    const dir = `${PROBE_DIR}/sessions`;
    const files = (fs.readdirSync(dir, { recursive: true }) as string[]).map(String).filter(f => f.endsWith(".jsonl"));
    const text = files.map(f => fs.readFileSync(`${dir}/${f}`, "utf8")).join("\n");
    const out: Record<string, boolean> = {};
    for (const m of ["TURN-END-MSG", "IDLE-MSG", "BOOT-MSG", "MODEL-MSG"]) out[m] = text.includes(m);
    return out;
  } catch { return {}; }
}
async function respond(context: any, options: any, _state?: any, model?: any) {
  const msgs: any[] = context.messages ?? [];
  let idx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "assistant" && msgs[i].role !== "toolResult" && textOf(msgs[i]).includes("#script:")) { idx = i; break; }
  }
  if (idx < 0) { log("respond", { step: -1, kind: ["none"], model: model?.id, disk: diskMarkers() }); return fauxAssistantMessage("no script"); }
  const script = JSON.parse((textOf(msgs[idx]).split("#script:")[1] ?? "[]").trim());
  // pi 1.0.2 sometimes answers a turn itself with "Unknown provider" (no request reaches us); count only our answers.
  const n = msgs.slice(idx + 1).filter(m => m.role === "assistant" && (m.provider === undefined || m.provider === "probe")).length;
  const step = script[n] ?? { text: "end of script" };
  const lastUser = [...msgs].reverse().find(m => m.role === "user");
  const allText = msgs.map(textOf).join("\n");
  log("respond", { step: n, kind: Object.keys(step), model: model?.id, sawStale: allText.includes("STALE-Q"), sawResolved: allText.includes("RESOLVED-Q"), disk: diskMarkers(), lastUser: textOf(lastUser).slice(0, 60) });
  if (step.delayMs) {
    await new Promise<void>((res, rej) => {
      const t = setTimeout(res, step.delayMs);
      options?.signal?.addEventListener?.("abort", () => { clearTimeout(t); rej(new Error("aborted")); });
    });
  }
  if (step.tool) return fauxAssistantMessage([fauxToolCall(step.tool, step.args ?? {})], { stopReason: "toolUse" });
  if (step.error) return fauxAssistantMessage([], { stopReason: "error", errorMessage: step.error });
  if (step.empty) return fauxAssistantMessage("");
  return fauxAssistantMessage([fauxText(step.text ?? "ok")]);
}

export default function (pi: ExtensionAPI) {
  const faux = fauxProvider({ provider: "probe", api: "probe-faux", models: [{ id: "scripted", name: "Scripted" }, { id: "scripted2", name: "Scripted Two" }, { id: "thinker", name: "Thinker", reasoning: true }], tokensPerSecond: 200 });
  faux.setResponses(Array.from({ length: 500 }, () => respond as any));
  pi.registerProvider(faux.provider as any);

}
