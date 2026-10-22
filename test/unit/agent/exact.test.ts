// EX1, EX4: the capture of a top-level session and the splice of an exact child's payload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFacts, exactCaptureEnabled, exactPath, pruneCaptures, readCapture, writeCapture, type Capture } from "../../../src/agent/exact/capture.ts";
import { registerCapture } from "../../../src/agent/exact/session.ts";
import { cacheMarkers, childConversation, clone, payloadTools, splicePayload } from "../../../src/agent/exact/splice.ts";
import { EXACT_REFUSAL, mismatch, registerExactChild } from "../../../src/agent/exact/child.ts";
import { CT } from "../../../src/types.ts";

const capture = (over: Partial<Capture> = {}): Capture => ({
  sessionId: "s1", provider: "qa", model: "m", api: "anthropic-messages", thinking: "off", at: 1_700_000_000_000,
  payload: { model: "m", max_tokens: 4096, stream: true, system: [{ type: "text", text: "parent system" }],
    messages: [{ role: "user", content: [{ type: "text", text: "parent question" }] }],
    tools: [{ name: "bash", description: "run", input_schema: { type: "object" } }] },
  ...over,
});

test("EX1 the capture is written mode 0600 and read back as the latest request", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-exact-capture-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const first = capture({ payload: { model: "m", messages: [{ role: "user", content: "one" }] } });
  await writeCapture(home, first);
  const path = exactPath(home, "s1");
  assert.equal((await stat(path)).mode & 0o777, 0o600, "the capture holds the payload only: it is readable by its owner alone");
  assert.deepEqual(await readCapture(home, "s1"), first);
  // Latest wins: the second request replaces the first capture.
  const second = capture({ payload: { model: "m", messages: [{ role: "user", content: "two" }] }, at: first.at + 1 });
  await writeCapture(home, second);
  assert.deepEqual((await readCapture(home, "s1"))?.payload, second.payload);
  assert.equal(await readCapture(home, "other"), undefined, "a session without a capture has none");
});

test("EX1 the capture keeps the payload only: no header, no key", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsa-exact-capture-"));
  const text = await readFile(exactPath(home, "none"), "utf8").catch(() => "");
  assert.equal(text, "");
  await writeCapture(home, capture());
  const raw = await readFile(exactPath(home, "s1"), "utf8");
  assert.ok(!raw.includes("authorization") && !raw.includes("apiKey") && !raw.includes("x-api-key"), "no credential is written");
});

test("EX1 the captures older than the retention are removed, the fresh ones stay", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-exact-capture-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeCapture(home, capture({ sessionId: "old" }));
  await writeCapture(home, capture({ sessionId: "new" }));
  const old = exactPath(home, "old");
  const long = Date.now() - 8 * 24 * 60 * 60 * 1000;
  await utimes(old, long / 1000, long / 1000);
  assert.equal(await pruneCaptures(home, 7 * 24 * 60 * 60 * 1000), 1);
  assert.equal(await readCapture(home, "old"), undefined);
  assert.ok(await readCapture(home, "new"));
});

test("EX1 the capture configuration is a boolean that defaults to on", () => {
  assert.equal(exactCaptureEnabled({}), true);
  assert.equal(exactCaptureEnabled({ exactCapture: true }), true);
  assert.equal(exactCaptureEnabled({ exactCapture: false }), false);
  assert.equal(exactCaptureEnabled({ exactCapture: "no" }), true, "only false disables the capture");
});

test("EX1 the facts of a capture are its sha256, size and request", () => {
  const c = capture(), facts = captureFacts(c);
  assert.equal(facts.provider, "qa"); assert.equal(facts.model, "m"); assert.equal(facts.api, "anthropic-messages");
  assert.equal(facts.at, c.at); assert.equal(facts.bytes, Buffer.byteLength(JSON.stringify(c.payload)));
  assert.match(facts.sha256, /^[0-9a-f]{64}$/);
});

test("EX1 a top-level session keeps the capture of its latest request without changing it", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-exact-session-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  await registerCapture({ on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => hooks.set(name, fn) } as never, home);
  const ctx = { sessionManager: { getSessionId: () => "s1" }, model: { provider: "qa", id: "m", api: "anthropic-messages" }, thinkingLevel: "off" };
  const payload = { model: "m", messages: [{ role: "user", content: "hello" }] };
  assert.equal(await hooks.get("before_provider_request")!({ payload }, ctx), undefined, "the payload is not changed");
  // The write happens off the request path: it is queued, not awaited.
  for (let i = 0; i < 50 && !(await readCapture(home, "s1")); i++) await new Promise(resolve => setTimeout(resolve, 20));
  const written = await readCapture(home, "s1");
  assert.deepEqual(written?.payload, payload);
  assert.equal(written?.provider, "qa"); assert.equal(written?.model, "m"); assert.equal(written?.api, "anthropic-messages");
  assert.equal(written?.thinking, "off");
  // A second request replaces the capture (latest wins).
  await hooks.get("before_provider_request")!({ payload: { model: "m", messages: [{ role: "user", content: "later" }] } }, ctx);
  const first = (c: Capture | undefined) => ((c?.payload.messages as { content?: unknown }[] | undefined)?.[0]?.content);
  for (let i = 0; i < 50; i++) { if (first(await readCapture(home, "s1")) === "later") break; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(first(await readCapture(home, "s1")), "later");
});

test("EX1 a disabled capture writes nothing", async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-exact-session-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "config.json"), JSON.stringify({ exactCapture: false }));
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  await registerCapture({ on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => hooks.set(name, fn) } as never, home);
  assert.equal(hooks.has("before_provider_request"), false, "the capture is off: no request is observed");
});

test("EX4 the splice keeps every parent field and concatenates the conversations (anthropic)", () => {
  const parent = capture().payload;
  const child = { model: "m", max_tokens: 1, system: [{ type: "text", text: "child system" }], stream: true,
    messages: [{ role: "user", content: [{ type: "text", text: "child task" }] }], tools: [] };
  const out = splicePayload(parent, child, "anthropic-messages");
  assert.deepEqual(out.system, parent.system, "the child's system prompt never reaches the provider");
  assert.deepEqual(out.tools, parent.tools, "the parent's tools are the ones the model sees");
  assert.equal(out.max_tokens, 4096); assert.equal(out.stream, true);
  assert.deepEqual(out.messages, [...(parent.messages as unknown[]), ...(child.messages as unknown[])]);
});

test("EX4 the splice drops the child's own instruction messages (openai-responses)", () => {
  const parent = { model: "m", instructions: "parent instructions", input: [{ role: "user", content: [{ type: "input_text", text: "parent question" }] }] };
  const child = { model: "m", instructions: "child instructions", input: [{ role: "developer", content: "child system" },
    { role: "user", content: [{ type: "input_text", text: "child task" }] }] };
  const out = splicePayload(parent, child, "openai-responses");
  assert.equal(out.instructions, "parent instructions");
  assert.equal((out.input as unknown[]).length, 2);
  assert.equal((out.input as unknown[])[0], (parent.input as unknown[])[0]);
  assert.equal(((out.input as unknown[])[1] as { role: string }).role, "user");
  assert.ok(!JSON.stringify(out).includes("child system"), "the child's own instructions never reach the provider");
});

test("EX4 the child's conversation starts at its first user message", () => {
  assert.deepEqual(childConversation([{ role: "system" }, { role: "user", content: "a" }, { role: "assistant" }]), [{ role: "user", content: "a" }, { role: "assistant" }]);
  assert.deepEqual(childConversation([{ role: "assistant" }]), []);
  assert.deepEqual(childConversation(undefined), []);
});

test("EX4 the parent's cache breakpoints stay, the child's are dropped from the earliest first", () => {
  const mark = { type: "text", text: "x", cache_control: { type: "ephemeral" } };
  const parent = { model: "m", messages: [{ role: "user", content: [mark] }, { role: "assistant", content: [mark] }] };
  const child = { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "c1", cache_control: { type: "ephemeral" } },
    { type: "text", text: "c2", cache_control: { type: "ephemeral" } }, { type: "text", text: "c3", cache_control: { type: "ephemeral" } }] }] };
  const out = splicePayload(parent, child, "anthropic-messages");
  const messages = out.messages as { role: string; content: { cache_control?: unknown }[] }[];
  assert.equal(cacheMarkers(messages[0]!.content).length, 1, "the parent's markers are kept");
  assert.equal(cacheMarkers(messages[1]!.content).length, 1);
  assert.equal(cacheMarkers(messages[2]!.content).length, 2, "two child markers fit under the provider's limit of 4");
  const kept = messages[2]!.content.filter(block => block.cache_control).map(block => (block as { text: string }).text);
  assert.deepEqual(kept, ["c2", "c3"], "the child's earliest markers are dropped first");
  assert.equal(cacheMarkers(out).length, 4, "the request keeps at most four breakpoints");
});

test("EX4 the tools of a payload are named", () => {
  assert.deepEqual(payloadTools({ tools: [{ name: "bash" }] }), ["bash"]);
  assert.deepEqual(payloadTools({ tools: [{ type: "function", function: { name: "read" } }] }), ["read"]);
  assert.deepEqual(payloadTools({}), []);
});

test("EX4 the clone of a payload keeps the values and detaches the objects", () => {
  const payload = { a: [1, { b: 2 }] }, copy = clone(payload);
  assert.deepEqual(copy, payload);
  (copy.a[1] as { b: number }).b = 3;
  assert.equal((payload.a[1] as { b: number }).b, 2);
});

test("EX4 the mismatch names the provider, the model and the api that differ", () => {
  const c = capture();
  assert.equal(mismatch(c, { provider: "qa", id: "m", api: "anthropic-messages" }), undefined);
  assert.match(mismatch(c, { provider: "qb", id: "m", api: "anthropic-messages" })!, /provider qb is not the captured provider qa/);
  assert.match(mismatch(c, { provider: "qa", id: "other", api: "anthropic-messages" })!, /model other is not the captured model m/);
  assert.match(mismatch(c, { provider: "qa", id: "m", api: "openai-responses" })!, /api openai-responses is not the captured api/);
});

// ---------------------------------------------------------------------------------------------------------------------
// The exact child: the payload splice, the mismatch guard, the tool refusals and the hook detection.
// ---------------------------------------------------------------------------------------------------------------------
function childFixture(t: any, options: { capture?: Capture; allow?: string[]; active?: string[] }) {
  const hooks = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>(), history: any[] = [];
  const c = options.capture ?? capture();
  const pi = {
    on: (name: string, fn: any) => hooks.set(name, fn),
    appendEntry: (customType: string, data: unknown) => history.push({ type: "custom", customType, data }),
    getActiveTools: () => options.active ?? ["bash", "ask"],
  };
  registerExactChild(pi as never, { capture: Promise.resolve(c), allow: options.allow ?? ["bash", "ask"] });
  const ctx = { model: { provider: "qa", id: "m", api: "anthropic-messages" }, abort: () => { ctx.aborted = true; }, aborted: false } as any;
  return { hooks, history, ctx, pi };
}

test("EX4 the exact child replaces the request with the parent's fields and the joined conversation", async t => {
  const f = childFixture(t, {});
  const payload = { model: "m", max_tokens: 1, system: [{ type: "text", text: "child system" }], stream: true,
    messages: [{ role: "user", content: [{ type: "text", text: "child task" }] }] };
  const out = await f.hooks.get("before_provider_request")!({ payload }, f.ctx) as Record<string, unknown>;
  assert.deepEqual((out.messages as unknown[]).length, 2);
  assert.deepEqual(out.system, [{ type: "text", text: "parent system" }]);
  assert.equal(out.max_tokens, 4096);
});

test("EX4 the exact child refuses a request on another model", async t => {
  const f = childFixture(t, {});
  await assert.rejects(async () => f.hooks.get("before_provider_request")!({ payload: { model: "other", messages: [] } }, f.ctx),
    /exact-mismatch: the request names model other, the capture names m/);
});

test("EX4 the exact child aborts the turn when the provider, the model or the api differ", async t => {
  const f = childFixture(t, {});
  await f.hooks.get("context")!({ type: "context" }, f.ctx);
  assert.equal(f.ctx.aborted, false, "a matching model is left alone");
  f.ctx.model = { provider: "qb", id: "m", api: "anthropic-messages" };
  await f.hooks.get("context")!({ type: "context" }, f.ctx);
  assert.equal(f.ctx.aborted, true, "the request is not sent on another provider");
  const receipt = f.history.find(e => e.customType === CT.exactMismatch);
  assert.match(receipt?.data.error as string, /^exact-mismatch: provider qb is not the captured provider qa/);
});

test("EX4 the exact child refuses the tools it may not run and lets the others through", async t => {
  const f = childFixture(t, { allow: ["bash"], active: ["bash", "ask"] });
  const refuse = (toolName: string) => f.hooks.get("tool_call")!({ toolName, input: {} }, f.ctx) as { block: boolean; reason: string } | undefined;
  assert.match(refuse("subagents")!.reason, new RegExp(`^${EXACT_REFUSAL} subagents`));
  assert.match(refuse("web_search")!.reason, new RegExp(`^${EXACT_REFUSAL} web_search is not in this call's tool allow-list`));
  assert.equal(refuse("bash"), undefined, "a tool of the allow-list that the child can run is executed");
  const f2 = childFixture(t, { allow: ["bash", "web_search"], active: ["bash"] });
  const blocked = f2.hooks.get("tool_call")!({ toolName: "web_search", input: {} }, f2.ctx) as { block: boolean; reason: string };
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, new RegExp(`^${EXACT_REFUSAL} web_search cannot be executed in this exact child`));
});

test("EX5 the exact child reports a transport that never offers the payload hook", async t => {
  const f = childFixture(t, {});
  await f.hooks.get("message_end")!({ message: { role: "assistant" } }, f.ctx);
  assert.equal(f.history.some(e => e.customType === CT.exactRebuilt), true, "the first answer without a splice rebuilds the call");
  assert.equal(f.history.find(e => e.customType === CT.exactRebuilt)?.data.reason, "no-payload-hook");
});
