import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "../../harness/pi.ts";
import { openJournal } from "../../../src/kernel/journal.ts";
import { journalPath, orchLedger } from "../../../src/paths.ts";
import { CT, JT } from "../../../src/types.ts";
import { attention, presentText, presented, resolved, workflows } from "../../../src/agent/main/snapshots.ts";
import { holdOf, workflowSnapshot } from "../../../src/orchestrator/snapshot.ts";
import type { Entry } from "../../../src/types.ts";
import { registerCards } from "../../../src/ui/cards.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const root = tempRoot("dsa-snapshots-");
test.after(() => rmSync(root, { recursive: true, force: true }));
const sender = "main:s1";
const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, rev: 1, kind: "finished", text: `${id} done`, wid: "w1", ...extra });
async function append(path: string, type: string, fields: Record<string, unknown>) { const j = await openJournal(path); await j.append(type, fields); await j.close(); }

test("cached attention and snapshots follow every journal append: new items, resolutions and presentations", async () => {
  const home = join(root, "attention");
  await append(orchLedger(home), JT.created, { wid: "w1", origin: sender });
  await append(journalPath(home, "w1"), JT.created, { origin: sender, cwd: root, revision: 1 });
  await append(journalPath(home, "w1"), JT.attention, { item: item("a") });
  assert.deepEqual(attention(home, sender, []).map(i => i.id), ["a"]);
  assert.equal(workflowSnapshot(home, "w1").attention.length, 1);
  await append(journalPath(home, "w1"), JT.attention, { item: item("b") });
  assert.deepEqual(attention(home, sender, []).map(i => i.id), ["a", "b"], "an appended item is seen at once");
  assert.equal(workflowSnapshot(home, "w1").attention.length, 2, "the workflow snapshot follows the append");
  assert.deepEqual(attention(home, sender, [{ id: "a", rev: 1 }]).map(i => i.id), ["b"], "a presented id/rev is not presented again");
  assert.deepEqual(attention(home, sender, [{ id: "a", rev: 2 }]).map(i => i.id), ["a", "b"], "another revision is a new presentation");
  await append(journalPath(home, "w1"), JT.attentionResolved, { id: "b", rev: 1 });
  assert.deepEqual(attention(home, sender, []).map(i => i.id), ["a"], "a resolution appended later hides the item");
  assert.equal(workflowSnapshot(home, "w1").attention.length, 1, "the workflow snapshot is rebuilt after an append");
  assert.deepEqual(attention(home, "main:other", []), []);
});

test("presented receipts are read incrementally while the session grows and fully after a session switch", () => {
  const entry = (ids: string[]) => ({ type: "custom_message", customType: CT.attention, details: { items: ids.map(id => ({ id, rev: 1 })) } });
  const manager = { entries: [entry(["a"]), { type: "message" }] as object[], getEntries() { return this.entries; } };
  const ctx = { sessionManager: manager } as never;
  assert.deepEqual(presented(ctx).map(i => i.id), ["a"]);
  manager.entries = [...manager.entries, entry(["b", "c"])];
  assert.deepEqual(presented(ctx).map(i => i.id), ["a", "b", "c"], "appended receipts count");
  manager.entries = [entry(["z"])];
  assert.deepEqual(presented(ctx).map(i => i.id), ["z"], "a replaced session (switch, fork) is read again from the start");
  manager.entries = [manager.entries[0]!, { type: "message" }];
  assert.deepEqual(presented(ctx).map(i => i.id), ["z"]);
});

test("attention cards reuse their lines per width and redraw once a question is answered", () => {
  const home = join(root, "cards"), session = join(home, "child.jsonl");
  mkdirSync(home, { recursive: true }); writeFileSync(session, "");
  const renderers = new Map<string, (m: unknown, o: unknown, t: unknown) => { render(w: number): string[]; invalidate(): void } | undefined>();
  registerCards({ registerMessageRenderer: (type: string, r: never) => renderers.set(type, r) } as never, home);
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const question = { id: "q", rev: 1, kind: "question", text: "Which schema?", wid: "w", call: "w@1/writer@1", qid: "x", session };
  const component = renderers.get(CT.attention)!({ details: { items: [question] } }, { expanded: false }, theme)!;
  const first = component.render(60);
  assert.equal(component.render(60), first, "an unchanged card is not redrawn");
  assert.notEqual(component.render(40), first); assert.equal(visibleWidth(component.render(40)[0]!), 40);
  const original = Date.now;
  try {
    writeFileSync(session, JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "ask", isError: false, details: { qid: "x", rev: 1 } } }) + "\n");
    Date.now = () => original() + 5_000;
    assert.match(component.render(60).join("\n"), /— answered/, "the answer is seen on a later frame");
  } finally { Date.now = original; }
  const note = renderers.get(CT.note)!({ content: "stop" }, { expanded: false }, theme)!;
  assert.equal(note.render(60), note.render(60)); note.invalidate(); assert.match(note.render(60).join("\n"), /stop/);
});

test("the main agent reads each attention item with its address; a question says how to answer it", () => {
  assert.equal(presentText({ id: "q", rev: 1, kind: "question", text: "Which base?", wid: "01W", call: "01W@2/review@3", qid: "Q1" }),
    'Question from 01W/review (qid Q1); reply with send kind:"answer" to:"01W/review": Which base?');
  assert.equal(presentText({ id: "s", rev: 1, kind: "stall", text: "No execution activity", wid: "01W", call: "01W@1/a@1" }), "01W/a: No execution activity");
  assert.equal(presentText({ id: "f", rev: 1, kind: "finished", text: "Workflow 01W finished: done", wid: "01W" }), "Workflow 01W finished: done");
  assert.equal(presentText({ id: "b", rev: 1, kind: "budget", text: "Workflow budget reached", wid: "01W" }), "01W: Workflow budget reached");
});

test("an answered question is found by reading only what the child session appended", async () => {
  const { appendFileSync, renameSync } = await import("node:fs");
  const home = join(root, "answers"), session = join(home, "child.jsonl");
  mkdirSync(home, { recursive: true }); writeFileSync(session, JSON.stringify({ type: "session" }) + "\n");
  const q = { id: "q", rev: 1, kind: "question", text: "?", wid: "w9", call: "w9@1/a@1", qid: "x", session };
  const answer = (qid: string, rev = 1) => JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "ask", isError: false, details: { qid, rev } } });
  assert.equal(resolved(home, q), false);
  appendFileSync(session, answer("other") + "\n" + "{not json, \"ask\"\n");
  assert.equal(resolved(home, q), false, "another question's answer and a malformed line do not resolve it");
  const line = answer("x");
  appendFileSync(session, line.slice(0, 20));
  assert.equal(resolved(home, q), false, "a half-written line is not parsed yet");
  appendFileSync(session, line.slice(20) + "\n");
  assert.equal(resolved(home, q), true, "the line completed by a later append is");
  assert.equal(resolved(home, { ...q, rev: 2 }), false, "a later revision of the question is still open");
  writeFileSync(session + ".new", JSON.stringify({ type: "session" }) + "\n"); renameSync(session + ".new", session);
  assert.equal(resolved(home, q), false, "a replaced session file is read again from its start");
  rmSync(session);
  assert.equal(resolved(home, q), false, "a missing session resolves nothing");
  await append(journalPath(home, "w9"), JT.attentionResolved, { id: "q", rev: 1 });
  assert.equal(resolved(home, q), true, "a recorded resolution resolves it without the session");
});

test("hold lookups through the ledger index agree with a scan of the whole ledger", () => {
  // The reference is the scan the index replaced: the newest drain/undrain that applies, unless the workflow was created after it.
  const reference = (ledger: Entry[], wid: string, origin?: string) => {
    const applies = (e: Entry) => (e.wid === undefined && e.origin === undefined) || e.wid === wid || (origin !== undefined && e.origin === origin);
    const last = ledger.findLast(e => (e.type === "drain" || e.type === "undrain") && applies(e));
    if (last?.type !== "drain") return undefined;
    const created = ledger.find(e => e.type === JT.created && e.wid === wid);
    return !created || created.seq < last.seq ? last : undefined;
  };
  let seed = 7;
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  const wids = ["w1", "w2", "w3"], origins = ["o1", "o2"];
  for (let run = 0; run < 200; run++) {
    const ledger: Entry[] = [];
    for (let seq = 1; seq <= 1 + rand(30); seq++) {
      const kind = rand(4), scope = rand(3);
      const type = kind === 0 ? JT.created : kind === 1 ? "undrain" : "drain";
      const fields = type === JT.created ? { wid: wids[rand(3)], origin: origins[rand(2)] }
        : scope === 0 ? {} : scope === 1 ? { wid: wids[rand(3)] } : { origin: origins[rand(2)] };
      ledger.push({ seq, ts: seq, type, ...fields } as Entry);
      // Every prefix is checked, as a growing ledger is read.
      const view = ledger.slice();
      for (const wid of wids) for (const origin of [undefined, ...origins])
        assert.equal(holdOf(view, wid, origin), reference(view, wid, origin), `run ${run} seq ${seq} ${wid} ${origin}`);
    }
  }
});

test("attention for one session does not read the journals of workflows the ledger gives to another", async () => {
  const home = join(root, "origins");
  await append(orchLedger(home), JT.created, { wid: "mine", origin: sender });
  await append(orchLedger(home), JT.created, { wid: "theirs", origin: "main:other" });
  await append(journalPath(home, "mine"), JT.attention, { item: item("m", { wid: "mine" }) });
  await append(journalPath(home, "theirs"), JT.attention, { item: item("t", { wid: "theirs" }) });
  mkdirSync(join(home, "w", "orphan"), { recursive: true });
  await append(journalPath(home, "orphan"), JT.created, { origin: sender, cwd: root, revision: 1 });
  await append(journalPath(home, "orphan"), JT.attention, { item: item("o", { wid: "orphan" }) });
  assert.deepEqual(workflows(home, sender).map(w => w.wid), ["mine", "orphan"], "a journal-only workflow is attributed by its own created entry");
  assert.deepEqual(attention(home, sender, []).map(i => i.id), ["m", "o"]);
  assert.deepEqual(workflows(home).map(w => w.wid), ["mine", "orphan", "theirs"]);
});
