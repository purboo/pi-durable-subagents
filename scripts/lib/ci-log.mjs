// Reading a `node --test` log the way the CI scripts do: without terminal colors, and with the failing test files named
// so they can be rerun. Node prints a path as it looks on the platform, so the Windows form (`test\unit\x.test.ts`, or
// `C:\...` in TAP) is handled here, where it is testable from any platform.
export const stripAnsi = text => text.replace(/\x1b\[[0-9;]*m/g, "");

// This repository names test files *.test.{ts,mts,cts,js,mjs,cjs}.
const TEST_FILE = /\.test\.[cm]?[jt]s$/;

/** The failing test files in a run's output: the spec reporter's "test at <file>:<line>:<col>" (one per test, indented
 *  when nested) and TAP's "location: '<file>:<line>:<col>'". A file under `cwd` comes back cwd-relative, the form
 *  node --test accepted on the command line; anything else keeps the path the log printed. */
export function failingTestFiles(output, cwd, platform = process.platform) {
  const text = stripAnsi(output), found = new Set();
  for (const match of text.matchAll(/^\s*test at (\S+?):\d+:\d+\s*$/gm)) found.add(match[1]);
  for (const match of text.matchAll(/location: '([^']+?):\d+:\d+'/g)) {
    // Node's TAP reporter escapes backslashes in quoted locations. Spec locations are printed verbatim.
    const file = match[1];
    const escaped = platform === "win32" && /^(?:[a-z]:\\\\|\\\\\\\\)/i.test(file);
    found.add(escaped ? file.replace(/\\\\/g, "\\") : file);
  }
  const separator = platform === "win32" ? "\\" : "/", fold = path => platform === "win32" ? path.toLowerCase() : path;
  const trimmed = path => path.replace(/[\\/]+$/, ""), base = trimmed(cwd) + separator;
  const files = new Set();
  for (const file of found) {
    if (!TEST_FILE.test(file)) continue;
    const name = trimmed(file);
    files.add(fold(name).startsWith(fold(base)) ? name.slice(base.length) : file);
  }
  return [...files];
}
