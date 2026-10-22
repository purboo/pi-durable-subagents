// EX4, EX5: the exact child.
//
// The child pi runs as usual (its own session, its own tools), but every provider request it makes is replaced: the
// pinned parent capture supplies every field of the request byte for byte, and only the conversation differs (the
// parent's conversation followed by the child's own). The child's system prompt, context files and skills never reach
// the provider.
//
// Three things can go wrong, and none of them may send a cold request:
// - the child runs on another provider/model or another api than the capture: the request is not sent and the call
//   fails with `exact-mismatch: <detail>`;
// - the child transport never offers the payload hook: the call is rebuilt as a fork (`no-payload-hook`);
// - the model calls a tool the exact child may not run: the call is refused at `tool_call` and the child continues.
import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CT, ENV } from "../../types.ts";
import type { Capture } from "./capture.ts";
import { splicePayload } from "./splice.ts";

/** Every refused tool result starts with this text (EX4). */
export const EXACT_REFUSAL = "tool refused in exact fork:";
/** The tool an exact fork never offers (no recursion). */
export const NO_RECURSION = "subagents";

export interface ExactChild {
  /** The pinned capture of the parent session (loaded when the first request arrives). */
  capture: Promise<Capture>;
  /** The tools the call may run (the spec's tools, or the agent's, plus the protocol tools). */
  allow: string[];
}

/** The capture and the allow-list of an exact child, from its environment; undefined when it is not an exact child. */
export function exactChildFromEnv(env: NodeJS.ProcessEnv = process.env): ExactChild | undefined {
  const path = env[ENV.exactCapture];
  if (!path) return undefined;
  let allow: string[] = [];
  try { allow = JSON.parse(env[ENV.exactTools] ?? "[]") as string[]; } catch { allow = []; }
  return { capture: readCaptureFile(path).then(capture => {
    if (!capture) throw new Error(`the pinned capture ${path} is unreadable`);
    return capture;
  }), allow: Array.isArray(allow) ? allow.filter(name => typeof name === "string") : [] };
}

/** Read a pinned capture file (the published copy of the parent's capture). */
export async function readCaptureFile(path: string): Promise<Capture | undefined> {
  try {
    const capture = JSON.parse(await readFile(path, "utf8")) as Capture;
    if (!capture || typeof capture !== "object" || !capture.payload || typeof capture.payload !== "object") return undefined;
    return capture;
  } catch { return undefined; }
}

/** Why the child's request does not match the capture (EX4); undefined when it does. */
export function mismatch(capture: Capture, model: { provider?: string; id?: string; api?: string } | undefined): string | undefined {
  if (!model) return "the child has no model";
  if (capture.provider && model.provider && capture.provider !== model.provider)
    return `provider ${model.provider} is not the captured provider ${capture.provider}`;
  if (capture.model && model.id && capture.model !== model.id)
    return `model ${model.id} is not the captured model ${capture.model}`;
  if (capture.api && model.api && capture.api !== model.api)
    return `api ${model.api} is not the captured api ${capture.api}`;
  return undefined;
}

/**
 * Register the exact child: the payload splice, the mismatch guard, the tool refusals and the detection of a
 * transport that never offers the payload hook.
 */
export function registerExactChild(pi: ExtensionAPI, exact: ExactChild): void {
  const { allow } = exact, allowed = new Set(allow);
  let spliced = false, reported = false;
  const captureOf = async (): Promise<Capture | undefined> => { try { return await exact.capture; } catch { return undefined; } };
  const report = (type: string, data: Record<string, unknown>) => {
    pi.appendEntry(type, data);
    // The orchestrator reads the receipt from the session; the line wakes it at once.
    try { process.stdout.write(JSON.stringify({ type, ...data }) + "\n"); } catch { /* the session receipt is the record */ }
  };
  // EX4: the request the child would send is replaced by the parent's fields and the concatenated conversation.
  pi.on("before_provider_request", async (event) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object") return;
    const capture = await captureOf();
    if (!capture) return;
    spliced = true;
    const model = typeof payload.model === "string" ? payload.model : undefined;
    if (capture.model && model && model !== capture.model)
      throw new Error(`exact-mismatch: the request names model ${model}, the capture names ${capture.model}`);
    return splicePayload(capture.payload, payload, capture.api);
  });
  // EX4: the request is never sent on another provider/model or api: the turn is aborted before the request.
  pi.on("context", async (_event, ctx: ExtensionContext) => {
    const capture = await captureOf();
    if (!capture) {
      if (!reported) { reported = true; report(CT.exactMismatch, { error: "exact-mismatch: the pinned capture is unreadable" }); }
      ctx.abort();
      return;
    }
    const problem = mismatch(capture, ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined);
    if (!problem) return;
    if (!reported) { reported = true; report(CT.exactMismatch, { error: `exact-mismatch: ${problem}` }); }
    ctx.abort();
  });
  // EX4: a tool the capture lists but the child may not run is refused; the child continues.
  pi.on("tool_call", (event) => {
    const name = event.toolName;
    if (name === NO_RECURSION)
      return { block: true, reason: `${EXACT_REFUSAL} ${name} is not available in an exact fork (no recursion)` };
    if (!allowed.has(name))
      return { block: true, reason: `${EXACT_REFUSAL} ${name} is not in this call's tool allow-list` };
    if (!pi.getActiveTools().includes(name))
      return { block: true, reason: `${EXACT_REFUSAL} ${name} cannot be executed in this exact child` };
    return undefined;
  });
  // EX5: a transport that never offers the payload hook cannot be exact: the call is rebuilt as a fork.
  pi.on("message_end", (event) => {
    const message = event.message as { role?: string } | undefined;
    if (spliced || message?.role !== "assistant") return;
    if (reported) return;
    reported = true;
    report(CT.exactRebuilt, { reason: "no-payload-hook" });
  });
}
