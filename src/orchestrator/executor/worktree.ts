import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JT, isEntry, type AttentionItem, type Entry, type JournalHandle } from "../../types.ts";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
/** The file an edit/write tool call names, resolved as pi's tools resolve it (`resolveToCwd`): unicode spaces, an `@`
 *  prefix, `~` and file URLs. */
export function toolPath(cwd: string, input: string): string {
  let path = input.replace(UNICODE_SPACES, " ");
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  else if (/^file:\/\//.test(path)) path = fileURLToPath(path);
  return resolve(cwd, path);
}

/** The worktree an observed edit/write path is in: the nearest real ancestor directory holding `.git` (a directory, or
 *  a file in a linked worktree), for files and parent directories not created yet too. No git process and no cache: a
 *  repository made inside another while calls run is seen at once; each lookup is a few `lstat`s. */
export function worktreeRoots() {
  return async (cwd: string, path: string): Promise<string | undefined> => {
    // A path pi's tool cannot use either (e.g. a file URL with a host) is no evidence; the tool reports it to the agent.
    let dir: string;
    try { dir = dirname(toolPath(cwd, path)); } catch { return; }
    for (;;) {
      try { dir = await realpath(dir); break; }
      catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
        const parent = dirname(dir); if (parent === dir) return; dir = parent;
      }
    }
    for (;;) {
      try { await lstat(join(dir, ".git")); return dir; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; }
      const parent = dirname(dir); if (parent === dir) return; dir = parent;
    }
  };
}

/** Pair identity is durable; it also lets readers and seal recovery identify both participants. */
export const worktreePair = (a: string, b: string): string => `worktree:${[a, b].sort().join("|")}`;
export const worktreeCalls = (id: string): string[] => id.startsWith("worktree:") ? id.slice(9).split("|") : [];
export const worktreeLabel = (call: string): string => call.replace(/@\d+\//, "/").replace(/@\d+$/, "");

const callOf = (exec: string) => exec.slice(0, exec.lastIndexOf("#"));
export type WorktreeWrite = { call: string; journal: JournalHandle; after?: readonly string[] };

/** What the journals say about observed writes, kept up to date incrementally (each journal entry is read once):
 *  the first `wrote` of each call per worktree, calls that ended (sealed or retired), the conflict reminders written and
 *  whether each is still open, and each workflow's origin. Participants come from the journals, not from the calls
 *  running now: a paused call that wrote still counts until it ends. */
export class WorktreeIndex {
  private scanned = new Map<JournalHandle, number>();
  /** Writers per root that have not ended; a root is dropped when its last writer ends. */
  private byRoot = new Map<string, Map<string, WorktreeWrite>>();
  private callRoots = new Map<string, Set<string>>();
  private execRoots = new Set<string>();
  private endedCalls = new Set<string>();
  private reminders = new Map<string, Map<JournalHandle, { item: AttentionItem; open: boolean }>>();
  private origins = new Map<JournalHandle, unknown>();

  scan(journals: Iterable<JournalHandle>): this {
    for (const journal of journals) {
      const entries = journal.entries();
      for (let i = this.scanned.get(journal) ?? 0; i < entries.length; i++) this.apply(journal, entries[i]!);
      this.scanned.set(journal, entries.length);
    }
    return this;
  }
  private apply(journal: JournalHandle, e: Entry) {
    if (e.type === "wrote" && typeof e.exec === "string" && typeof e.root === "string") {
      const call = callOf(e.exec);
      this.execRoots.add(`${e.exec}\0${e.root}`);
      if (this.endedCalls.has(call)) return;
      const calls = this.byRoot.get(e.root) ?? new Map<string, WorktreeWrite>();
      this.byRoot.set(e.root, calls);
      if (!calls.has(call)) calls.set(call, { call, journal, ...(Array.isArray(e.after) ? { after: e.after.map(String) } : {}) });
      const roots = this.callRoots.get(call) ?? new Set<string>(); roots.add(e.root); this.callRoots.set(call, roots);
    } else if (e.type === JT.sealed || e.type === "retired") {
      const call = String(e.call); this.endedCalls.add(call);
      for (const root of this.callRoots.get(call) ?? []) {
        const calls = this.byRoot.get(root); calls?.delete(call);
        if (calls && !calls.size) this.byRoot.delete(root);
      }
      this.callRoots.delete(call);
    }
    else if (e.type === "wf-created") this.origins.set(journal, e.origin);
    else if (isEntry(e, JT.attention) && e.item?.kind === "conflict") {
      const held = this.reminders.get(e.item.id) ?? new Map();
      this.reminders.set(e.item.id, held);
      if (!held.has(journal)) held.set(journal, { item: e.item, open: true });
    } else if (e.type === JT.attentionResolved && typeof e.id === "string" && e.id.startsWith("worktree:")) {
      const held = this.reminders.get(e.id)?.get(journal); if (held) held.open = false;
    }
  }
  has(exec: string, root: string): boolean { return this.execRoots.has(`${exec}\0${root}`); }
  ended(call: string): boolean { return this.endedCalls.has(call); }
  /** Roots where two or more calls that have not ended wrote: the only ones a reminder can be due for. */
  contested(): string[] { return [...this.byRoot].filter(([, calls]) => calls.size > 1).map(([root]) => root); }
  /** Calls that wrote in `root` and have not ended. */
  live(root: string): WorktreeWrite[] { return [...this.byRoot.get(root)?.values() ?? []]; }
  origin(journal: JournalHandle): unknown { return this.origins.get(journal); }
  /** The reminder of a pair as first written (another journal may still lack its copy after a crash). */
  reminder(id: string): AttentionItem | undefined { return this.reminders.get(id)?.values().next().value?.item; }
  remindedIn(id: string, journal: JournalHandle): boolean { return this.reminders.get(id)?.has(journal) ?? false; }
  open(): { id: string; journal: JournalHandle; item: AttentionItem }[] {
    return [...this.reminders].flatMap(([id, held]) => [...held].filter(([, r]) => r.open).map(([journal, r]) => ({ id, journal, item: r.item })));
  }
  /** First and second writer of a pair, from the journals: a write records the calls that had written there before it
   *  (`after`), so the order survives a crash before the reminder; writes without it are ordered by call id. */
  static order(x: WorktreeWrite, y: WorktreeWrite): [WorktreeWrite, WorktreeWrite] {
    if (y.after?.includes(x.call)) return [x, y];
    if (x.after?.includes(y.call)) return [y, x];
    return x.call < y.call ? [x, y] : [y, x];
  }
}
