// Private entries: skip{pool,model,until} in orchestrator ledger (K7); retired{call} in workflow (P14).
import type { Containment, JournalHandle, ProcInfo } from "../../types.ts";
import { JT } from "../../types.ts";
import type { Model } from "../../compat/model.ts";

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
/** P23: Re-fence retired identities even if a previous fence was already committed. */
export async function sweepExecutions(journals: Iterable<JournalHandle>, containment: Containment) {
  for (const journal of journals) {
    const entries = journal.entries();
    for (const e of entries.filter(e => e.type === JT.exec)) {
      if (!entries.some(r => r.type === JT.fenced && r.exec === e.exec || r.type === "retired" && r.call === e.call)) continue;
      const tracked: ProcInfo[] = entries.filter(r => r.type === "tracked" && r.exec === e.exec).map(r => ({ pid: Number(r.pid), ppid: 0, start: String(r.start) }));
      await containment.fence(String(e.exec), tracked);
    }
  }
}
