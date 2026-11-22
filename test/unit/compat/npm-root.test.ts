// Issue #5: agent discovery asks `npm root -g` once per set of inputs, not on every pi start, run admission or request.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { globalNpmRoot } from "../../../src/compat/agents.ts";

const agents = fileURLToPath(new URL("../../../src/compat/agents.ts", import.meta.url));

/** A home with a fake `npm` first on PATH that counts its starts and prints `root` (or fails). Like a real install,
 *  `bin/npm` links to the npm package's `bin/npm-cli.js`; `shim` puts a version manager's shim there instead. */
function fixture(t: TestContext, shim = false) {
  const dir = mkdtempSync(join(tmpdir(), "dsa-npm-root-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin"), count = join(dir, "count"), out = join(dir, "root");
  const cli = shim ? join(dir, "shims", "npm") : join(dir, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  mkdirSync(bin); mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, `#!/bin/sh\necho x >> '${count}'\n[ -s '${out}' ] || exit 1\ncat '${out}'\n`);
  chmodSync(cli, 0o755);
  symlinkSync(cli, join(bin, "npm"));
  writeFileSync(out, "/prefix-a/lib/node_modules\n");
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, DSA_HOME: join(dir, "dsa"), DSA_CACHE_HOME: join(dir, "dsa") };
  const starts = () => existsSync(count) ? readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0;
  /** A fresh process: one discovery-time lookup each, sharing only the cache file. */
  const lookup = (extra: Record<string, string> = {}) => execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { globalNpmRoot } from ${JSON.stringify(agents)}; process.stdout.write(String(globalNpmRoot()));`],
  { env: { ...env, ...extra }, encoding: "utf8" });
  return { dir, bin, cli, out, env, starts, lookup, cache: join(dir, "dsa", "cache", "npm-root.json") };
}

test("a second process reuses the answer: npm starts once per set of inputs", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  assert.equal(f.lookup(), "/prefix-a/lib/node_modules");
  assert.equal(f.lookup(), "/prefix-a/lib/node_modules");
  assert.equal(f.starts(), 1, "the second process read the cache");
  assert.ok(existsSync(f.cache));

  // ~/.npmrc may set prefix: a changed file asks npm again.
  writeFileSync(join(f.dir, ".npmrc"), "prefix=/prefix-b\n");
  writeFileSync(f.out, "/prefix-b/lib/node_modules\n");
  assert.equal(f.lookup(), "/prefix-b/lib/node_modules");
  assert.equal(f.starts(), 2);
  // So does the prefix environment, kept as its own entry beside the first.
  writeFileSync(f.out, "/prefix-c/lib/node_modules\n");
  assert.equal(f.lookup({ npm_config_prefix: "/prefix-c" }), "/prefix-c/lib/node_modules");
  assert.equal(f.lookup({ npm_config_prefix: "/prefix-c" }), "/prefix-c/lib/node_modules");
  assert.equal(f.lookup(), "/prefix-b/lib/node_modules");
  assert.equal(f.starts(), 3);
  // And a different npm executable (an npm upgrade or another node on PATH).
  utimesSync(f.cli, new Date(), new Date(Date.now() + 5000));
  writeFileSync(f.out, "/prefix-d/lib/node_modules\n");
  assert.equal(f.lookup(), "/prefix-d/lib/node_modules");
  assert.equal(f.starts(), 4);
});

test("agent discovery in two processes starts npm once and still finds global packages", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  const global = join(f.dir, "global", "lib", "node_modules");
  mkdirSync(join(global, "agents-pkg", "agents"), { recursive: true });
  writeFileSync(join(global, "agents-pkg", "package.json"), JSON.stringify({ name: "agents-pkg", "pi-subagents": { agents: ["agents"] } }));
  writeFileSync(join(global, "agents-pkg", "agents", "g.md"), "---\nname: global-agent\ndescription: from the global root\n---\nbody");
  writeFileSync(f.out, `${global}\n`);
  const discover = () => execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { discoverAgents } from ${JSON.stringify(agents)}; process.stdout.write(discoverAgents(${JSON.stringify(f.dir)}, { home: ${JSON.stringify(f.dir)}, agentDir: ${JSON.stringify(join(f.dir, "agent"))}, extraAgentDirs: [] }).agents.filter(a => a.source === "package").map(a => a.name).join());`],
  { env: f.env, encoding: "utf8" });
  assert.equal(discover(), "global-agent");
  assert.equal(discover(), "global-agent");
  assert.equal(f.starts(), 1);
});

test("a failed answer is null, never cached on disk; no npm on PATH starts nothing", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  writeFileSync(f.out, "");
  assert.equal(f.lookup(), "null");
  assert.equal(f.lookup(), "null");
  assert.equal(f.starts(), 2, "each process asked again");
  assert.ok(!existsSync(f.cache));
  writeFileSync(f.out, "/prefix-a/lib/node_modules\n");
  assert.equal(f.lookup(), "/prefix-a/lib/node_modules");

  let runs = 0;
  assert.equal(globalNpmRoot({ env: { PATH: join(f.dir, "missing"), HOME: f.dir }, cacheFile: null, run: () => { runs++; return "/x"; } }), null);
  assert.equal(runs, 0);
});

test("within one process the answer is remembered until an input changes", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  let runs = 0;
  const ask = () => globalNpmRoot({ env: f.env, cacheFile: null, run: () => { runs++; return `/r${runs}\n`; } });
  assert.equal(ask(), "/r1");
  assert.equal(ask(), "/r1");
  assert.equal(runs, 1);
  writeFileSync(join(f.dir, ".npmrc"), "prefix=/elsewhere\n");
  assert.equal(ask(), "/r2");
  assert.equal(runs, 2);
});

test("a version manager's shim picks node per directory: its answer is not kept across processes", { skip: process.platform === "win32" }, t => {
  const f = fixture(t, true);
  assert.equal(f.lookup(), "/prefix-a/lib/node_modules");
  assert.equal(f.lookup(), "/prefix-a/lib/node_modules");
  assert.equal(f.starts(), 2);
  assert.ok(!existsSync(f.cache));
});

/** A Windows npm: `npm` is `npm.cmd`, the batch file an npm install writes, and the npm package's CLI is a node script
 *  the batch file names (Node cannot start a batch file, and refuses to spawn one without a shell). `install` keeps the
 *  CLI where an npm install has it (`<bin>/node_modules/npm/bin/npm-cli.js`); `shim` keeps it in a version directory a
 *  generated `npm.cmd` names instead (forward slashes, so this fixture also resolves on a POSIX host). The CLI counts
 *  its starts and prints what the `root` file holds. */
function winFixture(t: TestContext, shape: "install" | "shim" = "install") {
  const dir = mkdtempSync(join(tmpdir(), "dsa-npm-root-win-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin"), count = join(dir, "count"), out = join(dir, "root"), version = join(dir, "versions", "22");
  mkdirSync(bin);
  const cli = join(shape === "install" ? join(bin, "node_modules", "npm", "bin") : join(version, "node_modules", "npm", "bin"), "npm-cli.js");
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, `import { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(count)}, "x\\n");\nprocess.stdout.write(readFileSync(${JSON.stringify(out)}, "utf8"));\n`);
  writeFileSync(join(bin, "npm.cmd"), shape === "install"
    ? "@ECHO OFF\r\nSET \"NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js\"\r\n\"%NODE_EXE%\" \"%NPM_CLI_JS%\" %*\r\n"
    : "@ECHO OFF\r\n\"%NODE_EXE%\" \"%~dp0/../versions/22/node_modules/npm/bin/npm-cli.js\" %*\r\n");
  writeFileSync(out, "C:\\prefix-a\\node_modules\r\n");
  // Lowercase PATHEXT: the file is `npm.cmd`, and a Windows filesystem matches extensions case-insensitively.
  const env = { PATH: bin, PATHEXT: ".cmd", HOME: dir, DSA_HOME: join(dir, "dsa"), DSA_CACHE_HOME: join(dir, "dsa") };
  const starts = () => existsSync(count) ? readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0;
  /** A fresh process: Windows discovery (PATHEXT lookup, npm.cmd's CLI, cmd.exe fallback) on any host. */
  const lookup = () => execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { globalNpmRoot } from ${JSON.stringify(agents)}; process.stdout.write(String(globalNpmRoot({ platform: "win32" })));`],
  { env, encoding: "utf8" });
  return { dir, bin, cli, out, env, starts, lookup, cache: join(dir, "dsa", "cache", "npm-root.json") };
}

test("Windows: the CLI behind npm.cmd answers, and an npm install's answer is kept across processes", t => {
  const f = winFixture(t);
  assert.equal(f.lookup(), "C:\\prefix-a\\node_modules");
  assert.equal(f.lookup(), "C:\\prefix-a\\node_modules");
  assert.equal(f.starts(), 1, "the second process read the cache");
  assert.ok(existsSync(f.cache));

  // The npm package's own npmrc (a builtin config) is an input too.
  writeFileSync(join(f.bin, "node_modules", "npm", "npmrc"), "prefix=C:\\prefix-b\n");
  writeFileSync(f.out, "C:\\prefix-b\\node_modules\r\n");
  assert.equal(f.lookup(), "C:\\prefix-b\\node_modules");
  assert.equal(f.starts(), 2);
  // So is a new npm.cmd: an npm or node upgrade changes the file the answer came from.
  utimesSync(join(f.bin, "npm.cmd"), new Date(), new Date(Date.now() + 5000));
  writeFileSync(f.out, "C:\\prefix-c\\node_modules\r\n");
  assert.equal(f.lookup(), "C:\\prefix-c\\node_modules");
  assert.equal(f.starts(), 3);
});

test("Windows: a version manager's npm.cmd is asked again in each process", t => {
  const f = winFixture(t, "shim");
  assert.equal(f.lookup(), "C:\\prefix-a\\node_modules");
  assert.equal(f.lookup(), "C:\\prefix-a\\node_modules");
  assert.equal(f.starts(), 2);
  assert.ok(!existsSync(f.cache));
});

test("Windows: a failed answer is null, never cached; no npm.cmd on PATH starts nothing", t => {
  const f = winFixture(t);
  writeFileSync(f.out, "");
  assert.equal(f.lookup(), "null");
  assert.equal(f.lookup(), "null");
  assert.equal(f.starts(), 2, "each process asked again");
  assert.ok(!existsSync(f.cache));

  // No npm.cmd on PATH: null without starting anything. The extensionless POSIX `npm` beside it is not a program here.
  writeFileSync(join(f.bin, "npm"), "#!/bin/sh\necho /x\n");
  const missing = { ...f.env, PATH: join(f.dir, "missing") };
  let runs = 0;
  assert.equal(globalNpmRoot({ platform: "win32", env: missing, cacheFile: null, run: () => { runs++; return "C:\\x"; } }), null);
  assert.equal(globalNpmRoot({ platform: "win32", env: { ...f.env, PATHEXT: "" }, cacheFile: null, run: () => { runs++; return "C:\\x"; } }), null);
  assert.equal(runs, 0);

  // Within one process the answer is remembered until an input changes.
  runs = 0;
  const ask = () => globalNpmRoot({ platform: "win32", env: f.env, cacheFile: null, run: () => { runs++; return `C:\\r${runs}\n`; } });
  assert.equal(ask(), "C:\\r1");
  assert.equal(ask(), "C:\\r1");
  assert.equal(runs, 1);
});

test("Windows: an npm.exe stub (Volta) runs itself, and its answer is not cached", { skip: process.platform === "win32" }, t => {
  const dir = mkdtempSync(join(tmpdir(), "dsa-npm-root-exe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin"), count = join(dir, "count"), root = "C:\\prefix-a\\node_modules";
  mkdirSync(bin);
  // A PE stub on Windows; a shell script of the same name runs here, with only shell builtins (no PATH outside `bin`).
  writeFileSync(join(bin, "npm.exe"), `#!/bin/sh\necho x >> '${count}'\nprintf '%s\\n' '${root}'\n`);
  chmodSync(join(bin, "npm.exe"), 0o755);
  const env = { PATH: bin, PATHEXT: ".exe", HOME: dir, DSA_HOME: join(dir, "dsa"), DSA_CACHE_HOME: join(dir, "dsa") };
  const starts = () => existsSync(count) ? readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0;
  const lookup = () => execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { globalNpmRoot } from ${JSON.stringify(agents)}; process.stdout.write(String(globalNpmRoot({ platform: "win32" })));`],
  { env, encoding: "utf8" });
  assert.equal(lookup(), root);
  assert.equal(lookup(), root);
  assert.equal(starts(), 2, "a stub picks its version per directory: each process asks");
  assert.ok(!existsSync(join(dir, "dsa", "cache", "npm-root.json")));
});

test("Windows: a generated npm.cmd with no npm package beside it runs through cmd.exe, spaces and all", { skip: process.platform !== "win32" }, t => {
  const dir = mkdtempSync(join(tmpdir(), "dsa-npm-root-cmd-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const count = join(dir, "count"), bin = join(dir, "Program Files", "nodejs"), root = "C:\\prefix-a\\node_modules";
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "npm.cmd"), `@ECHO OFF\r\n>>"${count}" ECHO x\r\nECHO ${root}\r\n`);
  const env = { PATH: bin, HOME: dir, DSA_HOME: join(dir, "dsa"), DSA_CACHE_HOME: join(dir, "dsa"), SystemRoot: process.env.SystemRoot ?? "C:\\Windows", ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe" };
  const lookup = () => execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { globalNpmRoot } from ${JSON.stringify(agents)}; process.stdout.write(String(globalNpmRoot()));`], { env, encoding: "utf8" });
  assert.equal(lookup(), root);
  assert.equal(readFileSync(count, "utf8").split("\n").filter(Boolean).length, 1);
  assert.ok(!existsSync(join(dir, "dsa", "cache", "npm-root.json")), "a batch shim's answer is not kept on disk");
});
