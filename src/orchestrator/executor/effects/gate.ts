// Private workflow records (P30, A5): gate-intent{call,id,exec},
// gate-tracked{id,process}; gate{id,exit,json?,error?,unknown?,aborted?}.
// DSA_RESULT and DSA_OUTPUT are immutable gate inputs; JSON output is read from stdout.
import { join } from "node:path";
import { publishFile } from "../../../kernel/mailbox.ts";
import { callDir } from "../../../paths.ts";
import { validate } from "../../../agent/child/schema.ts";
import { recordFenceFailure, resolveFenceAttention } from "../sweep.ts";
import type { CallResult, Containment, Entry, JournalHandle, ProcInfo } from "../../../types.ts";
import type { CallTicket } from "../../contract.ts";

const tracked = (journal: JournalHandle, id: string) => journal.entries().filter(e => e.type === "gate-tracked" && e.id === id).map(e => e.process as ProcInfo);

/** P30, F1: A gate proven retired after a failed fence gets its unknown outcome once and its attention resolved. */
export async function gateRetired(journal: JournalHandle, id: string): Promise<void> {
  if (!journal.entries().some(e => e.type === "gate" && e.id === id)) await journal.append("gate", { id, unknown: true });
  await resolveFenceAttention(journal, id);
}
/** F1: Fence a gate identity; a failure is recorded once (timeouts raise an unknown attention) and left to the sweep. */
async function fenceGate(journal: JournalHandle, intent: Entry, containment: Pick<Containment, "fence">): Promise<boolean> {
  const id = String(intent.id);
  try { await containment.fence(id, tracked(journal, id)); return true; }
  catch (error) {
    if (!journal.entries().some(e => e.type === "fence-failed" && e.exec === id)) console.error(`durable-subagents: fence of ${id} failed: ${String(error)}`);
    if (/Fence timeout/.test(String(error))) await recordFenceFailure(journal, id, String(intent.call), error);
    else if (!journal.entries().some(e => e.type === "fence-failed" && e.exec === id)) await journal.append("fence-failed", { exec: id, error: String(error) });
    return false;
  }
}
/** P30, A5, F1: Fence unresolved gate identities before recording their outcome as unknown; a gate whose fence fails
 *  never fails recovery: it stays without an outcome and the executor sweep retries it every K1. */
export async function recoverGates(journal: JournalHandle, containment: Pick<Containment, "fence">): Promise<void> {
  for (const intent of journal.entries().filter(e => e.type === "gate-intent")) {
    const id = String(intent.id);
    if (journal.entries().some(e => e.type === "gate" && e.id === id)) continue;
    if (await fenceGate(journal, intent, containment)) await gateRetired(journal, id);
  }
}
function apply(result: CallResult, record: Entry): CallResult {
  if (record.aborted) return result;
  if (record.unknown) return { ...result, status: "unknown", ok: false, error: "Gate outcome unknown after recovery" };
  if (record.exit !== 0 || record.error) return { ...result, status: "gate-failed", ok: false, error: String(record.error ?? `Gate exited ${record.exit}`) };
  if (!Object.hasOwn(record, "json")) return result;
  const data = result.data && typeof result.data === "object" && !Array.isArray(result.data) ? result.data : {};
  return { ...result, data: { ...data, gate: record.json } };
}
/** P30: Run a contained, journaled gate at most once and honor settlement aborts. */
export async function runGate(t: CallTicket, home: string, cwd: string, exec: string, result: CallResult, signal: AbortSignal, containment: Containment): Promise<CallResult> {
  if (!t.spec.gate || signal.aborted) return result;
  const prior = t.journal.entries().filter(e => e.type === "gate-intent" && e.call === t.callId);
  if (prior.length) {
    const intent = prior.at(-1)!;
    let record = t.journal.entries().find(e => e.type === "gate" && e.id === intent.id);
    if (!record) {
      // A gate that cannot be fenced is never re-run: its outcome is unknown now and recorded once the sweep retires it.
      if (!await fenceGate(t.journal, intent, containment)) return apply(result, { unknown: true } as unknown as Entry);
      await gateRetired(t.journal, String(intent.id));
      record = t.journal.entries().find(e => e.type === "gate" && e.id === intent.id)!;
    }
    return apply(result, record);
  }
  const gate = typeof t.spec.gate === "string" ? { command: t.spec.gate } : t.spec.gate;
  if (gate.timeoutMs !== undefined && (!Number.isFinite(gate.timeoutMs) || gate.timeoutMs < 0)) throw new Error("Invalid gate timeout");
  const id = `gate:${t.callId}#${prior.length + 1}`, dir = join(callDir(home, t.wid, t.key, t.gen), "gate-1");
  await t.journal.append("gate-intent", { call: t.callId, id, exec });
  for (const [name, bytes] of [["result.json", JSON.stringify(result)], ["output.txt", result.output]]) {
    if (await publishFile(dir, name!, bytes!) === "conflict") throw new Error(`Gate input conflict: ${dir}/${name}`);
  }
  if (signal.aborted) { await t.journal.append("gate", { id, aborted: true, exit: null }); return result; }
  const known: ProcInfo[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined, scanTimer: ReturnType<typeof setInterval> | undefined;
  let scanQueue = Promise.resolve(), stdout = "", outputError: string | undefined;
  let abort = () => {};
  let fields: Record<string, unknown> = { id, exit: null };
  let finishRead: Promise<void> = Promise.resolve();
  try {
    const child = await containment.spawn({ command: "sh", args: ["-c", gate.command], cwd, exec: id,
      env: { DSA_RESULT: join(dir, "result.json"), DSA_OUTPUT: join(dir, "output.txt"), DSA_CALL: t.callId } });
    child.stdin.end(); child.stderr.resume(); child.stdout.setEncoding("utf8");
    finishRead = (async () => { for await (const chunk of child.stdout) stdout += chunk.toString(); })();
    void finishRead.catch(() => {});
    const remember = async (p: ProcInfo) => {
      if (known.some(k => k.pid === p.pid && k.start === p.start)) return;
      await t.journal.append("gate-tracked", { id, process: p }); known.push(p);
    };
    if (child.start) await remember({ pid: child.pid, start: child.start, ppid: process.pid, tag: id });
    let failScan: (error: unknown) => void = () => {};
    const scanFailed = new Promise<never>((_, reject) => { failScan = reject; });
    scanTimer = setInterval(() => {
      scanQueue = scanQueue.then(async () => { const found = await containment.scan(new Map([[id, known]])); for (const p of found.get(id) ?? []) await remember(p); });
      void scanQueue.catch(failScan);
    }, 1000);
    const interrupted = new Promise<"aborted" | "timeout">((resolve) => {
      abort = () => resolve("aborted"); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      if (gate.timeoutMs !== undefined) timer = setTimeout(() => resolve("timeout"), gate.timeoutMs);
    });
    const outcome = await Promise.race([child.exited, interrupted, scanFailed]);
    if (outcome === "aborted") fields.aborted = true;
    else if (outcome === "timeout") fields.error = "Gate timeout";
    else fields.exit = outcome.code;
  } catch (error) { fields.error = String(error); }
  finally {
    clearTimeout(timer); clearInterval(scanTimer); signal.removeEventListener("abort", abort);
    await scanQueue.catch(() => {});
    await containment.fence(id, known);
  }
  await finishRead.catch(error => { outputError = String(error); });
  if (signal.aborted) fields = { id, exit: fields.exit, aborted: true };
  else if (outputError) fields.error = outputError;
  else if (fields.exit === 0 && !fields.error && gate.output === "json") {
    try {
      fields.json = JSON.parse(stdout);
      if (gate.schema !== undefined) { const errors = validate(gate.schema, fields.json); if (errors.length) fields.error = errors.join("; "); }
    } catch (error) { fields.error = `Gate JSON: ${error}`; }
  }
  return apply(result, await t.journal.append("gate", fields));
}
