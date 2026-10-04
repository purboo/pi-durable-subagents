import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** P29: Observe available memory in MB; capability errors refuse dispatch instead of bypassing V1. */
export async function availableMemory(): Promise<number> {
  if (process.platform === "linux") {
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(await readFile("/proc/meminfo", "utf8"));
    if (!match) throw new Error("P29: MemAvailable unavailable");
    return Number(match[1]) / 1024;
  }
  if (process.platform === "darwin") {
    const { stdout } = await promisify(execFile)("vm_stat", [], { timeout: 2000 });
    const page = Number(/page size of (\d+) bytes/.exec(stdout)?.[1]);
    const pages = ["free", "inactive", "speculative"].reduce((n, name) => n + Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(stdout)?.[1] ?? 0), 0);
    if (!(page > 0)) throw new Error("P29: vm_stat unavailable");
    return pages * page / 1024 / 1024;
  }
  throw new Error(`P29 capability unavailable: ${process.platform}`);
}
