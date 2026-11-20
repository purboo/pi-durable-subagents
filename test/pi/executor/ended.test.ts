import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAUX, PI_BIN, REPO, script, tempRoot } from "../../harness/pi.ts";
import { openJournal, readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { ulid } from "../../../src/kernel/ids.ts";
import { binDir, journalPath, orchLedger } from "../../../src/paths.ts";
import { writeShim } from "../../../src/platform/lease.ts";
import { ProcessTable } from "../../../src/platform/proctable.ts";
import type { CallTicket } from "../../../src/orchestrator/contract.ts";
import createExecutor from "../../../src/orchestrator/executor/index.ts";

async function setup(t: TestContext) {
  const root = tempRoot("dsa-pi-ended-"), home = join(root, "dsa"), cwd = join(root, "work"), wid = ulid();
  await mkdir(cwd, { recursive: true });
  const old = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PROBE_DIR: process.env.PROBE_DIR, PATH: process.env.PATH,
    PI_OFFLINE: process.env.PI_OFFLINE, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK };
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PROBE_DIR = root;
  process.env.PI_OFFLINE = "1"; process.env.PI_SKIP_VERSION_CHECK = "1";
  process.env.PATH = `${join(REPO, "node_modules/.bin")}:${process.env.PATH}`;
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  await writeFile(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ extensions: [FAUX], defaultProvider: "probe", defaultModel: "scripted" }));
  writeShim(binDir(home), process.execPath, fileURLToPath(new URL("../../../src/cli/main.ts", import.meta.url)));
  const orch = await openJournal(orchLedger(home)), journal = await openJournal(journalPath(home, wid));
  const executor = createExecutor({ home, orch, config: { k: { trackerMs: 20 } } }, { memory: async () => 1e6, pi: PI_BIN });
  const agent = { name: "test", description: "test", body: "Test agent", model: "probe/scripted", tools: ["bash"], sourcePath: "/fixture/test.md",
    source: "project" as const, systemPromptMode: "replace" as const, inheritProjectContext: false, inheritSkills: false };
  const ticket: CallTicket = { wid, widRev: `${wid}@1`, key: "a", gen: 1, callId: `${wid}@1/a@1`, cwd, journal, spec: { agent: "test", task: "" }, agent };
  t.after(async () => {
    try { await executor.shutdown(); } finally {
      await journal.close(); await orch.close();
      for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    }
  });
  return { root, home, cwd, wid, journal, executor, ticket };
}

for (const detached of [false, true]) test(`EX1 real pi ends a background sleep${detached ? " in a new session (setsid)" : " grandchild"} and journals it before seal`,
  { timeout: 60_000, skip: process.platform === "win32" ? "Windows has no inherited DSA_EXEC tag: a grandchild whose parent exited before a scan cannot be discovered" : detached && process.platform !== "linux" ? "setsid is Linux-only; ordinary background process tested on macOS" : false }, async t => {
    const f = await setup(t), pidFile = join(f.cwd, "sleep.pid");
    f.ticket.spec.task = script([
      { tool: "bash", args: { command: `${detached ? "setsid " : ""}sh -c 'sleep 300' </dev/null > /dev/null 2>&1 & echo $! > sleep.pid`, timeout: 10 } },
      { text: "background started; turn done" },
    ]);
    const result = await f.executor.run(f.ticket);
    assert.equal(result.status, "ok", JSON.stringify(result));
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    const entries = readJournalSnapshot(f.journal.path), ended = entries.filter(e => e.type === "ended" && e.call === f.ticket.callId);
    const procs = ended.flatMap(e => e.procs as { pid: number; command: string }[]);
    assert.ok(procs.some(p => /(?:^|\s)sleep 300(?:\s|$)/.test(p.command)), `sleep argv in durable journal: ${JSON.stringify(ended)}`);
    const direct = entries.find(e => e.type === "tracked")!;
    assert.ok(!procs.some(p => p.pid === direct.pid), "direct pi child excluded");
    assert.ok(ended.every(e => e.exec === `${f.ticket.callId}#1.1`));
    assert.ok(ended.every(e => e.seq < entries.find(r => r.type === "sealed")!.seq));
    assert.ok(!(await new ProcessTable().list(new Set([`${f.ticket.callId}#1.1`]), { fresh: true })).some(p => p.pid === pid), "the background process cannot act after seal (zombies are retired)");
  });

test("EX3 command call finds the real shim with custom PATH lacking dsa (no version dependency)", { timeout: 30_000 }, async t => {
  const f = await setup(t);
  const root = process.env.SystemRoot ?? "C:\Windows";
  f.ticket.spec = { ...f.ticket.spec,
    command: process.platform === "win32" ? ["cmd", "/d", "/s", "/c", "where pi-durable-subagents.cmd"] : ["/bin/sh", "-c", "command -v pi-durable-subagents"],
    env: { PATH: process.platform === "win32" ? `${join(root, "System32")};${root}` : "/usr/bin:/bin" } };
  const result = await f.executor.run(f.ticket);
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal((result.data as { exitCode: number }).exitCode, 0);
  assert.equal(result.output.trim(), join(binDir(f.home), process.platform === "win32" ? "pi-durable-subagents.cmd" : "pi-durable-subagents"));
  assert.ok(!f.journal.entries().some(e => e.type === "ended"), "command fences remain out of scope");
});
