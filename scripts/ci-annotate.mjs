// CI: turn the "failing tests" section of node --test logs into public annotations (job logs need a sign-in to read).
import { existsSync, readFileSync } from "node:fs";
for (const file of process.argv.slice(2)) {
  if (!existsSync(file)) continue;
  const text = readFileSync(file, "utf8").replace(/\x1b\[[0-9;]*m/g, ""), at = text.lastIndexOf("failing tests:");
  // TAP (the non-TTY default on older Node): each failure is a "not ok" block; skip the per-file summary ones.
  const tap = [...text.matchAll(/^\s*not ok \d+ - (.*)\n([\s\S]*?)\n\s*\.\.\./gm)].filter(m => !/failureType: 'subtestsFailed'|error: 'test failed'/.test(m[2]));
  if (at < 0 && tap.length) {
    for (const m of tap.slice(0, 10)) console.log(`::error title=${file}::${`not ok - ${m[1]}\n${m[2]}`.slice(0, 4000).replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A")}`);
    continue;
  }
  const section = (at >= 0 ? text.slice(at) : text.slice(-6000)).split("\n").slice(0, 400);
  const blocks = section.join("\n").split(/\n(?=test at )/).slice(at >= 0 ? 1 : 0, 10);
  for (const block of blocks.length ? blocks : [section.join("\n")]) {
    console.log(`::error title=${file}::${block.slice(0, 4000).replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A")}`);
  }
}
