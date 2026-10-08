// Run with node [--cpu-prof] scripts/bench-orchestrator.ts idle-history|streaming [--seconds=30] [--workflows=100] [--entries=300000] [--idle-processes=200].
// Preparation/recovery are outside the measured interval. Only this process's CPU is charged.
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FAUX, REPO, script, tempRoot } from "../test/harness/pi.ts";
import { openJournal, readJournalSnapshot } from "../src/kernel/journal.ts";
import { publishRequest } from "../src/kernel/mailbox.ts";
import { orchLedger, orchInbox, journalPath } from "../src/paths.ts";
import { Store } from "../src/orchestrator/store.ts";
import { snapshotFromEntries } from "../src/orchestrator/snapshot.ts";
import { main } from "../src/orchestrator/main.ts";
import { ProcessTable } from "../src/platform/proctable.ts";
import { JT, type Request, type RunBody } from "../src/types.ts";
const scenario = process.argv[2] ?? "idle-history";
if (!["idle-history", "streaming"].includes(scenario)) throw new Error("Unknown scenario");
const option = (name: string, fallback: number) => {
  const value = Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
};
const seconds = option("seconds", 30), count = option("workflows", 100), volume = option("entries", 300000);
if (seconds < 1 || seconds > 35 || count < 1) throw new Error("Measurement must be 1..35 seconds and workflows must be positive");
const root = tempRoot("dsa-bench-"), home = join(root, "dsa"), cwd = join(root, "work"), agentDir = join(root, "agent");
const controller = new AbortController(), sleepers: ChildProcess[] = [];
let orchestrator: Promise<void> | undefined, failure: unknown, stopped = false;
let scans = 0;
const original = ProcessTable.prototype.list;
// Baseline counts list calls (= scans); optimized implementation exposes the physical scan count.
ProcessTable.prototype.list = async function (...args: Parameters<typeof original>) {
  const before = (this as ProcessTable & { scans?: number }).scans;
  const pending = original.apply(this, args);
  const after = (this as ProcessTable & { scans?: number }).scans;
  scans += before === undefined ? 1 : (after ?? 0) - before;
  return pending;
};
try {
  Object.assign(process.env, { PATH: `${join(REPO, "node_modules/.bin")}:${process.env.PATH}`, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PROBE_DIR: root });
  await mkdir(join(cwd, ".pi/agents"), { recursive: true }); await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [FAUX], defaultProvider: "probe", defaultModel: "scripted" }));
  await writeFile(join(cwd, ".pi/agents/echo.md"), "---\nname: echo\ndescription: echo\ntools: bash\n---\nFollow the script.\n");
  if (scenario === "idle-history") {
    const orch = await openJournal(orchLedger(home)), store = new Store({ home, orch, config: {} });
    try {
      let remaining = volume;
      for (let i = 0; i < count; i++) {
        const req: Request<RunBody> = { rid: `history-${i}`, from: "bench", to: "orch", sseq: i + 1, kind: "run", body: { cwd, source: "return 1;" } };
        await store.stage(req, { home: root }); const wf = await store.create(req);
        const n = i < Math.min(3, count - 1) ? Math.min(option("large-entries", 15000), Math.floor(volume / 6), remaining) : Math.floor(remaining / (count - i)); remaining -= n;
        // Fixture bulk writer uses the real journal envelope/CRC; Store recovery validates every record.
        // Avoid 300k fsyncs in setup, which would dominate the bounded benchmark's wall time.
        let seq = wf.journal.entries().length;
        await wf.journal.close();
        const exec = `${wf.wid}@1/old@1#1.1`, call = `${wf.wid}@1/old@1`, rows: string[] = [];
        const add = (type: string, fields: object) => {
          const json = JSON.stringify({ ...fields, seq: ++seq, ts: Date.now(), type });
          rows.push(`${crc32(Buffer.from(json)).toString(16).padStart(8, "0")} ${json}\n`);
        };
        add("call", { key: "old", gen: 1, spec: { agent: "echo", task: "historical" } });
        add(JT.exec, { exec, call });
        for (let k = 0; k < n; k++) add("tracked", { exec, pid: 1000000 + k, start: String(k) });
        add(JT.fenced, { exec });
        add(JT.sealed, { call, result: { key: "old", gen: 1, status: "ok", ok: true, output: "done" } });
        add(JT.done, { status: "done", result: 1 });
        add(JT.attention, { item: { id: `finished:${wf.wid}`, rev: 1, kind: "finished", wid: wf.wid, text: "history" } });
        const file = await open(journalPath(home, wf.wid), "a");
        try { await file.writeFile(rows.join("")); await file.sync(); } finally { await file.close(); }
        if (i === 0) {
          const check = await openJournal(journalPath(home, wf.wid));
          try {
            const snapshot = snapshotFromEntries(wf.wid, check.entries());
            if (check.entries().length !== seq || snapshot.status !== "done" || snapshot.calls[0]?.result?.status !== "ok") throw new Error("Invalid history fixture");
          } finally { await check.close(); }
        }
      }
    } finally { await store.close(); await orch.close(); }
  } else {
    for (let i = 0; i < option("idle-processes", 200); i++) sleepers.push(spawn("sleep", ["90"], { stdio: "ignore" }));
  }
  const calls = scenario === "streaming" ? 4 : 1;
  const task = scenario === "streaming"
    ? script([{ tool: "bash", args: { command: "(for i in $(seq 1 600); do sleep 0.05; done) >/dev/null 2>&1 &" } }, { text: "stream token ".repeat(10000) }])
    : script([{ tool: "bash", args: { command: "sleep 90" } }, { text: "done" }]);
  await publishRequest(orchInbox(home), { rid: "live", from: "bench-live", to: "orch", sseq: 1, kind: "run", body: { cwd, tasks: Array.from({ length: calls }, () => ({ agent: "echo", task })) } });
  orchestrator = main({ home, signal: controller.signal, discovery: { home: root }, config: { memory: { reserveMb: 0, perChildMb: 1 }, k: { idleExitMs: 60000 } } });
  void orchestrator.then(() => { stopped = true; }, e => { failure = e; });
  let wid: string | undefined;
  const deadline = Date.now() + 60000;
  while (true) {
    if (failure) throw failure;
    if (stopped || Date.now() > deadline) throw new Error(`Live calls did not start: ${JSON.stringify({ ledger: readJournalSnapshot(orchLedger(home)), workflow: wid ? readJournalSnapshot(journalPath(home, wid)) : [] })}`);
    wid ??= readJournalSnapshot(orchLedger(home)).find(e => e.type === JT.created && e.rid === "live")?.wid as string | undefined;
    if (wid && readJournalSnapshot(journalPath(home, wid)).filter(e => e.type === "observation" && (e.event as { type?: string }).type === "tool_execution_start").length >= calls) break;
    await delay(100);
  }
  await delay(3000);
  const cpu = process.cpuUsage(), started = performance.now(), beforeScans = scans;
  let rss = 0, heap = 0, samples = 0;
  while ((performance.now() - started) / 1000 < seconds) { await delay(1000); const m = process.memoryUsage(); rss += m.rss; heap += m.heapUsed; samples++; }
  if (failure) throw failure;
  if (stopped) throw new Error("Orchestrator stopped during measurement");
  const elapsed = (performance.now() - started) / 1000, used = process.cpuUsage(cpu);
  console.log(JSON.stringify({ scenario, seconds: elapsed, calls, historyWorkflows: scenario === "idle-history" ? count : 0, historyEntries: scenario === "idle-history" ? volume : 0, largeEntries: scenario === "idle-history" ? option("large-entries", 15000) : 0, cpuCores: (used.user + used.system) / 1e6 / elapsed, rssMb: rss / samples / 1048576, heapMb: heap / samples / 1048576, scansPerSecond: (scans - beforeScans) / elapsed }));
} finally {
  controller.abort(); await orchestrator?.catch(() => {});
  for (const child of sleepers) if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.all(sleepers.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once("exit", () => resolve()))));
  ProcessTable.prototype.list = original;
  await rm(root, { recursive: true, force: true });
}
