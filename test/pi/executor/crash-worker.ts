// Killed after its durable fence, before it can settle the real pi session.
import { openJournal } from "../../../src/kernel/journal.ts";
import createExecutor from "../../../src/orchestrator/executor/index.ts";
import { JT } from "../../../src/types.ts";
import { journalPath, orchLedger } from "../../../src/paths.ts";
const home = process.env.DSA_HOME!;
const journal = await openJournal(journalPath(home, "wf"));
const orch = await openJournal(orchLedger(home));
const wrapped = { ...journal, async append<T extends string>(type: T, fields: Record<string, unknown>) {
  const e = await journal.append(type, fields);
  if (type === JT.fenced) { process.send?.("fenced"); await new Promise(() => {}); }
  return e;
} };
const executor = createExecutor({ home, orch, config: {} });
await executor.recover("wf", wrapped);
