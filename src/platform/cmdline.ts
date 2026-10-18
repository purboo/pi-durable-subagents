import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { PS } from "./proctable.ts";

const exec = promisify(execFile);
/** EX1: A diagnostic argv, never evidence of identity or death. Unreadable processes have an empty command. */
export async function commandLine(pid: number, signal?: AbortSignal): Promise<string> {
  try {
    if (process.platform === "linux")
      return (await readFile(`/proc/${pid}/cmdline`, { encoding: "utf8", signal })).replace(/\0/g, " ").trimEnd().slice(0, 200);
    if (process.platform === "darwin")
      return (await exec(PS, ["-o", "command=", "-p", String(pid)], { signal, timeout: 450, maxBuffer: 1024 * 1024 })).stdout.trim().slice(0, 200);
  } catch { /* Diagnostics must not prevent a fence. */ }
  return "";
}
