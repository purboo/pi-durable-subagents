// Fails if source imports a pi package through anything other than its root export (robustness R-AC1).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const roots = ["src"];
const bad = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|mts|js|mjs)$/.test(f)) check(p); } };
const re = /(?:from\s+|import\s*\(\s*)["'](@earendil-works\/[^"']+|@mariozechner\/[^"']+)["']/g;
function check(p) {
  const src = readFileSync(p, "utf8");
  for (const m of src.matchAll(re)) {
    const spec = m[1];
    if (spec.startsWith("@mariozechner/")) bad.push(`${p}: legacy scope ${spec}`);
    else if (spec.split("/").length > 2) bad.push(`${p}: deep import ${spec}`);
  }
}
for (const r of roots) walk(r);
if (bad.length) { console.error("Forbidden pi imports:\n" + bad.join("\n")); process.exit(1); }
console.log("imports ok");
