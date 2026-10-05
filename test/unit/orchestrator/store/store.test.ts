import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { orchLedger } from "../../../../src/paths.ts";
import { Store } from "../../../../src/orchestrator/store.ts";
import type { Request, RunBody } from "../../../../src/types.ts";

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "dsa-store-")), cwd = join(home, "project"), agents = join(home, "config", "agents");
  await mkdir(cwd, { recursive: true }); await mkdir(agents, { recursive: true });
  const orch = await openJournal(orchLedger(home)), store = new Store({ home, orch, config: {} });
  t.after(async () => {
    for (const dir of [["staging"], ["staging", "transient"], ["staging", "transient", "inputs"]]) await chmod(join(home, ...dir), 0o700).catch(() => {});
    await orch.close(); await rm(home, { recursive: true, force: true });
  });
  await writeFile(join(agents, "worker.md"), "---\nname: worker\ndescription: Works\n---\nWork.\n");
  await writeFile(join(agents, "broken.md"), "---\nname: broken\ndescription: Broken\nfallbackModels: a, b\n---\nBroken.\n");
  const discovery = { home, agentDir: join(home, "config"), globalNpmRoot: null };
  const run = (rid: string, body: Partial<RunBody>): Request<RunBody> => ({ rid, from: "cli:test", to: "orch", sseq: 1, kind: "run", body: { cwd, ...body } as RunBody });
  return { home, store, discovery, run, staging: (rid: string) => join(home, "staging", rid) };
}
const root = process.getuid?.() === 0;

test("E3 an unrelated bad agent file is a staging warning; a referenced one rejects the run", async t => {
  const f = await fixture(t);
  const ok = f.run("unrelated", { tasks: [{ agent: "worker", task: "go" }] });
  await f.store.stage(ok, f.discovery);
  const pins = await f.store.staged(ok);
  assert.ok(pins.agents.some(a => a.name === "worker"));
  const snapshot = JSON.parse(await readFile(join(f.staging("unrelated"), "snapshot.json"), "utf8"));
  assert.equal(snapshot.warnings.length, 1); assert.match(snapshot.warnings[0], /broken\.md: .*fallbackModels/);
  const bad = f.run("referenced", { source: "return await runs.run('k', { agent: 'broken', task: 'x' });" });
  await f.store.stage(bad, f.discovery);
  await assert.rejects(f.store.staged(bad), /broken\.md: .*fallbackModels/);
});

test("E3 deterministic validation errors are pinned durably", async t => {
  const f = await fixture(t);
  const missing = f.run("missing", { workflow: join(f.home, "absent.js") });
  await f.store.stage(missing, f.discovery);
  await assert.rejects(f.store.staged(missing), /ENOENT/);
  const invalid = f.run("invalid", { source: "return 1;", tasks: [{ agent: "worker", task: "x" }] });
  await f.store.stage(invalid, f.discovery);
  await assert.rejects(f.store.staged(invalid), /invalid-run/);
});

test("E3 a transient temp-file error propagates without failure.json and the next intake succeeds", { skip: root ? "root bypasses EACCES" : false }, async t => {
  const f = await fixture(t), input = join(f.home, "input.txt"), dir = f.staging("transient");
  await writeFile(input, "data"); await rm(join(f.home, "config", "agents", "broken.md"));
  const req = f.run("transient", { source: "return 1;", inputs: { data: input } });
  await mkdir(join(f.home, "staging"), { recursive: true }); await chmod(join(f.home, "staging"), 0o500);
  await assert.rejects(f.store.stage(req, f.discovery), { code: "EACCES" });
  await chmod(join(f.home, "staging"), 0o700);
  await assert.rejects(readFile(join(dir, "snapshot.json")), { code: "ENOENT" });
  // Snapshot published, then a staged input fails on its temp file (the staging dir itself stays writable).
  await f.store.stage(req, f.discovery);
  await rm(join(dir, "inputs", "data")); await chmod(join(dir, "inputs"), 0o500);
  await assert.rejects(f.store.stage(req, f.discovery), { code: "EACCES" });
  await chmod(join(dir, "inputs"), 0o700);
  await assert.rejects(readFile(join(dir, "failure.json")), { code: "ENOENT" });
  await f.store.stage(req, f.discovery);
  assert.equal((await f.store.staged(req)).source, "return 1;");
  assert.equal(await readFile(join(dir, "inputs", "data"), "utf8"), "data");
});
