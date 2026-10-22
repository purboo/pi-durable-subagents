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
/** The origin as pi would see it without dsa receipts (they stay excluded, FC1): receipts removed and their children relinked. */
function withoutReceipts(rows: Row[]): Row[] {
  const dropped = new Map(rows.filter(e => String(e.customType ?? e.message?.customType ?? "").startsWith("dsa-")).map(e => [e.id!, e.parentId ?? null]));
  const lift = (id: string | null | undefined): string | null => id && dropped.has(id) ? lift(dropped.get(id)) : id ?? null;
  return rows.filter(e => !dropped.has(e.id!)).map(e => e.type === "session" ? e : { ...e, parentId: lift(e.parentId) });
}
async function write(path: string, rows: Row[]) { await writeFile(path, rows.map(e => JSON.stringify(e)).join("\n") + "\n"); }
const parse = (text: string) => text.trim().split("\n").map(line => JSON.parse(line) as Row);

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

test("FC1 the fork child's context equals pi's buildSessionContext of the origin (receipts excluded)", { skip: noPi }, async ctx => {
  const f = await fixture(ctx), file = join(f.root, "origin.jsonl"), rows = compacted();
  for (const [name, origin] of [["nested compactions", rows], ["kept marker off the branch", rows.map(e => e.id === "c" ? { ...e, firstKeptEntryId: "elsewhere" } : e)],
    ["no kept entries", rows.map(e => e.id === "c" ? { ...e, firstKeptEntryId: "c" } : e)]] as const) {
    await write(file, origin);
    const pinnedPath = join(f.root, `pinned-${name.replaceAll(" ", "-")}.jsonl`), session = join(f.root, `child-${name.replaceAll(" ", "-")}.jsonl`);
    await writeFile(pinnedPath, await pinOrigin({ sessionFile: file }));
    const t = { ...f.t, callId: `${f.t.callId}-${name.length}`, spec: { ...f.t.spec, context: "fork" as const }, originSession: pinnedPath };
    await f.effects().prepare(t, { sessionPath: session });
    const child = pi!.SessionManager.open(session, join(f.root, "sessions"), f.cwd).buildSessionContext();
    const reference = withoutReceipts(origin).filter(e => e.type !== "session") as Parameters<NonNullable<typeof pi>["buildSessionContext"]>[0];
    const expected = pi!.buildSessionContext(reference, reference.at(-1)!.id);
    assert.deepEqual(child.messages, expected.messages, name);
    assert.deepEqual(child.model, expected.model, name);
    assert.ok(JSON.stringify(child.messages).includes("LATEST-SUMMARY"), name);
    assert.ok(!JSON.stringify(child.messages).includes("EARLY-RAW"), name);
  }
  // The uncompacted fork session itself is unchanged from 1.2 (only message/model_change entries in the pin).
  const plain = [header, user("a", null, "q"), { type: "model_change", id: "m", parentId: "a", timestamp: ts, provider: "probe", modelId: "scripted" }, user("b", "m", "f")];
  await write(file, plain);
  assert.equal(await pinOrigin({ sessionFile: file }), pin12(plain));
});
