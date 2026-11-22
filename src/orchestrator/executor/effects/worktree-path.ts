// P32: the spelling of a call's worktree path and branch, and the identity of a path as the file system holds it.
// A call key is an opaque name inside its workflow's directory (`.dsa/<wid>`): a key that is path-like (a Win32
// separator, a traversal part, an absolute, drive-qualified or UNC spelling) is refused, and every other key keeps its
// own spelling, so POSIX journals name exactly what they always named. Win32 cannot spell some names (`tasks:0`, `CON`,
// `x.`, `a*b`), so on Windows such a key lives under `.keys/<hash>`: a literal key may not begin with `.keys`, so the
// encoded namespace is disjoint from every literal spelling, even where the file system ignores case. The rules are pure
// functions of the key and the platform, so the Windows decisions are testable anywhere.
import { realpathSync } from "node:fs";
import { basename, dirname, join, posix, win32 } from "node:path";
import { contentHash } from "../../../kernel/ids.ts";

/** The one directory under `.dsa/<wid>` that only encoded keys name; no literal key starts with it on Windows. */
export const encodedDir = ".keys";
/** Win32 reserves these names for devices, with or without an extension and in any case. */
const device = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

/** Reject a key that is not an opaque name inside its workflow's directory. A key never names a path: `a:0` is a name
 *  Win32 cannot spell (it is encoded), while `C:\x`, `C:/x`, `\\server\share`, `/abs` and `..` are paths and are
 *  refused, so no key can ever resolve outside `.dsa/<wid>`. */
export function checkKey(key: string): void {
  if (key.includes("\\") || /^[A-Za-z]:([\\/]|$)/.test(key)) throw new Error("Invalid worktree key");
  if (key.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid worktree key");
}
/** Whether Win32 can create a directory spelled exactly like `part`: no character it forbids, no trailing dot or space
 *  (Win32 drops those), and not a reserved device name. */
export function win32Name(part: string): boolean {
  return Boolean(part) && part !== "." && part !== ".." && !/[<>:"|?*\\/\x00-\x1f]/.test(part) && !/[. ]$/.test(part) && !device.test(part);
}
/** Whether a key keeps its own spelling on `platform`: always on POSIX (journals name what they always named), and on
 *  Windows when every part is a Win32 name and the first part is not the encoded namespace's. */
export function literalKey(key: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return true;
  const parts = key.split("/");
  return parts.every(win32Name) && parts[0]!.toLowerCase() !== encodedDir;
}
/** The spelling of a key's worktree relative to `.dsa/<wid>`: its own, or — where the platform cannot spell it — the
 *  encoded namespace with the key's hash (deterministic, one-to-one, and outside every literal name). */
export function keyDir(key: string, platform: NodeJS.Platform = process.platform): string {
  checkKey(key);
  return literalKey(key, platform) ? key : `${encodedDir}/${contentHash(key)}`;
}
/** The branch of a key's worktree: `dsa/<wid>/<key>`, or — for a key a ref cannot spell (`:`) or one whose path is
 *  encoded — the hashed namespace, so no two keys share a branch. */
export function keyBranch(wid: string, key: string, platform: NodeJS.Platform = process.platform): string {
  checkKey(key);
  return key.includes(":") || !literalKey(key, platform) ? `dsa-colon/${wid}/${contentHash(key)}` : `dsa/${wid}/${key}`;
}

/** The identity of a path as the file system holds it: the native spelling its nearest existing ancestor has (on Windows
 *  the long form `C:\Users\runneradmin\...` under its on-disk case, on macOS `/private/var` for `/var`) extended by the
 *  parts that do not exist yet, so a worktree Git has not created still compares. */
export function nativePath(path: string): string {
  let dir = path, rest = "";
  for (;;) {
    try { return join(realpathSync.native(dir), rest); }
    catch { const up = dirname(dir); if (up === dir) return path; rest = join(basename(dir), rest); dir = up; }
  }
}
/** How Win32 spells one path: `\\?\C:\x` and `\\?\UNC\s\share\x` are the extended forms of `C:\x` and `\\s\share\x`,
 *  either separator is the same one, `.` and repeated separators collapse, a trailing separator is not part of the name,
 *  and case does not tell two names apart. */
export function win32Spelling(path: string): string {
  const plain = path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/i, "").replace(/\//g, "\\");
  const trimmed = win32.normalize(plain).replace(/\\+$/, "");
  return (/^[A-Za-z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed).toLowerCase();
}
/** Whether two spellings name one path here: the same spelling, or — on Windows — the same Win32 spelling of the native
 *  form each names (an 8.3 alias, another case, a `/` from `git worktree list`, a symlinked directory). */
export function sameWorktree(a: string, b: string): boolean {
  if (a === b) return true;
  const na = nativePath(a), nb = nativePath(b);
  return na === nb || (process.platform === "win32" && win32Spelling(na) === win32Spelling(nb));
}
/** Whether `target` is inside `base`, both already in the file system's own spelling. It is not when there is no
 *  relative part at all (the same directory), when that part leaves `base` (`..`), or when it is absolute — which is
 *  what Win32 `relative` yields for another drive or share, so a cross-drive target is never inside. */
export function insidePath(base: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const path = platform === "win32" ? win32 : posix, within = path.relative(base, target);
  return Boolean(within) && within !== ".." && !within.startsWith(`..${path.sep}`) && !path.isAbsolute(within) &&
    path.resolve(base, within) === target;
}
/** Whether `path` is inside `root` by the identity the file system gives each (a spelling through a symlink, a junction
 *  or an 8.3 alias is still inside), and on Windows never across drives or shares. */
export function inside(root: string, path: string): boolean {
  return insidePath(nativePath(root), nativePath(path));
}
