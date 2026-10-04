import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { captureStart, ProcessTable } from "../../platform/proctable.ts";
import { Containment } from "../../platform/containment.ts";
import { readJournalSnapshot } from "../../kernel/journal.ts";
import { orchLedger, journalPath } from "../../paths.ts";
import { JT } from "../../types.ts";

/** Read complete JSONL records, tolerating only a concurrently written tail. */
export function rows(path: string): any[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n"); lines.pop();
  return lines.filter(Boolean).map(line => JSON.parse(line));
}
/** Poll evidence with a fixed deadline instead of holding an unbounded process wait. */
export async function until<T>(get: () => T | Promise<T>, label: string, ms = 60_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  do { const value = await get(); if (value) return value as NonNullable<T>; await delay(40); } while (Date.now() < end);
  throw new Error(`deadline: ${label}`);
}
/** Encode a script carried by a real task or main-session prompt. */
export function script(steps: unknown[]): string { return `#chaos: ${JSON.stringify(steps)}`; }
/** Start an isolated real pi main, retaining RPC and diagnostic evidence. */
export function stack(root: string, inherited: NodeJS.ProcessEnv) {
  const home = join(root, "dsa"), cwd = join(root, "work"), agent = join(root, "agent"), session = join(root, "main.jsonl");
  for (const dir of [home, agent, join(root, "home"), join(cwd, ".pi/agents")]) mkdirSync(dir, { recursive: true });
  const sibling = (name: string) => fileURLToPath(new URL(name + (import.meta.url.endsWith(".ts") ? ".ts" : ".js"), import.meta.url));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ extensions: [sibling("../../agent/extension"), sibling("./provider")],
    defaultProvider: "dsa-chaos", defaultModel: "scripted", retry: { enabled: false }, compaction: { enabled: false }, defaultProjectTrust: "always" }));
  writeFileSync(join(home, "config.json"), JSON.stringify({ providers: { "dsa-chaos": 3 }, k: { trackerMs: 100, checkpointMs: 200, idleExitMs: 2000 } }));
  for (const name of ["writer", "reviewer", "integrator"]) writeFileSync(join(cwd, `.pi/agents/${name}.md`), `---\nname: ${name}\ndescription: Chaos ${name}\nmodel: dsa-chaos/scripted\ntools: bash, ask\n---\nFollow the scripted task.\n`);
  const env = { PATH: inherited.PATH, HOME: join(root, "home"), TMPDIR: root, PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", DSA_HOME: home, DSA_CHAOS_ROOT: root, DSA_ORCHESTRATOR_ENTRY: sibling("./host") };
  const instances: { child: ChildProcessWithoutNullStreams; events: any[]; prompt(steps: unknown[]): Promise<void> }[] = [];
  function launch() {
    let child!: ChildProcessWithoutNullStreams, events: any[] = [], buffer = "", error: Error | undefined, requestId = 0, ready = false;
    const start = () => {
      child = spawn("pi", ["--mode", "rpc", "--session", session], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      events = []; buffer = ""; error = undefined; const own = child;
      child.on("error", e => { if (own === child) error = e; }); child.stdin.on("error", e => { if (own === child) error = e; });
      child.stdout.on("data", data => {
        appendFileSync(join(root, "rpc.jsonl"), data);
        if (own !== child) return;
        buffer += data.toString();
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); try { events.push(JSON.parse(line)); } catch {} }
      });
      child.stderr.on("data", data => appendFileSync(join(root, "pi-stderr.log"), data));
    };
    start();
    async function request(command: Record<string, unknown>) {
      const id = `chaos-${++requestId}`;
      child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
      const response = await until(() => {
        if (error) throw error;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error("main pi exited before RPC response");
        return events.find(e => e.type === "response" && e.id === id);
      }, `RPC ${command.type}`, 10_000);
      if (!response.success) throw new Error(`RPC ${command.type}: ${response.error}`);
      return response;
    }
    // pi 1.0.2 occasionally starts with the extension-registered scripted provider missing (model "unknown"; no
    // diagnostic on RPC stderr). That is a pi startup fault outside the product under test: record it, restart
    // the main pi on the same (still empty) session, and count the restart in the report.
    async function readiness() {
      for (let attempt = 1; ; attempt++) {
        try {
          await until(async () => {
            const state = (await request({ type: "get_state" })).data;
            appendFileSync(join(root, "readiness.jsonl"), JSON.stringify({ pid: child.pid, attempt, state }) + "\n");
            return state?.model?.provider === "dsa-chaos" && state.model.id === "scripted";
          }, "scripted model ready", 8_000);
          return;
        } catch (failure) {
          if (attempt >= 3) throw failure;
          appendFileSync(join(root, "pi-startup-retries.jsonl"), JSON.stringify({ pid: child.pid, attempt, reason: String(failure) }) + "\n");
          try { process.kill(-child.pid!, "SIGKILL"); } catch {}
          await until(() => child.exitCode !== null || child.signalCode !== null, "unready main exited", 5_000);
          start();
        }
      }
    }
    const pi = { get child() { return child; }, get events() { return events; }, async prompt(steps: unknown[]) {
      if (!ready) { await readiness(); ready = true; }
      const from = events.length;
      await request({ type: "prompt", message: script(steps) });
      await until(() => { if (error) throw error; return events.slice(from).some(e => e.type === "agent_settled"); }, "main settled");
    } };
    instances.push(pi); return pi;
  }
  const ledger = () => readJournalSnapshot(orchLedger(home));
  const journal = (wid: string) => readJournalSnapshot(journalPath(home, wid));
  async function signalHost(signal: NodeJS.Signals) {
    const host = rows(join(root, "hosts.jsonl")).at(-1);
    if (!host || await captureStart(host.pid) !== host.start) throw new Error("host identity unavailable");
    process.kill(host.pid, signal); return host;
  }
  async function close() {
    for (const pi of instances) if (pi.child.exitCode === null && pi.child.signalCode === null) { try { process.kill(-pi.child.pid!, "SIGKILL"); } catch {} }
    for (const pi of instances) { pi.child.stdin.destroy(); pi.child.stdout.destroy(); pi.child.stderr.destroy(); pi.child.unref(); }
    for (const host of rows(join(root, "hosts.jsonl"))) if (await captureStart(host.pid) === host.start) {
      process.kill(host.pid, "SIGCONT"); process.kill(host.pid, "SIGTERM");
      try { await until(async () => await captureStart(host.pid) !== host.start, "host shutdown", 8000); }
      catch { if (await captureStart(host.pid) === host.start) process.kill(host.pid, "SIGKILL"); }
    }
    const containment = new Containment(new ProcessTable());
    for (const created of ledger().filter(e => e.type === JT.created)) for (const exec of journal(String(created.wid)).filter(e => e.type === JT.exec))
      await containment.fence(String(exec.exec), journal(String(created.wid)).filter(e => e.type === "tracked" && e.exec === exec.exec).map(e => ({ pid: Number(e.pid), ppid: 0, start: String(e.start) })));
  }
  return { root, home, cwd, session, launch, ledger, journal, signalHost, close };
}
