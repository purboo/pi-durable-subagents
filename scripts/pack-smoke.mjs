// Release check: build, `npm pack`, unpack into a temp prefix and run the PACKAGED product end to end:
// `pi-durable-subagents smoke`, then a real two-step chain through the packaged orchestrator, executor, evaluator
// and child extension (pi with the test faux provider). Never touches ~/.pi or the real DSA_HOME.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, ".."), keep = process.argv.includes("--keep");
const root = mkdtempSync(join(tmpdir(), "dsa-pack-"));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });
try {
  run("npm", ["run", "build"], { cwd: repo });
  const tgz = run("npm", ["pack", "--pack-destination", root, "--silent"], { cwd: repo }).trim().split("\n").at(-1);
  const pkg = join(root, "node_modules", "pi-durable-subagents");
  mkdirSync(pkg, { recursive: true });
  run("tar", ["-xzf", join(root, tgz), "-C", pkg, "--strip-components=1"]);
  const files = run("tar", ["-tzf", join(root, tgz)]).trim().split("\n");
  for (const bad of files.filter(f => /\/(src|test|design)\/|\.ts$/.test(f) && !f.endsWith(".d.ts"))) throw new Error(`unexpected file in package: ${bad}`);
  for (const need of ["package/dist/agent/extension.js", "package/dist/orchestrator/main.js", "package/dist/evaluator/worker.js", "package/dist/cli/main.js", "package/agents/worker.md", "package/LICENSE", "package/README.md"])
    if (!files.includes(need)) throw new Error(`missing from package: ${need}`);
  console.log(`package: ${tgz} (${files.length} files)`);

  const home = join(root, "dsa"), agentDir = join(root, "agent"), cwd = join(root, "work");
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true }); mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [join(repo, "test/harness/faux-provider.ts")], defaultProvider: "probe", defaultModel: "scripted" }));
  writeFileSync(join(cwd, ".pi/agents/echo.md"), "---\nname: echo\ndescription: echo\ntools: bash\n---\nYou echo.\n");
  const env = { ...process.env, DSA_HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PROBE_DIR: root,
    PATH: `${join(repo, "node_modules/.bin")}:${process.env.PATH}` };
  console.log(run(process.execPath, [join(pkg, "dist/cli/main.js"), "smoke"], { env }).trim());

  const script = steps => `#script: ${JSON.stringify(steps)}`;
  const req = { rid: "pack-1", from: "pack:smoke", to: "orch", sseq: 1, kind: "run",
    body: { cwd, chain: [{ agent: "echo", task: script([{ text: "alpha" }]) }, { agent: "echo", task: `after {previous}: ${script([{ text: "beta" }])}` }] } };
  mkdirSync(join(home, "inbox"), { recursive: true });
  const { publishRequest } = await import(join(pkg, "dist/kernel/mailbox.js"));
  const { orchInbox, orchLedger, journalPath } = await import(join(pkg, "dist/paths.js"));
  const { readJournalSnapshot } = await import(join(pkg, "dist/kernel/journal.js"));
  await publishRequest(orchInbox(home), req);
  const orch = spawn(process.execPath, [join(pkg, "dist/orchestrator/main.js")], { env, stdio: ["ignore", "inherit", "inherit"] });
  const deadline = Date.now() + 90_000;
  let done;
  while (!done) {
    if (Date.now() > deadline) throw new Error("packaged workflow did not finish in 90 s");
    const wid = readJournalSnapshot(orchLedger(home)).find(e => e.type === "created" && e.rid === req.rid)?.wid;
    done = wid && readJournalSnapshot(journalPath(home, wid)).find(e => e.type === "workflow-done");
    await new Promise(r => setTimeout(r, 200));
  }
  orch.kill("SIGTERM");
  const outputs = Array.isArray(done.result) ? done.result.map(r => r.output) : [];
  if (done.status !== "done" || outputs.join(",") !== "alpha,beta") throw new Error(`unexpected result: ${JSON.stringify(done)}`);
  console.log(`packaged chain: ${done.status} ${JSON.stringify(outputs)}`);
  console.log("pack-smoke ok");
} finally {
  if (keep) console.log(`kept: ${root}`); else rmSync(root, { recursive: true, force: true });
}
