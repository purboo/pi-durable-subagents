// State layout under DSA_HOME (spec §1). Single source of truth for paths.
import * as os from "node:os";
import * as path from "node:path";
import { ENV, type Wid } from "./types.ts";

/** State root: $DSA_HOME or ~/.pi/durable-subagents. */
export const dsaHome = (env: NodeJS.ProcessEnv = process.env) => env[ENV.home] || path.join(os.homedir(), ".pi", "durable-subagents");
export const orchLedger = (home: string) => path.join(home, "orchestrator.jsonl");
export const orchLock = (home: string) => path.join(home, "orchestrator.lock");
/** The cross-workflow event log (single writer: the orchestrator; read by `events --all`). */
export const eventsLog = (home: string) => path.join(home, "events.jsonl");
/** Executables for subagents: the orchestrator writes a `pi-durable-subagents` shim here and children get it on PATH. */
export const binDir = (home: string) => path.join(home, "bin");
/** Drop box for requests addressed to the orchestrator. */
export const orchInbox = (home: string) => path.join(home, "inbox");
/** Sender outboxes live under this root (kernel Outbox.open(root, ...)). */
export const outboxRoot = (home: string) => home;
export const workflowDir = (home: string, wid: Wid) => path.join(home, "w", wid);
export const journalPath = (home: string, wid: Wid) => path.join(workflowDir(home, wid), "journal.jsonl");
/** Per-call directory; `key` is the script key, `gen` the generation. */
export const callDir = (home: string, wid: Wid, key: string, gen: number) => path.join(workflowDir(home, wid), "x", `${encodeURIComponent(key)}@${gen}`);
export const callSession = (home: string, wid: Wid, key: string, gen: number) => path.join(callDir(home, wid, key, gen), "session.jsonl");
export const callInbox = (home: string, wid: Wid, key: string, gen: number) => path.join(callDir(home, wid, key, gen), "inbox");
export const artifactsDir = (home: string, wid: Wid) => path.join(workflowDir(home, wid), "artifacts");
export const pinnedDir = (home: string, wid: Wid) => path.join(workflowDir(home, wid), "pinned");
