import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerLive, LIVE_FILE } from "../../../src/agent/child/live.ts";

test("UI §3: the child publishes waiting, then the streaming thinking/text, then idle (ephemeral live.json)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsa-live-")), handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  try {
    const pi = { on: (name: string, fn: (event: unknown, ctx: unknown) => void) => handlers.set(name, fn) };
    let enabled = true;
    registerLive(pi as never, () => enabled);
    const ctx = { sessionManager: { getSessionFile: () => join(dir, "session.jsonl") } };
    const read = () => JSON.parse(readFileSync(join(dir, LIVE_FILE), "utf8"));
    handlers.get("turn_start")!({}, ctx);
    assert.equal(read().phase, "waiting");
    const since = read().since; handlers.get("before_provider_request")!({}, ctx);
    assert.equal(read().since, since, "the provider request continues the same wait");
    handlers.get("message_update")!({ message: { role: "assistant", content: [{ type: "thinking", thinking: "**Checking the lease**\nhmm" }] } }, ctx);
    assert.equal(read().phase, "streaming"); assert.match(read().thinking, /Checking the lease/);
    await new Promise(resolve => setTimeout(resolve, 300));
    handlers.get("message_update")!({ message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "Done." }] } }, ctx);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(read().text, "Done.");
    handlers.get("message_end")!({ message: { role: "assistant" } }, ctx);
    assert.equal(read().phase, "idle");
    enabled = false; handlers.get("before_provider_request")!({}, ctx);
    assert.equal(read().phase, "idle", "a child that is no longer current publishes nothing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
