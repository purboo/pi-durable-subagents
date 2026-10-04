import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { publishFile } from "../kernel/mailbox.ts";
import { syncDirectory } from "../kernel/journal.ts";

const name = "pi-durable-subagents";
const quote = (s: string, exec = true) => `"${s.replace(/[%$\\"\n\r]/g, c => c === "$" ? exec ? "$$" : "$" : ({ "%": "%%", "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r" })[c]!)}"`;
const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
export interface ServiceFile { path: string; content: string }
/** P1, K1: Render a login and 30-second starter using absolute runtime paths; it runs `start`, never `resume`. */
export function serviceFiles(home: string, dsa: string, entry: string, platform: string = process.platform, node = process.execPath): ServiceFile[] {
  if (platform === "linux") {
    const dir = join(home, ".config/systemd/user");
    return [
      { path: join(dir, `${name}.service`), content: `[Unit]\nDescription=Durable subagents starter\n\n[Service]\nType=oneshot\n# Keep the detached orchestrator alive after the starter exits.\nKillMode=process\nEnvironment=${quote(`DSA_HOME=${dsa}`, false)}\nExecStart=${quote(node)} ${quote(entry)} start\n` },
      { path: join(dir, `${name}.timer`), content: `[Unit]\nDescription=Durable subagents periodic starter\n\n[Timer]\nOnStartupSec=1s\nOnUnitActiveSec=30s\nAccuracySec=1s\nUnit=${name}.service\n\n[Install]\nWantedBy=timers.target\n` },
    ];
  }
  if (platform === "darwin") return [{ path: join(home, "Library/LaunchAgents", `${name}.plist`), content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${name}</string>\n<key>ProgramArguments</key><array>${[node, entry, "start"].map(s => `<string>${xml(s)}</string>`).join("")}</array>\n<key>EnvironmentVariables</key><dict><key>DSA_HOME</key><string>${xml(dsa)}</string></dict>\n<key>RunAtLoad</key><true/>\n<!-- Keep the detached orchestrator alive after the starter exits. -->\n<key>AbandonProcessGroup</key><true/>\n<key>StartInterval</key><integer>30</integer>\n</dict></plist>\n` }];
  throw new Error(`Starter service unavailable on ${platform}`);
}
/** P1: Invoke the platform service manager, surfacing the exact failed command. */
export async function runServiceCommand(command: string, args: string[]): Promise<void> {
  try { await promisify(execFile)(command, args, { timeout: 10_000 }); }
  catch (error) { throw new Error(`${command} ${args.join(" ")}: ${(error as { stderr?: string }).stderr || String(error)}`); }
}
export type ServiceRunner = (command: string, args: string[]) => Promise<void>;
/** P1: Activate or deactivate the optional starter; injected runners isolate service tests. */
export async function manageService(files: ServiceFile[], install: boolean, options: { platform?: string; uid?: number; dryRun?: boolean; runner?: ServiceRunner; write?: (line: string) => void } = {}): Promise<void> {
  const platform = options.platform ?? process.platform, write = options.write ?? console.log;
  const run = async (command: string, args: string[], tolerated?: RegExp) => {
    write(`${command} ${args.join(" ")}`);
    if (options.dryRun) return;
    try { await (options.runner ?? runServiceCommand)(command, args); }
    catch (error) { if (!tolerated?.test(String(error))) throw error; }
  };
  if (options.dryRun) for (const file of files) write(`${file.path}\n${file.content}`);
  else if (install) await installService(files);
  if (platform === "linux") {
    if (install) await run("systemctl", ["--user", "daemon-reload"]);
    await run("systemctl", ["--user", install ? "enable" : "disable", "--now", `${name}.timer`], install ? undefined : /not loaded|does not exist|not found/i);
  } else if (platform === "darwin") {
    const domain = `gui/${options.uid ?? process.getuid?.() ?? 0}`;
    await run("launchctl", install ? ["bootstrap", domain, files[0]!.path] : ["bootout", `${domain}/${name}`], install ? /already (bootstrapped|loaded)|service already exists/i : /not loaded|could not find service|no such process/i);
  } else throw new Error(`Starter service unavailable on ${platform}`);
  if (!install && !options.dryRun) await uninstallService(files);
  if (!install && platform === "linux") await run("systemctl", ["--user", "daemon-reload"]);
}

/** P1, C11: Publish optional service definitions without replacing user configuration. */
export async function installService(files: ServiceFile[]): Promise<void> {
  for (const file of files) if (await publishFile(dirname(file.path), file.path.slice(dirname(file.path).length + 1), file.content) === "conflict")
    throw new Error(`Service file differs: ${file.path}; uninstall it before installing again`);
}
/** P1, C11: Remove only the named starter definitions and sync their directories. */
export async function uninstallService(files: ServiceFile[]): Promise<void> {
  for (const file of files) {
    try { await unlink(file.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    await syncDirectory(dirname(file.path));
  }
}
