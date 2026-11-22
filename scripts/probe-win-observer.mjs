// Windows-only probe: how far does a PowerShell/CIM process-table scan depend on the caller's environment?
// The orchestrator is regularly handed an isolated environment (a chaos/drill/e2e fixture, the evaluator host, a service
// starter): PATH and HOME, no SystemRoot, TEMP, USERPROFILE, ComSpec or PSModulePath. On native Windows Node 24 that
// environment made the fence time out at its full 15 s budget while the sweep reported a failed Get-CimInstance.
//   node scripts/probe-win-observer.mjs
// Prints one line per environment variant (wall time of each scan, or its failure) and one line for four concurrent
// scans, which is what the tracker's period and several workflows ask of the observer. Read-only: it starts
// powershell.exe, writes nothing and changes no state.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IS_WINDOWS, helperEnv, powershellPath } from "../src/platform/windows.ts";

const exec = promisify(execFile);
const SCAN = "Get-CimInstance Win32_Process | Measure-Object | ForEach-Object { $_.Count }";
const FLAGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCAN];
const TIMEOUT = 20_000, ROUNDS = 2;

if (!IS_WINDOWS) { console.log("probe-win-observer: Windows only; nothing to measure on " + process.platform); process.exit(0); }

const isolated = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? process.env.USERPROFILE ?? "C:\\" };
const variants = { "as inherited (control)": process.env, "isolated (PATH + HOME)": isolated, "isolated + helperEnv": helperEnv(isolated) };
const show = env => ["SystemRoot", "windir", "SystemDrive", "ComSpec", "PATHEXT", "PSModulePath", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA"]
  .map(name => `${name}=${env[name] === undefined ? "(unset)" : env[name]}`).join(" ");

async function scan(env) {
  const started = Date.now();
  try {
    const { stdout } = await exec(powershellPath(), FLAGS, { env, timeout: TIMEOUT, windowsHide: true, maxBuffer: 1 << 20 });
    return `${Date.now() - started} ms, ${stdout.trim()} processes`;
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim().replace(/\s+/g, " ").slice(0, 300);
    return `${Date.now() - started} ms FAILED: ${detail}`;
  }
}

for (const [name, env] of Object.entries(variants)) {
  const times = [];
  for (let round = 0; round < ROUNDS; round++) times.push(await scan(env));
  console.log(`${name}: ${times.join(" · ")}`);
  console.log(`  ${show(env)}`);
}
// What the observer is actually asked for: the tracker's period per running call plus fences and lease readers.
const concurrent = await Promise.all(Array.from({ length: 4 }, () => scan(helperEnv(isolated))));
console.log(`four concurrent scans (isolated + helperEnv): ${concurrent.join(" · ")}`);
