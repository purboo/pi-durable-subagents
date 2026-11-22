// Run the same process-table read with selected Windows system variables. Log only timings and row counts.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IS_WINDOWS, PROCESS_ROWS_SCRIPT, cimScript, helperEnv, parseProcessRows, powershellPath } from "../src/platform/windows.ts";

if (!IS_WINDOWS) process.exit(0);
const exec = promisify(execFile);
const groups = {
  system: ["SystemRoot", "windir", "SystemDrive", "COMSPEC", "PATHEXT", "PSModulePath"],
  profile: ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN", "COMPUTERNAME"],
  software: ["ProgramData", "ALLUSERSPROFILE", "PUBLIC", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432"],
  machine: ["OS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION", "NUMBER_OF_PROCESSORS"],
};
const isolated = { PATH: process.env.PATH, HOME: process.env.HOME ?? process.env.USERPROFILE };
const select = names => Object.fromEntries(names.filter(n => process.env[n] !== undefined).map(n => [n, process.env[n]]));
const script = `$ErrorActionPreference = 'Stop'; ${PROCESS_ROWS_SCRIPT}`;
async function query(label, env, command = script) {
  const before = performance.now();
  try {
    const { stdout } = await exec(powershellPath(), ["-NoProfile", "-NonInteractive", "-Command", command], { env, timeout: 6000, windowsHide: true, maxBuffer: 8 << 20 });
    const ok = command === "'ready'" ? stdout.trim() === 'ready' : parseProcessRows(stdout).some(row => row.pid === process.pid);
    console.log(`probe ${label}: ${ok ? 'OK' : 'INVALID'} ${Math.round(performance.now() - before)} ms`);
    return ok;
  } catch (e) {
    console.log(`probe ${label}: FAILED ${Math.round(performance.now() - before)} ms killed=${e.killed} signal=${e.signal} code=${e.code} detail=${String(e.stderr ?? "").split(/\r?\n/)[0].slice(0, 256)}`);
    return false;
  }
}
await query('inherited', process.env);
await query('isolated-startup', isolated, "'ready'");
await query('isolated-scan', isolated);
await query('derived-scan', helperEnv(isolated));
const fixed = await query('explicit-import', helperEnv(isolated), cimScript(PROCESS_ROWS_SCRIPT));
if (!fixed) {
  process.exitCode = 1;
  // Record which *individual* directory restores discovery if an explicit import is insufficient.
  for (const [index, path] of (process.env.PSModulePath ?? '').split(';').filter(Boolean).entries()) {
    await query(`module-dir-${index}`, { ...isolated, PSModulePath: path });
  }
}
const names = Object.keys(groups);
const envFor = selected => ({ ...isolated, ...select(selected.flatMap(key => groups[key])) });
if (await query('os-allowlist', envFor(names))) {
  let needed = names;
  for (const name of names) {
    const subset = needed.filter(n => n !== name);
    if (await query(`groups-${subset.join('+') || 'none'}`, envFor(subset))) needed = subset;
  }
  let keys = needed.flatMap(g => groups[g]);
  for (const key of [...keys]) {
    const subset = keys.filter(k => k !== key);
    if (await query(`drop-${key}`, { ...isolated, ...select(subset) })) keys = subset;
  }
  console.log(`probe retained system keys: ${keys.join(', ')}`);
  await query('confirm-retained', { ...isolated, ...select(keys) });
} else {
  for (const name of names) {
    const env = { ...process.env };
    const drop = new Set(groups[name].map(key => key.toLowerCase()));
    for (const key of Object.keys(env)) if (drop.has(key.toLowerCase())) delete env[key];
    await query(`inherited-minus-${name}`, env);
  }
}
