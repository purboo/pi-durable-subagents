import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLedger, emptyLedger, foldLedger, holdings, settingsOf, type LedgerState } from "../../../src/orchestrator/ledger.ts";
import type { Entry } from "../../../src/types.ts";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameLine, hasJournalSnapshot, readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { applyReaderLedger, emptyReaderLedger, readerHold, readerLedger } from "../../../src/orchestrator/reader-ledger.ts";
import { ledgerIndex, holdOf, ownWorkflows, runningOrchestrator, slotsView } from "../../../src/orchestrator/snapshot.ts";
import { workflows, unfinishedWorkflow } from "../../../src/agent/main/snapshots.ts";
import { orchLedger } from "../../../src/paths.ts";
import { UiActions, UiData } from "../../../src/ui/data.ts";

function randomLedger(n: number, seed: number): Entry[] {
  let x = seed;
  const rnd = (k: number) => { x = (x * 1103515245 + 12345) % 2 ** 31; return x % k; };
  const out: Entry[] = [];
  for (let i = 1; i <= n; i++) {
    const pool = ["p", "q", "memory"][rnd(3)]!, slot = rnd(3), exec = `e${rnd(4)}`;
    const kinds: Record<string, unknown>[] = [
      { type: "hold", pool, slot, exec }, { type: "release", pool, slot, exec },
      { type: "config", hash: `h${i}`, config: { providers: { p: { slots: rnd(3) } } } }, { type: "config-rejected", error: `bad ${i}` },
      { type: "skip", pool: "pool", model: `p/m${rnd(2)}`, until: i * 10 }, { type: "switch-observed", exec, rid: `r${rnd(3)}` },
      { type: "provider-exhausted", provider: pool, exec, since: i, nextTry: i + 5, error: "used up" }, { type: "provider-available", provider: pool, exec },
    ];
    out.push(Object.freeze({ seq: i, ts: i, ...kinds[rnd(kinds.length)]! }) as Entry);
  }
  return out;
}
const view = (s: LedgerState) => JSON.stringify({ held: [...s.held].sort(), observed: [...s.observed].sort(), skips: [...s.skips].sort(), exhausted: [...s.exhausted].sort(), config: s.config, rejected: s.rejected });

test("A1 the orchestrator ledger fold extended as the ledger grows equals one fold of the whole ledger", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const all = randomLedger(120, seed), whole = emptyLedger();
    for (const e of all) applyLedger(whole, e);
    const grown = emptyLedger();
    for (let end = 0; end <= all.length; end += 1 + (seed % 7)) foldLedger(grown, all.slice(0, end));
    foldLedger(grown, all);
    assert.equal(view(grown), view(whole), `seed ${seed}`);
    assert.equal(grown.seen, all.length);
  }
});

test("A1 another ledger (not a continuation of the one folded) is folded from the start", () => {
  const a = randomLedger(40, 3), b = randomLedger(60, 4), state = foldLedger(emptyLedger(), a);
  foldLedger(state, b);
  assert.equal(view(state), view(foldLedger(emptyLedger(), b)));
  foldLedger(state, b.slice(0, 10)); // shorter: a rewritten ledger
  assert.equal(view(state), view(foldLedger(emptyLedger(), b.slice(0, 10))));
});

test("compact reader state extends committed bytes and rebuilds on truncation or replacement", async t => {
  const home = await mkdtemp(join(tmpdir(), "reader-ledger-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = orchLedger(home), entries: Entry[] = [], append = (fields: Record<string, unknown>) => {
    const e = { seq: entries.length + 1, ts: entries.length + 1, ...fields } as Entry;
    entries.push(e); fs.appendFileSync(path, frameLine(JSON.stringify(e))); return e;
  };
  append({ type: "request", request: { rid: "r1", kind: "run", body: { session: "s", labels: { x: "1" }, origin: "x".repeat(200_000) } } });
  append({ type: "create-intent", rid: "r1", wid: "w1", origin: "main:s" });
  append({ type: "created", rid: "r1", wid: "w1", origin: "main:s" });
  append({ type: "config", hash: "a", config: { providers: { p: { slots: 2 } } } });
  const first = readerLedger(home), state = first.state;
  assert.equal(hasJournalSnapshot(path), false);
  assert.equal(readerLedger(home), first, "no newly decoded bytes returns the same record");
  const original = fs.readSync; let bytes = 0, largest = 0;
  t.mock.method(fs, "readSync", (...args: unknown[]) => {
    largest = Math.max(largest, Number(args[3]));
    const n = (original as (...args: unknown[]) => number)(...args); bytes += n; return n;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  append({ type: "drain", origin: "main:s" });
  append({ type: "hold", pool: "p", slot: 0, exec: "w1@1/a@1#1" });
  append({ type: "release", pool: "p", slot: 0, exec: "wrong" });
  append({ type: "revise-intent", wid: "w1", revision: 2 });
  append({ type: "send-note", rid: "send", model: "p/m", effect: "next-request" });
  append({ type: "applied", rid: "send" });
  const next = { seq: entries.length + 1, ts: 10, type: "undrain", wid: "w1" } as Entry, line = frameLine(JSON.stringify(next));
  fs.appendFileSync(path, line.slice(0, -2));
  let record = readerLedger(home);
  assert.equal(record.state, state, "appends extend the compact state in place");
  assert.equal(record.seen, entries.length, "torn tail is not consumed");
  assert.equal(record.length, fs.statSync(path).size - Buffer.byteLength(line.slice(0, -2)));
  assert.ok(bytes < 4096, "only the appended bytes are read, not the large backlog");
  fs.appendFileSync(path, line.slice(-2)); entries.push(next);
  record = readerLedger(home);
  const verify = () => {
    const rebuilt = emptyReaderLedger(); for (const e of entries) applyReaderLedger(rebuilt, e);
    assert.deepEqual(record.state, rebuilt);
    const ix = ledgerIndex(entries);
    for (const key of ["intents", "pruned", "labels", "runLabels", "sessions", "runSessions"] as const) assert.deepEqual(record.state[key], ix[key]);
    for (const wid of ["w1", "unknown"]) {
      const full = holdOf(entries, wid, "main:s"), compact = readerHold(record.state, wid, "main:s");
      assert.equal(compact?.seq, full?.seq);
    }
  };
  verify();
  entries.splice(2); fs.writeFileSync(path, entries.map(e => frameLine(JSON.stringify(e))).join(""));
  record = readerLedger(home); assert.notEqual(record.state, state); verify();
  fs.writeFileSync(path + ".new", entries.map(e => frameLine(JSON.stringify(e))).join("")); fs.renameSync(path + ".new", path);
  const prior = record.state; record = readerLedger(home); assert.notEqual(record.state, prior); verify();
  assert.ok(largest <= 64 * 1024, "backlog reads are bounded even for a large record");
  fs.appendFileSync(path, "00000000 {}\n");
  assert.equal(readerLedger(home).seen, entries.length, "a corrupt last line is not consumed");
  fs.appendFileSync(path, "extra\n");
  assert.throws(() => readerLedger(home), /Journal corruption/);
  fs.writeFileSync(path, entries.map(e => frameLine(JSON.stringify(e))).join(""));
  assert.equal(readerLedger(home).seen, entries.length, "failure discards a partially applied fold");
  fs.rmSync(path); assert.equal(readerLedger(home).seen, 0);
});

test("Pi read paths keep no ledger snapshot or decoded history after a pass", async t => {
  const home = await mkdtemp(join(tmpdir(), "reader-release-")); t.after(() => rm(home, { recursive: true, force: true }));
  const path = orchLedger(home), entries = randomLedger(120, 8);
  fs.writeFileSync(path, entries.map(e => frameLine(JSON.stringify(e))).join(""));
  readJournalSnapshot(path); assert.equal(hasJournalSnapshot(path), true);
  ownWorkflows(home, "main:s"); workflows(home, "main:s"); unfinishedWorkflow(home); runningOrchestrator(home); slotsView(home); new UiData(home).refresh("main:s");
  assert.equal(hasJournalSnapshot(path), false);
  const record = readerLedger(home);
  assert.equal("entries" in record, false);
  assert.equal(record.state.state.last, undefined);
  assert.equal(record.state.state.observed.size, 0, "execution-only switch history is not retained");
  assert.equal(record.state.state.skips.size, 0);
});

test("compact UI resolutions preserve ledger order and identity-conflict semantics", async t => {
  const home = await mkdtemp(join(tmpdir(), "reader-controls-")); t.after(() => rm(home, { recursive: true, force: true }));
  let n = 0; const notes: string[] = [];
  const actions = new UiActions({ home, submit: async () => ({ submitted: { rid: String(++n) } }), presentNote: note => notes.push(note) });
  await actions.send({}, "first"); await actions.send({}, "second");
  fs.writeFileSync(orchLedger(home), [
    { seq: 1, ts: 1, type: "rejected", rid: "2", reason: "identity-conflict" },
    { seq: 2, ts: 2, type: "rejected", rid: "1", reason: "refused" },
    { seq: 3, ts: 3, type: "applied", rid: "2" },
  ].map(e => frameLine(JSON.stringify(e))).join(""));
  assert.equal(actions.reconcile(), "first: refused");
  assert.deepEqual(actions.resolutions, [{ rid: "2", applied: false, reason: "identity-conflict" }, { rid: "1", applied: false, reason: "refused" }]);
  assert.equal(notes.length, 4); assert.equal(actions.reconcile(), undefined);
  assert.deepEqual(readerLedger(home).state.decisions.get("2"), { type: "applied" }, "main lifecycle ignores identity-conflict refusals");
  assert.equal(hasJournalSnapshot(orchLedger(home)), false);
});

test("UI refresh keeps time-sensitive live workflows polling even without calls", async t => {
  const home = await mkdtemp(join(tmpdir(), "reader-live-")); t.after(() => rm(home, { recursive: true, force: true }));
  fs.mkdirSync(join(home, "w", "wf"), { recursive: true });
  fs.writeFileSync(orchLedger(home), frameLine(JSON.stringify({ seq: 1, ts: 1, type: "created", wid: "wf", origin: "main:s" })));
  fs.writeFileSync(join(home, "w", "wf", "journal.jsonl"), frameLine(JSON.stringify({ seq: 1, ts: 1, type: "wf-created", revision: 1, origin: "main:s" })));
  const data = new UiData(home), revision = data.refresh("main:s");
  assert.notEqual(data.refresh("main:s"), revision, "live elapsed time is not frozen by the empty final-facts map");
});

test("A4 settings in effect are the last recorded ones, a rejection keeps them, and a release frees only its holder", () => {
  const e = (seq: number, fields: Record<string, unknown>) => ({ seq, ts: seq, ...fields }) as Entry;
  const given = { providers: { p: { slots: 9 } } };
  const state = foldLedger(emptyLedger(), []);
  assert.equal(settingsOf(state, given), given, "nothing recorded: the given settings");
  foldLedger(state, [e(1, { type: "config", hash: "a", config: { providers: { p: { slots: 1 } } } }), e(2, { type: "config-rejected", error: "bad" }),
    e(3, { type: "hold", pool: "p", slot: 0, exec: "x" }), e(4, { type: "release", pool: "p", slot: 0, exec: "y" })]);
  assert.deepEqual(settingsOf(state, given), { providers: { p: { slots: 1 } } });
  assert.equal(state.rejected?.error, "bad");
  assert.deepEqual(holdings(state).map(h => h.exec), ["x"], "a release by another execution frees nothing");
});
