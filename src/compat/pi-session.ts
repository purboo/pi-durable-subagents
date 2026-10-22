// The pi session files of the host: a run flag names a pi session id, and the orchestrator needs the session's file
// (the branch it pins for a fork, and the session whose capture an exact run pins).
//
// pi stores every session as `<agent dir>/sessions/<project>/<timestamp>_<session id>.jsonl`. The agent dir is
// `PI_CODING_AGENT_DIR` or `~/.pi/agent`.
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The pi agent directory of the host. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** The session file of a pi session id, when the host has one; undefined otherwise. */
export async function findSessionFile(sessionId: string, env: NodeJS.ProcessEnv = process.env, depth = 3): Promise<string | undefined> {
  if (!sessionId || sessionId.includes("/") || sessionId.includes("\\")) return undefined;
  const root = join(agentDir(env), "sessions");
  const wanted = `_${sessionId}.jsonl`;
  const walk = async (dir: string, left: number): Promise<string | undefined> => {
    let names: string[];
    try { names = await readdir(dir); } catch { return undefined; }
    for (const name of names.sort()) {
      const path = join(dir, name);
      if (name.endsWith(wanted)) return path;
      if (left <= 0) continue;
      let info;
      try { info = await stat(path); } catch { continue; }
      if (!info.isDirectory()) continue;
      const found = await walk(path, left - 1);
      if (found) return found;
    }
    return undefined;
  };
  return walk(root, depth);
}
