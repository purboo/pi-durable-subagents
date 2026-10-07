// The version of this package, read from its package.json (src/ and dist/ both sit one level below it).
import { readFileSync } from "node:fs";

let cached: string | undefined;
export function packageVersion(): string {
  if (cached === undefined) {
    try { cached = String((JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown }).version ?? "unknown"); }
    catch { cached = "unknown"; }
  }
  return cached;
}
