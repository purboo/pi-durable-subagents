// CI test runner: run a suite; if test files fail, rerun only those files once. A file that passes on the rerun is
// reported as a flaky warning (an annotation, never hidden); a file that fails twice fails the job.
// Shared CI runners are much slower and noisier than a workstation; real-process and timing-sensitive tests can
// miss a deadline there. A failure that repeats is a real failure.
// Output streams live, so a run that hangs shows its last test in the job log; a run still going after
// DSA_CI_RUN_MINUTES (default 25) is killed with its whole process group and counts as a failure.
//   node scripts/ci-test.mjs <log> [node --test args...]
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

const [log, ...args] = process.argv.slice(2);
const runMs = Number(process.env.DSA_CI_RUN_MINUTES ?? 25) * 60_000;
const run = (testArgs) => new Promise(resolve => {
  // Like `npm run`: the repository's node_modules/.bin (the `pi` the real-process tests launch) comes first on PATH.
  const env = { ...process.env, PATH: `${join(process.cwd(), "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}` };
  // Its own process group, so a deadline kill also reaches the per-file test processes holding the output pipes.
  const child = spawn(process.execPath, ["--test", ...testArgs], { env, detached: process.platform !== "win32" });
  let output = "", timedOut = false;
  const collect = stream => stream.setEncoding("utf8").on("data", chunk => { process.stdout.write(chunk); output += chunk; });
  collect(child.stdout); collect(child.stderr);
  const deadline = setTimeout(() => {
    timedOut = true;
    const note = `\n::error::node --test ${testArgs.join(" ")} still running after ${runMs / 60_000} min; killed\n`;
    process.stdout.write(note); output += note;
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }, runMs);
  child.on("close", code => { clearTimeout(deadline); resolve({ code: timedOut ? 1 : code ?? 1, output }); });
});
const first = await run(args);
writeFileSync(log, first.output);
if (first.code === 0) process.exit(0);

// Failing files: "test at <file>:<line>" (spec reporter) or a TAP "location: '<file>:<line>:<col>'".
const files = new Set();
const text = first.output.replace(/\x1b\[[0-9;]*m/g, "");
// The spec reporter indents "test at" under a nested test; this repository names test files *.test.{ts,mts,js,mjs,…}.
const testFile = /\.test\.[cm]?[jt]s$/;
for (const m of text.matchAll(/^\s*test at (\S+?):\d+:\d+\s*$/gm)) files.add(m[1]);
for (const m of text.matchAll(/location: '([^']+?):\d+:\d+'/g)) files.add(m[1]);
const relative = [...files].map(f => f.replace(`${process.cwd()}/`, "")).filter(f => testFile.test(f));
if (!relative.length) { console.log("::error::test run failed without an identifiable failing file"); process.exit(first.code); }

const flags = args.filter(a => a.startsWith("--"));
console.log(`\n=== rerunning ${relative.length} failing file(s) once: ${relative.join(", ")} ===\n`);
const second = await run([...flags, ...relative]);
appendFileSync(log, `\n=== rerun of ${relative.join(", ")} ===\n${second.output}`);
if (second.code === 0) {
  for (const f of relative) console.log(`::warning title=flaky test file::${f} failed once and passed when rerun alone`);
  process.exit(0);
}
process.exit(second.code);
