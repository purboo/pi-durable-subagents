import assert from "node:assert/strict";
import fs, { readdirSync, renameSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { frameLine, hasJournalSnapshot, openJournal, readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { ownWorkflows, pendingRecovery, SETTLED_RECHECK_MS, workflowDigest, workflowDigestChecked } from "../../../src/orchestrator/snapshot.ts";
import { workflows, attention, unfinishedWorkflow } from "../../../src/agent/main/snapshots.ts";
import { UiData } from "../../../src/ui/data.ts";
import { callSession, digestDir, journalPath, orchLedger } from "../../../src/paths.ts";
import { JT } from "../../../src/types.ts";

async function fixture(home: string) {
  const ledger = await openJournal(orchLedger(home));
  await ledger.append("create-intent", { wid: "wf", origin: "main:s" });
  await ledger.append(JT.created, { wid: "wf", origin: "main:s" }); await ledger.close();
  const journal = await openJournal(journalPath(home, "wf"));
  await journal.append("wf-created", { origin: "main:s", revision: 1 });
  await journal.append("call", { key: "a", gen: 1, spec: { agent: "worker", task: "fallback task" } });
  await journal.append(JT.sealed, { call: "wf@1/a@1", result: { key: "a", gen: 1, ok: true, status: "ok", output: "ok" } });
  await journal.append(JT.done, { status: "done" });
  await journal.append(JT.attention, { item: { id: "finished:wf", rev: 1, kind: "finished", wid: "wf", text: "done" } });
  await journal.append(JT.attentionResolved, { id: "finished:wf", rev: 1 }); await journal.close();
}
function external(home: string, ledger: boolean) {
  const src = new URL("../../../src/", import.meta.url).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `
const {openJournal} = await import(${JSON.stringify(src + "kernel/journal.ts")});
${ledger ? `const l = await openJournal(${JSON.stringify(orchLedger(home))}); await l.append("request", {request:{rid:"follow",kind:"send",from:"main:s",body:{to:"wf/a",kind:"follow-up"}}}); await l.close();` : ""}
const j = await openJournal(${JSON.stringify(journalPath(home, "wf"))});
await j.append("generation", {key:"a",gen:2,spec:{agent:"worker",task:"more"}}); await j.close();
`], { timeout: 10_000 });
}

test("settled own workflows skip journal IO and release entries, including final facts with a task fallback", async t => {
  const home = await mkdtemp(join(tmpdir(), "digest-own-"));
  try {
    await fixture(home);
    let clock = Date.now() + 60_000;
    t.mock.method(Date, "now", () => clock);
    const data = new UiData(home); data.refresh("main:s");
    assert.equal(data.facts.get("wf@1/a@1")?.task, "fallback task");
    assert.equal(data.sessions.size, 0, "final facts retain no transcript");
    assert.equal(hasJournalSnapshot(journalPath(home, "wf")), false, "settled journal released after pass and facts fallback");
    // An explicit journal reader can load it again; the next digest pass drops it too.
    readJournalSnapshot(journalPath(home, "wf"));
    assert.equal(hasJournalSnapshot(journalPath(home, "wf")), true);
    const first = ownWorkflows(home, "main:s")[0];
    assert.equal(hasJournalSnapshot(journalPath(home, "wf")), false);
    const originalOpen = fs.openSync, originalStat = fs.statSync, touched: string[] = [];
    t.mock.method(fs, "openSync", (path: fs.PathLike, ...args: unknown[]) => { touched.push(String(path)); return (originalOpen as (...args: unknown[]) => number)(path, ...args); });
    t.mock.method(fs, "statSync", (path: fs.PathLike, ...args: unknown[]) => { touched.push(String(path)); return (originalStat as (...args: unknown[]) => unknown)(path, ...args); });
    syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    data.refresh("main:s");
    assert.strictEqual(data.workflows[0], first);
    assert.deepEqual(attention(home, "main:s", []), []);
    assert.ok(workflows(home, "main:s")[0]?.settled);
    assert.ok(!touched.includes(journalPath(home, "wf")), "unchanged settled journal was opened or stat'ed");
    external(home, true);
    data.refresh("main:s");
    assert.equal(data.workflows[0]?.followUps, 1, "ledger-first follow-up appears on the next refresh");
    clock += SETTLED_RECHECK_MS;
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("recent sealed calls use the digest's task fallback without journal IO on refresh", async t => {
  const home = await mkdtemp(join(tmpdir(), "digest-recent-"));
  try {
    await fixture(home);
    const data = new UiData(home); data.refresh("main:s");
    const stat = fs.statSync, touched: string[] = [];
    t.mock.method(fs, "statSync", (path: fs.PathLike, ...args: unknown[]) => { touched.push(String(path)); return (stat as (...args: unknown[]) => unknown)(path, ...args); });
    syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    data.refresh("main:s");
    assert.equal(data.facts.get("wf@1/a@1")?.task, "fallback task");
    assert.ok(!touched.includes(journalPath(home, "wf")), "a recent seal's task fallback rechecked a settled journal");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an external journal-only change is detected at the trust-window boundary", async t => {
  const home = await mkdtemp(join(tmpdir(), "digest-window-"));
  try {
    await fixture(home);
    let clock = Date.now(); t.mock.method(Date, "now", () => clock);
    ownWorkflows(home, "main:s");
    external(home, false);
    assert.equal(ownWorkflows(home, "main:s")[0]?.followUps, undefined);
    clock += SETTLED_RECHECK_MS;
    assert.equal(ownWorkflows(home, "main:s")[0]?.followUps, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("layered trust windows never outlive reused digests with interleaved starter, owner, main and UI readers", async t => {
  for (const first of ["owner", "main", "ui"] as const) {
    const home = await mkdtemp(join(tmpdir(), `digest-layered-${first}-`));
    try {
      const l = await openJournal(orchLedger(home));
      await l.append(JT.created, { wid: "wf", origin: "main:s" }); await l.close();
      const j = await openJournal(journalPath(home, "wf"));
      await j.append("wf-created", { origin: "main:s", revision: 1 });
      await j.append(JT.done, { status: "done" });
      await j.append(JT.attention, { item: { id: "finished:wf", rev: 1, kind: "finished", wid: "wf", text: "done" } }); await j.close();
      const start = Date.now() + 60_000;
      let clock = start; t.mock.method(Date, "now", () => clock);
      assert.equal(unfinishedWorkflow(home), false, "starter checks the listing at t=0");
      const data = new UiData(home), warning = "fence:external";
      const poll = {
        owner: () => ownWorkflows(home, "main:s")[0]?.attention.some(a => a.id === warning) ?? false,
        main: () => attention(home, "main:s", []).some(a => a.id === warning),
        ui: () => { data.refresh("main:s"); return data.workflows[0]?.attention.some(a => a.id === warning) ?? false; },
      };
      const order = [first, ...(["owner", "main", "ui"] as const).filter(name => name !== first)];
      clock = start + 1000;
      for (const name of order) assert.equal(poll[name](), false, `${name} checks the digest at t=1000`);
      const ledgerSize = fs.statSync(orchLedger(home)).size;
      clock = start + 1001;
      execFileSync(process.execPath, ["--input-type=module", "-e", `
const {openJournal} = await import(${JSON.stringify(new URL("../../../src/kernel/journal.ts", import.meta.url).href)});
const j = await openJournal(${JSON.stringify(journalPath(home, "wf"))});
await j.append("attention", {item:{id:${JSON.stringify(warning)},rev:1,kind:"unknown",wid:"wf",call:"wf@1/a@1",text:"fence warning"}}); await j.close();
`], { timeout: 10_000 });
      const observations: { at: number; reader: string; visible: boolean }[] = [];
      for (const at of [4999, 5000, 5001, 5999, 6000, 6001, 9999, 10000]) {
        clock = start + at;
        // The listing refresh at t=5000 must not renew a digest last checked at t=1000.
        if (at === 5000) assert.equal(unfinishedWorkflow(home), false);
        for (const name of order) observations.push({ at, reader: name, visible: poll[name]() });
        if (at === 5000) assert.equal(workflowDigestChecked(home, "wf"), start + 1000, "listing/pass reuse never renews the journal identity check");
      }
      assert.equal(fs.statSync(orchLedger(home)).size, ledgerSize, "external append never changes the ledger");
      for (const { at, reader, visible } of observations) if (at >= 1000 + SETTLED_RECHECK_MS)
        assert.equal(visible, true, `${first}-first ${reader} at t=${at}: digest expiry cannot be renewed by listing/pass reuse`);
    } finally { t.mock.restoreAll(); await rm(home, { recursive: true, force: true }); }
  }
});

test("UI view reuse cannot renew final session facts after an unrelated config refresh", async t => {
  const home = await mkdtemp(join(tmpdir(), "digest-view-window-"));
  try {
    await fixture(home);
    const start = Date.now() + 60_000;
    let clock = start; t.mock.method(Date, "now", () => clock);
    assert.equal(unfinishedWorkflow(home), false);
    clock = start + 1000;
    const path = callSession(home, "wf", "a", 1), data = new UiData(home);
    fs.mkdirSync(join(path, ".."), { recursive: true });
    const message = (text: string) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
    writeFileSync(path, message("before"));
    data.refresh("main:s"); assert.equal(data.facts.get("wf@1/a@1")?.latest, "before");
    clock = start + 1001;
    execFileSync(process.execPath, ["--input-type=module", "-e", `
import {appendFileSync} from "node:fs";
appendFileSync(${JSON.stringify(path)}, ${JSON.stringify(message("after"))});
`], { timeout: 10_000 });
    clock = start + 5000;
    writeFileSync(join(home, "config.json"), JSON.stringify({ ui: { dock: "line" } }));
    data.refresh("main:s"); assert.equal(data.dock, "line");
    assert.equal(data.facts.get("wf@1/a@1")?.latest, "before", "facts still inside their original trust may be reused");
    clock = start + 6000;
    data.refresh("main:s"); assert.equal(data.facts.get("wf@1/a@1")?.latest, "after", "view/config refresh never renews the session check");
  } finally { t.mock.restoreAll(); await rm(home, { recursive: true, force: true }); }
});

test("truncated and replaced settled journals invalidate at the window boundary", async t => {
  const home = await mkdtemp(join(tmpdir(), "digest-replaced-"));
  try {
    let clock = Date.now(); t.mock.method(Date, "now", () => clock);
    for (const mode of ["truncate", "replace"]) {
      const dir = join(home, mode); await fixture(dir);
      ownWorkflows(dir, "main:s");
      const content = [
        { seq: 1, ts: clock, type: "wf-created", origin: "main:s", revision: 1, name: mode },
        { seq: 2, ts: clock, type: JT.done, status: "done" },
        { seq: 3, ts: clock, type: JT.attention, item: { id: "finished:wf", rev: 1, kind: "finished", wid: "wf", text: "done" } },
      ].map(e => frameLine(JSON.stringify(e))).join("");
      const path = journalPath(dir, "wf");
      if (mode === "truncate") writeFileSync(path, content);
      else { writeFileSync(`${path}.replacement`, content); renameSync(`${path}.replacement`, path); }
      assert.equal(ownWorkflows(dir, "main:s")[0]?.name, undefined);
      clock += SETTLED_RECHECK_MS;
      assert.equal(ownWorkflows(dir, "main:s")[0]?.name, mode);
      assert.equal(hasJournalSnapshot(path), false);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an unchanged owner/main/UI pass skips readdir and returns identical result objects", async t => {
  const home = await mkdtemp(join(tmpdir(), "reader-unchanged-")); t.after(() => rm(home, { recursive: true, force: true }));
  await fixture(home);
  let clock = Date.now() + 60_000; t.mock.method(Date, "now", () => clock);
  const data = new UiData(home), revision = data.refresh("main:s"), ordered = data.workflows, facts = data.facts;
  const own = ownWorkflows(home, "main:s"), main = workflows(home, "main:s");
  const list = fs.readdirSync;
  let scans = 0;
  t.mock.method(fs, "readdirSync", (...args: unknown[]) => { if (String(args[0]) === join(home, "w")) scans++; return (list as (...args: unknown[]) => unknown)(...args); });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(ownWorkflows(home, "main:s"), own);
  assert.equal(workflows(home, "main:s"), main);
  assert.equal(data.refresh("main:s"), revision);
  assert.equal(data.workflows, ordered); assert.equal(data.facts, facts); assert.equal(scans, 0);
  clock += SETTLED_RECHECK_MS; data.refresh("main:s");
  assert.ok(scans > 0, "the bounded fallback lists w/ again");
  assert.equal(hasJournalSnapshot(orchLedger(home)), false);
});

test("a mixed owner pass checks only unsettled journals and preserves its settled workflow", async t => {
  const home = await mkdtemp(join(tmpdir(), "reader-mixed-")); t.after(() => rm(home, { recursive: true, force: true }));
  await fixture(home);
  const l = await openJournal(orchLedger(home)); await l.append(JT.created, { wid: "live", origin: "main:s" }); await l.close();
  const j = await openJournal(journalPath(home, "live"));
  await j.append("wf-created", { origin: "main:s", revision: 1 });
  await j.append("call", { key: "b", gen: 1, spec: { agent: "worker", task: "live" } }); await j.close();
  const before = ownWorkflows(home, "main:s"), main = workflows(home, "main:s"), settled = before.find(w => w.wid === "wf");
  const stat = fs.statSync, list = fs.readdirSync; let settledStats = 0, liveStats = 0, scans = 0;
  t.mock.method(fs, "statSync", (...args: unknown[]) => {
    if (String(args[0]) === journalPath(home, "wf")) settledStats++;
    if (String(args[0]) === journalPath(home, "live")) liveStats++;
    return (stat as (...args: unknown[]) => unknown)(...args);
  });
  t.mock.method(fs, "readdirSync", (...args: unknown[]) => { scans++; return (list as (...args: unknown[]) => unknown)(...args); });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(ownWorkflows(home, "main:s"), before); assert.equal(workflows(home, "main:s"), main);
  assert.equal(settledStats, 0); assert.ok(liveStats > 0); assert.equal(scans, 0);
  execFileSync(process.execPath, ["--input-type=module", "-e", `
const {openJournal} = await import(${JSON.stringify(new URL("../../../src/kernel/journal.ts", import.meta.url).href)});
const j = await openJournal(${JSON.stringify(journalPath(home, "live"))});
await j.append("sealed", {call:"live@1/b@1",result:{key:"b",gen:1,status:"ok",ok:true}}); await j.close();
`], { timeout: 10_000 });
  const after = ownWorkflows(home, "main:s");
  assert.notEqual(after, before); assert.equal(after.find(w => w.wid === "wf"), settled);
  assert.equal(after.find(w => w.wid === "live")?.calls[0]?.phase, "sealed");
  assert.equal(settledStats, 0); assert.equal(scans, 0);
});

test("a committed revision intent stays checked until its journal revision is applied", async t => {
  const home = await mkdtemp(join(tmpdir(), "reader-revision-")); t.after(() => rm(home, { recursive: true, force: true }));
  await fixture(home); t.mock.method(Date, "now", () => 2_000_000_000_000);
  const l = await openJournal(orchLedger(home)); await l.append("revise-intent", { wid: "wf", revision: 2 }); await l.close();
  assert.equal(ownWorkflows(home, "main:s")[0]?.rev, 1); workflows(home, "main:s");
  const before = fs.statSync(orchLedger(home)).size;
  execFileSync(process.execPath, ["--input-type=module", "-e", `
const {openJournal} = await import(${JSON.stringify(new URL("../../../src/kernel/journal.ts", import.meta.url).href)});
const j = await openJournal(${JSON.stringify(journalPath(home, "wf"))});
await j.append("revised", {revision:2}); await j.close();
`], { timeout: 10_000 });
  assert.equal(fs.statSync(orchLedger(home)).size, before);
  assert.equal(ownWorkflows(home, "main:s")[0]?.rev, 2);
  assert.ok(workflows(home, "main:s")[0]?.entries.some(e => e.type === "revised"));
});

test("a committed intent whose directory materializes later is found on the next pass", async t => {
  const home = await mkdtemp(join(tmpdir(), "reader-materialize-")); t.after(() => rm(home, { recursive: true, force: true }));
  const l = await openJournal(orchLedger(home));
  await l.append("create-intent", { wid: "later", origin: "main:s" }); await l.close();
  assert.deepEqual(ownWorkflows(home, "main:s"), []);
  assert.deepEqual(workflows(home, "main:s"), []);
  execFileSync(process.execPath, ["--input-type=module", "-e", `
const {openJournal} = await import(${JSON.stringify(new URL("../../../src/kernel/journal.ts", import.meta.url).href)});
const j = await openJournal(${JSON.stringify(journalPath(home, "later"))});
await j.append("wf-created", {origin:"main:s",revision:1}); await j.close();
`], { timeout: 10_000 });
  assert.deepEqual(ownWorkflows(home, "main:s").map(w => w.wid), ["later"]);
  // The main reader historically attributes only ledger `created`, not `create-intent`/`wf-created`.
  assert.deepEqual(workflows(home, "main:s"), []);
  const created = await openJournal(orchLedger(home)); await created.append(JT.created, { wid: "later", origin: "main:s" }); await created.close();
  assert.deepEqual(workflows(home, "main:s").map(w => w.wid), ["later"]);
});

test("an undelivered follow-up reopened by the engine is visible on the next pass with unchanged ledger and clock", async t => {
  const home = await mkdtemp(join(tmpdir(), "reader-reopen-")); t.after(() => rm(home, { recursive: true, force: true }));
  const l = await openJournal(orchLedger(home));
  await l.append(JT.created, { wid: "wf", origin: "main:s" });
  await l.append("request", { request: { rid: "follow", kind: "send", body: { kind: "follow-up", to: "wf/a" } } }); await l.close();
  const j = await openJournal(journalPath(home, "wf"));
  await j.append("wf-created", { origin: "main:s", revision: 1 });
  await j.append("call", { key: "a", gen: 1, spec: { agent: "worker", task: "task" } });
  await j.append("forward", { rid: "follow", rid2: "f2", dest: "wf@1/a@1", envelope: { kind: "follow-up", body: { message: "continue" } } });
  await j.append(JT.sealed, { call: "wf@1/a@1", result: { key: "a", gen: 1, status: "ok", ok: true } });
  await j.append("forward-retired", { rid: "follow", rid2: "f2", reason: "undelivered-follow-up" });
  await j.append(JT.done, { status: "done" });
  await j.append(JT.attention, { item: { id: "finished:wf", rev: 1, kind: "finished", wid: "wf", text: "done" } });
  await j.close();
  t.mock.method(Date, "now", () => 2_000_000_000_000);
  const data = new UiData(home); data.refresh("main:s"); workflows(home, "main:s");
  assert.equal(workflowDigest(home, "wf").settled, undefined, "pending forwarded work is never settled");
  const before = fs.statSync(orchLedger(home)).size, src = new URL("../../../src/", import.meta.url).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `
const { openJournal } = await import(${JSON.stringify(src + "kernel/journal.ts")});
const { Engine } = await import(${JSON.stringify(src + "orchestrator/engine.ts")});
const orch = await openJournal(${JSON.stringify(orchLedger(home))}), journal = await openJournal(${JSON.stringify(journalPath(home, "wf"))});
const engine = new Engine({ home: ${JSON.stringify(home)}, config: {}, orch }, {}, { evaluator: {} });
engine.dispatchGeneration = () => {};
await engine.reopenForwarded({ wid: "wf", revision: 1, origin: "main:s", journal });
await journal.close(); await orch.close();
`], { timeout: 10_000 });
  assert.equal(fs.statSync(orchLedger(home)).size, before);
  assert.equal(ownWorkflows(home, "main:s")[0]?.followUps, 1);
  assert.equal(workflows(home, "main:s")[0]?.entries.filter(e => e.type === "generation").length, 1);
  data.refresh("main:s"); assert.equal(data.workflows[0]?.followUps, 1);
});

test("recovery predicates cover missing notices, forwards, fences, gates, cleanup and retired questions", () => {
  const entries = (rows: Record<string, unknown>[]) => rows.map((e, i) => ({ seq: i + 1, ts: i + 1, ...e })) as import("../../../src/types.ts").Entry[];
  const done = [{ type: JT.done, status: "done" }, { type: JT.attention, item: { id: "finished:wf", rev: 1, kind: "finished", wid: "wf" } }];
  assert.equal(pendingRecovery("wf", entries(done)), false);
  for (const row of [
    { type: "forward", rid: "r", rid2: "f", dest: "wf@1/a@1" }, { type: JT.exec, exec: "e" },
    { type: "gate-intent", id: "g" }, { type: JT.sealed, call: "wf@1/a@1", result: { status: "unknown" } },
    { type: "generation", key: "a", gen: 2, revision: 1 },
  ]) {
    const rows = row.type === "generation" ? [...done, row, { type: JT.sealed, call: "wf@1/a@2" }] : [...done, row];
    assert.equal(pendingRecovery("wf", entries(rows)), true, String(row.type));
  }
  assert.equal(pendingRecovery("wf", entries(done.slice(0, 1))), true, "missing workflow completion notice");
  assert.equal(pendingRecovery("wf", entries([...done, { type: "wt-intent", call: "c" }, { type: JT.sealed, call: "c", result: { status: "ok" } }])), true);
  assert.equal(pendingRecovery("wf", entries([...done, { type: JT.sealed, call: "c" }, { type: JT.attention, item: { id: "q", call: "c", rev: 1, kind: "question" } }])), true);
});

test("concurrent digest writers leave a complete keyed record and no temporary files", async () => {
  const home = await mkdtemp(join(tmpdir(), "digest-writers-"));
  try {
    await fixture(home);
    const src = new URL("../../../src/orchestrator/snapshot.ts", import.meta.url).href;
    const code = `const s = await import(${JSON.stringify(src)}); s.ownWorkflows(${JSON.stringify(home)}, "main:s");`;
    const { spawn } = await import("node:child_process");
    await Promise.all(Array.from({ length: 3 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "pipe", timeout: 10_000 });
      child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(`writer exit ${code}`)));
    })));
    assert.deepEqual(readdirSync(digestDir(home)), ["wf.json"]);
    assert.equal(ownWorkflows(home, "main:s")[0]?.status, "done");
  } finally { await rm(home, { recursive: true, force: true }); }
});
