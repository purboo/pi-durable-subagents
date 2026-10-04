// Private workflow records (P19, A5): output-intent{call,path,hash,previous,absolute},
// output{call,path,hash,skipped?}. Intent fixes the artifact identity across crash windows.
import { readFile, rename, symlink, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { publishFile } from "../../../kernel/mailbox.ts";
import { syncDirectory } from "../../../kernel/journal.ts";
import { artifactsDir } from "../../../paths.ts";
import type { CallResult } from "../../../types.ts";
import type { CallTicket } from "../../contract.ts";
import { attention } from "./prepare.ts";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
async function currentHash(path: string): Promise<string | null> {
  try { return hash(await readFile(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function replace(path: string, bytes: string) {
  const temp = `.${randomUUID()}.tmp`, dir = dirname(path);
  try {
    await publishFile(dir, temp, bytes);
    await rename(join(dir, temp), path); await syncDirectory(dir);
  } finally { await unlink(join(dir, temp)).catch(() => {}); }
}
async function latest(path: string) {
  const dir = dirname(path), temp = join(dir, `.${randomUUID()}.link`);
  try {
    await symlink(basename(path), temp); await rename(temp, join(dir, "latest")); await syncDirectory(dir);
  } finally { await unlink(temp).catch(() => {}); }
}
/** P19: Reconcile immutable output publication and protect best-effort targets with a recorded hash. */
export async function publishOutput(t: CallTicket, home: string, result: CallResult): Promise<CallResult> {
  if (!t.spec.output) return result;
  const entries = () => t.journal.entries();
  let intent = entries().find(e => e.type === "output-intent" && e.call === t.callId);
  const digest = hash(result.output);
  if (!intent) {
    const absolute = isAbsolute(t.spec.output), n = 1 + entries().filter(e => e.type === "output-intent" && e.call === t.callId).length;
    const path = absolute ? t.spec.output : join(artifactsDir(home, t.wid), `${encodeURIComponent(t.key)}@${t.gen}`, `${n}-${basename(t.spec.output)}`);
    const previous = entries().filter(e => e.type === "output" && e.path === path && !e.skipped).at(-1)?.hash ?? null;
    intent = await t.journal.append("output-intent", { call: t.callId, path, hash: digest, previous, absolute });
  }
  if (intent.hash !== digest) throw new Error("Output intent content conflict");
  const path = String(intent.path);
  let done = entries().find(e => e.type === "output" && e.call === t.callId);
  if (!done) {
    if (intent.absolute) {
      const current = await currentHash(path);
      if (current !== digest && current !== intent.previous) {
        await attention(t, "output", `Output conflict; kept existing file: ${path}`);
        done = await t.journal.append("output", { call: t.callId, path, hash: digest, skipped: true });
      } else { if (current !== digest) await replace(path, result.output); else await syncDirectory(dirname(path)); }
    } else {
      if (await publishFile(dirname(path), basename(path), result.output) === "conflict") throw new Error(`Artifact conflict: ${path}`);
      await latest(path);
    }
    done ??= await t.journal.append("output", { call: t.callId, path, hash: digest });
  }
  return done.skipped ? result : { ...result, artifacts: [...new Set([...(result.artifacts ?? []), path])] };
}
