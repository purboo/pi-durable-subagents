// A Windows helper (PowerShell, taskkill) is started by processes whose environment was deliberately isolated: the
// chaos/drill/e2e fixtures, the evaluator host and a service starter keep PATH and HOME and drop SystemRoot, TEMP,
// USERPROFILE, ComSpec and PSModulePath. powershell.exe cannot autoload Get-CimInstance from an empty %SystemRoot% and
// has no module analysis cache without %LOCALAPPDATA%, so the CIM process-table scan failed or outlasted the fence
// deadline (native Windows CI: "Fence timeout" at the full 15 s budget, "sweep failed ... Get-CimInstance").
import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { helperEnv, mergeEnv, normalizeEnv, envValue, systemRoot } from "../../../src/platform/windows.ts";

const isolated: NodeJS.ProcessEnv = { PATH: "C:\\iso\\bin;C:\\Windows\\System32", HOME: "C:\\iso\\home", TMPDIR: "C:\\iso\\tmp" };
/** The defaults the helper derives, with this platform's separator (the module runs on Windows, where join is `\`). */
const derived = (root: string) => ({ system32: join(root, "System32"), modules: join(root, "System32", "WindowsPowerShell", "v1.0", "Modules") });

test("a Windows helper gets the system variables an isolated caller dropped", () => {
  const env = helperEnv(isolated), paths = derived("C:\\Windows");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.windir, "C:\\Windows");
  assert.equal(env.SystemDrive, "C:");
  assert.equal(env.ComSpec, join(paths.system32, "cmd.exe"));
  assert.equal(env.PSModulePath, paths.modules);
  assert.equal(env.PATHEXT, ".COM;.EXE;.BAT;.CMD");
  // The temp directory and the profile are the operating system's answer for this process, never empty.
  assert.ok(env.TEMP && env.TEMP === env.TMP);
  assert.equal(env.USERPROFILE, homedir());
  assert.equal(env.APPDATA, join(homedir(), "AppData", "Roaming"));
  assert.equal(env.LOCALAPPDATA, join(homedir(), "AppData", "Local"));
});

test("a Windows helper keeps the caller's own values and adds only missing system variables", () => {
  const env = helperEnv({ ...isolated, SystemRoot: "D:\\Windows", PSModulePath: "C:\\mods", TEMP: "C:\\iso\\temp", TMP: "C:\\iso\\temp",
    ComSpec: "D:\\Windows\\system32\\cmd.exe", USERPROFILE: "C:\\Users\\runner", APPDATA: "C:\\Users\\runner\\AppData\\Roaming" });
  assert.equal(env.SystemRoot, "D:\\Windows");
  assert.equal(env.windir, "D:\\Windows");
  assert.equal(env.SystemDrive, "D:");
  assert.equal(env.ComSpec, "D:\\Windows\\system32\\cmd.exe");
  assert.equal(env.PSModulePath, "C:\\mods");
  assert.equal(env.TEMP, "C:\\iso\\temp");
  assert.equal(env.TMP, "C:\\iso\\temp");
  assert.equal(env.USERPROFILE, "C:\\Users\\runner");
  assert.equal(env.APPDATA, "C:\\Users\\runner\\AppData\\Roaming");
  // The caller's PATH and HOME are untouched: the helper adds nothing an isolated caller did not already have beyond
  // the system variables themselves (no credential, no token, no session variable).
  assert.equal(env.PATH, isolated.PATH);
  assert.equal(env.HOME, isolated.HOME);
  assert.equal(helperEnv({ TEMP: "first", TMP: "second" }).TMP, "second");
  assert.equal(env.TMPDIR, isolated.TMPDIR);
  assert.deepEqual(Object.keys(env).sort(), [...Object.keys(isolated), "APPDATA", "ComSpec", "LOCALAPPDATA", "PATHEXT", "PSModulePath",
    "SystemDrive", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "windir"].sort());
});

test("a helper environment without PATH still resolves System32", () => {
  const paths = derived("C:\\Windows");
  assert.equal(helperEnv({ HOME: "C:\\iso\\home" }).PATH, `${paths.system32};C:\\Windows`);
});

test("systemRoot reads the environment it is given, and defaults to the Windows directory", () => {
  assert.equal(systemRoot({ windir: "E:\\WinNT" }), "E:\\WinNT");
  assert.equal(systemRoot({}), "C:\\Windows");
  assert.equal(systemRoot({ SystemRoot: "D:\\Windows", windir: "E:\\WinNT" }), "D:\\Windows");
  assert.equal(systemRoot({ WINDIR: "E:\\WinNT" }), "E:\\WinNT", "names compare case-insensitively");
});

// Windows has one variable per name: `Path` and `PATH` are the same variable, and so are `ComSpec` and `COMSPEC`. A block
// carrying both (what `{...inherited, ...call}` produces when their spellings differ) leaves it to Windows which definition
// a child reads, so a call's own PATH or ComSpec would silently not apply.
test("environment names on Windows are one name whatever their case, and the last definition wins", () => {
  assert.equal(envValue({ Path: "C:\\a" }, "PATH"), "C:\\a");
  assert.equal(envValue({ PATH: "C:\\a", Path: "C:\\b" }, "PATH"), "C:\\b", "the later definition wins, as process.env does");
  assert.equal(envValue({ PATH: "C:\\a" }, "ComSpec"), undefined);
  const merged = mergeEnv({ Path: "C:\\inherited", ComSpec: "C:\\inherited\\cmd.exe", KEEP: "1" },
    { PATH: "C:\\call", COMSPEC: "D:\\cmd.exe", dsa_home: "C:\\wrong" }, { PATH: "C:\\last", DSA_HOME: "/h" });
  const named = (name: string) => Object.keys(merged).filter(key => key.toUpperCase() === name);
  assert.deepEqual(named("PATH"), ["PATH"]);
  assert.equal(merged.PATH, "C:\\last");
  assert.equal(merged.Path, undefined, "the inherited spelling is gone, not a second definition");
  assert.deepEqual(named("COMSPEC"), ["COMSPEC"]);
  assert.equal(merged.COMSPEC, "D:\\cmd.exe");
  assert.equal(merged.KEEP, "1", "other variables stay as they were");
  assert.deepEqual(named("DSA_HOME"), ["DSA_HOME"]);
  assert.equal(merged.dsa_home, undefined);
  assert.equal(merged.DSA_HOME, "/h");
  // normalizeEnv is mergeEnv without overrides: one definition per name, the later spelling winning.
  assert.deepEqual(normalizeEnv({ Path: "a", PATH: "b", PathExt: ".CMD" }), { PATH: "b", PathExt: ".CMD" });
  assert.equal(Object.keys(mergeEnv({}, { Path: "x" }))[0], "Path", "an unambiguous spelling is kept as given");
});

test("a Windows helper keeps the caller's own spelling of a shared name (PATH/Path, ComSpec/COMSPEC)", () => {
  const env = helperEnv({ Path: "C:\\iso\\bin", COMSPEC: "D:\\Windows\\system32\\cmd.exe", HOME: "C:\\iso\\home" });
  assert.deepEqual(Object.keys(env).filter(key => key.toUpperCase() === "PATH"), ["Path"], "no second PATH beside the caller's Path");
  assert.equal(env.Path, "C:\\iso\\bin");
  assert.deepEqual(Object.keys(env).filter(key => key.toUpperCase() === "COMSPEC"), ["COMSPEC"]);
  assert.equal(env.COMSPEC, "D:\\Windows\\system32\\cmd.exe");
});
