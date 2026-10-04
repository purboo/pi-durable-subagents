// Pinned shared contracts for pi-durable-subagents.
// Changing anything here needs parent approval: every module and test depends on it.
// Design references (repo-local, not published): design/principles.md (A1-A5, V1-V8), design/spec.md (P1-P38, K1-K11).

// ---------------------------------------------------------------------------
// Identities (spec §1)
// ---------------------------------------------------------------------------

/** Workflow id: ULID. */
export type Wid = string;
/** Workflow revision, e.g. "01J...@1". */
export type WidRev = `${string}@${number}`;
/** Call (generation) id, e.g. "01J...@1/E02@1". */
export type CallId = string;
/** Execution id, e.g. "01J...@1/E02@1#1.2" (attempt.epoch). Also the containment tag value. */
export type ExecId = string;
/** Request id: ULID, or a deterministic hash for derived requests (forwards). */
export type Rid = string;
/** Sender id: "main:<piSessionId>" | "cli:<uuid>" | "orch" | "eval:<wid>". */
export type SenderId = string;
/** Question id with revision handled separately. */
export type Qid = string;

// ---------------------------------------------------------------------------
// Durable logs (A1; spec §1; contract C11)
// ---------------------------------------------------------------------------

/** One committed journal entry. On disk: `<crc32 hex 8> <json>\n`. `seq` starts at 1 and is dense. */
export interface Entry<T extends string = string> {
  seq: number;
  /** Wall clock ms (display only; never used for ordering or budgets). */
  ts: number;
  type: T;
  [field: string]: unknown;
}

export interface JournalHandle {
  readonly path: string;
  /** All committed entries (torn tail already truncated on open). */
  entries(): readonly Entry[];
  /** Append + fsync. Resolves only when durable. Single writer per file (caller holds authority). */
  append<T extends string>(type: T, fields: Record<string, unknown>): Promise<Entry<T>>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Requests (A3, A4; spec §2, P3, P5, P6, P38)
// ---------------------------------------------------------------------------

export type RequestKind =
  // to orchestrator from main/cli
  | "run" | "send" | "stop" | "revise" | "resume" | "drain"
  // orchestrator to child (forwarded or own)
  | "task" | "steer" | "follow-up" | "answer" | "model" | "continue" | "withdraw"
  // evaluator to orchestrator
  | "call" | "emit";

export interface Conditions {
  /** Resolve only after this rid (admitted earlier at the same recipient) has a terminal resolution. V5. */
  after?: Rid;
  /** Application requires this workflow revision / evaluator incarnation to be current. V3. */
  epoch?: string;
  /** Answer application requires this open question revision. V4. */
  qid?: Qid;
  rev?: number;
}

/** Immutable request envelope. Published as `<inbox>/<rid>.json` (no-replace). */
export interface Request<B = unknown> {
  rid: Rid;
  from: SenderId;
  /** "orch" or a CallId. */
  to: string;
  /** Per (from,to) sequence, 1,2,3... Recipient admits in sseq order and holds on gaps (P5). */
  sseq: number;
  kind: RequestKind;
  cond?: Conditions;
  body: B;
}

export type Resolution =
  | { rid: Rid; status: "applied"; result?: unknown }
  | { rid: Rid; status: "rejected"; reason: string };

// ---------------------------------------------------------------------------
// Child session entries (pi session file is the child's log; P4, P8, P23, P24)
// customType values written by the session agent. All carry details/data as below.
// ---------------------------------------------------------------------------

export const CT = {
  admitted: "dsa-admitted",    // custom: { rid, from, sseq, hash, kind } — lifecycle admission record (kernel DecisionRecord)
  exec: "dsa-exec",            // custom: { exec } — start of an execution segment
  msg: "dsa-msg",              // custom_message: details { rid, kind, from } — applied request (receipt)
  rejected: "dsa-rejected",    // custom: { rid, reason }
  withdrawn: "dsa-withdrawn",  // custom: { rid, rids } — tombstones AND the withdraw request's receipt (rebuild: withdrawn{rids} + applied{rid})
  question: "dsa-question",    // custom: { qid, rev, question }
  report: "dsa-report",        // custom: { exec, outcome, data?, artifacts? }
  model: "dsa-model",          // custom: { rid, provider, model } — model change receipt
  attention: "dsa-attention",  // custom_message (main session): details { items: {id, rev}[] }
  budget: "dsa-budget",        // custom: { exec, usage } — the child refused its next provider request: per-call budget reached (P31b)
  note: "dsa-note",            // custom_message (main session), never triggers a turn
} as const;

// ---------------------------------------------------------------------------
// Orchestrator journal entries that OTHER domains read (snapshot only; never written by them).
// orchestrator.jsonl (user-level ledger) and w/<wid>/journal.jsonl (per workflow).
// ---------------------------------------------------------------------------

export const JT = {
  /** orchestrator.jsonl: { rid, wid, origin } — a `run` request was applied; origin = "main:<sessionId>". */
  created: "created",
  /** journal: { exec, call } — the current execution of `call` (last one wins). Launch gate P23. */
  exec: "exec",
  /** journal: { exec } — execution retired (A2). Launch gate P23. */
  fenced: "fenced",
  /** journal: { item: AttentionItem } — an attention item for the origin session (P15). */
  attention: "attention",
  /** journal: { id, rev, resolution } — the item is resolved; never present it as open again. */
  attentionResolved: "attention-resolved",
  /** journal: { call, exec, result: CallResult } — terminal seal (V2). */
  sealed: "sealed",
  /** journal: { status: "done"|"failed"|"parked"|"stopped", result?, error? } — workflow terminal (starter: no JT.done = pending). */
  done: "workflow-done",
  /** orchestrator.jsonl lifecycle records for requests addressed to "orch" (kernel DecisionRecord shapes):
   *  admitted { rid, from, sseq, hash, kind } · applied { rid } · rejected { rid, reason } · withdrawn { rid, rids }.
   *  Senders read them (snapshot) to learn terminal resolution and call Outbox.markResolved. */
  admitted: "admitted",
  applied: "applied",
  rejected: "rejected",
  withdrawn: "withdrawn",
} as const;

// ---------------------------------------------------------------------------
// Request bodies addressed to the orchestrator (to: "orch"). Paths are absolute (resolved by the sender).
// ---------------------------------------------------------------------------

export interface RunBody {
  /** Working directory of the origin session. */
  cwd: string;
  /** Exactly one of: workflow (script file), source (inline script), tasks, chain, call (single subagent). */
  workflow?: string;
  source?: string;
  tasks?: (CallSpec & { key?: string })[];
  chain?: (CallSpec & { key?: string })[];
  call?: CallSpec & { key?: string };
  args?: unknown;
  /** Declared inputs: name -> absolute file path; copied into pinned/ at admission, served by runs.input(name). */
  inputs?: Record<string, string>;
  name?: string;
  /** Workflow usage budget (P31a, upstream usageBudget): once reached, new dispatches and continuations are refused. */
  usageBudget?: { tokens?: number; costUsd?: number };
  /** Spawn budget override (P36, upstream maxSubagentSpawnsPerRun); default K11 = 300. */
  maxCalls?: number;
  /** Origin session for `context: "fork"` (P33): its branch up to `leafId` is pinned at admission. */
  origin?: { sessionFile: string; leafId?: string | null };
}
/** kind "send": forwarded to a child (P7). cond.qid/rev required for answers. */
export interface SendBody {
  to: CallId | `${Wid}/${string}`;
  /** steer: next boundary (interrupts between turns); follow-up: only after the current run settles; answer; model. */
  kind: "steer" | "follow-up" | "answer" | "model";
  message?: string;
  /** "provider/id[:thinking]". */
  model?: string;
  /** Provenance for display and notes (ui.md: user actions are journaled as coming from the user). */
  by?: "user" | "agent";
}
/** kind "withdraw": withdraw the sender's own earlier requests (P6). */
export interface WithdrawBody { rids: Rid[] }
/** kind "stop": stop a workflow or one call. */
export interface StopBody { target: Wid | CallId }
/** kind "revise" (P14). */
export interface ReviseBody { wid: Wid; workflow?: string; source?: string; args?: unknown }
/** kind "resume": adopt/continue unfinished work (all when wid absent). */
export interface ResumeBody { wid?: Wid }
/** kind "drain": durable; no new dispatch and no continuation until `resume`. Running calls finish, unless
 *  `fence` (CLI stop-all): then every running execution is fenced WITHOUT sealing, so journals stay resumable. */
export interface DrainBody { fence?: boolean }

// Request bodies addressed to a child (to: CallId), written by the orchestrator (own requests or P7 forwards).
/** kinds "task" | "steer" | "follow-up" | "continue" | "answer": text shown to the model (answer: cond.qid/rev set). */
export interface MessageBody { message: string }
/** kind "model": parsed from "provider/id[:thinking]" by the orchestrator. */
export interface ModelBody { provider: string; model: string; thinking?: string }
/** Arguments of the child `report` tool (P24); `data` is validated against DSA_SCHEMA. */
export interface ReportArgs { outcome: "ok" | "failed"; summary?: string; data?: unknown }

export interface AttentionItem {
  id: string;
  rev: number;
  kind: "question" | "finished" | "stall" | "unknown" | "budget";
  /** Human-readable one-liner shown to the main agent. */
  text: string;
  wid: Wid;
  call?: CallId;
  qid?: Qid;
  /** Child session file, for late refresh of question state (P15). */
  session?: string;
}

// ---------------------------------------------------------------------------
// Call spec and result (compat with pi-subagents runs.run; spec mapping table)
// ---------------------------------------------------------------------------

export interface CallSpec {
  agent: string;
  task: string;
  /** "provider/id[:thinking]" or a pool name. */
  model?: string;
  cwd?: string;
  /** Active-time budget (P18). */
  timeoutMs?: number;
  /** Relative path -> private artifact (P19); absolute -> best-effort publication. */
  output?: string;
  /** JSON schema for the report tool (P24). */
  schema?: unknown;
  gate?: string | { command: string; output?: "json"; schema?: unknown; timeoutMs?: number };
  isolation?: "none" | "worktree";
  context?: "fresh" | "fork";
  budget?: { tokens?: number; costUsd?: number };
  /** Unknown tool effects park instead of continuing (P9). */
  once?: boolean;
  tools?: string[];
  skills?: string[];
}

export type CallStatus =
  | "ok" | "failed" | "stopped" | "timeout" | "budget" | "unknown" | "gate-failed" | "skipped" | "parked";

export interface CallResult {
  key: string;
  gen: number;
  status: CallStatus;
  /** true iff status === "ok". */
  ok: boolean;
  /** Full final text (legacy scripts parse its last line). Never truncated. */
  output: string;
  /** Structured report data, if a schema was declared. */
  data?: unknown;
  error?: string;
  usage?: { input: number; output: number; costUsd: number };
  artifacts?: string[];
}

// ---------------------------------------------------------------------------
// Evaluator IPC (P10, P11): orchestrator <-> evaluator host, JSON lines over stdio.
// Every message names the workflow and evaluator incarnation; stale `ev` is ignored by both sides.
// ---------------------------------------------------------------------------

export type OrchToEval =
  | { t: "start"; wid: Wid; ev: number; scriptPath: string; args: unknown; inputs: Record<string, string> }
  | { t: "expose"; wid: Wid; ev: number; pos: number; result: CallResult }
  | { t: "value"; wid: Wid; ev: number; n: number; value: number }
  | { t: "stop"; wid: Wid; ev: number };

export type EvalToOrch =
  /** pos = 0-based index of this proposal in the script's proposal sequence. */
  | { t: "call"; wid: Wid; ev: number; pos: number; key: string; spec: CallSpec }
  | { t: "emit"; wid: Wid; ev: number; pos: number; value: unknown }
  /** Request a recorded nondeterministic value (n = 0-based index of such requests). */
  | { t: "need"; wid: Wid; ev: number; n: number; kind: "now" | "random" }
  /** Event loop drained while awaiting exposures: the replay frontier signal (P11). `exposed` = number of exposures
   *  this incarnation has applied so far; the frontier requires exposed >= number of logged exposures sent. */
  | { t: "idle"; wid: Wid; ev: number; exposed: number }
  | { t: "done"; wid: Wid; ev: number; result: unknown }
  | { t: "error"; wid: Wid; ev: number; error: string; kind: "script" | "limit" | "internal" };

// ---------------------------------------------------------------------------
// Platform (P22, P23; contracts C1-C4)
// ---------------------------------------------------------------------------

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Opaque start-time token; (pid,start) identifies a process across pid reuse. */
  start: string;
  /** Value of DSA_EXEC in its environment, if readable and present. */
  tag?: string;
  /** Cumulative CPU time in ms, if available. */
  cpuMs?: number;
}

export interface ProcessTable {
  list(): Promise<ProcInfo[]>;
}

export interface SpawnSpec {
  exec: ExecId;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface Spawned {
  pid: number;
  start: string;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  exited: Promise<{ code: number | null; signal: string | null }>;
}

export interface Containment {
  /** Direct spawn (C3) with DSA_EXEC=<exec> injected (C1). */
  spawn(spec: SpawnSpec): Promise<Spawned>;
  /** One tracker scan: processes per exec (tagged, or descendants of known ones). Caller persists new ones. */
  scan(known: ReadonlyMap<ExecId, readonly ProcInfo[]>): Promise<Map<ExecId, ProcInfo[]>>;
  /** Kill tagged + tracked processes of `exec`, rescan until empty. Resolves only when empty (or rejects on timeout). */
  fence(exec: ExecId, tracked: readonly ProcInfo[], opts?: { timeoutMs?: number }): Promise<void>;
}

export interface LockHandle {
  release(): Promise<void>;
}

export interface OsLock {
  /** Non-blocking; null if held by a live process. Released by the OS when the holder dies (C4). */
  tryAcquire(path: string): Promise<LockHandle | null>;
}

// ---------------------------------------------------------------------------
// Environment variables passed to children (child session agent reads them)
// ---------------------------------------------------------------------------

export const ENV = {
  home: "DSA_HOME",       // state root, default ~/.pi/durable-subagents
  exec: "DSA_EXEC",       // ExecId; presence switches the extension into child mode
  call: "DSA_CALL",       // CallId
  inbox: "DSA_INBOX",     // absolute path of this call's inbox dir
  journal: "DSA_JOURNAL", // absolute path of the workflow journal (read-only snapshot for the launch gate)
  schema: "DSA_SCHEMA",   // absolute path of report JSON schema, if any
  budget: "DSA_BUDGET",   // JSON {tokens?, costUsd?}: per-call budget; the child refuses the next provider request once reached (P31b)
  model: "DSA_MODEL",     // "provider/id" the executor holds a slot for; the child re-applies it if pi started without it (C8)
} as const;
