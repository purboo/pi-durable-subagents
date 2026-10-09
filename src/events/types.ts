// The public shape of the cross-workflow event log. Changing a field here changes the public contract.
//
// One durable sequence, single writer (the orchestrator). Each record is one event; `seq` grows strictly (gaps allowed:
// retention drops records and every orchestrator start skips ahead, see EVENT_SEQ_SKIP). The public cursor is
// `<epoch>:<seq>`; `--since c` returns events with a larger seq of the same epoch.

/** Milestone types and why-not-moving transitions. Readers must ignore types they do not know. */
export type EventType = "submitted" | "started" | "asking" | "answered" | "sealed" | "fenced" | "workflow-done" | "waiting" | "moving";

/** Wait reasons, one per waiting call, in this precedence when several apply (first wins). */
export const WAIT_REASONS = ["unconfirmed-stop", "provider-exhausted", "writer-lock", "lease", "slot", "silent"] as const;
export type WaitReason = typeof WAIT_REASONS[number];

/** Fields every event carries (absent when not applicable). `id` is unique and stable: an event derived again after a
 *  crash gets the same id, so readers deduplicate on it (delivery is at least once, without gaps). */
export interface EventBase {
  id: string;
  /** `<epoch>:<seq>`, filled in by the log on append (drafts leave it out). */
  cursor: string;
  /** When the milestone happened (ms since epoch), not when it was logged. */
  ts: number;
  type: EventType;
  wid: string;
  /** The run request id (`run --request <id>`), when the workflow was created by one. */
  request?: string;
  /** Call key and generation; absent on workflow-level events (`submitted`, `workflow-done`). */
  key?: string;
  gen?: number;
  /** Full call id `<wid>@<rev>/<key>@<gen>`, with key/gen. */
  call?: string;
  /** The labels given at `run --labels`, echoed on every event of the workflow. */
  labels?: Record<string, string>;
}
export type Event =
  | EventBase & { type: "submitted"; name?: string }
  | EventBase & { type: "started"; exec: string }
  | EventBase & { type: "asking"; qid: string; rev: number; question: string; /** answer address `<wid>/<key>` */ to: string }
  | EventBase & { type: "answered"; qid: string; rev: number; by: string; via?: "ui"; digest: string; length: number }
  | EventBase & { type: "sealed"; status: string; error?: string; data?: unknown; /** bytes of `data` JSON when too large to inline; read it with `describe` */ data_omitted?: number }
  | EventBase & { type: "fenced"; exec: string; reason: "restart-force" | "orchestrator-crash" | "process-died"; at: number }
  | EventBase & { type: "workflow-done"; status: string; error?: string }
  | EventBase & { type: "waiting"; reason: WaitReason; detail: string; since: number }
  | EventBase & { type: "moving"; after: WaitReason };

/** What a producer hands to the log: everything but the cursor. */
export type EventDraft = Event extends infer E ? E extends Event ? Omit<E, "cursor"> : never : never;

/** The orchestrator's writer. `emit` appends in order, durably (fsync) before it resolves; drafts whose id was already
 *  logged in this epoch may be appended again (at least once) — producers need not deduplicate. */
export interface EventSink { emit(drafts: readonly EventDraft[]): Promise<void> }

/** `data` of a `sealed` event is inlined up to this many bytes of JSON; larger → `data_omitted`. */
export const EVENT_DATA_INLINE_MAX = 16 * 1024;
/** At most this many events per durable write; every orchestrator start skips this far ahead, so a seq a reader saw in
 *  a write that a power loss undid is never reused. */
export const EVENT_SEQ_SKIP = 1000;
/** `events --all --limit`: default and maximum. */
export const EVENTS_PAGE_MAX = 1000;
/** Default retention: events younger than this are never dropped. `k.eventRetentionMs` overrides it (tests lower it). */
export const EVENT_RETENTION_MS = 7 * 24 * 3600_000;
/** CLI exit code for `{"error":"cursor-expired"}`. */
export const EXIT_CURSOR_EXPIRED = 4;
