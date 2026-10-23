// Cross-platform filesystem primitives the durable writers share. Windows refuses to replace a file that another
// handle has open (POSIX allows it), so a replacement retries briefly: readers close their handles, and a live writer
// closes its own handle around the rename.
import { renameSync } from "node:fs";
import { rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const transient = (error: unknown) => ["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException)?.code ?? "");

/** Rename `from` over `to`. On Windows a transient sharing violation is retried (10 attempts, up to ~220 ms). */
export async function replacePath(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      if (process.platform !== "win32" || !transient(error) || attempt >= 9) throw error;
      await delay(10 * (attempt + 1));
    }
  }
}
export function replacePathSync(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return; }
    catch (error) {
      if (process.platform !== "win32" || !transient(error) || attempt >= 9) throw error;
      // The synchronous callers write small files in a tight loop; a short spin is enough for a closing reader.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
    }
  }
}

/** Write `bytes` at `position`, looping over short writes. A positional write works with a read/write handle on every
 *  platform (Windows append-mode handles cannot truncate, which journal repair needs). */
export async function writeAt(file: FileHandle, bytes: Buffer, position: number): Promise<void> {
  for (let at = 0; at < bytes.length;) {
    const { bytesWritten } = await file.write(bytes, at, bytes.length - at, position + at);
    if (!bytesWritten) throw new Error("short write");
    at += bytesWritten;
  }
}
