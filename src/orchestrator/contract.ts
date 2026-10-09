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
  /** K-parameters overrides (ms / counts). r7Ms: period of the R7 waiting/moving check (events/r7.ts, default 5000). */
  /** Writer lock: "queue" (default) runs one writer call per git worktree at a time; "off" only reminds of observed
   *  shared writes. */
  writerLock?: "queue" | "off";
  k?: Partial<Record<"lossBound" | "checkpointMs" | "stallMs" | "progressMs" | "switchTimeoutMs" | "idleExitMs" | "trackerMs" | "hibernateMs" | "spawnBudget" | "probeMs" | "eventRetentionMs" | "r7Ms", number>>;
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
  /** Pinned workflow usage budget (P31a); the executor refuses dispatches and continuations once reached. */
  workflowBudget?: { tokens?: number; costUsd?: number };
  /** P33: pinned origin branch (JSONL of pi session entries, message/model entries only), when the run had one. */
  originSession?: string;
  /** P37: this generation continues the session of an earlier, sealed generation of the same key. */
  continueFrom?: CallId;
  /** P37: the send that opened this generation; its message is the first thing the generation receives. */
  opening?: { rid: string; kind: "steer" | "follow-up"; message: string };
  /** "provider/id[:thinking]" a follow-up asked this generation to run on (replaces the continued session's model). */
  model?: string;
}

/** P19, P30, P32, P33: Call-scoped effects around executions, implemented in src/orchestrator/executor/effects/
 *  (default export `createEffects(ledgers): CallEffects`) and called by the executor run loop. Every method is
 *  idempotent from the workflow journal (intent entries are committed before effects) and safe to repeat after a crash. */
export interface CallEffects {
  /** Before the first execution of a call generation: create the worktree (P32) and/or the forked session (P33,
   *  published no-replace at `sessionPath`). Returns the working directory for every execution of the call. */
  prepare(t: CallTicket, ctx: { sessionPath: string }): Promise<{ cwd: string }>;
  /** After the fence and before the seal of an outcome that is not stopped/timeout/budget: run the gate (P30,
   *  contained as `gate:<call>#<attempt>`) and publish outputs (P19). May turn the result into gate-failed/unknown and
   *  add artifacts. `ctl.signal` aborts when stop/timeout/budget is decided during the gate: fence it and return. */
  beforeSeal(t: CallTicket, exec: string, result: CallResult, ctl: { signal: AbortSignal }): Promise<CallResult>;
  /** After the seal: remove a clean worktree after success; keep it otherwise (P32). */
  afterSeal(t: CallTicket, result: CallResult): Promise<void>;
  /** Recovery for one workflow: fence gate identities with an intent but no outcome (they then seal unknown). */
  recover(journal: JournalHandle): Promise<void>;
}

/** An execution whose child (or gate before its seal) runs now. */
export interface LiveExecution { wid: Wid; key: string; gen: number; callId: CallId; exec: string; since: number; phase: "child" | "gate" }

export interface Executor {
  /** Start, or resume after recovery, one call. Idempotent per callId: a second call returns the same promise.
   *  Resolves only after JT.sealed is committed (V2); never rejects for model/tool failures (those seal). */
  run(ticket: CallTicket): Promise<CallResult>;
  /** P7: handle a child-addressed request admitted at "orch" (send / withdraw of a forwarded rid).
   *  Returns the orch-level decision; on apply the forward record is committed and rid' published. */
  forward(req: Request, ctx: { journal: JournalHandle; widRev: WidRev; key: string; gen: number }): Promise<{ action: "apply" } | { action: "reject"; reason: string }>;
  /** Stop a call or a whole workflow (fence, then seal "stopped"). */
  stop(target: { wid: Wid; callId?: CallId }): Promise<void>;
  /** P14: retire every call of one workflow revision: fence its executions and commit `retired{call}` (no seal);
   *  pending run() promises for those calls resolve with status "stopped" error "retired". Idempotent. */
  retire(widRev: WidRev): Promise<void>;
  /** Startup recovery for one workflow, BEFORE the engine replays it: fence every exec without JT.fenced
   *  (using persisted tracked identities), and re-derive pool holdings. Unsealed calls are settled later via run(). */
  recover(wid: Wid, journal: JournalHandle): Promise<void>;
  /** True while any call is running or pending (used for idle exit, K6). */
  busy(): boolean;
  /** Drain with fence (stop-all, quit): fence every running execution (or only those of workflows `only` selects)
   *  WITHOUT sealing; their run() promises reject with an Error named "ExecutorShutdown"; the executor stays open and a
   *  later run() continues the call. */
  suspend(only?: (wid: string) => boolean): Promise<void>;
  /** Restart: stop launching executions (children and gates before a seal) and report those running now; `resume()`
   *  lets launches continue when the restart is refused. */
  quiesce?(): { live: LiveExecution[]; resume(): void };
  /** Orchestrator exit: suspend(), then close the outbox. */
  shutdown(): Promise<void>;
  /** Apply a config.json change between slot admissions (never inside one), then let waiting calls retry. */
  reconfigure?(apply: () => Promise<void>): Promise<void>;
}

export interface Ledgers {
  /** orchestrator.jsonl: request lifecycle records for "orch", JT.created, pool hold/release, epochs. */
  orch: JournalHandle;
  config: OrchestratorConfig;
  home: string;
}
