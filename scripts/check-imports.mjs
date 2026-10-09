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

// The CLI, orchestrator and evaluator run from the package directory, where the optional pi peer packages need not
// resolve: no value import (static or dynamic) reachable from them may name one. Type-only imports are erased. The
// chaos command is a test tool that needs pi and is exempt.
const entries = ["src/cli/main.ts", "src/orchestrator/main.ts", "src/evaluator/worker.ts", "src/evaluator/host.ts"];
const exempt = new Set([join("src", "cli", "chaos", "index.ts")]);
const local = /(?:^|[;\n])\s*(?:import|export)\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']|import\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
const peer = /(?:^|[;\n])\s*(?:import|export)\s+(?!type\s)(?:[^"';]*?\s+from\s+)?["'](@earendil-works\/[^"']+)["']|import\s*\(\s*["'](@earendil-works\/[^"']+)["']\s*\)/g;
const seen = new Map();
const visit = (file, via) => {
  if (seen.has(file) || exempt.has(file)) return;
  seen.set(file, via);
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(peer)) bad.push(`${file}: imports ${m[1] ?? m[2]} (reached from ${[...chain(file)].reverse().join(" -> ")})`);
  for (const m of src.matchAll(local)) if (!m[1]) visit(join(file, "..", m[2] ?? m[3]), file);
};
const chain = function* (file) { for (let f = file; f; f = seen.get(f)) yield f; };
for (const e of entries) visit(e, undefined);
if (bad.length) { console.error("Forbidden pi imports:\n" + bad.join("\n")); process.exit(1); }
console.log("imports ok");
