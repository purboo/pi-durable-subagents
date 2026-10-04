import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root, clean, now, call, workflow, state, session } from "./fixture.ts";
const { listRows, duration, mainLine, modelLabel, statusPhrase } = await import("../../../src/ui/view.ts");
const { SessionTail, thoughtSummary, sessionFacts, sessionBranch } = await import("../../../src/ui/session.ts");
after(clean);

test("durations and model names stay compact and truthful", () => {
  assert.equal(duration(-1), "0s"); assert.equal(duration(59_999), "59s"); assert.equal(duration(3720_000), "1h02m");
  assert.equal(modelLabel("bedrock-claude/claude-opus:high", () => ({ name: "Opus 5.5" })), "Opus 5.5 (bedrock)");
  assert.equal(modelLabel("openai/gpt-6", () => undefined, { "openai/gpt-6": "GPT" }), "GPT (openai)");
  assert.equal(modelLabel(undefined, () => undefined), "—");
});

test("grouping, recent activity, done paging, and narrow columns", () => {
  const calls = [call("E02"), call("E05", { lastActivity: now - 5_000 }), ...Array.from({ length: 10 }, (_, i) => call(`D${i}`, { phase: "sealed", endedAt: now - i * 1000, result: { key: `D${i}`, gen: 1, ok: true, status: "ok", output: "", data: { summary: `merged ${i}` } } }))];
  const w = workflow(calls), s = state();
  const solo = workflow([call("scout")], { wid: "solo" });
  let rows = listRows([solo, w], s, new Map(), () => "GPT-6 (openai)", 100, now);
  assert.equal(rows[0]!.kind, "workflow"); assert.match(rows[0]!.text, /10\/12 · 1h02m/);
  assert.equal(rows[1]!.call!.key, "E05"); assert.equal(rows[3]!.text.trim(), "10 done");
  assert(!rows.some(r => r.kind === "more"));
  s.done.set("w", 8); rows = listRows([w], s, new Map(), () => "GPT-6 (openai)", 100, now);
  assert.equal(rows.filter(r => r.call?.phase === "sealed").length, 8); assert.equal(rows.at(-1)!.text.trim(), "2 more");
  assert.match(rows.find(r => r.call?.key === "D0")!.text, /merged 0/);
  assert(!listRows([w], s, new Map(), () => "GPT-6 (openai)", 40, now).some(r => r.text.includes("GPT")));
  s.folded.add("w"); assert.equal(listRows([w], s, new Map(), () => "", 100, now).length, 1);
});

test("unviewed failures remain visible then collapse; all-ended workflows expand done rows", () => {
  const bad = call("bad", { phase: "sealed", endedAt: now, result: { key: "bad", gen: 1, status: "failed", ok: false, output: "", error: "merge conflict" } });
  const good = call("good", { phase: "sealed", endedAt: now });
  const w = workflow([good, bad], { status: "failed" }), s = state();
  const rows = listRows([w], s, new Map(), () => "—", 100, now);
  assert.equal(rows.find(r => r.kind === "call")!.call!.key, "bad"); assert(rows.some(r => r.failed));
  s.viewed.add(bad.callId);
  assert.deepEqual(listRows([w], s, new Map(), () => "—", 100, now).map(r => r.text), ["  1 finished workflow"]);
  s.finished = true; assert(listRows([w], s, new Map(), () => "—", 100, now).some(r => r.call === good));
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

test("ordinary status phrases, main line, questions and stalls", () => {
  const c = call("E07"), w = workflow([c]);
  assert.equal(mainLine([]), undefined); assert.equal(mainLine([w]), "1 subagent working  ↓");
  w.attention = [{ id: "q", rev: 1, kind: "question", call: c.callId, text: "docs/ in write set?", wid: "w" }];
  assert.equal(statusPhrase(c, w, undefined, now), "asking main agent: docs/ in write set?");
  w.attention = [{ id: "s", rev: 1, kind: "stall", call: c.callId, text: "", wid: "w" }]; c.lastActivity = now - 840_000;
  assert.equal(statusPhrase(c, w, undefined, now), "no activity for 14m");
  w.attention = []; assert.equal(statusPhrase(c, w, undefined, now), "thinking");
  c.phase = "queued"; assert.match(statusPhrase(c, w, undefined, now), /^queued:/);
  c.phase = "sealed"; c.result = { key: c.key, gen: 1, status: "failed", ok: false, output: "", error: "blocked" };
  w.status = "failed";
  assert.match(mainLine([w])!, /E07 failed/);
});

test("thinking summaries never display partial prose or expose empty expansion", () => {
  assert.equal(thoughtSummary("First complete. Still typing"), "First complete.");
  assert.equal(thoughtSummary("**First**\n**Last heading**\npartial"), "Last heading");
  assert.equal(thoughtSummary("partial"), ""); assert.equal(thoughtSummary(""), "");
});

test("session tails tolerate split UTF-8 and partial lines, replacement and truncation", () => {
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
  appendFileSync(path, "bad\n"); assert.throws(() => tail.read(path)); assert.throws(() => tail.read(path));
});

test("session facts follow the native branch and completed tools disappear", () => {
  const entries = session();
  const facts = sessionFacts(entries); assert.equal(facts.model, "openai/gpt-6"); assert.equal(facts.thinking, "high"); assert.match(facts.task, /scheduler/); assert.equal(facts.activity, undefined);
  assert.equal(sessionFacts(entries.slice(0, -1)).activity, "running npm test -- sched");
  const fork = { ...entries.at(-1)!, id: "fork", parentId: "0" };
  assert.deepEqual(sessionBranch([...entries, fork]).map(e => e.id), ["0", "fork"]);
});
