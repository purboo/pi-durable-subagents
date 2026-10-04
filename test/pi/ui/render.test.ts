import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { join } from "node:path";
import { root, clean, now, call, workflow, state, session, ctx, tui, theme, writeSession } from "../../unit/ui/fixture.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { UiDeps } from "../../../src/agent/main.ts";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme("dark", false);
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { SubagentScreen } = await import("../../../src/ui/screen.ts");
const { UiData, UiActions } = await import("../../../src/ui/data.ts");
const { sessionFacts } = await import("../../../src/ui/session.ts");
const { openJournal } = await import("../../../src/kernel/journal.ts");
const { journalPath, callSession, orchLedger } = await import("../../../src/paths.ts");
after(clean);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const plain = (screen: InstanceType<typeof SubagentScreen>, width = 100) => screen.render(width).map(line => stripVTControlCharacters(line).trimEnd()).join("\n") + "\n";
function setup(submit?: UiDeps["submit"]) {
  const data = new UiData(join(root, "dsa")), requests: Record<string, unknown>[] = [], notes: string[] = [];
  const c = call("E02"), c2 = call("E07", { phase: "asking" });
  data.workflows = [workflow([c, c2, call("E01", { phase: "sealed", endedAt: now - 240_000, result: { key: "E01", gen: 1, status: "ok", ok: true, output: "", data: { summary: "merged 3f2a9c1" } } })], {
    attention: [{ kind: "question", id: "q", rev: 2, qid: "question-1", call: c2.callId, wid: "w", text: "docs/ in write set?" }],
  })];
  data.sessions.set(c.callId, session()); data.facts.set(c.callId, sessionFacts(session()));
  const deps = { home: data.home, presentNote: (text: string) => { notes.push(text); }, submit: submit ?? (async (args: Record<string, unknown>) => { requests.push(args); return { submitted: { rid: String(requests.length) } }; }) };
  const actions = new UiActions(deps); let closed = false;
  const screen = new SubagentScreen(data, actions, ctx, tui, theme, () => { closed = true; }, state());
  const open = () => { screen.render(100); screen.handleInput("\x1b[B"); screen.handleInput("\r"); };
  return { data, screen, requests, notes, actions, open, closed: () => closed };
}

test("isolated pi components produce stable full-width list and watch captures", () => {
  const original = Date.now; Date.now = () => now;
  try {
    const { screen, open } = setup();
    const list = plain(screen); open(); const watch = plain(screen);
    for (const [name, content] of [["list", list], ["watch", watch]]) {
      const path = new URL(`./${name}.txt`, import.meta.url);
      if (process.env.UPDATE_UI_CAPTURES === "1") writeFileSync(path, content!);
      assert.equal(content, readFileSync(path, "utf8"));
    }
    assert.match(watch, /Review the scheduler/); assert.match(watch, /Checking SDK import path/); assert.match(watch, /3 failing/);
    assert(watch.indexOf("Review the scheduler") < watch.indexOf("Thinking"));
    for (const width of [20, 40, 59, 60, 100]) assert(screen.render(width).every(line => visibleWidth(line) <= width));
    assert.match(plain(screen, 40), /E02 1\/3/);
  } finally { Date.now = original; }
});

test("thinking duration renders for text and redacted blocks, with timestamp-free fallback", () => {
  for (const thinking of ["A complete thought.", ""]) {
    const { screen, data, open } = setup();
    const entries = session().slice(0, 4);
    entries[2]!.timestamp = new Date(now - 32_000).toISOString();
    const assistant = entries[3]!;
    assert(assistant.type === "message" && assistant.message.role === "assistant");
    assistant.message.content = [{ type: "thinking", thinking }];
    data.sessions.set("w@1/E02@1", entries); open();
    assert.match(plain(screen), thinking ? /▸ Thinking 12s · A complete thought\./ : /\nThinking 12s\n/);
    if (!thinking) assert(!plain(screen).includes("▸ Thinking"));
    const noTimes = entries.map(e => {
      const copy = { ...e, timestamp: undefined };
      if (copy.type === "message") copy.message = { ...copy.message, timestamp: undefined } as unknown as typeof copy.message;
      return copy;
    }) as unknown as SessionEntry[];
    data.sessions.set("w@1/E02@1", noTimes);
    assert.match(plain(screen), /Thinking(?: · A complete thought\.)?\n/);
    assert(!/Thinking \d+s/.test(plain(screen)));
  }
});

test("pending thinking uses latest durable entry time until the next message is complete", () => {
  const original = Date.now; Date.now = () => now;
  try {
    const { screen, data, open } = setup(); open();
    assert.match(plain(screen), /\nThinking 20s\n/);
    Date.now = () => now + 3_000; assert.match(plain(screen), /\nThinking 23s\n/);
    data.sessions.set("w@1/E02@1", []); assert.match(plain(screen), /\nThinking\n/);
  } finally { Date.now = original; }
});

test("watch interaction sends steer, answer, model, thinking, follow-up, and stop through deps", async () => {
  const { screen, open, requests, notes } = setup(); open();
  screen.handleInput("Keep the tests"); screen.handleInput("\r"); await tick();
  assert.deepEqual(requests[0], { action: "send", to: "w@1/E02@1", kind: "steer", message: "Keep the tests" });
  assert.match(notes[0]!, /^\[user\] steered E02:/);
  screen.handleInput("Next run"); screen.handleInput("\x1b\r"); await tick(); assert.equal(requests[1]!.kind, "follow-up");
  screen.handleInput("\x1b[Z"); await tick(); assert.equal(requests[2]!.model, "openai/gpt-6:xhigh");
  screen.handleInput("\x0c"); assert.match(plain(screen), /Model for E02/); screen.handleInput("\x1b[B"); screen.handleInput("\r"); await tick();
  assert.equal(requests[3]!.model, "bedrock-claude/claude-opus:high");
  screen.handleInput("\x1b[C"); assert.match(plain(screen), /Reply to E07/);
  screen.handleInput("Yes"); screen.handleInput("\r"); await tick();
  assert.deepEqual(requests[4], { action: "send", to: "w@1/E07@1", kind: "answer", message: "Yes", qid: "question-1", rev: 2 });
  screen.handleInput("/stop"); screen.handleInput("\r"); await tick(); assert.deepEqual(requests[5], { action: "stop", target: "w@1/E07@1" });
});

test("tabs switch only on empty input, done tab opens ended context, Esc returns through list", () => {
  const { screen, open, closed } = setup(); open();
  screen.handleInput("draft"); screen.handleInput("\x1b[C"); assert.match(plain(screen), /Steer|draft/); assert.match(plain(screen), /E02 · GPT/);
  screen.handleInput("\x15"); screen.handleInput("\x1b[C"); screen.handleInput("\x1b[C");
  assert.match(plain(screen), /done · ← →/); screen.handleInput("\r"); assert.match(plain(screen), /Continue E01/);
  screen.handleInput("\x1b"); assert.match(plain(screen), /^Subagents/); screen.handleInput("\x1b"); assert(closed());
});

test("thinking/tool expansion and follow pause use pi rendering", () => {
  const { screen, open } = setup(); open();
  assert(!plain(screen).includes("Checking the tests now")); screen.handleInput("\x14"); assert.match(plain(screen), /Checking the tests now/);
  screen.handleInput("\x0f"); assert.match(plain(screen), /3 failing/);
  screen.handleInput("\x1b[5~"); assert.match(plain(screen), /Following paused/); screen.handleInput("\x1b[F"); assert(!plain(screen).includes("Following paused"));
});

test("late submit completion cannot clear a different call's editor", async () => {
  let resolve!: (value: unknown) => void;
  const { screen, open } = setup(() => new Promise(r => { resolve = r; })); open();
  screen.handleInput("old"); screen.handleInput("\r"); screen.handleInput("\x1b");
  screen.render(100); screen.handleInput("\x1b[B"); screen.handleInput("\x1b[B"); screen.handleInput("\r");
  resolve({}); await tick(); screen.handleInput("new draft"); assert.match(plain(screen), /new draft/);
});

test("actual journals and session growth feed fresh snapshots; rejection is a non-waking note", async () => {
  const home = join(root, "durable"), j = await openJournal(journalPath(home, "run"));
  await j.append("wf-created", { origin: "main:test", cwd: root, revision: 1 });
  await j.append("call", { key: "E02", gen: 1, spec: { agent: "worker" } });
  await j.append("exec", { call: "run@1/E02@1", exec: "run@1/E02@1#1.1" }); await j.close();
  writeSession(callSession(home, "run", "E02", 1));
  const data = new UiData(home); data.refresh(); assert.equal(data.workflows[0]!.calls[0]!.phase, "running");
  assert.equal(data.facts.get("run@1/E02@1")!.thinking, "high");
  const notes: string[] = [], actions = new UiActions({ home, submit: async () => ({ submitted: { rid: "rejected" } }), presentNote: n => { notes.push(n); } });
  await actions.send({ action: "send" }, "continued E02");
  const ledger = await openJournal(orchLedger(home)); await ledger.append("rejected", { rid: "rejected", reason: "call-sealed" }); await ledger.close();
  assert.match(actions.reconcile()!, /call-sealed/); actions.reconcile(); assert.equal(notes.length, 2);
});

test("fullscreen model and thinking controls expose separate selectors", async () => {
  const { screen, open, requests } = setup(); open();
  screen.handleMouse({ type: "click", button: "left", x: 35, y: 1 } as TuiMouseEvent);
  assert.match(plain(screen), /Thinking for E02/); screen.handleInput("\r"); await tick();
  assert.equal(requests[0]!.model, "openai/gpt-6:off");
  screen.handleMouse({ type: "click", button: "left", x: 8, y: 1 } as TuiMouseEvent);
  assert.match(plain(screen), /Model for E02/); screen.handleInput("\x1b");
});

test("list selection survives incoming activity reordering", () => {
  const { screen, data } = setup(); screen.render(100); screen.handleInput("\x1b[B"); screen.render(100);
  data.workflows[0]!.calls[1]!.lastActivity = now + 10_000;
  screen.render(100); screen.handleInput("\r"); assert.match(plain(screen), /E02 · GPT-6/);
});

test("submission failure retains input and records failure note", async () => {
  const { screen, open, notes } = setup(async () => { throw new Error("disk unavailable"); }); open(); screen.handleInput("preserve me"); screen.handleInput("\r"); await tick();
  assert.match(plain(screen), /preserve me/); assert.match(plain(screen), /disk unavailable/); assert.match(notes[0]!, /disk unavailable/);
});
