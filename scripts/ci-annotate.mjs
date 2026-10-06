// CI: turn the "failing tests" section of node --test logs into public annotations (job logs need a sign-in to read).
import { existsSync, readFileSync } from "node:fs";
for (const file of process.argv.slice(2)) {
  if (!existsSync(file)) continue;
  const text = readFileSync(file, "utf8").replace(/\x1b\[[0-9;]*m/g, ""), at = text.lastIndexOf("failing tests:");
  const section = (at >= 0 ? text.slice(at) : text.slice(-6000)).split("\n").slice(0, 400);
  const blocks = section.join("\n").split(/\n(?=test at )/).slice(at >= 0 ? 1 : 0, 10);
  for (const block of blocks.length ? blocks : [section.join("\n")]) {
    console.log(`::error title=${file}::${block.slice(0, 4000).replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A")}`);
  }
}
