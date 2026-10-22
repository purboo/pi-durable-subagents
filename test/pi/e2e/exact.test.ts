// EX2, EX3, EX4, EX5, EX6: the exact fork end to end: a pinned parent capture, an exact child that splices it into
// its own provider request, and the fallback to a rebuilt fork when there is no capture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { REPO, tempRoot } from "../../harness/pi.ts";
import { orchLedger } from "../../../src/paths.ts";
import { readJournalSnapshot } from "../../../src/kernel/journal.ts";

type Seen = { body: Record<string, unknown> };

/** The text of a message of a request (its content is blocks or a plain string). */
const textOf = (message: { content?: unknown }): string => {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map(block => typeof block === "string" ? block : String((block as { text?: unknown }).text ?? "")).join("");
};

const parentPayload = (text: string) => ({
  model: "m", max_tokens: 4096, stream: true,
  system: [{ type: "text", text: "parent system" }],
  messages: [{ role: "user", content: [{ type: "text", text }] }],
  tools: [{ name: "bash", description: "run a command", input_schema: { type: "object", properties: {} } }],
});

test("EX2 an exact run splices the pinned capture into the child's provider request", { timeout: 300000 }, async t => {
  const root = tempRoot("dsa-e2e-exact-"), home = join(root, "dsa"), cwd = join(root, "work"), agentDir = join(root, "agent");
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    seen.push({ body });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    event("message_start", { type: "message_start", message: { id: "msg_1", model: "m", role: "assistant", content: [],
      usage: { input_tokens: 4400, output_tokens: 0, cache_read_input_tokens: 148200, cache_creation_input_tokens: 0 } } });
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answered" } });
    event("content_block_stop", { type: "content_block_stop", index: 0 });
    event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
    event("message_stop", { type: "message_stop" });
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await mkdir(join(cwd, ".pi/agents"), { recursive: true }); await mkdir(join(agentDir, "sessions/proj"), { recursive: true }); await mkdir(home, { recursive: true });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { qa: { api: "anthropic-messages", apiKey: "test-only",
    baseUrl: `http://127.0.0.1:${port}`, models: [{ id: "m", name: "m", reasoning: false, input: ["text"], contextWindow: 128000,
      maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "qa", defaultModel: "m" }));
  await writeFile(join(cwd, ".pi/agents/worker.md"), "---\nname: worker\ndescription: worker\ntools: bash\n---\nYou work.\n");
  await writeFile(join(home, "config.json"), JSON.stringify({ providers: { qa: { slots: 2 } } }));
  // The parent's capture: the payload of the parent's last provider request.
  await mkdir(join(home, "exact"), { recursive: true });
  await writeFile(join(home, "exact", "parent1.json"), JSON.stringify({ sessionId: "parent1", provider: "qa", model: "m",
    api: "anthropic-messages", thinking: "off", at: Date.now(), payload: parentPayload("parent question") }));
  // The parent's pi session: the origin of the run (its branch is pinned with the capture).
  await writeFile(join(agentDir, "sessions/proj/20260101_000000_parent1.jsonl"), JSON.stringify({ type: "session", id: "parent1" }) + "\n" +
    JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text: "parent question" }] } }) + "\n");
  // A second session without a capture: an exact run of it cannot be exact.
  await writeFile(join(agentDir, "sessions/proj/20260101_000100_parent2.jsonl"), JSON.stringify({ type: "session", id: "parent2" }) + "\n" +
    JSON.stringify({ type: "message", id: "m2", parentId: null, message: { role: "user", content: [{ type: "text", text: "parent question" }] } }) + "\n");
  const env: NodeJS.ProcessEnv = { PATH: `${join(REPO, "node_modules/.bin")}:${process.env.PATH}`, HOME: root, DSA_HOME: home,
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  const cli = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO, "src/cli/main.ts"), ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { err += d; });
    child.once("error", reject); child.once("close", code => resolve({ code, out: out.trim(), err: err.trim() }));
  });
  const json = async (args: string[]) => { const r = await cli([...args, "--json"]); assert.equal(r.code, 0, `${args.join(" ")}: ${r.out} ${r.err}`); return JSON.parse(r.out); };
  const pids = () => readJournalSnapshot(orchLedger(home)).filter(e => e.type === "orchestrator").map(e => Number(e.pid));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(async () => {
    for (const pid of pids()) if (alive(pid)) process.kill(pid, "SIGTERM");
    const end = Date.now() + 15000;
    while (pids().some(alive) && Date.now() < end) await delay(100);
    for (const pid of pids()) if (alive(pid)) process.kill(pid, "SIGKILL");
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (process.env.DSA_KEEP) t.diagnostic(`kept: ${root}`); else await rm(root, { recursive: true, force: true });
  });
  const run = async (id: string, context: string, origin?: string) => {
    const spec = join(root, `${id}.json`);
    await writeFile(spec, JSON.stringify({ agent: "worker", task: "child task", context, once: true, timeoutMs: 60000 }));
    await json(["run", "--request", id, "--spec", spec, ...(origin ? ["--origin-session", origin] : [])]);
    const end = Date.now() + 120000;
    for (;;) {
      const d = await json(["describe", "--key", id]);
      if (d.state === "sealed") return d;
      if (Date.now() > end) throw new Error(`${id} did not seal: ${JSON.stringify(d)}`);
      await delay(200);
    }
  };

  await t.test("the exact child sends the parent's fields and the joined conversation", async () => {
    const d = await run("exact-one", "exact", "parent1"), c = d.calls[0];
    assert.equal(c.status, "ok", JSON.stringify(d));
    assert.equal(c.output, "answered");
    assert.equal(seen.length, 1, "the child makes one provider request");
    const body = seen[0]!.body;
    assert.deepEqual(body.system, [{ type: "text", text: "parent system" }], "the parent's system reaches the provider, the agent's does not");
    assert.deepEqual(body.tools, parentPayload("x").tools, "the parent's tools are the ones the model sees");
    assert.equal(body.max_tokens, 4096);
    const messages = body.messages as { role: string; content: unknown }[];
    assert.equal(messages.length, 2, "the parent's conversation and the child's own one");
    assert.equal(textOf(messages[0]!), "parent question");
    assert.match(textOf(messages[1]!), /child task/, "the child's own conversation follows the parent's");
    assert.equal(c.exact?.mode, "exact");
    assert.equal(c.exact?.provider, "qa"); assert.equal(c.exact?.model, "m");
    assert.match(c.exact?.captureSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(c.exact?.requests.length, 1, "the usage of every provider request is recorded");
    assert.equal(c.exact?.cacheRead, 148200);
    assert.ok((c.exact?.firstCacheRatio ?? 0) > 0.9, "the first request reads the parent's cache");
  });

  await t.test("an exact call without a capture is rebuilt as a fork", async () => {
    const before = seen.length;
    const d = await run("exact-nocapture", "exact", "parent2"), c = d.calls[0];
    assert.equal(c.status, "ok", JSON.stringify(d));
    assert.equal(c.exact?.mode, "rebuilt");
    assert.equal(c.exact?.reason, "no-capture");
    assert.equal(seen.length, before + 1);
    const body = seen[before]!.body;
    assert.notDeepEqual(body.system, [{ type: "text", text: "parent system" }], "a rebuilt call runs with the agent's own context");
    const messages = body.messages as { role: string; content: unknown }[];
    assert.match(textOf(messages[0]!), /parent question/, "the fork inherits the parent's context");
  });
});
