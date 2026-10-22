// EX1: the parent capture of a top-level pi session.
//
// A top-level pi session (not inside a dsa call) observes every provider request it makes and keeps the latest
// serialized payload in memory. The payload is written to `<dsa home>/exact/<sessionId>.json` (mode 0600, atomic
// replace, off the request path, latest wins). The file holds the serialized provider payload only: never headers,
// never keys.
//
// The capture is what a `context: "exact"` child splices its own conversation into (EX4). It is delivery metadata:
// it is pinned at admission (EX2) and never hashed into a request digest.
//
// A failed write never fails or delays the request: the write happens after the request was handed to the provider
// and every error is swallowed.
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { contentHash } from "../../kernel/ids.ts";

/** The apis an exact fork can splice (EX4). Every other api falls back to a rebuilt fork. */
export const EXACT_APIS = ["anthropic-messages", "openai-responses"] as const;
/** The provider payload of one request, as pi serialized it. */
export type ProviderPayload = Record<string, unknown>;
/** What a capture holds: the payload and the request's identity. */
export interface Capture {
  /** The pi session that made the request. */
  sessionId: string;
  /** The provider that served it ("relay-claude"). */
  provider: string;
  /** The model that answered it ("claude-opus-5-5"). */
  model: string;
  /** The api the payload was serialized for ("anthropic-messages"). */
  api: string;
  /** The thinking level of the request, when it had one. */
  thinking?: string;
  /** Wall-clock ms of the request. */
  at: number;
  /** The serialized provider payload (the only thing the child splices). */
  payload: ProviderPayload;
}

/** `<home>/exact`: the capture directory of every session. */
export const exactDir = (home: string) => join(home, "exact");
/** `<home>/exact/<sessionId>.json`: the capture file of one session. */
export const exactPath = (home: string, sessionId: string) => join(exactDir(home), `${sessionId}.json`);
/** A session id is a file name: no path separators, no dots alone. */
export const SESSION_FILE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The sha256 of the capture bytes (the identity a pinned capture keeps). */
export const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The metadata a pinned capture records beside its bytes. */
export interface CaptureFacts {
  sha256: string; bytes: number; at: number; provider: string; model: string; api: string; thinking?: string;
}

/** The facts of a capture, from its bytes. */
export function captureFacts(capture: Capture): CaptureFacts {
  const bytes = Buffer.from(JSON.stringify(capture.payload), "utf8");
  return { sha256: sha256(bytes), bytes: bytes.byteLength, at: capture.at, provider: capture.provider, model: capture.model,
    api: capture.api, ...(capture.thinking !== undefined ? { thinking: capture.thinking } : {}) };
}

/** Whether the api of a capture can be spliced (EX4). */
export const supportedApi = (api: string) => (EXACT_APIS as readonly string[]).includes(api);

/**
 * Write the capture of a session: mode 0600, atomic replace (a temporary file beside it, then a rename), latest wins.
 * The caller does not await the write (it must not delay the request); a failure is reported, never thrown.
 */
export async function writeCapture(home: string, capture: Capture): Promise<void> {
  const dir = exactDir(home);
  await mkdir(dir, { recursive: true });
  const target = exactPath(home, capture.sessionId);
  const temp = join(dir, `.${capture.sessionId}.${process.pid}.${Date.now()}.tmp`);
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify({ ...capture, payload: capture.payload }));
    await file.sync();
  } finally { await file.close(); }
  await rename(temp, target);
}

/** Read the capture of a session; undefined when there is none (or it is unreadable). */
export async function readCapture(home: string, sessionId: string): Promise<Capture | undefined> {
  if (!SESSION_FILE.test(sessionId)) return undefined;
  let text: string;
  try { text = await readFile(exactPath(home, sessionId), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return undefined; }
  try {
    const capture = JSON.parse(text) as Capture;
    if (!capture || typeof capture !== "object" || !capture.payload || typeof capture.payload !== "object") return undefined;
    return capture;
  } catch { return undefined; }
}

/** EX1: remove the capture files that were not modified for `maxAgeMs` (the orchestrator keeps 7 days). */
export async function pruneCaptures(home: string, maxAgeMs: number, now = Date.now()): Promise<number> {
  const dir = exactDir(home);
  let names: string[];
  try { names = await readdir(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs < maxAgeMs) continue;
      await rm(path, { force: true }); removed++;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return removed;
}

/** The capture retention of the orchestrator: 7 days. */
export const CAPTURE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * EX1: the `exactCapture` config key (boolean, default true). The extension reads it from the same config.json the
 * orchestrator reads; while it is off, no capture file is written and an exact run falls back (`no-capture`).
 */
export function exactCaptureEnabled(config: unknown): boolean {
  const value = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>).exactCapture : undefined;
  return value !== false;
}

/** The identity of a capture's payload: the sha256 of its serialized bytes. */
export const payloadHash = (payload: ProviderPayload) => contentHash(payload);
