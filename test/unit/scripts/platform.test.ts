// Platform handling the CI scripts rely on, checked for both platforms from either one (see scripts/lib/platform.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(import.meta.dirname, "../../..");
// A non-literal specifier: the scripts are plain ESM, which the TypeScript side of this repository does not declare.
const platform = await import(pathToFileURL(join(REPO, "scripts/lib/platform.mjs")).href) as {
  npmInvocation: (platform?: string, env?: NodeJS.ProcessEnv) => { command: string; args: string[]; shell: boolean };
  cmdArgs: (args: string[]) => string[];
  withBinPath: (dir: string, platform?: string, base?: string) => string;
  setEnvPath: (env: NodeJS.ProcessEnv, value: string) => NodeJS.ProcessEnv;
  fileSpecifier: (path: string) => string;
  treeKillCommand: (pid: number, platform?: string) => { command: string; args: string[] } | undefined;
};

test("npm runs through npm_execpath without a shell, else as npm.cmd through cmd.exe on Windows", () => {
  const cli = "/usr/lib/node_modules/npm/bin/npm-cli.js";
  assert.deepEqual(platform.npmInvocation("linux", { npm_execpath: cli }), { command: process.execPath, args: [cli], shell: false });
  // The same under `npm run` on Windows: this Node starts npm's own JS entry, so no shell and no quoting.
  const winCli = String.raw`C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js`;
  assert.deepEqual(platform.npmInvocation("win32", { npm_execpath: winCli }), { command: process.execPath, args: [winCli], shell: false });
  // Without npm_execpath: a Windows install has npm.cmd only, which Node starts only through a shell.
  assert.deepEqual(platform.npmInvocation("win32", {}), { command: "npm.cmd", args: [], shell: true });
  assert.deepEqual(platform.npmInvocation("linux", {}), { command: "npm", args: [], shell: false });
});

test("cmd.exe arguments are quoted, others are passed unchanged", () => {
  assert.deepEqual(platform.cmdArgs(["run", "build"]), ["run", "build"]);
  assert.deepEqual(platform.cmdArgs([String.raw`C:\Users\First Last\tmp`, "--pack-destination"]), ['"C:\\Users\\First Last\\tmp"', "--pack-destination"]);
});

test("PATH puts node_modules/.bin first with the platform separator", () => {
  assert.equal(platform.withBinPath(String.raw`C:\repo\node_modules\.bin`, "win32", String.raw`C:\Windows;`), String.raw`C:\repo\node_modules\.bin;C:\Windows;`);
  assert.equal(platform.withBinPath("/repo/node_modules/.bin", "linux", "/usr/bin:/bin"), "/repo/node_modules/.bin:/usr/bin:/bin");
  assert.equal(platform.withBinPath("/repo/node_modules/.bin", "linux", ""), "/repo/node_modules/.bin");
});

test("setting PATH in a copied environment leaves exactly one name for it", () => {
  // Windows spells it `Path`; a second `PATH` beside it makes the child read whichever one it finds first.
  assert.deepEqual(platform.setEnvPath({ Path: String.raw`C:\Windows`, HOME: "/h" }, "/bin"), { HOME: "/h", PATH: "/bin" });
  assert.deepEqual(platform.setEnvPath({ PATH: "/usr/bin" }, "/bin"), { PATH: "/bin" });
});

test("a module path becomes a file: URL, which import() accepts with a Windows drive letter", () => {
  assert.equal(platform.fileSpecifier("/tmp/dsa/kernel/mailbox.js"), pathToFileURL("/tmp/dsa/kernel/mailbox.js").href);
  // Importing the bare path `C:\…` would read `c:` as a URL scheme (ERR_UNSUPPORTED_ESM_URL_SCHEME).
  const windows = new URL("file:///C:/Users/First%20Last/pkg/dist/paths.js");
  assert.equal(windows.protocol, "file:");
  assert.equal(windows.pathname, "/C:/Users/First%20Last/pkg/dist/paths.js");
});

test("a timed-out run ends its whole tree with taskkill on Windows, the process group on POSIX", () => {
  assert.deepEqual(platform.treeKillCommand(4242, "win32"), { command: "taskkill", args: ["/pid", "4242", "/T", "/F"] });
  assert.equal(platform.treeKillCommand(4242, "linux"), undefined);
});
