// What Git lists for a repository, read without comparing raw path text: Git for Windows prints `C:/Users/...` for a
// path a journal records as `C:\Users\...`, and a path may be spelled through an 8.3 alias, another case or a symlink.
// The workflow-local part of the path (`.dsa/<wid>/<key>`) is the same worktree whichever spelling each side uses, so a
// test asks about that instead of about one separator style.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** The paths `git worktree list` holds for `repo`, as Git spells them. */
export async function listedWorktrees(repo: string): Promise<string[]> {
  const { stdout } = await promisify(execFile)("git", ["worktree", "list", "--porcelain"], {
    cwd: repo, timeout: 10000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  return stdout.split("\n").filter(line => line.startsWith("worktree ")).map(line => line.slice("worktree ".length).trim());
}
/** The last `parts` components of a path, `/`-separated: a spelling no separator style or drive letter changes. */
export function localPath(path: string, parts: number): string {
  return path.split(/[\\/]+/).filter(Boolean).slice(-parts).join("/");
}
/** How many listed worktrees end in the workflow-local spelling `.dsa/<wid>/<key>`. */
export function countWorktrees(listed: readonly string[], suffix: string): number {
  const parts = suffix.split("/").length;
  return listed.filter(path => localPath(path, parts) === suffix).length;
}
