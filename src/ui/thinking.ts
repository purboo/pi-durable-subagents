import type { SessionEntry } from "@earendil-works/pi-coding-agent";

function timestamp(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}
function entryTime(entry: SessionEntry | undefined): number | undefined {
  return timestamp(entry?.timestamp) ?? (entry?.type === "message" ? timestamp(entry.message.timestamp) : undefined);
}

/** UI §3: Derive thinking wall time from adjacent session timestamps, or the latest entry for pending output. */
export function thinkingElapsed(entries: readonly SessionEntry[], index?: number, now = Date.now()): number | undefined {
  if (index === undefined) {
    const start = entryTime(entries.at(-1));
    return start === undefined ? undefined : Math.max(0, now - start);
  }
  const entry = entries[index], start = entryTime(entries[index - 1]);
  const end = entry?.type === "message" ? timestamp(entry.message.timestamp) ?? entryTime(entry) : entryTime(entry);
  return start === undefined || end === undefined ? undefined : Math.max(0, end - start);
}
