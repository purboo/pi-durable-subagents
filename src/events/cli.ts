// R2: `events --all [--since <cursor>] [--limit <n>] [--json] [--wait-ms <n>]` — read the cross-workflow event log.
// Output is JSON lines (with or without --json). Without --since: `{"head","more":false}`. With --since: the events
// after the cursor (at most --limit, default and max EVENTS_PAGE_MAX), then `{"head","more"}`: more:true → head is the
// cursor of the last event printed; more:false → the log head. Exit 0; 4 cursor-expired (other epoch, seq below
// `dropped`, or beyond the head); 1 malformed cursor or options (`{"error":"invalid-arguments","message"}`) or an
// unreadable log (`{"error":"log-unreadable","message"}`: corrupt, or gone between reads twice); 75 no log yet within
// --wait-ms (an orchestrator was started to create it). Read-only: never repairs the log, never starts the orchestrator when the log exists.
import { setTimeout as delay } from "node:timers/promises";
import { eventsLog } from "../paths.ts";
import { EPOCH, LogCorrupt, readHead, readPage, type LogHead, type Page } from "./log.ts";
import { EVENTS_PAGE_MAX, EXIT_CURSOR_EXPIRED } from "./types.ts";

export interface EventsContext { home: string; env: NodeJS.ProcessEnv; write: (line: string) => void; starter: (home: string, env: NodeJS.ProcessEnv) => Promise<void>; waitMs?: number }
export const EVENTS_EXIT = { ok: 0, invalid: 1, expired: EXIT_CURSOR_EXPIRED, pending: 75 } as const;
export const EVENTS_USAGE = "usage: events --all [--since <epoch>:<seq>] [--limit <n>] [--json] [--wait-ms <n>]";

/** A cursor `<epoch>:<seq>`, or undefined when malformed. */
export function parseCursor(text: string): { epoch: string; seq: number } | undefined {
  const m = /^([0-9a-f]{16}):(0|[1-9]\d{0,15})$/.exec(text);
  return m && EPOCH.test(m[1]!) && Number.isSafeInteger(Number(m[2])) ? { epoch: m[1]!, seq: Number(m[2]) } : undefined;
}
/** Exit 1 with one JSON line `{"error":"invalid-arguments","message"}` (the output stays JSON lines). */
function invalid(ctx: EventsContext, message: string): number { ctx.write(JSON.stringify({ error: "invalid-arguments", message })); return EVENTS_EXIT.invalid; }
/** Exit 1 with one JSON line `{"error":"log-unreadable","message"}`. */
function unreadable(ctx: EventsContext, message: string): number { ctx.write(JSON.stringify({ error: "log-unreadable", message })); return EVENTS_EXIT.invalid; }
class Vanished extends Error { constructor() { super("the event log disappeared while it was read"); } }
class Expired extends Error { readonly head: LogHead; constructor(head: LogHead) { super("cursor-expired"); this.head = head; } }

export async function eventsAll(args: string[], ctx: EventsContext): Promise<number> {
  try { return await read(args, ctx); }
  catch (error) {
    if (error instanceof Vanished) try { return await read(args, ctx); } catch (again) { error = again; } // retried once
    if (error instanceof LogCorrupt || error instanceof Vanished) return unreadable(ctx, error.message);
    throw error;
  }
}
async function read(args: string[], ctx: EventsContext): Promise<number> {
  const values: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, name = arg.startsWith("--") ? arg.slice(2) : undefined;
    const kind = name === "all" || name === "json" ? "flag" : name === "since" || name === "limit" || name === "wait-ms" ? "value" : undefined;
    if (!name || !kind || Object.hasOwn(values, name)) { return invalid(ctx, `unknown, repeated or misplaced argument ${JSON.stringify(arg)}; ${EVENTS_USAGE}`); }
    if (kind === "flag") { values[name] = true; continue; }
    const value = args[++i];
    if (value === undefined) { return invalid(ctx, `--${name} needs a value; ${EVENTS_USAGE}`); }
    values[name] = value;
  }
  const number = (name: string, min: number, max: number): number | undefined | null => {
    const raw = values[name];
    if (raw === undefined) return undefined;
    return typeof raw === "string" && /^\d+$/.test(raw) && Number(raw) >= min && Number(raw) <= max ? Number(raw) : null;
  };
  const limit = number("limit", 1, EVENTS_PAGE_MAX), wait = number("wait-ms", 0, 86_400_000);
  if (limit === null) return invalid(ctx, `--limit needs an integer 1-${EVENTS_PAGE_MAX}`);
  if (wait === null) return invalid(ctx, "--wait-ms needs a non-negative integer");
  const since = typeof values.since === "string" ? parseCursor(values.since) : undefined;
  if (values.since !== undefined && !since) return invalid(ctx, `malformed cursor ${JSON.stringify(values.since)}; a cursor is <epoch>:<seq> as printed in "head" or "cursor"`);
  const path = eventsLog(ctx.home);
  // No log yet: the orchestrator creates it at start (deriving everything still on disk); start one and wait.
  if (!readHead(path)) {
    await ctx.starter(ctx.home, ctx.env);
    const deadline = performance.now() + (wait ?? ctx.waitMs ?? 60_000);
    while (!readHead(path) && performance.now() < deadline) await delay(Math.min(100, Math.max(0, deadline - performance.now())));
    if (!readHead(path)) { ctx.write(JSON.stringify({ pending: true })); return EVENTS_EXIT.pending; }
  }
  const cursor = (h: LogHead, seq: number) => `${h.epoch}:${seq}`;
  if (!since) { const h = readHead(path); if (!h) throw new Vanished(); ctx.write(JSON.stringify({ head: cursor(h, h.head), more: false })); return EVENTS_EXIT.ok; }
  try {
    const page: Page | undefined = readPage(path, since.seq, limit ?? EVENTS_PAGE_MAX, h => {
      if (h.epoch !== since.epoch || since.seq < h.dropped || since.seq > h.head) throw new Expired(h);
    });
    if (!page) throw new Vanished();
    for (const e of page.events) ctx.write(JSON.stringify(e));
    ctx.write(JSON.stringify({ head: page.more ? page.events.at(-1)!.cursor : cursor(page, page.head), more: page.more }));
    return EVENTS_EXIT.ok;
  } catch (error) {
    if (!(error instanceof Expired)) throw error;
    ctx.write(JSON.stringify({ error: "cursor-expired", head: cursor(error.head, error.head.head), oldest: cursor(error.head, error.head.dropped) }));
    return EVENTS_EXIT.expired;
  }
}
