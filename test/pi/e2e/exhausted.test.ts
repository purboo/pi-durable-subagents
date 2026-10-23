// Real HTTP 200/SSE responses through pi's OpenAI-compatible transport, the CLI and a detached orchestrator.
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

const quota = "\u989d\u5ea6\u5df2\u4f7f\u7528\u5b8c\u6bd5";
const text = `${quota}: ${"x".repeat(220)}`;

test("XP1 HTTP-200 quota answers fail over without contaminating the next request", { timeout: 180000 }, async t => {
  const root = tempRoot("dsa-e2e-exhausted-"), home = join(root, "dsa"), cwd = join(root, "work"), agentDir = join(root, "agent");
  const requests: { provider: string; body: { messages: unknown[] } }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()), provider = req.url!.split("/")[1]!;
    requests.push({ provider, body });
    const n = requests.filter(r => r.provider === provider).length;
    const tool = provider === "qtool" && n === 1;
    const content = ["qa", "qsolo", "qunset"].includes(provider) || tool ? text : `answered by ${provider}`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: unknown, finish_reason: string | null, usage?: unknown) => res.write(`data: ${JSON.stringify({ id: `response-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
    chunk({ role: "assistant", content, ...(tool ? { tool_calls: [{ index: 0, id: "tool-1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf tool-done" }) } }] } : {}) }, null);
    chunk({}, tool ? "tool_calls" : "stop", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await mkdir(join(cwd, ".pi/agents"), { recursive: true }); await mkdir(agentDir, { recursive: true }); await mkdir(home, { recursive: true });
  const names = ["qa", "qb", "qsolo", "qtool", "qunset"];
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: Object.fromEntries(names.map(provider => [provider, {
    api: "openai-completions", apiKey: "test-only", baseUrl: `http://127.0.0.1:${port}/${provider}/v1`,
    models: [{ id: "m", name: provider, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  }])) }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "qa", defaultModel: "m" }));
  await writeFile(join(cwd, ".pi/agents/worker.md"), "---\nname: worker\ndescription: worker\ntools: bash\n---\nYou work.\n");
  await writeFile(join(home, "config.json"), JSON.stringify({ pools: { top: ["qa/m", "qb/m"] },
    providers: Object.fromEntries(names.map(provider => [provider, { slots: 1, ...(provider !== "qunset" ? { exhaustedPatterns: [quota] } : {}) }])) }));
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
    if (process.env.DSA_KEEP) t.diagnostic(`kept: ${root}`); else await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  });
  const run = async (id: string, model: string) => {
    const spec = join(root, `${id}.json`);
    await writeFile(spec, JSON.stringify({ agent: "worker", task: "work", model, once: true, timeoutMs: 60000 }));
    await json(["run", "--request", id, "--spec", spec]);
    const end = Date.now() + 75000;
    for (;;) {
      const d = await json(["describe", "--key", id]);
      if (d.state === "sealed") return d;
      if (Date.now() > end) throw new Error(`${id} did not seal: ${JSON.stringify(d)}`);
      await delay(200);
    }
  };

  await t.test("pool returns only the second answer and omits the quota turn from its request", async () => {
    const d = await run("quota-pool", "top"), c = d.calls[0];
    assert.deepEqual([c.status, c.ok, c.output, c.model], ["ok", true, "answered by qb", "qb/m"], JSON.stringify(d));
    assert.deepEqual(requests.map(r => r.provider), ["qa", "qb"]);
    assert.ok(requests[1]!.body.messages.length > 0);
    assert.ok(!JSON.stringify(requests[1]!.body).includes(quota));
    assert.ok(!JSON.stringify(requests[1]!.body).includes("dsa-exhausted-text"));
    assert.ok(!requests[1]!.body.messages.some(m => (m as { role?: string }).role === "assistant"), "no empty rejected assistant turn either");
    const exhausted = (await json(["status"])).exhausted;
    assert.equal(exhausted.length, 1); assert.match(exhausted[0], /^qa exhausted /);
  });
  await t.test("later pool call avoids the exhausted provider until its probe", async () => {
    const from = requests.length, d = await run("quota-next", "top");
    assert.equal(d.calls[0].output, "answered by qb");
    assert.deepEqual(requests.slice(from).map(r => r.provider), ["qb"]);
  });
  await t.test("a concrete model fails without exposing quota text as its output", async () => {
    const d = await run("quota-solo", "qsolo/m"), c = d.calls[0];
    assert.equal(c.status, "failed"); assert.equal(c.ok, false); assert.equal(c.output, "");
    assert.equal(c.error, `model-unavailable: ${text.slice(0, 200)}`);
    assert.equal(requests.filter(r => r.provider === "qsolo").length, 1, "no local provider retry");
  });
  await t.test("matching text alongside a tool call remains a normal tool turn", async () => {
    const d = await run("quota-tool", "qtool/m");
    assert.equal(d.calls[0].output, "answered by qtool");
    const calls = requests.filter(r => r.provider === "qtool");
    assert.equal(calls.length, 2); assert.ok(JSON.stringify(calls[1]!.body).includes(quota));
    assert.ok(!(await json(["status"])).exhausted.some((line: string) => line.startsWith("qtool ")));
  });
  await t.test("providers without patterns keep the existing successful-answer behavior", async () => {
    const d = await run("quota-unset", "qunset/m");
    assert.equal(d.calls[0].status, "ok"); assert.equal(d.calls[0].output, text);
  });
});
