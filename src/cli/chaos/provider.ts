import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Register the offline script model, deriving its cursor from the real session history. */
export default function provider(pi: ExtensionAPI): void {
  let ctx: ExtensionContext;
  const root = process.env.DSA_CHAOS_ROOT!;
  const record = (value: unknown) => appendFileSync(join(root, "provider.jsonl"), JSON.stringify({ at: Date.now(), pid: process.pid, exec: process.env.DSA_EXEC, ...value as object }) + "\n");
  pi.on("session_start", (_event, context) => { ctx = context; });
  pi.on("before_agent_start", event => { if (!process.env.DSA_EXEC) record({ kind: "start", prompted: event.prompt.startsWith("#chaos: ") }); });
  pi.on("context", event => {
    if (!process.env.DSA_EXEC) record({ kind: "context", messages: event.messages.filter(m => m.role === "custom") });
  });
  const respond: FauxResponseFactory = async (_context, options, _state, model) => {
    if (model.provider !== "dsa-chaos" || model.id !== "scripted") throw new Error("Unexpected chaos model");
    const entries = ctx.sessionManager.getEntries();
    const messages = entries.map(e => e.type === "message" ? e.message : e.type === "custom_message" ? e : undefined);
    const text = (m: any) => typeof m?.content === "string" ? m.content : (m?.content ?? []).map((b: any) => b.text ?? "").join("");
    const index = messages.findLastIndex(m => m && (!('role' in m) || m.role === "user") && text(m).startsWith("#chaos: "));
    if (index < 0) return fauxAssistantMessage("Acknowledged.");
    const steps = JSON.parse(text(messages[index]).slice(8));
    const cursor = messages.slice(index + 1).filter(m => m && 'role' in m && m.role === "assistant").length;
    const step = steps[cursor] ?? { text: "Acknowledged." };
    const session = ctx.sessionManager.getSessionFile(), bytes = session && existsSync(session) ? readFileSync(session) : Buffer.alloc(0);
    record({ kind: "response", cursor, step, model: `${model.provider}/${model.id}`, session, bytes: bytes.length, hash: createHash("sha256").update(bytes).digest("hex") });
    if (step.requires && !(step.input ?? "").split("\n").includes(step.requires)) throw new Error(`Missing upstream output: ${step.requires}`);
    if (step.delayMs) await delay(step.delayMs, undefined, { signal: options?.signal });
    if (step.tool) return fauxAssistantMessage([fauxToolCall(step.tool, step.args ?? {})], { stopReason: "toolUse" });
    if (step.error) return fauxAssistantMessage("partial stream", { stopReason: "error", errorMessage: step.error });
    return fauxAssistantMessage(step.empty ? "" : step.text ?? "Acknowledged.");
  };
  const faux = fauxProvider({ provider: "dsa-chaos", api: "dsa-chaos-faux", models: [{ id: "scripted" }] });
  faux.setResponses(Array.from({ length: 200 }, () => respond));
  pi.registerProvider(faux.provider);
}
