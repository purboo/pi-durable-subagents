// Cross-platform filesystem primitives the durable writers share. Windows refuses to replace a file that another
// handle has open (POSIX allows it), so a replacement retries briefly: readers close their handles, and a live writer
// closes its own handle around the rename.
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const WIN_SHARING_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const SYNC_WAIT_BUF = new Int32Array(new SharedArrayBuffer(4));

/** Whether `error` is a Windows transient sharing/AV/indexer conflict (`EACCES`, `EBUSY`, `EPERM`). */
export function isWinSharingError(error: unknown): boolean {
  return WIN_SHARING_CODES.has((error as NodeJS.ErrnoException | undefined)?.code ?? "");
}

export interface RetryWinSharingOptions {
  /** Test seam: platform override (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** Maximum number of attempts including the initial try (default 10). */
  maxAttempts?: number;
  /** Wall-clock budget for retries in ms (default 2000). */
  timeoutMs?: number;
  /** Linear backoff step in ms (default 10). */
  baseDelayMs?: number;
  /** Maximum single backoff delay in ms (default 100). */
  maxDelayMs?: number;
  /** Test seam: custom async wait function. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: custom synchronous wait function. */
  sleepSync?: (ms: number) => void;
}

const defaultSleepSync = (ms: number) => {
  if (ms > 0) Atomics.wait(SYNC_WAIT_BUF, 0, 0, ms);
};

/** Run `op` with bounded retries on Windows transient sharing errors (`EACCES`, `EBUSY`, `EPERM`). Non-Windows
 *  platforms and non-sharing errors fail immediately without sleeping. */
export async function retryWinSharing<T>(op: () => Promise<T>, options: RetryWinSharingOptions = {}): Promise<T> {
  const platform = options.platform ?? process.platform;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 10);
  const timeoutMs = Math.max(0, options.timeoutMs ?? 2_000);
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? 10);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 100);
  const sleep = options.sleep ?? (ms => delay(ms));
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    try { return await op(); }
    catch (error) {
      if (platform !== "win32" || !isWinSharingError(error) || attempt + 1 >= maxAttempts) throw error;
      const left = deadline - Date.now();
      if (left <= 0) throw error;
      await sleep(Math.min(left, Math.min(maxDelayMs, baseDelayMs * (attempt + 1))));
    }
  }
}

/** Synchronous counterpart of {@link retryWinSharing}. */
export function retryWinSharingSync<T>(op: () => T, options: RetryWinSharingOptions = {}): T {
  const platform = options.platform ?? process.platform;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 10);
  const timeoutMs = Math.max(0, options.timeoutMs ?? 2_000);
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? 10);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 100);
  const sleepSync = options.sleepSync ?? defaultSleepSync;
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    try { return op(); }
    catch (error) {
      if (platform !== "win32" || !isWinSharingError(error) || attempt + 1 >= maxAttempts) throw error;
      const left = deadline - Date.now();
      if (left <= 0) throw error;
      sleepSync(Math.min(left, Math.min(maxDelayMs, baseDelayMs * (attempt + 1))));
    }
  }
}

export interface WriteFileAtomicOptions extends RetryWinSharingOptions {
  /** Temporary sibling path (default `${target}.tmp`). */
  tempPath?: string;
  /** Encoding for string content (default "utf8"). */
  encoding?: BufferEncoding;
  /** Test seam: custom async writeFile. */
  writeFile?: (path: string, data: string | Uint8Array, encoding?: BufferEncoding) => Promise<void>;
  /** Test seam: custom async rename. */
  rename?: (from: string, to: string) => Promise<void>;
  /** Test seam: custom async unlink. */
  unlink?: (path: string) => Promise<void>;
  /** Test seam: custom sync writeFile. */
  writeFileSync?: (path: string, data: string | Uint8Array, encoding?: BufferEncoding) => void;
  /** Test seam: custom sync rename. */
  renameSync?: (from: string, to: string) => void;
  /** Test seam: custom sync unlink. */
  unlinkSync?: (path: string) => void;
}

/** Publish `content` at `target` atomically via temp-file + rename (never writing directly to `target`, so readers
 *  never observe partial content). On Windows, transient sharing conflicts (`EACCES`, `EBUSY`, `EPERM`) during temp
 *  write and rename are retried within a bounded budget; on failure, the temporary file is removed best-effort. */
export async function writeFileAtomic(target: string, content: string | Uint8Array, options: WriteFileAtomicOptions = {}): Promise<void> {
  const temp = options.tempPath ?? `${target}.tmp`;
  const encoding = options.encoding ?? "utf8";
  const writeFn = options.writeFile ?? ((path, data, enc) => typeof data === "string" ? writeFile(path, data, enc) : writeFile(path, data));
  const renameFn = options.rename ?? rename;
  const unlinkFn = options.unlink ?? unlink;
  const timeoutMs = Math.max(0, options.timeoutMs ?? 2_500);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 25);
  const deadline = Date.now() + timeoutMs;
  const stepOptions = (): RetryWinSharingOptions => ({
    ...options,
    maxAttempts,
    timeoutMs: Math.max(0, deadline - Date.now()),
  });
  try {
    await retryWinSharing(() => writeFn(temp, content, encoding), stepOptions());
    await retryWinSharing(() => renameFn(temp, target), stepOptions());
  } catch (error) {
    await unlinkFn(temp).catch(() => {});
    throw error;
  }
}

/** Synchronous counterpart of {@link writeFileAtomic}. */
export function writeFileAtomicSync(target: string, content: string | Uint8Array, options: WriteFileAtomicOptions = {}): void {
  const temp = options.tempPath ?? `${target}.tmp`;
  const encoding = options.encoding ?? "utf8";
  const writeFn = options.writeFileSync ?? ((path, data, enc) => typeof data === "string" ? writeFileSync(path, data, enc) : writeFileSync(path, data));
  const renameFn = options.renameSync ?? renameSync;
  const unlinkFn = options.unlinkSync ?? unlinkSync;
  const timeoutMs = Math.max(0, options.timeoutMs ?? 2_500);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 25);
  const deadline = Date.now() + timeoutMs;
  const stepOptions = (): RetryWinSharingOptions => ({
    ...options,
    maxAttempts,
    timeoutMs: Math.max(0, deadline - Date.now()),
  });
  try {
    retryWinSharingSync(() => writeFn(temp, content, encoding), stepOptions());
    retryWinSharingSync(() => renameFn(temp, target), stepOptions());
  } catch (error) {
    try { unlinkFn(temp); } catch { /* best effort */ }
    throw error;
  }
}

/** Rename `from` over `to`. On Windows a transient sharing violation is retried (10 attempts, up to ~450 ms). */
export async function replacePath(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      if (process.platform !== "win32" || !isWinSharingError(error) || attempt >= 9) throw error;
      await delay(10 * (attempt + 1));
    }
  }
}
export function replacePathSync(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return; }
    catch (error) {
      if (process.platform !== "win32" || !isWinSharingError(error) || attempt >= 9) throw error;
      // The synchronous callers write small files in a tight loop; a short spin is enough for a closing reader.
      defaultSleepSync(10 * (attempt + 1));
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
