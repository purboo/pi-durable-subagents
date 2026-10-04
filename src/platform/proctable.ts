// C2: macOS ps flattens argv and environment without preserving boundaries.
// Known-id filtering assumes argv/other values do not impersonate the sole known
// execution id. Multiple known ids are ambiguous; macOS verification awaits CI.
import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProcInfo, ProcessTable as Table } from "../types.ts";

const exec = promisify(execFile);
const vanished = (error: unknown) => ["ENOENT", "ESRCH", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "");

type Observation = ProcInfo & { ambiguous?: true };

/** C2, C3: Capture only the newly spawned pid; an absent or dead process has no token. */
export async function captureStart(pid: number): Promise<string> {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[0] === "Z" || fields[0] === "X" ? "" : fields[19]!;
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return "";
      throw error;
    }
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await exec("ps", ["-o", "lstart=", "-p", String(pid)],
        { env: { ...process.env, LC_ALL: "C" }, timeout: 2000 });
      return stdout.trim().replace(/\s+/g, " ");
    } catch (error) {
      // ps exits 1 with empty output when the selected pid has already gone.
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      if (failure.code === 1 && failure.stdout?.trim() === "" && failure.stderr?.trim() === "") return "";
      throw error;
    }
  }
  throw new Error(`C2 capability unavailable: ${process.platform}`);
}

/** C2: Observe live process identities, inherited tags and cumulative CPU time. */
export class ProcessTable implements Table {
  private tags = new Map<string, string | undefined>();
  private ticks?: Promise<number>;
  private platform: NodeJS.Platform;
  private ps: () => Promise<string>;

  constructor(options: { platform?: NodeJS.Platform; ps?: () => Promise<string> } = {}) {
    this.platform = options.platform ?? process.platform;
    this.ps = options.ps ?? (async () => (await exec("ps",
      ["-axEww", "-o", "pid=,ppid=,lstart=,time=,stat=,command="],
      { env: { ...process.env, LC_ALL: "C" }, timeout: 2000, maxBuffer: 32 * 1024 * 1024 })).stdout);
  }

  /** C2: Return a fresh process snapshot, caching Linux environments by identity. */
  async list(knownExecs: ReadonlySet<string> = new Set()): Promise<Observation[]> {
    if (this.platform === "darwin") return this.mac(knownExecs);
    if (this.platform !== "linux") throw new Error(`C2 capability unavailable: ${this.platform}`);
    this.ticks ??= exec("getconf", ["CLK_TCK"], { timeout: 2000 }).then(({ stdout }) => {
      const value = Number(stdout.trim());
      if (!(value > 0)) throw new Error("C2: invalid CLK_TCK");
      return value;
    });
    const ticks = await this.ticks;
    const result: ProcInfo[] = [];
    const cache = new Map<string, string | undefined>();
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = await readFile(`/proc/${name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        // Zombies cannot act and may remain indefinitely under a non-reaping init.
        if (fields[0] === "Z" || fields[0] === "X") continue;
        const start = fields[19]!;
        const key = `${name}:${start}`;
        let tag = this.tags.get(key);
        if (!this.tags.has(key)) {
          try {
            const env = await readFile(`/proc/${name}/environ`, "utf8");
            tag = env.split("\0").find(value => value.startsWith("DSA_EXEC="))?.slice(9);
          } catch (error) { if (!vanished(error)) throw error; }
        }
        // Do not attach an old environment to a reused pid.
        const check = await readFile(`/proc/${name}/stat`, "utf8");
        if (check.slice(check.lastIndexOf(")") + 2).split(" ")[19] !== start) continue;
        cache.set(key, tag);
        result.push({ pid: Number(name), ppid: Number(fields[1]), start, tag,
          cpuMs: (Number(fields[11]) + Number(fields[12])) * 1000 / ticks });
      } catch (error) { if (!vanished(error)) throw error; }
    }
    this.tags = cache;
    return result;
  }

  private async mac(knownExecs: ReadonlySet<string>): Promise<Observation[]> {
    const stdout = await this.ps();
    const result: Observation[] = [];
    for (const line of stdout.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+([\d:.-]+)\s+(\S+)\s+(.*)$/);
      if (!match || match[5]!.startsWith("Z")) continue;
      const parts = match[4]!.split(":").map(Number);
      const seconds = parts.reduce((total, part) => total * 60 + part, 0);
      const tags = new Set([...match[6]!.matchAll(/(?:^|\s)DSA_EXEC=([^\s]*)/g)]
        .map(token => token[1]!).filter(tag => knownExecs.has(tag)));
      result.push({ pid: Number(match[1]), ppid: Number(match[2]), start: match[3]!.replace(/\s+/g, " "),
        tag: tags.size === 1 ? tags.values().next().value : undefined, cpuMs: seconds * 1000,
        ...(tags.size > 1 ? { ambiguous: true as const } : {}) });
    }
    return result;
  }
}
