// FC1: a fork pins the origin's effective (compaction-aware) context; uncompacted branches keep the 1.2 bytes.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pinOrigin } from "../../../src/orchestrator/origin.ts";
import { fixture } from "./effects/helpers.ts";

type Row = Record<string, any> & { type: string; id?: string; parentId?: string | null };
const pi = await import("@earendil-works/pi-coding-agent").catch(() => undefined);
const noPi = pi ? false : "the pi package is not resolvable here: parity with pi's exported buildSessionContext cannot be checked";
const ts = "2026-10-22T08:00:00.000Z";
const user = (id: string, parentId: string | null, text: string): Row => ({ type: "message", id, parentId, timestamp: ts, message: { role: "user", content: text, timestamp: 1 } });
/** Link rows into one chain: each entry's parent is the previous one. */
function chain(rows: Row[]): Row[] {
  let parent: string | null = null;
  return rows.map(r => { const row: Row = { ...r, parentId: parent }; parent = row.id!; return row; });
}
const header: Row = { type: "session", version: 3, id: "00000000-0000-4000-8000-0000000000aa", timestamp: ts, cwd: "/origin" };
/** A compacted origin: an older compaction inside the kept range, a system message, receipts, a later branch summary and edit. */
const compacted = (): Row[] => [header, ...chain([
  user("a", null, "EARLY-RAW"),
  { type: "message", id: "b", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "EARLY-ANSWER" }], provider: "probe", model: "scripted", timestamp: 2 } },
  { type: "compaction", id: "c0", timestamp: ts, summary: "OLD-SUMMARY", firstKeptEntryId: "a", tokensBefore: 10 },
  { type: "message", id: "s", timestamp: ts, message: { role: "system", content: "SYSTEM-IN-KEPT", timestamp: 3 } },
  user("k", null, "KEPT-MSG"),
  { type: "custom", id: "r", timestamp: ts, customType: "dsa-exec", data: { exec: "x" } },
  { type: "custom_message", id: "cm", timestamp: ts, customType: "ext-note", content: "EXT-NOTE", display: true },
  { type: "custom_message", id: "dm", timestamp: ts, customType: "dsa-attention", content: "DSA-ATTENTION", display: true },
  { type: "thinking_level_change", id: "th", timestamp: ts, thinkingLevel: "high" },
  { type: "compaction", id: "c", timestamp: ts, summary: "LATEST-SUMMARY", firstKeptEntryId: "c0", tokensBefore: 1000 },
  user("l", null, "LATER-MSG"),
  { type: "branch_summary", id: "bs", timestamp: ts, fromId: "x", summary: "BRANCH-SUMMARY" },
  { type: "context_edit", id: "ce", timestamp: ts, targetId: "k", replacement: { content: "KEPT-EDITED" } },
  { type: "model_change", id: "m", timestamp: ts, provider: "probe", modelId: "scripted2" },
])];
/** The 1.2 pin rule, verbatim (src/orchestrator/store.ts at 2a01184). */
function pin12(rows: Row[], leafId?: string): string {
  const head = rows.find(e => e.type === "session")!;
  const byId = new Map(rows.filter(e => e.type !== "session" && e.id).map(e => [e.id!, e]));
  let id = leafId === undefined ? rows.findLast(e => e.type !== "session" && e.id)?.id : leafId;
  const branch: Row[] = [];
  while (id) { const entry = byId.get(id)!; branch.unshift(entry); id = entry.parentId ?? undefined; }
  return [head, ...branch.filter(e => ["message", "model_change"].includes(e.type) && !e.message?.customType?.startsWith("dsa-"))].map(e => JSON.stringify(e)).join("\n") + "\n";
}
async function write(path: string, rows: Row[]) { await writeFile(path, rows.map(e => JSON.stringify(e)).join("\n") + "\n"); }
const parse = (text: string) => text.trim().split("\n").map(line => JSON.parse(line) as Row);
const isReceipt = (e: any) => String(e?.customType ?? e?.message?.customType ?? "").startsWith("dsa-");
const text = (m: any): string => typeof m.content === "string" ? m.content : (m.content ?? []).map((b: any) => b?.text ?? "").join("");

/** What pi sends for the origin itself: its projection without dsa's receipts (FC1 keeps them out of the fork). */
function parentMessages(rows: Row[]): any[] {
  const entries = rows.filter(e => e.type !== "session") as any[];
  const projection = pi!.buildSessionProjection(entries, entries.at(-1)!.id);
  return projection.entries.filter(e => !isReceipt(e.sourceEntry)).flatMap(e => e.messages);
}
/** Pin an origin and publish the fork session the executor would publish. */
async function fork(f: { root: string; t: any; effects: () => any }, rows: Row[], name: string) {
  const file = join(f.root, `${name}-origin.jsonl`), pinnedPath = join(f.root, `${name}-pinned.jsonl`), session = join(f.root, `${name}-child.jsonl`);
  await write(file, rows);
  const bytes = await pinOrigin({ sessionFile: file });
  await writeFile(pinnedPath, bytes);
  const t = { ...f.t, callId: `${f.t.callId}#${name}`, spec: { ...f.t.spec, context: "fork" as const }, originSession: pinnedPath };
  await f.effects().prepare(t, { sessionPath: session });
  return { file, pinnedPath, session, bytes, pinned: parse(bytes) };
}
/** The messages the fork child sends, as pi's builder computes them from the published session. */
function childMessages(session: string, root: string, cwd: string): any[] {
  return pi!.SessionManager.open(session, join(root, "sessions"), cwd).buildSessionContext().messages;
}

test("FC1 compacted origin pins kept + latest compaction + later entries, not earlier raw messages or receipts", async ctx => {
  const f = await fixture(ctx), file = join(f.root, "origin.jsonl");
  await write(file, compacted());
  const pinned = parse(await pinOrigin({ sessionFile: file }));
  assert.deepEqual(pinned.map(e => e.id), [header.id, "k", "cm", "c", "l", "bs", "ce", "m"]);
  const text = JSON.stringify(pinned);
  for (const absent of ["EARLY-RAW", "EARLY-ANSWER", "OLD-SUMMARY", "SYSTEM-IN-KEPT", "DSA-ATTENTION", "dsa-exec"]) assert.ok(!text.includes(absent), absent);
  const compaction = pinned.find(e => e.id === "c")!;
  assert.equal(compaction.summary, "LATEST-SUMMARY"); assert.equal(compaction.firstKeptEntryId, "k");
  assert.deepEqual(pinned.find(e => e.id === "k"), compacted().find(e => e.id === "k"), "kept entries are copied unchanged");
});

test("FC1 a leaf before any compaction pins the 1.2 bytes; firstKeptEntryId off the branch keeps nothing before the compaction", async ctx => {
  const f = await fixture(ctx), file = join(f.root, "origin.jsonl"), rows = compacted();
  await write(file, rows);
  assert.equal(await pinOrigin({ sessionFile: file, leafId: "b" }), pin12(rows, "b"));
  const off = rows.map(e => e.id === "c" ? { ...e, firstKeptEntryId: "elsewhere" } : e);
  await write(file, off);
  const pinned = parse(await pinOrigin({ sessionFile: file }));
  assert.deepEqual(pinned.map(e => e.id), [header.id, "c", "l", "bs", "m"], "an edit of an entry that is not pinned is dropped");
  assert.equal(pinned[1]!.firstKeptEntryId, "c");
});

test("FC1 uncompacted origins pin exactly the 1.2 bytes (branch summaries and custom messages still dropped)", async ctx => {
  const f = await fixture(ctx), file = join(f.root, "origin.jsonl");
  const rows: Row[] = [header, user("a", null, "question"),
    { type: "custom", id: "receipt", parentId: "a", timestamp: ts, customType: "dsa-exec", data: {} },
    { type: "model_change", id: "model", parentId: "receipt", timestamp: ts, provider: "probe", modelId: "scripted" },
    { type: "custom_message", id: "note", parentId: "model", timestamp: ts, customType: "ext-note", content: "n", display: true },
    { type: "branch_summary", id: "bs", parentId: "note", timestamp: ts, fromId: "z", summary: "s" },
    { type: "message", id: "dsa", parentId: "bs", timestamp: ts, message: { role: "custom", customType: "dsa-msg", content: "x" } },
    user("b", "dsa", "follow-up"), user("other", "a", "other branch")];
  await write(file, rows);
  for (const leafId of [undefined, "b", "other", "model"]) assert.equal(await pinOrigin({ sessionFile: file, leafId }), pin12(rows, leafId), `leaf ${leafId}`);
  assert.deepEqual(parse(await pinOrigin({ sessionFile: file, leafId: "b" })).map(e => e.id), [header.id, "a", "model", "b"]);
});

test("FC1 the fork child's context equals pi's projection of the origin (receipts excluded)", { skip: noPi }, async ctx => {
  const f = await fixture(ctx), rows = compacted();
  for (const [name, origin] of [["nested compactions", rows], ["kept marker off the branch", rows.map(e => e.id === "c" ? { ...e, firstKeptEntryId: "elsewhere" } : e)],
    ["no kept entries", rows.map(e => e.id === "c" ? { ...e, firstKeptEntryId: "c" } : e)]] as const) {
    const forked = await fork(f, origin, name.replaceAll(" ", "-"));
    const child = childMessages(forked.session, f.root, f.cwd);
    assert.deepEqual(child, parentMessages(origin), name);
    assert.ok(child.map(text).join(" ").includes("LATEST-SUMMARY"), name);
    assert.ok(!child.map(text).join(" ").includes("EARLY-RAW"), name);
  }
  // The uncompacted fork session itself is unchanged from 1.2 (only message/model_change entries in the pin).
  const plain = [header, user("a", null, "q"), { type: "model_change", id: "m", parentId: "a", timestamp: ts, provider: "probe", modelId: "scripted" }, user("b", "m", "f")];
  const forked = await fork(f, plain, "plain");
  assert.equal(forked.bytes, pin12(plain));
});

test("FC1 a kept marker that names a receipt keeps the range that follows it", { skip: noPi }, async ctx => {
  const f = await fixture(ctx);
  // The marker names a dsa receipt; the first kept entry is an edit of an entry that is not pinned and is dropped.
  const rows: Row[] = [header, ...chain([
    user("e0", null, "EARLY"),
    { type: "custom_message", id: "e1", timestamp: ts, customType: "dsa-exec", content: "RECEIPT", display: true },
    { type: "context_edit", id: "e2", timestamp: ts, targetId: "e0", replacement: { content: "EDITED" } },
    user("e3", null, "U3"),
    { type: "compaction", id: "e4", timestamp: ts, summary: "SUM4", firstKeptEntryId: "e1", tokensBefore: 400 },
  ])];
  const forked = await fork(f, rows, "receipt-at-the-cut");
  assert.deepEqual(forked.pinned.map(e => e.id), [header.id, "e3", "e4"]);
  assert.equal(forked.pinned.find(e => e.id === "e4")!.firstKeptEntryId, "e3", "the marker names an entry the child carries");
  const child = childMessages(forked.session, f.root, f.cwd);
  const texts = child.map(text);
  assert.equal(texts.length, 2, "the summary and the kept message");
  assert.ok(texts[0]!.includes("SUM4"), texts[0]);
  assert.ok(texts[1]!.includes("U3"), texts[1]);
  assert.deepEqual(child, parentMessages(rows));
});

test("FC1 a kept marker that names an older compaction keeps the range that follows it", { skip: noPi }, async ctx => {
  const f = await fixture(ctx);
  // The marker names an older compaction; the first kept entry is an edit of an entry that is not pinned and is dropped.
  const rows: Row[] = [header, ...chain([
    user("e0", null, "EARLY"),
    { type: "compaction", id: "c0", timestamp: ts, summary: "SUM0", firstKeptEntryId: "e0", tokensBefore: 100 },
    { type: "context_edit", id: "e1", timestamp: ts, targetId: "e0", replacement: { content: "EDITED" } },
    user("e2", null, "U2"),
    { type: "compaction", id: "e3", timestamp: ts, summary: "SUM3", firstKeptEntryId: "c0", tokensBefore: 300 },
  ])];
  const forked = await fork(f, rows, "older-compaction-at-the-cut");
  assert.deepEqual(forked.pinned.map(e => e.id), [header.id, "e2", "e3"]);
  assert.equal(forked.pinned.find(e => e.id === "e3")!.firstKeptEntryId, "e2", "the marker names an entry the child carries");
  const child = childMessages(forked.session, f.root, f.cwd);
  const texts = child.map(text);
  assert.equal(texts.length, 2, "the summary and the kept message");
  assert.ok(texts[0]!.includes("SUM3"), texts[0]);
  assert.ok(texts[1]!.includes("U2"), texts[1]);
  assert.deepEqual(child, parentMessages(rows));
});
