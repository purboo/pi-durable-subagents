// UI §3 "be pi": the child's in-flight model response, for watching only. pi persists an assistant message when it
// ends; until then the session file cannot say whether the model is thinking, writing or has not answered yet.
// live.json (next to the session) holds that ephemeral state. It is not durable state: written without fsync,
// replaced atomically (temp + rename), ignored when stale, and never read by the orchestrator.
import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** UI §3: The ephemeral live state of a child's current model response. */
export interface Live { phase: "waiting" | "streaming" | "idle"; since: number; at: number; thinking?: string; text?: string; tool?: string }
export const LIVE_FILE = "live.json";
const TAIL = 4000, EVERY_MS = 250;
const tail = (text: string) => text.length > TAIL ? text.slice(-TAIL) : text;

/** UI §3: Publish waiting/streaming/idle while a provider request is in flight (at most four writes a second). */
export function registerLive(pi: ExtensionAPI, enabled: () => boolean): void {
  let since = 0, last = 0, pending: ReturnType<typeof setTimeout> | undefined, path: string | undefined, state: Live | undefined;
  const flush = () => {
    pending = undefined; last = Date.now();
    if (!path || !state) return;
    try { const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify({ ...state, at: last })); renameSync(tmp, path); }
    catch { /* Watching is best effort; the session file stays the truth. */ }
  };
  const publish = (ctx: ExtensionContext, next: Omit<Live, "at">, now = false) => {
    if (!enabled()) return;
    const file = ctx.sessionManager.getSessionFile(); if (!file) return;
    path = join(dirname(file), LIVE_FILE); const changed = state?.phase !== next.phase; state = { ...next, at: Date.now() };
    if (changed || now || Date.now() - last >= EVERY_MS) { if (pending) clearTimeout(pending); flush(); }
    else pending ??= setTimeout(flush, EVERY_MS - (Date.now() - last));
  };
  // A turn is one model call: from its start (or the provider request) until the first streamed token, it is waiting.
  const waiting = (_event: unknown, ctx: ExtensionContext) => { if (state?.phase !== "waiting") since = Date.now(); publish(ctx, { phase: "waiting", since }); };
  pi.on("turn_start", waiting);
  pi.on("before_provider_request", waiting);
  pi.on("message_update", (event, ctx) => {
    const m = event.message as { role?: string; content?: { type: string; thinking?: string; text?: string; name?: string }[] };
    if (m.role !== "assistant" || !Array.isArray(m.content)) return;
    const thinking = m.content.filter(b => b.type === "thinking").map(b => b.thinking ?? "").join("\n");
    const text = m.content.filter(b => b.type === "text").map(b => b.text ?? "").join("\n");
    const tool = m.content.filter(b => b.type === "toolCall").at(-1)?.name;
    publish(ctx, { phase: "streaming", since: since || Date.now(), ...(thinking ? { thinking: tail(thinking) } : {}), ...(text ? { text: tail(text) } : {}), ...(tool ? { tool } : {}) });
  });
  pi.on("message_end", (event, ctx) => {
    if ((event.message as { role?: string }).role === "assistant") { since = 0; publish(ctx, { phase: "idle", since: Date.now() }, true); }
  });
}
