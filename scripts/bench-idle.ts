// Run with node scripts/bench-idle.ts [--workflows=300] [--seconds=30] [--entries=200] [--live=0] [--pad-mb=20]
//   [--append-kb=8] [--every-s=5] [--keep]
// Idle cost of an orchestrator over many finished workflows: N finished workflows are written through the kernel
// journal API in a temporary home, then a real orchestrator process (src/orchestrator/main.ts, the real executor and
// evaluator) is started on that home with nothing live, and its CPU ticks, read bytes (/proc/<pid>/io rchar), read
// syscalls and open journal descriptors are sampled from /proc for the measured interval. Linux only.
// --live=N adds N live calls (real pi with the scripted faux provider): each runs a bash tool that prints
// --append-kb KiB every --every-s seconds, and its session file is first padded to --pad-mb MiB with realistic
// assistant/tool-result message pairs (about 5 KiB per entry) (as a call with hundreds of large tool results has). Only the orchestrator
// process is measured, not the pi children.
import { mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { appendFile, stat } from "node:fs/promises";
import { publishRequest } from "../src/kernel/mailbox.ts";
import { orchInbox, journalPath } from "../src/paths.ts";
import { readJournalSnapshot } from "../src/kernel/journal.ts";
import { FAUX, REPO, script } from "../test/harness/pi.ts";
import { openJournal } from "../src/kernel/journal.ts";
import { orchLedger } from "../src/paths.ts";
import { Store } from "../src/orchestrator/store.ts";
import { JT, type Request, type RunBody } from "../src/types.ts";

if (process.platform !== "linux") throw new Error("bench-idle reads /proc: Linux only");
const option = (name: string, fallback: number) => {
  const value = Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
};
const count = option("workflows", 300), seconds = option("seconds", 30), entries = option("entries", 200);
const keep = process.argv.includes("--keep");
const live = option("live", 0), padMb = option("pad-mb", 20), appendKb = option("append-kb", 8), every = option("every-s", 5);
const root = mkdtempSync(join(tmpdir(), "dsa-idle-")), home = join(root, "dsa"), cwd = join(root, "work");
const entry = fileURLToPath(new URL("../src/orchestrator/main.ts", import.meta.url));

async function proc(pid: number) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const io = Object.fromEntries((await readFile(`/proc/${pid}/io`, "utf8")).trim().split("\n").map(l => { const [k, v] = l.split(":"); return [k!, Number(v)]; }));
  let journals = 0;
  for (const fd of await readdir(`/proc/${pid}/fd`).catch(() => [] as string[])) {
    const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
    if (target.endsWith("/journal.jsonl")) journals++;
  }
  return { ticks: Number(fields[11]) + Number(fields[12]), user: Number(fields[11]), system: Number(fields[12]), rchar: io.rchar ?? 0, syscr: io.syscr ?? 0, journals };
}

let child: ReturnType<typeof spawn> | undefined;
try {
  await mkdir(join(cwd, ".pi/agents"), { recursive: true });
  await writeFile(join(cwd, ".pi/agents/echo.md"), "---\nname: echo\ndescription: echo\ntools: bash\n---\nFollow the script.\n");
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [FAUX], defaultProvider: "probe", defaultModel: "scripted" }));
  const orch = await openJournal(orchLedger(home)), store = new Store({ home, orch, config: {} });
  try {
    for (let i = 0; i < count; i++) {
      const req: Request<RunBody> = { rid: `finished-${i}`, from: "bench", to: "orch", sseq: i + 1, kind: "run", body: { cwd, source: "return 1;" } };
      await store.stage(req, { home: root, agentDir: join(root, "agent"), globalNpmRoot: null });
      const wf = await store.create(req), call = `${wf.wid}@1/old@1`, exec = `${call}#1.1`;
      await wf.journal.append("call", { pos: 0, key: "old", gen: 1, spec: { agent: "echo", task: "historical" }, fingerprint: "x" });
      await wf.journal.append(JT.exec, { exec, call });
      for (let k = 0; k < entries; k++) await wf.journal.append("observation", { exec, event: { type: "message_update", text: "x".repeat(200) } });
      await wf.journal.append(JT.fenced, { exec });
      await wf.journal.append(JT.sealed, { call, exec, result: { key: "old", gen: 1, status: "ok", ok: true, output: "done" } });
      await wf.journal.append(JT.done, { status: "done", result: 1 });
    }
  } finally { await store.close(); await orch.close(); }
  await writeFile(join(home, "config.json"), JSON.stringify({ k: { idleExitMs: (seconds + 120) * 1000 } }));
  if (live) {
    const loop = { tool: "bash", args: { command: `sleep ${every}; head -c ${appendKb * 1024} /dev/zero | tr '\\0' x` } };
    const task = script([{ tool: "bash", args: { command: "sleep 15" } }, ...Array.from({ length: 400 }, () => loop)]);
    await publishRequest(orchInbox(home), { rid: "live", from: "bench-live", to: "orch", sseq: 1, kind: "run", body: { cwd, tasks: Array.from({ length: live }, () => ({ agent: "echo", task })) } } as Request);
  }
  child = spawn(process.execPath, [entry], { env: { ...process.env, DSA_HOME: home, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: agentDir, PROBE_DIR: root,
    PATH: `${join(REPO, "node_modules/.bin")}:${process.env.PATH}` }, stdio: ["ignore", "ignore", "inherit"] });
  if (live) {
    // Pad each session while its first (15 s) tool runs: whole lines appended with O_APPEND, as pi appends.
    const deadline = Date.now() + 60_000;
    let wid: string | undefined, sessions: string[] = [];
    while (sessions.length < live) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error("live calls did not start");
      wid ??= readJournalSnapshot(orchLedger(home)).find(e => e.type === JT.created && e.rid === "live")?.wid as string | undefined;
      if (wid) {
        const started = readJournalSnapshot(journalPath(home, wid)).filter(e => e.type === "observation" && (e.event as { type?: string }).type === "tool_execution_start");
        if (started.length >= live) sessions = Array.from({ length: live }, (_, i) => join(home, "w", wid!, "x", `${encodeURIComponent(`tasks:${i}`)}@1`, "session.jsonl"));
      }
      await delay(200);
    }
    // Mostly small results with an occasional large one: about 5 KiB per entry on average, as in long real sessions.
    const text = (n: number) => "y".repeat(n % 20 === 0 ? 48 * 1024 : 2 * 1024 + (n % 7) * 512);
    let ts = Date.now() - 86_400_000;
    for (const session of sessions) {
      const lines: string[] = [];
      for (let n = 0, bytes = 0; bytes < padMb * 1024 * 1024; n++) {
        const id = `pad${n}`, t = ++ts;
        const a = JSON.stringify({ type: "message", id: `a${n}`, parentId: null, timestamp: new Date(t).toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: `/tmp/file${n}.txt` } }], api: "anthropic-messages", provider: "probe", model: "scripted", usage: { input: 4, output: 78, cacheRead: 2605, cacheWrite: 3885, totalTokens: 6572, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: t } });
        const r = JSON.stringify({ type: "message", id: `r${n}`, parentId: `a${n}`, timestamp: new Date(t).toISOString(), message: { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: text(n) }], isError: false, timestamp: t } });
        lines.push(a, r); bytes += a.length + r.length + 2;
      }
      await appendFile(session, `${lines.join("\n")}\n`);
    }
    console.error(`padded: ${(await Promise.all(sessions.map(s => stat(s)))).map(s => (s.size / 1048576).toFixed(1)).join(", ")} MiB`);
  }
  // Recovery, padding and the first passes are outside the measurement.
  await delay(Math.max(live ? 20_000 : 5000, count * 20));
  if (child.exitCode !== null) throw new Error(`orchestrator exited early: ${child.exitCode}`);
  const before = await proc(child.pid!), started = performance.now();
  await delay(seconds * 1000);
  const after = await proc(child.pid!), elapsed = (performance.now() - started) / 1000;
  const tck = 100;
  console.log(JSON.stringify({
    workflows: count, live, padMb, appendKb, everyS: every, entriesPerWorkflow: entries + 6, seconds: Number(elapsed.toFixed(1)),
    cpuCores: Number(((after.ticks - before.ticks) / tck / elapsed).toFixed(4)), ticksPer10s: Number(((after.ticks - before.ticks) * 10 / elapsed).toFixed(1)), userTicks: after.user - before.user, systemTicks: after.system - before.system,
    rcharPer10s: Math.round((after.rchar - before.rchar) * 10 / elapsed), readSyscallsPerSecond: Number(((after.syscr - before.syscr) / elapsed).toFixed(1)),
    openJournals: after.journals,
    stats: await readFile(join(home, "orchestrator-stats.json"), "utf8").then(JSON.parse, () => undefined),
  }));
} finally {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await new Promise(resolve => child!.once("exit", resolve)); }
  // The orchestrator fences its children on exit; anything still tagged with this home is killed here.
  for (const pid of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(pid)) continue;
    const env = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
    if (env.split("\0").includes(`DSA_HOME=${home}`)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  }
  await delay(500);
  if (!keep) await rm(root, { recursive: true, force: true });
  else console.error(`home kept: ${home}`);
}
