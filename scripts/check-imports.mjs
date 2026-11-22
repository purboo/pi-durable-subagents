// Fails if source imports a pi package through anything other than its root export (robustness R-AC1).
// Paths are resolved from this repository, not from the working directory, so the check means the same thing wherever
// CI starts it; messages name files relative to the repository with `/` separators on every platform.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep, dirname } from "node:path";
const root = resolve(import.meta.dirname, "..");
const shown = file => relative(root, file).split(sep).join("/");
const roots = [join(root, "src")];
const bad = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|mts|js|mjs)$/.test(f)) check(p); } };
const re = /(?:from\s+|import\s*\(\s*)["'](@earendil-works\/[^"']+|@mariozechner\/[^"']+)["']/g;
function check(p) {
  const src = readFileSync(p, "utf8");
  for (const m of src.matchAll(re)) {
    const spec = m[1];
    if (spec.startsWith("@mariozechner/")) bad.push(`${shown(p)}: legacy scope ${spec}`);
    else if (spec.split("/").length > 2) bad.push(`${shown(p)}: deep import ${spec}`);
  }
}
for (const r of roots) walk(r);

// The CLI, orchestrator (with its executor) and evaluator run from the package directory, where the optional pi peer
// packages need not resolve: no value import reachable from them may name one. The walk parses with TypeScript:
// static imports and re-exports (type-only ones are erased) and import() of a literal path or of
// new URL("./x.ts", import.meta.url). A dynamic import whose path is not a literal cannot be followed and fails the check. The chaos command
// is a test tool that needs pi and is exempt.
const ts = (await import("typescript")).default;
const entries = ["src/cli/main.ts", "src/orchestrator/main.ts", "src/orchestrator/executor/index.ts", "src/evaluator/worker.ts", "src/evaluator/host.ts"].map(e => join(root, e));
const exempt = new Set([join(root, "src", "cli", "chaos", "index.ts")]);
const literals = node => ts.isStringLiteralLike(node) ? [node.text] : ts.isConditionalExpression(node) ? [...literals(node.whenTrue), ...literals(node.whenFalse)]
  : ts.isParenthesizedExpression(node) ? literals(node.expression) : undefined;
/** import(new URL("./x.ts" or cond ? "./x.ts" : "./x.js", import.meta.url).href): the .ts paths. */
const urlLiterals = node => {
  const url = ts.isPropertyAccessExpression(node) && node.name.text === "href" ? node.expression : node;
  if (!ts.isNewExpression(url) || url.expression.getText() !== "URL" || url.arguments?.length !== 2 || !/import\.meta\.url/.test(url.arguments[1].getText())) return undefined;
  const paths = literals(url.arguments[0])?.filter(p => p.endsWith(".ts"));
  return paths?.length ? paths : undefined;
};
function references(file) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true), found = [];
  // Only `import type …` is erased: under verbatimModuleSyntax `import { type X } from "m"` still emits `import {} from "m"`.
  const typeOnly = clause => clause.isTypeOnly;
  const visitNode = node => {
    if (ts.isImportDeclaration(node) && !(node.importClause && typeOnly(node.importClause))) found.push(node.moduleSpecifier.text);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) found.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0], paths = arg && (literals(arg) ?? urlLiterals(arg));
      if (paths) found.push(...paths);
      else bad.push(`${shown(file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: dynamic import with a computed path cannot be checked`);
    }
    ts.forEachChild(node, visitNode);
  };
  visitNode(source);
  return found;
}
const seen = new Map();
const chain = function* (file) { for (let f = file; f; f = seen.get(f)) yield f; };
const visit = (file, via) => {
  if (seen.has(file) || exempt.has(file)) return;
  seen.set(file, via);
  for (const spec of references(file)) {
    if (/^@earendil-works\//.test(spec)) bad.push(`${shown(file)}: imports ${spec} (reached from ${[...chain(file)].reverse().map(shown).join(" -> ")})`);
    // A relative specifier is the module's own path with a `.ts` extension (rewriteRelativeImportExtensions).
    else if (spec.startsWith(".")) visit(join(dirname(file), spec), file);
  }
};
for (const e of entries) visit(e, undefined);
if (seen.size < 40) bad.push(`the import walk reached only ${seen.size} files from ${entries.map(shown).join(", ")}: the walk itself is broken`);
if (bad.length) { console.error("Forbidden pi imports:\n" + bad.join("\n")); process.exit(1); }
console.log("imports ok");
