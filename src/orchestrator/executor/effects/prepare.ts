// Private workflow records (A5): wt-intent{call,path,branch,base}, wt-created{call},
// wt-remove-intent{call}, wt-removed{call}, wt-kept{call}; fork-intent{call,header,hash,path}, fork-created{call}.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { publishFile } from "../../../kernel/mailbox.ts";
import { contentHash } from "../../../kernel/ids.ts";
import { JT, isEntry, type Entry } from "../../../types.ts";
import type { CallTicket } from "../../contract.ts";
import { forkEntry } from "../../origin.ts";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const records = (t: CallTicket, type: string) => t.journal.entries().filter(e => e.type === type && e.call === t.callId);

/** P15, A5: Publish one stable attention item for a retained or conflicting effect. */
export async function attention(t: CallTicket, kind: string, text: string): Promise<void> {
  const id = `${kind}:${t.callId}`;
  if (!t.journal.entries().some(e => isEntry(e, JT.attention) && e.item?.id === id))
    await t.journal.append(JT.attention, { item: { id, rev: 1, kind: "unknown", text, wid: t.wid, call: t.callId } });
}
/** Git lists worktrees by real path (macOS: /var is /private/var); compare paths in that form. */
function canonical(path: string): string {
  let dir = path, rest = "";
  for (;;) {
    try { return join(realpathSync(dir), rest); }
    catch { const up = dirname(dir); if (up === dir) return path; rest = join(basename(dir), rest); dir = up; }
  }
}
async function worktree(cwd: string, path: string) {
  const want = canonical(path);
  return (await worktrees(cwd)).find(w => w.worktree && canonical(w.worktree) === want);
}
async function worktrees(cwd: string) {
  const text = await git(cwd, "worktree", "list", "--porcelain", "-z");
  return text.split("\0\0").filter(Boolean).map(block => Object.fromEntries(block.split("\0").filter(Boolean).map(line => {
    const i = line.indexOf(" "); return i < 0 ? [line, ""] : [line.slice(0, i), line.slice(i + 1)];
  })));
}
async function branchHead(cwd: string, branch: string): Promise<string | undefined> {
  try { return await git(cwd, "rev-parse", "--verify", `refs/heads/${branch}`); }
  catch (error) { if ((error as { code?: number }).code === 128) return undefined; throw error; }
}
/** What a registered worktree holds now, for a person: its branch (or a detached HEAD) and its commit. */
function holdText(tree: Record<string, string>): string {
  const at = tree.HEAD ? ` at ${tree.HEAD}` : "";
  return tree.branch ? `${tree.branch.replace(/^refs\/heads\//, "")}${at}` : tree.detached !== undefined ? `a detached HEAD${at}` : `no branch${at}`;
}
/** P32: An identity mismatch names the call, the workflow, the path and both identities, so a person can repair the path;
 *  this process never moves a worktree, a branch or a file to make them agree. */
function identityConflict(t: CallTicket, path: string, branch: string, head: string | undefined, tree: Record<string, string>): string {
  return `Worktree identity conflict: ${t.callId} (workflow ${t.wid}) needs its worktree ${path} on ${branch}${head ? ` at ${head}` : ""}, ` +
    `but the path holds ${holdText(tree)}`;
}
/** P32: Commit creation intent and reconcile Git's worktree registry and branch identity. */
export async function prepareWorktree(t: CallTicket): Promise<string> {
  if (t.spec.isolation !== "worktree") return t.cwd;
  let intent = records(t, "wt-intent")[0];
  if (!intent) {
    const root = resolve(t.cwd, ".dsa", t.wid), path = resolve(root, t.key);
    // Colon keys could never create a branch in the original namespace. Give them their own namespace so
    // existing literal keys (including percent-encoded spellings) retain their branches across upgrades.
    const branch = t.key.includes(":")
      ? `dsa-colon/${t.wid}/${contentHash(t.key)}`
      : `dsa/${t.wid}/${t.key}`;
    if (t.key.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid worktree key");
    if (!path.startsWith(root + sep)) throw new Error("Invalid worktree key");
    await git(t.cwd, "check-ref-format", "--branch", branch);
    const base = await git(t.cwd, "rev-parse", "HEAD");
    const earlier = t.journal.entries().some(e => e.type === "wt-intent" && e.path === path && e.branch === branch);
    if (!earlier && await branchHead(t.cwd, branch)) throw new Error(`Worktree branch already exists: ${branch}`);
    intent = await t.journal.append("wt-intent", { call: t.callId, path, branch, base });
  }
  const { path, branch, base } = intent as Entry & { path: string; branch: string; base: string };
  if (records(t, "wt-removed").length) return path;
  const tree = (await worktree(t.cwd, path)), head = await branchHead(t.cwd, branch);
  if (tree) {
    // A path someone else moved fails this call only, before anything runs: the worktree is never re-created or moved
    // over what it holds (its files and branch stay for the person to repair).
    if (tree.branch !== `refs/heads/${branch}` || tree.HEAD !== head) throw new Error(`${identityConflict(t, path, branch, head, tree)}. ` +
      `The call failed and the path, its files and its branches were left untouched: check the path out on ${branch} ` +
      `(git -C ${path} checkout ${branch}), or remove it (git worktree remove ${path}), and run the call again`);
  } else {
    if (head) {
      const known = t.journal.entries().some(e => e.type === "wt-created" && t.journal.entries().some(i => i.type === "wt-intent" && i.call === e.call && i.branch === branch));
      if (head !== base && !known) throw new Error(`Worktree branch changed before creation: ${branch}`);
      await git(t.cwd, "worktree", "add", path, branch);
    } else await git(t.cwd, "worktree", "add", "-b", branch, path, base);
  }
  if (!records(t, "wt-created").length) await t.journal.append("wt-created", { call: t.callId });
  return path;
}
/** P32: Remove only a clean successful worktree, retaining its branch and failed work. */
export async function cleanWorktree(t: CallTicket): Promise<void> {
  const intent = records(t, "wt-intent")[0];
  if (!intent || records(t, "wt-removed").length || records(t, "wt-kept").length) return;
  const path = String(intent.path), tree = (await worktree(t.cwd, path));
  if (!tree) {
    if (records(t, "wt-remove-intent").length) await t.journal.append("wt-removed", { call: t.callId });
    return;
  }
  const head = await branchHead(t.cwd, String(intent.branch));
  if (tree.branch !== `refs/heads/${intent.branch}` || tree.HEAD !== head) {
    // The call already sealed ok: its result is final, and removing or moving anything would discard what the path
    // holds, while throwing here would fail this call's recovery on every start. The note is an `unknown` item (like a
    // dirty keep), not a `conflict` reminder: no cross-call contention is open, so it does not hold the workflow open.
    await attention(t, "worktree-conflict", `${identityConflict(t, path, String(intent.branch), head, tree)}. ` +
      `The worktree and its branch were kept, nothing was removed, and this call's sealed result is unchanged; check the ` +
      `path out or remove it (git worktree remove ${path}) when it is no longer needed`);
    await t.journal.append("wt-kept", { call: t.callId }); return;
  }
  if (await git(path, "status", "--porcelain", "--untracked-files=all")) {
    await attention(t, "worktree", `Dirty worktree kept: ${path}`);
    await t.journal.append("wt-kept", { call: t.callId }); return;
  }
  if (!records(t, "wt-remove-intent").length) await t.journal.append("wt-remove-intent", { call: t.callId });
  await git(t.cwd, "worktree", "remove", path);
  await t.journal.append("wt-removed", { call: t.callId });
}
/** P33, FC1: Publish a fresh session from the already pinned origin branch (its effective context) without importing receipts. */
export async function prepareFork(t: CallTicket, cwd: string, sessionPath: string): Promise<void> {
  if (t.spec.context !== "fork" || t.continueFrom) return;
  if (!t.originSession) throw new Error("fork requested but the run has no origin session");
  if (records(t, "fork-created").length) return;
  const origin = (await readFile(t.originSession, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  if (origin[0]?.type !== "session") throw new Error("Invalid origin session header");
  let intent = records(t, "fork-intent")[0];
  const header = intent?.header ?? { type: "session", id: randomUUID(), version: origin[0].version, cwd, timestamp: new Date().toISOString() };
  let parentId: string | null = null;
  const entries = origin.filter(forkEntry).map(e => {
    const entry = { ...e, parentId }; parentId = e.id; return entry;
  });
  const bytes = [header, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n", hash = contentHash(bytes);
  if (!intent) intent = await t.journal.append("fork-intent", { call: t.callId, header, hash, path: sessionPath });
  if (intent.hash !== hash || intent.path !== sessionPath) throw new Error("Fork intent conflict");
  if (await publishFile(dirname(sessionPath), basename(sessionPath), bytes) === "conflict") throw new Error(`Fork publication conflict: ${sessionPath}`);
  await t.journal.append("fork-created", { call: t.callId });
}
