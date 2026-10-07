// Private entries: skip{pool,model,until} in orchestrator ledger (K7); retired{call} in workflow (P14);
// fence-failed{exec,error} in workflow: a fence timed out, the call is parked until a sweep proves retirement.
import type { Containment, JournalHandle, ProcInfo } from "../../types.ts";
import { JT, attentionEntries, isEntry } from "../../types.ts";
import { Containment as PlatformContainment } from "../../platform/containment.ts";
import { ProcessTable } from "../../platform/proctable.ts";
import type { Model } from "../../compat/model.ts";

/** C2, F4: A containment whose process-table snapshots never overlap (ProcessTable.list is not reentrant). */
export function serialContainment(table: Pick<ProcessTable, "list"> = new ProcessTable()): PlatformContainment {
  let queue: Promise<unknown> = Promise.resolve();
  return new PlatformContainment({ list(known) { const next = queue.then(() => table.list(known)); queue = next.catch(() => {}); return next; } });
}

/** K7: Three consecutive losses for a candidate within its pool suspend it for ten minutes. */
export async function skipLostCandidate(journal: JournalHandle, orch: JournalHandle, exec: string) {
  const selected = journal.entries().find(e => e.type === "selected" && e.exec === exec);
  if (!selected?.pool) return;
  const model = selected.model as Model, name = `${model.provider}/${model.id}`;
  if (orch.entries().some(e => e.type === "candidate-loss" && e.exec === exec)) return;
  // candidate-loss{pool,model,exec} is the durable cross-workflow K7 loss sequence.
  await orch.append("candidate-loss", { pool: selected.pool, model: name, exec });
  const history = orch.entries().filter(e => e.pool === selected.pool && ["candidate-loss", "candidate-success", "skip"].includes(e.type));
  const tail = history.slice(-3);
  if (tail.length === 3 && tail.every(e => e.type === "candidate-loss" && e.model === name))
    await orch.append("skip", { pool: selected.pool, model: name, until: Date.now() + 600000 });
}
// The gate path records outside the executor's serial section and the sweep inside it: each check-then-append of a
// fence record runs in this per-journal section, so two recorders that both find no record still write it once (A5).
const sections = new WeakMap<JournalHandle, Promise<unknown>>();
/** A5: Run a check-then-append of fence records alone on its journal. Not reentrant: never nest two. */
export function recordOnce<T>(journal: JournalHandle, operation: () => Promise<T>): Promise<T> {
  const result = (sections.get(journal) ?? Promise.resolve()).then(operation);
  const tail = result.catch(() => {}); sections.set(journal, tail);
  void tail.then(() => { if (sections.get(journal) === tail) sections.delete(journal); });
  return result;
}
/** F1: Record a fence timeout of an execution or gate identity once, with one unknown attention item for the origin. */
export function recordFenceFailure(journal: JournalHandle, id: string, call: string, error: unknown) {
  return recordOnce(journal, () => fenceFailure(journal, id, call, error));
}
async function fenceFailure(journal: JournalHandle, id: string, call: string, error: unknown) {
  if (!journal.entries().some(e => e.type === "fence-failed" && e.exec === id)) await journal.append("fence-failed", { exec: id, error: String(error) });
  const item = `fence:${id}`;
  if (journal.entries().some(e => isEntry(e, JT.attention) && e.item.id === item)) return;
  const text = id.startsWith("gate:")
    ? `Processes of gate ${id} did not exit after SIGKILL (${String(error)}). Its outcome stays unknown and is recorded once they are gone; check for stuck processes (e.g. blocked I/O).`
    : `Processes of execution ${id} did not exit after SIGKILL (${String(error)}). Call ${call} is paused and starts no new execution until they are gone; check for stuck processes (e.g. blocked I/O).`;
  await journal.append(JT.attention, { item: { id: item, rev: 1, kind: "unknown", text, wid: call.slice(0, call.lastIndexOf("@", call.indexOf("/"))), call } });
}
/** F1: Resolve the fence attention item of an identity that a later fence proved retired. */
export function resolveFenceAttention(journal: JournalHandle, id: string) {
  return recordOnce(journal, () => fenceAttentionResolved(journal, id));
}
/** The same, inside a `recordOnce` section. */
export async function fenceAttentionResolved(journal: JournalHandle, id: string) {
  const item = attentionEntries(journal.entries(), `fence:${id}`)[0]?.item;
  if (item && !journal.entries().some(e => e.type === JT.attentionResolved && e.id === `fence:${id}` && e.rev === item.rev))
    await journal.append(JT.attentionResolved, { id: `fence:${id}`, rev: item.rev, resolution: "fenced" });
}
type SweepHooks = {
  /** Execs whose last fence failed in this process (not yet recorded durably). */
  failing?: (exec: string) => boolean;
  /** A fence proved the exec retired; `wasFenced` tells whether `fenced` was already committed. */
  fenced?: (journal: JournalHandle, exec: string, call: string, wasFenced: boolean) => Promise<void>;
  failed?: (journal: JournalHandle, exec: string, call: string, error: unknown) => Promise<void>;
};
/** P23, F1, F2: Every K1 re-fence retired identities and retry failed fences (executions and gates without an outcome)
 *  with one shared scan; a failing identity is reported through `failed` and never stops the sweep of the others. */
export async function sweepExecutions(journals: Iterable<JournalHandle>, containment: Pick<Containment, "scan" | "fence">, hooks: SweepHooks = {}) {
  const targets: { journal: JournalHandle; exec: string; call: string; fenced: boolean; failed: boolean; tracked: ProcInfo[] }[] = [];
  for (const journal of journals) {
    const fenced = new Set<unknown>(), retired = new Set<unknown>(), failed = new Set<unknown>(), gated = new Set<unknown>(), tracked = new Map<string, ProcInfo[]>();
    const entries = journal.entries();
    for (const e of entries) {
      if (e.type === JT.fenced) fenced.add(e.exec);
      else if (e.type === "retired") retired.add(e.call);
      else if (e.type === "fence-failed") failed.add(e.exec);
      else if (e.type === "gate") gated.add(e.id);
      else if (e.type === "tracked") tracked.set(String(e.exec), [...tracked.get(String(e.exec)) ?? [], { pid: Number(e.pid), ppid: 0, start: String(e.start) }]);
      else if (e.type === "gate-tracked") tracked.set(String(e.id), [...tracked.get(String(e.id)) ?? [], e.process as ProcInfo]);
    }
    // A gate whose recovery fence failed has no outcome yet; it is retried here until its processes are gone.
    for (const e of entries) {
      const id = String(e.id);
      if (e.type === "gate-intent" && !gated.has(id) && (failed.has(id) || hooks.failing?.(id)))
        targets.push({ journal, exec: id, call: String(e.call), fenced: false, failed: true, tracked: tracked.get(id) ?? [] });
    }
    for (const e of entries) {
      if (e.type !== JT.exec) continue;
      const exec = String(e.exec), isFailed = failed.has(exec) || !!hooks.failing?.(exec);
      if (fenced.has(exec) || retired.has(e.call) || isFailed)
        targets.push({ journal, exec, call: String(e.call), fenced: fenced.has(exec), failed: isFailed, tracked: tracked.get(exec) ?? [] });
    }
  }
  if (!targets.length) return;
  const live = await containment.scan(new Map(targets.map(t => [t.exec, t.tracked])));
  for (const t of targets) {
    if (t.fenced && !live.get(t.exec)?.length) { if (t.failed) await hooks.fenced?.(t.journal, t.exec, t.call, true); continue; }
    try { await containment.fence(t.exec, t.tracked); }
    catch (error) { await hooks.failed?.(t.journal, t.exec, t.call, error); continue; }
    await hooks.fenced?.(t.journal, t.exec, t.call, t.fenced);
  }
}
