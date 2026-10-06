// Isolated pi RPC harness for tests. Never touches the user's ~/.pi: every instance gets its own
// PI_CODING_AGENT_DIR, session dir and cwd under a temp root, and loads the faux provider.
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "../..");
export const PI_BIN = path.join(REPO, "node_modules/.bin/pi");
export const FAUX = path.join(HERE, "faux-provider.ts");

// Tests must never reach a real provider: drop provider credentials from this process and everything it spawns.
for (const key of Object.keys(process.env)) if (/(_API_KEY|_AUTH_TOKEN|_ACCESS_TOKEN)$/.test(key)) delete process.env[key];

export interface PiEvent { type: string; _t: number; [k: string]: unknown }

export interface PiInstance {
  dir: string;
  child: ChildProcess;
  events: PiEvent[];
  stderr: string[];
  exited(): { code: number | null; signal: string | null } | null;
  send(cmd: Record<string, unknown>): string;
  waitFor(pred: (e: PiEvent) => boolean, ms?: number): Promise<PiEvent>;
  sessionFile(): string | null;
  sessionEntries(): any[];
  stop(): Promise<void>;
}

export function tempRoot(prefix = "dsa-test-"): string {
  // Real path: pi reports its cwd resolved (macOS: /var is /private/var), so expectations must use the same form.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A shell snippet that starts `sleep <s>` in a new session (detached, like setsid, which macOS lacks) and prints its pid. */
export const detachedSleep = (seconds: number) =>
  `'${process.execPath}' -e 'const c = require("child_process").spawn("sleep", ["${seconds}"], { detached: true, stdio: "ignore" }); console.log(c.pid); c.unref()'`;
export const script = (steps: unknown[]) => `#script: ${JSON.stringify(steps)}`;

export function startPi(opts: { root: string; name: string; extensions?: string[]; args?: string[]; env?: Record<string, string>; model?: boolean }): PiInstance {
  const dir = path.join(opts.root, opts.name);
  for (const d of ["agent", "work", "sessions"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const env: Record<string, string | undefined> = {
    ...process.env, PROBE_DIR: dir, PI_CODING_AGENT_DIR: path.join(dir, "agent"),
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", ...opts.env,
  };
  delete env.PI_SESSION_FILE; delete env.PI_SESSION_ID;
  const extArgs = [FAUX, ...(opts.extensions ?? [])].flatMap(e => ["-e", e]);
  const modelArgs = opts.model === false ? [] : ["--provider", "probe", "--model", "scripted"];
  const args = ["--mode", "rpc", ...extArgs, ...modelArgs, "--session-dir", path.join(dir, "sessions"), ...(opts.args ?? [])];
  const child = spawn(PI_BIN, args, { cwd: path.join(dir, "work"), env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const events: PiEvent[] = [];
  const waiters: { pred: (e: PiEvent) => boolean; resolve: (e: PiEvent) => void }[] = [];
  let buf = "";
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let ev: PiEvent;
      try { ev = { ...JSON.parse(line), _t: Date.now() }; } catch { ev = { type: "unparsed", line, _t: Date.now() }; }
      events.push(ev);
      for (const w of [...waiters]) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
    }
  });
  const stderr: string[] = [];
  child.stderr!.on("data", (d: Buffer) => stderr.push(d.toString()));
  let exit: { code: number | null; signal: string | null } | null = null;
  child.on("exit", (code, signal) => { exit = { code, signal }; });
  let n = 0;
  const api: PiInstance = {
    dir, child, events, stderr,
    exited: () => exit,
    send(cmd) { const id = `r${++n}`; child.stdin!.write(JSON.stringify({ id, ...cmd }) + "\n"); return id; },
    waitFor(pred, ms = 20000) {
      const hit = events.find(pred); if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); reject(new Error(`timeout waiting in ${opts.name}; stderr=${stderr.join("").slice(-500)}`)); } }, ms);
        const w = { pred, resolve: (e: PiEvent) => { clearTimeout(timer); resolve(e); } }; waiters.push(w);
      });
    },
    sessionFile() {
      const s = path.join(dir, "sessions");
      const f = (fs.readdirSync(s, { recursive: true }) as string[]).map(String).filter(x => x.endsWith(".jsonl"));
      return f.length ? path.join(s, f[0]!) : null;
    },
    sessionEntries() {
      const f = api.sessionFile();
      return f ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
    },
    async stop() {
      try { child.stdin!.end(); } catch {}
      for (let i = 0; i < 50 && !exit; i++) await new Promise(r => setTimeout(r, 100));
      if (!exit && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
    },
  };
  return api;
}

export const settled = (e: PiEvent) => e.type === "agent_settled";
