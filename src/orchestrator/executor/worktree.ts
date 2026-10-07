import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** Resolve observed edit/write paths, including files and parent directories not created yet. No git process. */
export function worktreeRoots() {
  const cache = new Map<string, string | undefined>();
  return async (cwd: string, path: string): Promise<string | undefined> => {
    let dir = dirname(resolve(cwd, path));
    for (;;) {
      try { dir = await realpath(dir); break; }
      catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
        const parent = dirname(dir); if (parent === dir) return; dir = parent;
      }
    }
    const visited: string[] = [];
    let root: string | undefined;
    for (;;) {
      if (cache.has(dir)) { root = cache.get(dir); break; }
      visited.push(dir);
      try { await lstat(join(dir, ".git")); root = dir; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; }
      const parent = dirname(dir); if (parent === dir) break; dir = parent;
    }
    for (const dir of visited) cache.set(dir, root);
    return root;
  };
}

/** Pair identity is durable; it also lets readers and seal recovery identify both participants. */
export const worktreePair = (a: string, b: string): string => `worktree:${[a, b].sort().join("|")}`;
export const worktreeCalls = (id: string): string[] => id.startsWith("worktree:") ? id.slice(9).split("|") : [];
export const worktreeLabel = (call: string): string => call.replace(/@\d+\//, "/").replace(/@\d+$/, "");
