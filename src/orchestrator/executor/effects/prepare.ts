// Private workflow records (A5): wt-intent{call,path,branch,base}, wt-created{call},
// wt-remove-intent{call}, wt-removed{call}; fork-intent{call,header,hash,path}, fork-created{call}.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { publishFile } from "../../../kernel/mailbox.ts";
import { contentHash } from "../../../kernel/ids.ts";
import { JT, type Entry } from "../../../types.ts";
import type { CallTicket } from "../../contract.ts";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const records = (t: CallTicket, type: string) => t.journal.entries().filter(e => e.type === type && e.call === t.callId);

/** P15, A5: Publish one stable attention item for a retained or conflicting effect. */
export async function attention(t: CallTicket, kind: string, text: string): Promise<void> {
  const id = `${kind}:${t.callId}`;
  if (!t.journal.entries().some(e => e.type === JT.attention && (e.item as { id?: string })?.id === id))
    await t.journal.append(JT.attention, { item: { id, rev: 1, kind: "unknown", text, wid: t.wid, call: t.callId } });
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
/** P32: Commit creation intent and reconcile Git's worktree registry and branch identity. */
export async function prepareWorktree(t: CallTicket): Promise<string> {
  if (t.spec.isolation !== "worktree") return t.cwd;
  let intent = records(t, "wt-intent")[0];
  if (!intent) {
    const root = resolve(t.cwd, ".dsa", t.wid), path = resolve(root, t.key), branch = `dsa/${t.wid}/${t.key}`;
    if (!path.startsWith(root + sep)) throw new Error("Invalid worktree key");
    await git(t.cwd, "check-ref-format", "--branch", branch);
    const base = await git(t.cwd, "rev-parse", "HEAD");
    const earlier = t.journal.entries().some(e => e.type === "wt-intent" && e.path === path && e.branch === branch);
    if (!earlier && await branchHead(t.cwd, branch)) throw new Error(`Worktree branch already exists: ${branch}`);
    intent = await t.journal.append("wt-intent", { call: t.callId, path, branch, base });
  }
  const { path, branch, base } = intent as Entry & { path: string; branch: string; base: string };
  if (records(t, "wt-removed").length) return path;
  const tree = (await worktrees(t.cwd)).find(w => w.worktree === path), head = await branchHead(t.cwd, branch);
  if (tree) {
    if (tree.branch !== `refs/heads/${branch}` || tree.HEAD !== head) throw new Error(`Worktree identity conflict: ${path}`);
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
  if (!intent || records(t, "wt-removed").length) return;
  const path = String(intent.path), tree = (await worktrees(t.cwd)).find(w => w.worktree === path);
  if (!tree) {
    if (records(t, "wt-remove-intent").length) await t.journal.append("wt-removed", { call: t.callId });
    return;
  }
  if (tree.branch !== `refs/heads/${intent.branch}` || tree.HEAD !== await branchHead(t.cwd, String(intent.branch))) throw new Error(`Worktree identity conflict: ${path}`);
  if (await git(path, "status", "--porcelain", "--untracked-files=all")) {
    await attention(t, "worktree", `Dirty worktree kept: ${path}`); return;
  }
  if (!records(t, "wt-remove-intent").length) await t.journal.append("wt-remove-intent", { call: t.callId });
  await git(t.cwd, "worktree", "remove", path);
  await t.journal.append("wt-removed", { call: t.callId });
}
/** P33: Publish a fresh session from the already pinned origin branch without importing receipts. */
export async function prepareFork(t: CallTicket, cwd: string, sessionPath: string): Promise<void> {
  if (t.spec.context !== "fork" || t.continueFrom) return;
  if (!t.originSession) throw new Error("fork requested but the run has no origin session");
  if (records(t, "fork-created").length) return;
  const origin = (await readFile(t.originSession, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  if (origin[0]?.type !== "session") throw new Error("Invalid origin session header");
  let intent = records(t, "fork-intent")[0];
  const header = intent?.header ?? { type: "session", id: randomUUID(), version: origin[0].version, cwd, timestamp: new Date().toISOString() };
  let parentId: string | null = null;
  const entries = origin.filter(e => e.type === "message" || e.type === "model_change").filter(e => !String(e.message?.customType ?? "").startsWith("dsa-")).map(e => {
    const entry = { ...e, parentId }; parentId = e.id; return entry;
  });
  const bytes = [header, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n", hash = contentHash(bytes);
  if (!intent) intent = await t.journal.append("fork-intent", { call: t.callId, header, hash, path: sessionPath });
  if (intent.hash !== hash || intent.path !== sessionPath) throw new Error("Fork intent conflict");
  if (await publishFile(dirname(sessionPath), basename(sessionPath), bytes) === "conflict") throw new Error(`Fork publication conflict: ${sessionPath}`);
  await t.journal.append("fork-created", { call: t.callId });
}
