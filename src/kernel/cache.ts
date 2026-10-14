// Rebuildable reader caches: checked payloads, published whole, with no durable authority.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { crc32 } from "./journal.ts";

export function readCache(path: string): Record<string, unknown> | undefined {
  try {
    const { checksum, ...record } = JSON.parse(readFileSync(path, "utf8"));
    return checksum === crc32(Buffer.from(JSON.stringify(record))) ? record : undefined;
  } catch { return undefined; }
}
/** A disappeared journal means pruning won: neither an in-flight reader nor another window recreates its cache. */
export function writeCache(path: string, record: object, journal: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    if (!existsSync(journal)) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ ...record, checksum: crc32(Buffer.from(JSON.stringify(record))) }), { flag: "wx" });
    renameSync(tmp, path);
    if (!existsSync(journal)) {
      rmSync(path, { force: true });
      // A facts cache has one directory per workflow; remove it only if it is empty.
      try { rmdirSync(dirname(path)); } catch { /* another cache may still live here */ }
    }
  } catch { /* A cache failure only costs another read. */ }
  finally { try { rmSync(tmp, { force: true }); } catch { /* best effort */ } }
}
