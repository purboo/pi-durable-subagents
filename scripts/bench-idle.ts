// Run with node scripts/bench-idle.ts [--workflows=300] [--seconds=30] [--entries=200] [--keep]
// Idle cost of an orchestrator over many finished workflows: N finished workflows are written through the kernel
// journal API in a temporary home, then a real orchestrator process (src/orchestrator/main.ts, the real executor and
// evaluator) is started on that home with nothing live, and its CPU ticks, read bytes (/proc/<pid>/io rchar), read
// syscalls and open journal descriptors are sampled from /proc for the measured interval. Linux only.
import { mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
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
  await writeFile(join(cwd, ".pi/agents/echo.md"), "---\nname: echo\ndescription: echo\n---\nEcho.\n");
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
  child = spawn(process.execPath, [entry], { env: { ...process.env, DSA_HOME: home, PI_OFFLINE: "1" }, stdio: ["ignore", "ignore", "inherit"] });
  // Recovery and the first passes are outside the measurement.
  await delay(Math.max(5000, count * 20));
  if (child.exitCode !== null) throw new Error(`orchestrator exited early: ${child.exitCode}`);
  const before = await proc(child.pid!), started = performance.now();
  await delay(seconds * 1000);
  const after = await proc(child.pid!), elapsed = (performance.now() - started) / 1000;
  const tck = 100;
  console.log(JSON.stringify({
    workflows: count, entriesPerWorkflow: entries + 6, seconds: Number(elapsed.toFixed(1)),
    cpuCores: Number(((after.ticks - before.ticks) / tck / elapsed).toFixed(4)), ticksPer10s: Number(((after.ticks - before.ticks) * 10 / elapsed).toFixed(1)), userTicks: after.user - before.user, systemTicks: after.system - before.system,
    rcharPer10s: Math.round((after.rchar - before.rchar) * 10 / elapsed), readSyscallsPerSecond: Number(((after.syscr - before.syscr) / elapsed).toFixed(1)),
    openJournals: after.journals,
    stats: await readFile(join(home, "orchestrator-stats.json"), "utf8").then(JSON.parse, () => undefined),
  }));
} finally {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await new Promise(resolve => child!.once("exit", resolve)); }
  if (!keep) await rm(root, { recursive: true, force: true });
  else console.error(`home kept: ${home}`);
}
