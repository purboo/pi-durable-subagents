import type { CallEffects, Ledgers } from "../../contract.ts";
import { Containment } from "../../../platform/containment.ts";
import { cleanWorktree, prepareFork, prepareWorktree } from "./prepare.ts";
import { recoverGates, runGate } from "./gate.ts";
import { publishOutput } from "./output.ts";

/** P19, P30, P32, P33, A5: Construct durable call effects under the orchestrator's single-writer authority. */
export default function createEffects(ledgers: Ledgers): CallEffects {
  const containment = new Containment(), queues = new Map<string, Promise<unknown>>();
  function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (queues.get(key) ?? Promise.resolve()).then(operation);
    const tail = result.catch(() => {}); queues.set(key, tail);
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return result;
  }
  return {
    prepare: (t, ctx) => serial(t.callId, async () => {
      const cwd = await prepareWorktree(t); await prepareFork(t, cwd, ctx.sessionPath); return { cwd };
    }),
    beforeSeal: (t, exec, result, ctl) => serial(t.callId, async () => {
      if (ctl.signal.aborted || ["stopped", "timeout", "budget"].includes(result.status)) return result;
      const intent = t.journal.entries().find(e => e.type === "wt-intent" && e.call === t.callId);
      const gated = await runGate(t, ledgers.home, intent ? String(intent.path) : t.cwd, exec, result, ctl.signal, containment);
      if (ctl.signal.aborted) return result;
      return serial(`output:${t.journal.path}`, () => publishOutput(t, ledgers.home, gated));
    }),
    afterSeal: (t, result) => serial(t.callId, async () => { if (result.status === "ok") await cleanWorktree(t); }),
    recover: journal => recoverGates(journal, containment),
  };
}
