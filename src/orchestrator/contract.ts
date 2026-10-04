// Pinned internal contract between the orchestrator's workflow engine (O1a) and executor (O1b).
// Parent-owned. Both run inside the single orchestrator process (P2), which holds the OS lock and is the
// only writer of orchestrator.jsonl and every w/<wid>/journal.jsonl (A2). They share JournalHandles.
import type { AgentDefinition } from "../compat/agents.ts";
import type { CallId, CallResult, CallSpec, JournalHandle, Request, Wid, WidRev } from "../types.ts";

/** User configuration: $DSA_HOME/config.json (all optional). */
export interface OrchestratorConfig {
  /** Default model when neither the call nor the agent names one (before pi's own settings default). */
  defaultModel?: string;
  /** Model pools: name -> ordered "provider/id[:thinking]" candidates (P12, D10). */
  pools?: Record<string, string[]>;
  /** Provider slot capacities (V1). Missing provider = unlimited. */
  providers?: Record<string, { slots: number }>;
  memory?: { reserveMb?: number; perChildMb?: number };
  /** K-parameters overrides (ms / counts). */
  k?: Partial<Record<"lossBound" | "checkpointMs" | "stallMs" | "switchTimeoutMs" | "idleExitMs" | "trackerMs" | "hibernateMs" | "spawnBudget", number>>;
}

/** Everything the executor needs to run one call generation. */
export interface CallTicket {
  wid: Wid;
  widRev: WidRev;
  key: string;
  gen: number;
  callId: CallId;
  spec: CallSpec;
  agent: AgentDefinition;
  /** Absolute working directory of the call (spec.cwd resolved against the workflow cwd). */
  cwd: string;
  /** The workflow journal (shared handle; append-only; engine and executor both write). */
  journal: JournalHandle;
}

export interface Executor {
  /** Start, or resume after recovery, one call. Idempotent per callId: a second call returns the same promise.
   *  Resolves only after JT.sealed is committed (V2); never rejects for model/tool failures (those seal). */
  run(ticket: CallTicket): Promise<CallResult>;
  /** P7: handle a child-addressed request admitted at "orch" (send / withdraw of a forwarded rid).
   *  Returns the orch-level decision; on apply the forward record is committed and rid' published. */
  forward(req: Request, ctx: { journal: JournalHandle; widRev: WidRev; key: string; gen: number }): Promise<{ action: "apply" } | { action: "reject"; reason: string }>;
  /** Stop a call or a whole workflow (fence, then seal "stopped"). */
  stop(target: { wid: Wid; callId?: CallId }): Promise<void>;
  /** Startup recovery for one workflow, BEFORE the engine replays it: fence every exec without JT.fenced
   *  (using persisted tracked identities), and re-derive pool holdings. Unsealed calls are settled later via run(). */
  recover(wid: Wid, journal: JournalHandle): Promise<void>;
  /** True while any call is running or pending (used for idle exit, K6). */
  busy(): boolean;
  shutdown(): Promise<void>;
}

export interface Ledgers {
  /** orchestrator.jsonl: request lifecycle records for "orch", JT.created, pool hold/release, epochs. */
  orch: JournalHandle;
  config: OrchestratorConfig;
  home: string;
}
