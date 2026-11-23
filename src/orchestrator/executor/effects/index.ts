import type { CallEffects, Ledgers } from "../../contract.ts";
import { serialContainment } from "../sweep.ts";
import type { Containment } from "../../../types.ts";
import { cleanWorktree, prepareFork, prepareWorktree, worktreePath } from "./prepare.ts";
import { recoverGates, runGate, type GateOptions } from "./gate.ts";
import { publishOutput } from "./output.ts";

/** P19, P30, P32, P33, A5: Construct durable call effects under the orchestrator's single-writer authority. */
export default function createEffects(ledgers: Ledgers, containment: Containment = serialContainment(), gateOptions?: GateOptions): CallEffects {
  const queues = new Map<string, Promise<unknown>>();
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
      // A refused call did no work: no gate, no output (the executor does not call this for one either).
      if (t.refusal !== undefined || ctl.signal.aborted || ["stopped", "timeout", "budget"].includes(result.status)) return result;
      const gated = await runGate(t, ledgers.home, worktreePath(t.journal, t.callId) ?? t.cwd, exec, result, ctl.signal, containment, gateOptions);
      if (ctl.signal.aborted) return result;
      return serial(`output:${t.journal.path}`, () => publishOutput(t, ledgers.home, gated));
    }),
    afterSeal: (t, result) => serial(t.callId, async () => { if (result.status === "ok") await cleanWorktree(t); }),
    recover: journal => recoverGates(journal, containment),
  };
}
