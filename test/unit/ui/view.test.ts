import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root, clean, now, call, workflow, state, session } from "./fixture.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { WorkflowSnapshot } from "../../../src/orchestrator/snapshot.ts";
import type { CallStatus } from "../../../src/types.ts";
const { listRows, toggleOpen, dockLines, duration, mainLine, modelLabel, statusPhrase, orderWorkflows, keepSelection, rowText, toolCount, summaryText, summary, resultPhrase, resultWord } = await import("../../../src/ui/view.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { SessionTail, thoughtSummary, sessionFacts, sessionBranch } = await import("../../../src/ui/session.ts");
after(clean);

test("durations and model names stay compact and truthful", () => {
  assert.equal(duration(-1), "0s"); assert.equal(duration(59_999), "59s"); assert.equal(duration(3720_000), "1h02m");
  assert.equal(modelLabel("bedrock-claude/claude-opus:high", () => ({ name: "Opus 5.5" })), "Opus 5.5 (bedrock)");
  assert.equal(modelLabel("openai/gpt-6", () => undefined, { "openai/gpt-6": "GPT" }), "GPT (openai)");
  assert.equal(modelLabel(undefined, () => undefined), "—");
});

test("grouping, proposal order, done paging, and narrow columns", () => {
  const calls = [call("E02"), call("E05", { lastActivity: now - 5_000 }), ...Array.from({ length: 10 }, (_, i) => call(`D${i}`, { phase: "sealed", endedAt: now - i * 1000, result: { key: `D${i}`, gen: 1, ok: true, status: "ok", output: "", data: { summary: `merged ${i}` } } }))];
  const w = workflow(calls), s = state();
  const solo = workflow([call("scout")], { wid: "solo" });
  let rows = listRows([w, solo], s, new Map(), () => "GPT-6 (openai)", 100, now);
  assert.equal(rows[0]!.kind, "workflow"); assert.match(rows[0]!.text, /10\/12\+ · 1h02m/, "no planned total: proposed so far reads as n+ (v12 §4)");
  assert.equal(rows[1]!.call!.key, "E02"); assert.equal(rows[2]!.call!.key, "E05"); assert.equal(rows[3]!.text.trim(), "└ ▸ 10 done");
  assert.match(rows[1]!.text, /^ {2}├ E02/, "agents are tree children of their workflow");
  assert(!rows.some(r => r.kind === "more"));
  s.done.set("w", 8); rows = listRows([w], s, new Map(), () => "GPT-6 (openai)", 100, now);
  assert.equal(rows.filter(r => r.call?.phase === "sealed").length, 8); assert.equal(rows.at(-1)!.text.trim(), "└ … 2 more");
  assert.match(rows.find(r => r.call?.key === "D0")!.text, /^ {6}├ D0/, "done rows are nested under their done node");
  assert.match(rows.find(r => r.call?.key === "D0")!.text, /merged 0/);
  assert(listRows([w], s, new Map(), () => "GPT-6 (openai)", 50, now).some(r => r.text.includes("GPT-6") && !r.text.includes("(openai)")), "narrow: model kept, provider dropped");
  s.folded.add("w"); assert.equal(listRows([w], s, new Map(), () => "", 100, now).length, 1);
});

test("unviewed failures remain visible; finished workflows stay listed with their done rows", () => {
  const bad = call("bad", { phase: "sealed", endedAt: now, result: { key: "bad", gen: 1, status: "failed", ok: false, output: "", error: "merge conflict" } });
  const good = call("good", { phase: "sealed", endedAt: now - 1_000 });
  const w = workflow([good, bad], { status: "failed" }), s = state();
  const rows = listRows([w], s, new Map(), () => "—", 100, now);
  assert.equal(rows.find(r => r.kind === "call")!.call!.key, "bad"); assert(rows.some(r => r.failed));
  s.viewed.add(bad.callId);
  const listed = listRows([w], s, new Map(), () => "—", 100, now);
  assert.ok(listed.some(r => r.kind === "workflow" && r.dim), "v12 §5: the finished workflow stays listed, dimmed");
  assert(listed.some(r => r.call === good), "its done rows stay readable after the failure is viewed");
  s.done.set("w", 0);
  assert.deepEqual(listRows([w], s, new Map(), () => "—", 100, now).map(r => r.kind), ["workflow"], "a closed finished workflow keeps its row");
});

test("done rows reopen on new failure and completion transitions, then respect fresh user collapse", () => {
  const a = call("A"), b = call("B"), done = call("done", { phase: "sealed" });
  const w = workflow([a, b, done]), s = state();
  const render = () => listRows([w], s, new Map(), () => "—", 100, now);
  render(); s.done.set("w", 8); render(); s.done.set("w", 0); render();
  a.phase = "sealed"; a.result = { key: "A", gen: 1, status: "failed", ok: false, output: "" };
  s.folded.add("w");
  assert(render().some(r => r.call === a)); assert(!s.folded.has("w"));
  s.viewed.add(a.callId); s.done.set("w", 0);
  assert(!render().some(r => r.call === a));
  b.phase = "sealed"; b.result = { key: "B", gen: 1, status: "failed", ok: false, output: "" }; w.status = "failed";
  assert(render().some(r => r.call === b));
  s.done.set("w", 0); assert(!render().some(r => r.call));
});

test("successful last call also reopens collapsed done rows without a new failure", () => {
  const last = call("last"), w = workflow([last, call("done", { phase: "sealed" })]), s = state();
  const render = () => listRows([w], s, new Map(), () => "—", 100, now);
  render(); s.done.set("w", 8); render(); s.done.set("w", 0); render();
  last.phase = "sealed";
  assert.equal(render().filter(r => r.kind === "call").length, 2);
  s.done.set("w", 0); assert.equal(render().filter(r => r.kind === "call").length, 0);
});

test("no-progress status retains the progress duration despite retry activity", () => {
  const c = call("E07", { lastActivity: now }), w = workflow([c]);
  w.attention = [{ id: `noprogress:${c.callId}`, rev: 1, kind: "stall", call: c.callId, wid: "w",
    text: "w/E07: running but no progress for 10m (no output tokens or tool results); last provider error: 529 overloaded" }];
  assert.equal(statusPhrase(c, w, undefined, now), "no progress for 10m");
});

test("ordinary status phrases, main line, questions and stalls", () => {
  const c = call("E07"), w = workflow([c]);
  assert.equal(mainLine([]), undefined); assert.equal(mainLine([w]), "1 working · 0/1+ done · ↓ subagents");
  w.attention = [{ id: "q", rev: 1, kind: "question", call: c.callId, text: "docs/ in write set?", wid: "w" }];
  assert.equal(statusPhrase(c, w, undefined, now), "asking main agent: docs/ in write set?");
  w.attention = [{ id: "s", rev: 1, kind: "stall", call: c.callId, text: "", wid: "w" }]; c.lastActivity = now - 840_000;
  assert.equal(statusPhrase(c, w, undefined, now), "no activity for 14m00s");
  w.attention = []; c.lastActivity = now - 8_000; assert.equal(statusPhrase(c, w, undefined, now), "thinking · 8s", "the age of the newest evidence ticks");
  c.lastActivity = now - 1_000; assert.equal(statusPhrase(c, w, undefined, now), "thinking · 1s", "and resets on new activity");
  assert.equal(statusPhrase(c, w, { ...sessionFacts([], c.callId), activity: "reading src/a.ts" }, now), "reading src/a.ts · 1s");
  c.phase = "queued"; assert.match(statusPhrase(c, w, undefined, now), /^queued:/);
  c.phase = "sealed"; c.result = { key: c.key, gen: 1, status: "failed", ok: false, output: "", error: "blocked" };
  w.status = "failed"; w.endedAt = now;
  assert.match(mainLine([w])!, /exec-0927 finished: 1 failed · ↓ subagents/);
});

test("thinking summaries never display partial prose or expose empty expansion", () => {
  assert.equal(thoughtSummary("First complete. Still typing"), "First complete.");
  assert.equal(thoughtSummary("**First**\n**Last heading**\npartial"), "Last heading");
  assert.equal(thoughtSummary("partial"), ""); assert.equal(thoughtSummary(""), "");
});

test("thought summaries match the sentence rule exactly and stay linear on long unpunctuated thoughts", () => {
  const rule = (t: string) => t.match(/[^.!?。！？]+[.!?。！？](?=\s|$)/gu)?.at(-1)?.trim() ?? "";
  const parts = ["a", "b c", " ", "\n", ".", "!", "?", "。", "！", "？", "\u00a0", "\u3000", "😀", "\t", "x.y", "...", ". "];
  let seed = 7; const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 20000; i++) {
    const text = Array.from({ length: Math.floor(next() * 12) }, () => parts[Math.floor(next() * parts.length)]).join("");
    assert.equal(thoughtSummary(text), rule(text), JSON.stringify(text));
  }
  const started = performance.now(); thoughtSummary("word ".repeat(12_000) + "end");
  assert.ok(performance.now() - started < 1000, "a 60 KB thought is summarised without quadratic backtracking (the regex took seconds)");
});

test("session tails tolerate split UTF-8, partial and corrupt lines, replacement and truncation", () => {
  const path = join(root, "tail.jsonl"), tail = new SessionTail();
  assert.deepEqual(tail.read(path), []);
  const bytes = Buffer.from(JSON.stringify({ type: "custom", id: "a", data: "你好" }) + "\n");
  const split = bytes.indexOf(Buffer.from("你")) + 1;
  writeFileSync(path, bytes.subarray(0, split)); assert.deepEqual(tail.read(path), []);
  appendFileSync(path, bytes.subarray(split)); assert.equal((tail.read(path)[0] as { data?: unknown }).data, "你好");
  assert.equal(tail.read(path).length, 1);
  writeFileSync(path, ""); assert.equal(tail.read(path).length, 0);
  writeFileSync(path + ".new", '{"type":"custom","id":"b"}\n'); renameSync(path + ".new", path);
  assert.equal(tail.read(path)[0]!.id, "b");
  // E4: a corrupt interior line is skipped (as pi and the orchestrator do) and the tail keeps following.
  appendFileSync(path, 'bad\n{"type":"custom","id":"c"}\n'); assert.deepEqual(tail.read(path).map(e => e.id), ["b", "c"]);
  appendFileSync(path, '{"type":"custom","id":"d"}\n'); assert.deepEqual(tail.read(path).map(e => e.id), ["b", "c", "d"]);
});

test("session facts follow the native branch and completed tools disappear", () => {
  const entries = session();
  const facts = sessionFacts(entries, "w@1/E02@1"); assert.equal(facts.model, "openai/gpt-6"); assert.equal(facts.thinking, "high"); assert.match(facts.task, /scheduler/); assert.equal(facts.activity, undefined);
  assert.equal(sessionFacts(entries.slice(0, -1), "w@1/E02@1").activity, "running npm test -- sched");
  const fork = { ...entries.at(-1)!, id: "fork", parentId: "0" };
  assert.deepEqual(sessionBranch([...entries, fork]).map(e => e.id), ["0", "fork"]);
});

test("model labels never repeat a provider the display name already contains", () => {
  const named = (name: string) => () => ({ name });
  assert.equal(modelLabel("zhipu/glm-5.3", named("GLM-5.3 (zhipu)")), "GLM-5.3 (zhipu)");
  assert.equal(modelLabel("zhipu/glm-5.3-flash:high", named("GLM-5.3 Flash (ZhiPu)")), "GLM-5.3 Flash (ZhiPu)");
  assert.equal(modelLabel("bedrock-claude/claude-opus", named("Opus 5.5 (bedrock)")), "Opus 5.5 (bedrock)");
  assert.equal(modelLabel("zhipu/glm-5.3", () => undefined, { "zhipu/glm-5.3": "GLM (Zhipu)" }), "GLM (Zhipu)");
  assert.equal(modelLabel("zhipu/glm-5.3", named("GLM-5.3")), "GLM-5.3 (zhipu)");
  assert.equal(modelLabel("zhipu/glm-5.3", named("GLM zhipuplus")), "GLM zhipuplus (zhipu)"); // a word, not a substring
  assert.equal(modelLabel("openai/gpt-6", named("GPT-6")), "GPT-6 (openai)");
});

test("row order is stable across refreshes while activity changes", () => {
  const calls = [call("E02"), call("E05"), call("E07"), call("D1", { phase: "sealed", endedAt: now - 9_000 })];
  const w = workflow(calls), facts = new Map(calls.map(c => [c.callId, { ...sessionFacts([], c.callId) }])), s = state();
  const ids = () => listRows([w], s, facts, () => "GPT-6 (openai)", 100, now).map(r => r.id);
  const first = ids();
  for (const [i, c] of calls.entries()) {
    c.lastActivity = now - (i % 2 ? 1_000 : 60_000) * (i + 1); facts.get(c.callId)!.lastActivity = now - i * 7_000;
    assert.deepEqual(ids(), first);
  }
  calls[1]!.startedAt = undefined; calls[1]!.phase = "queued"; assert.deepEqual(ids(), first); // dispatch timing does not reorder
  const a = { wid: "a", origin: "main:other", startedAt: 3, status: "running" as const }, b = { wid: "b", origin: "main:me", startedAt: 5, status: "done" as const };
  const c = { wid: "c", origin: "main:other", startedAt: 1, status: "done" as const }, d = { wid: "d", origin: "main:me", startedAt: 2, status: "running" as const };
  assert.deepEqual(orderWorkflows([a, b, c, d], "main:me").map(x => x.wid), ["b", "d"], "only this session's workflows, newest first; finishing never reorders");
  assert.deepEqual(orderWorkflows(orderWorkflows([a, b, c, d], "main:me"), "main:me").map(x => x.wid), ["b", "d"]);
});

test("done rows are newest first and never reshuffle when failures are viewed or results arrive", () => {
  const fail = (key: string, endedAt: number) => call(key, { phase: "sealed", endedAt, result: { key, gen: 1, status: "failed", ok: false, output: "", error: "x" } });
  const calls = [call("A"), call("D1", { phase: "sealed", endedAt: now - 30_000 }), fail("F1", now - 40_000), call("D2", { phase: "sealed", endedAt: now - 10_000 })];
  const w = workflow(calls), s = state(); s.done.set("w", 8);
  const done = () => listRows([w], s, new Map(), () => "—", 100, now).filter(r => r.call?.phase === "sealed").map(r => r.call!.key);
  assert.deepEqual(done(), ["D2", "D1", "F1"]);
  s.viewed.add(calls[2]!.callId); assert.deepEqual(done(), ["D2", "D1", "F1"]);
  calls.push(call("D3", { phase: "sealed", endedAt: now - 1_000 })); assert.deepEqual(done(), ["D3", "D2", "D1", "F1"]);
});

test("selection follows the same row id across insertions and falls back by position", () => {
  const rows = [{ id: "h" }, { id: "E02" }, { id: "E07" }];
  assert.equal(keepSelection(rows, "E07", 2), 2);
  assert.equal(keepSelection([{ id: "new" }, { id: "h2" }, ...rows], "E07", 2), 4);
  assert.equal(keepSelection([{ id: "h" }, { id: "E02" }], "E07", 2), 1);
  assert.equal(keepSelection([], "E07", 2), 0);
});

test("tool counts come only from this call's own committed execution segments", () => {
  const call = "w@1/E02@2", tool = (id: string) => ({ type: "toolCall", id, name: "read", arguments: { path: "a" } });
  const assistant = (...ids: string[]) => ({ type: "message", timestamp: new Date(now).toISOString(), message: { role: "assistant", provider: "openai", model: "gpt-6", content: ids.map(tool), timestamp: now } });
  const exec = (id: string) => ({ type: "custom", customType: "dsa-exec", data: { exec: id } });
  const entries = [
    assistant("inherited"), // fork / continuation context before any segment
    exec("w@1/E02@1#1.1"), assistant("g1a", "g1b"), // previous generation's segment
    exec(`${call}#1.1`), assistant("a", "b"), { type: "message", timestamp: "", message: { role: "toolResult", toolCallId: "a", content: [] } },
    exec("w@1/E020@2#1.1"), assistant("prefix-trap"), // a different key that merely shares a prefix
    exec(`${call}#2.1`), assistant("c"),
  ] as unknown as SessionEntry[];
  assert.equal(sessionFacts(entries, call).tools, 3);
  assert.equal(sessionFacts(entries, "w@1/E02@1").tools, 2);
  assert.equal(sessionFacts(entries.slice(0, 1), call).tools, 0);
  assert.equal(sessionFacts(session(), "w@1/E02@1").tools, 1);
  assert.equal(toolCount(0), ""); assert.equal(toolCount(1), "1 tool"); assert.equal(toolCount(12), "12 tools");
});

test("call rows show tool counts within width and keep the model (provider dropped when narrow)", () => {
  const c = call("E02"), w = workflow([c, call("E05")]);
  const facts = new Map([[c.callId, { ...sessionFacts([], c.callId), tools: 12, activity: "editing src/a/very/long/path/that/keeps/going/and/going.ts" }]]);
  for (const width of [24, 40, 59, 60, 80, 100, 140]) {
    const row = listRows([w], state(), facts, () => "GLM-5.3 (zhipu)", width, now).find(r => r.call === c)!;
    assert(visibleWidth(row.text) <= width, `${width}: ${row.text}`);
    if (width >= 59) assert(row.text.includes("GLM"), `${width}: ${row.text}`); // the model gives way before the tail
    assert.equal(row.text.includes("(zhipu)"), width >= 70, `${width}: ${row.text}`);
    if (width >= 40) assert.match(row.text, /12 tools · 3m00s$/, "a long command never hides the tools and the age");
  }
  assert.equal(rowText("  ", "E02", "M", "short", ["", ""], 100), "  E02  M  short");
  assert.equal(rowText("", "a", "M", "x", ["2 tools"], 50, { key: 3, model: 0 }).indexOf("M"), 5, "key column padded for alignment");
});

test("overview: newest workflow first, agents as tree children, live preview line, done rows show the conclusion", () => {
  const older = workflow([call("map", { phase: "sealed", endedAt: now - 5_000, result: { key: "map", gen: 1, status: "ok", ok: true, output: "work\nLEAF: ok" } }), call("scan")], { wid: "old", name: "older", startedAt: now - 60_000 });
  const newer = workflow([call("plan", { callId: "new@1/plan@1" }), call("test", { callId: "new@1/test@1" })], { wid: "new", name: "newer", startedAt: now - 10_000 });
  const facts = new Map([["new@1/plan@1", { ...sessionFacts([], "new@1/plan@1"), latest: "thinking: Checking the lease logic" }]]);
  const s = state(); s.done.set("old", 8);
  const rows = listRows(orderWorkflows([older, newer]), s, facts, () => "GLM-5.3 (zhipu)", 100, now).map(r => r.text);
  assert.match(rows[0]!, /^▾ newer/); assert.ok(rows.findIndex(r => /^▾ older/.test(r)) > 0, "newest first");
  assert.match(rows[1]!, /^ {2}├ plan/); assert.match(rows[2]!, /^ {2}│ {3}thinking: Checking the lease logic/);
  assert.ok(rows.some(r => /^ {6}└ map .*done · LEAF: ok/.test(r)), "done rows nested under their done node, showing the final line");
  assert.equal(summaryText([older, newer]), "3 working · 1/4+ done");
});

test("P7 list rows carry a small pending marker until the message is delivered, within width", async () => {
  const { pendingMarker, pendingText } = await import("../../../src/ui/view.ts");
  assert.equal(pendingText(1), "1 message pending"); assert.equal(pendingText(2), "2 messages pending"); assert.equal(pendingText(0), "");
  assert.equal(pendingMarker(undefined), "");
  const c = call("E02", { pending: 1, sends: [{ rid: "s", kind: "steer", state: "pending", at: now }] }), w = workflow([c, call("E05")]);
  const facts = new Map([[c.callId, { ...sessionFacts([], c.callId), tools: 3 }]]);
  const row = (width: number) => listRows([w], state(), facts, () => "GPT-6 (openai)", width, now).find(r => r.call?.key === "E02")!.text;
  assert.match(row(100), /thinking · 20s\s+1 pending · 3 tools · 3m00s$/);
  for (const width of [24, 40, 60, 100]) assert(visibleWidth(row(width)) <= width, `${width}: ${row(width)}`);
  assert(!listRows([w], state(), facts, () => "GPT-6 (openai)", 100, now).find(r => r.call?.key === "E05")!.text.includes("pending"));
  // Delivered: the snapshot no longer counts it, so the marker disappears.
  delete c.pending; c.sends = [{ rid: "s", kind: "steer", state: "delivered", at: now }];
  assert.doesNotMatch(row(100), /pending/); assert.match(row(100), /3 tools · 3m00s$/);
});

test("drain: a queued call in a drained orchestrator says it waits for resume, not for capacity", () => {
  const c = call("q", { phase: "queued" });
  assert.equal(statusPhrase(c, workflow([c], { paused: true }), undefined, now), "paused · r resumes");
  assert.equal(statusPhrase(c, workflow([c]), undefined, now), "queued: waiting for a free slot");
});

test("v12 §4: totals use planned counts; scripts show n+ while running", () => {
  const ok = (key: string) => ({ key, gen: 1, status: "ok" as const, ok: true, output: "" });
  const header = (w: WorkflowSnapshot) => listRows([w], state(), new Map(), () => "—", 100, now).find(r => r.kind === "workflow")!.text;
  const chain = workflow([call("c1"), call("c2")], { planned: 2 });
  assert.equal(summaryText([chain]), "2 working · 0/2 done", "a chain of two is never 0/1");
  assert.match(header(chain), /0\/2 · /);
  const tasks = workflow([call("a", { phase: "sealed", endedAt: now, result: ok("a") }), call("b"), call("c"), call("d")], { planned: 4 });
  assert.equal(summaryText([tasks]), "3 working · 1/4 done");
  assert.match(header(tasks), /1\/4 · /);
  const script = workflow([call("s1"), call("s2")]);
  assert.equal(summaryText([script]), "2 working · 0/2+ done");
  assert.match(header(script), /0\/2\+ · /);
  const ended = workflow([call("s1", { phase: "sealed", endedAt: now, result: ok("s1") }), call("s2", { phase: "sealed", endedAt: now, result: ok("s2") })], { status: "done", endedAt: now });
  assert.equal(summaryText([ended]), "1 finished", "a finished script drops the +");
  assert.match(header(ended), /2\/2 · /);
});

test("v12 §4: follow-up generations never change the denominator", () => {
  const ok = (key: string) => ({ key, gen: 1, status: "ok" as const, ok: true, output: "" });
  const rev1 = call("rev", { phase: "sealed", endedAt: now - 10_000, result: ok("rev") });
  const rev2 = call("rev", { gen: 2, callId: "w@1/rev@2", phase: "running", startedAt: now - 1_000 });
  const other = call("other", { phase: "sealed", endedAt: now - 5_000, result: ok("other") });
  const planned = summary([workflow([rev1, rev2, other, call("wait")], { planned: 3 })]);
  assert.equal(planned.done, 1); assert.equal(planned.total, 3); assert.equal(planned.plus, false);
  assert.equal(summaryText([workflow([rev1, rev2, other, call("wait")], { planned: 3 })]), "2 working · 1/3 done");
  const script = summary([workflow([rev1, rev2, call("x")])]);
  assert.equal(script.total, 2); assert.equal(script.done, 0); assert.equal(script.plus, true, "a follow-up adds a generation, not a key");
});

test("v12 §4: completion words — stopped is never failed; timeout/budget/unknown named as such", () => {
  const seal = (key: string, status: CallStatus = "ok", extra: Record<string, unknown> = {}) =>
    call(key, { phase: "sealed", endedAt: now, result: { key, gen: 1, status, ok: status === "ok", output: "", ...extra } });
  assert.equal(resultWord("stopped"), "stopped"); assert.equal(resultWord("gate-failed"), "failed");
  const w = workflow([seal("a"), seal("b"), seal("c"), seal("d", "stopped"), seal("e", "failed", { error: "merge conflict" })], { status: "stopped", endedAt: now });
  assert.equal(mainLine([w]), "exec-0927 finished: 3 done · 1 stopped · 1 failed · ↓ subagents");
  for (const status of ["timeout", "budget", "unknown", "skipped", "parked"] as const)
    assert.equal(mainLine([workflow([seal("k", status)], { status: "failed", endedAt: now })]), `exec-0927 finished: 1 ${resultWord(status)} · ↓ subagents`);
  assert.equal(resultPhrase(seal("s", "stopped")), "stopped");
  assert.equal(resultPhrase(seal("s", "stopped", { error: "by user" })), "stopped: by user");
  assert.equal(resultPhrase(seal("s", "timeout")), "timeout");
  assert.equal(resultPhrase(seal("s", "budget")), "budget");
  assert.equal(resultPhrase(seal("s", "unknown")), "unknown");
  assert.equal(resultPhrase(seal("s", "gate-failed", { error: "exit 1" })), "failed: exit 1");
});

test("v12 §5: finished workflows stay expandable with dimmed call rows; finished agents keep their final line", () => {
  const good = call("good", { phase: "sealed", endedAt: now - 1_000, result: { key: "good", gen: 1, status: "ok", ok: true, output: "work\nLEAF: ok" } });
  const bad = call("bad", { phase: "sealed", endedAt: now, result: { key: "bad", gen: 1, status: "failed", ok: false, output: "", error: "x" } });
  const w = workflow([good, bad], { status: "failed" }), s = state();
  s.viewed.add(bad.callId); // no unviewed failure: the compact listing is the default
  let rows = listRows([w], s, new Map(), () => "—", 100, now);
  assert.deepEqual(rows.map(r => r.kind), ["workflow"], "the finished workflow stays listed, closed");
  assert.equal(rows[0]!.dim, true); assert.match(rows[0]!.text, /^▸ /);
  toggleOpen(w, s); // Enter opens it: its agents are listed directly, without a nested "done" node
  rows = listRows([w], s, new Map(), () => "—", 100, now);
  assert.deepEqual(rows.map(r => r.kind), ["workflow", "call", "call"]); assert.match(rows[0]!.text, /^▾ /);
  const goodRow = rows.find(r => r.call?.key === "good")!;
  assert.match(goodRow.text, /done · LEAF: ok/, "the finished agent keeps its final line");
  assert.equal(goodRow.dim, true);
  toggleOpen(w, s);
  assert.deepEqual(listRows([w], s, new Map(), () => "—", 100, now).map(r => r.kind), ["workflow"], "folding toggles, but the row never vanishes");
  const solo = listRows([workflow([good], { wid: "solo", status: "done" })], state(), new Map(), () => "—", 100, now);
  assert.equal(solo[0]!.kind, "call"); assert.equal(solo[0]!.dim, true); assert.match(solo[0]!.text, /LEAF: ok/);
});

test("one row per key: a follow-up generation replaces its key's earlier row, so rows match done/total", () => {
  const seal = (key: string, gen: number) => call(key, { gen, callId: `w@1/${key}@${gen}`, phase: "sealed", endedAt: now - 1_000 * gen, result: { key, gen, status: "ok", ok: true, output: `${key}@${gen} ok` } });
  const w = workflow([seal("a", 1), seal("b", 1), seal("c", 1), seal("a", 2)], { status: "done", endedAt: now }), s = state();
  toggleOpen(w, s);
  const rows = listRows([w], s, new Map(), () => "—", 100, now);
  assert.match(rows[0]!.text, /· 3\/3 ·/); assert.equal(rows.filter(r => r.kind === "call").length, 3);
  assert.ok(rows.some(r => r.call?.callId === "w@1/a@2") && !rows.some(r => r.call?.callId === "w@1/a@1"));
});

test("UI §1 dock: a row per active agent (questions first, at most three), a summary line; finished for ten minutes; then nothing", () => {
  const busy = (key: string, extra = {}) => call(key, { phase: "running", startedAt: now - 60_000, lastActivity: now - 2_000, ...extra });
  const a = busy("a"), b = busy("b", { startedAt: now - 300_000, lastActivity: now - 120_000 }), c = busy("c"), d = busy("d"), q = busy("q");
  const w = workflow([a, b, c, d, q], { attention: [{ kind: "question", id: "x", rev: 1, qid: "x", call: q.callId, wid: "w", text: "Which file?" }] });
  const lines = dockLines([w], new Map(), () => "GLM", 80, now);
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /^\? q .*asks: Which file\?/, "the question comes first");
  assert.match(lines[1]!, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] a /, "fresh activity spins");
  assert.match(lines[2]!, /^… b /, "a quiet agent stops spinning");
  assert.match(lines[3]!, /^\+2 more · 1 asking · 4 working · 0\/5\+ done · ↓ subagents$/);
  assert(lines.every(l => visibleWidth(l) <= 80));
  const done = workflow([call("a", { phase: "sealed", endedAt: now - 1_000, result: { key: "a", gen: 1, status: "ok", ok: true, output: "x" } })], { status: "done", endedAt: now - 1_000 });
  assert.deepEqual(dockLines([done], new Map(), () => "GLM", 80, now), ["exec-0927 finished: 1 done · ↓ subagents"]);
  assert.deepEqual(dockLines([done], new Map(), () => "GLM", 80, now + 11 * 60_000), [], "the completion sentence leaves after ten minutes");
  assert.deepEqual(dockLines([], new Map(), () => "GLM", 80, now), []);
});

test("UI §3 be pi: the phrase says what the model is really doing; a dimmed row has no reset before its tail", () => {
  const c = call("E02", { phase: "running", startedAt: now - 60_000 }), w = workflow([c]);
  const base = sessionFacts([], c.callId);
  assert.equal(statusPhrase(c, w, { ...base, live: { phase: "waiting", since: now - 12_000, at: now } }, now), "waiting for the model · 12s");
  assert.equal(statusPhrase(c, w, { ...base, live: { phase: "streaming", since: now - 5_000, at: now, thinking: "x" } }, now), "thinking · 5s");
  assert.equal(statusPhrase(c, w, { ...base, live: { phase: "streaming", since: now - 5_000, at: now, text: "y" } }, now), "writing · 5s");
  assert.equal(statusPhrase(c, w, { ...base, live: { phase: "streaming", since: now - 5_000, at: now, tool: "bash" } }, now), "writing a bash call · 5s");
  const row = rowText("  ", "E02", "GLM", "running " + "x".repeat(200), ["3 tools", "1m00s"], 80);
  assert(!row.includes("\x1b[0m"), "no SGR reset inside a row: the whole row takes the dim style");
  assert.match(row, /3 tools · 1m00s$/);
});

test("a follow-up on a finished workflow is live: the dock, the summary and the list show it", async () => {
  const { snapshotFromEntries } = await import("../../../src/orchestrator/snapshot.ts");
  let seq = 0;
  const e = (type: string, fields: Record<string, unknown>) => ({ seq: ++seq, ts: now - 60_000 + seq * 1000, type, ...fields });
  const ok = (key: string) => ({ key, gen: 1, ok: true, status: "ok", output: `${key} built` });
  const step = { agent: "worker", task: "t" };
  const entries = [
    e("wf-created", { revision: 1, name: "tier1-build" }),
    e("call", { key: "harness", gen: 1, spec: step }), e("sealed", { call: "W@1/harness@1", result: ok("harness") }),
    e("call", { key: "ext", gen: 1, spec: step }), e("sealed", { call: "W@1/ext@1", result: ok("ext") }),
    e("workflow-done", { status: "done", result: 1 }),
    e("generation", { key: "harness", gen: 2, from: "W@1/harness@1", rid: "f", opening: { kind: "follow-up" } }),
    e("exec", { call: "W@1/harness@2", exec: "W@1/harness@2#1.1" }), e("selected", { exec: "W@1/harness@2#1.1", model: { provider: "p", id: "m" } }),
  ];
  const w = snapshotFromEntries("W", entries as never);
  assert.equal(w.status, "done"); assert.equal(w.followUps, 1);
  const later = now + 30 * 60_000; // long after the workflow ended: the completion sentence alone would be gone
  const dock = dockLines([w], new Map(), () => "M", 100, later);
  assert.ok(dock.some(l => l.includes("harness")), dock.join("\n"));
  assert.equal(summary([w]).working, 1);
  assert.match(summaryText([w]), /1 working/);
  const rows = listRows([w], state(), new Map(), () => "M", 100, later);
  const harness = rows.find(r => r.call?.callId === "W@1/harness@2");
  assert.ok(harness && !harness.dim, rows.map(r => r.text).join("\n"));
  assert.ok(rows.some(r => r.kind === "done" && r.text.includes("1 done")), "finished agents fold under done, as in a running workflow");
  // once the follow-up ends, the workflow is finished again
  const sealed = snapshotFromEntries("W", [...entries, e("sealed", { call: "W@1/harness@2", result: { ...ok("harness"), gen: 2 } })] as never);
  assert.equal(sealed.followUps, undefined);
  assert.deepEqual(dockLines([sealed], new Map(), () => "M", 100, later), []);
  assert.equal(summaryText([sealed]), "1 finished");
});
