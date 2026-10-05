import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetSession, readSession, readSessionState } from "../../../../src/orchestrator/executor/session.ts";

const line = (n: number) => JSON.stringify({ type: "custom", id: `e${n}`, data: { text: "ü".repeat(n) } }) + "\n";

test("F3 incremental session reads equal a full parse and never mutate an earlier result", async t => {
  const root = await mkdtemp(join(tmpdir(), "dsa-session-read-")), file = join(root, "session.jsonl");
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await readSession(file), []);
  await writeFile(file, line(1) + line(2));
  const first = await readSession(file);
  assert.deepEqual(first.map(e => e.id), ["e1", "e2"]);
  assert.equal(await readSession(file), first, "an unchanged file is served from the cache");
  await appendFile(file, line(3) + line(4).slice(0, 7));
  const second = await readSession(file);
  assert.deepEqual(second.map(e => e.id), ["e1", "e2", "e3"], "an unfinished trailing line is not an entry");
  assert.deepEqual(first.map(e => e.id), ["e1", "e2"]);
  await appendFile(file, line(4).slice(7));
  assert.deepEqual((await readSession(file)).map(e => e.id), ["e1", "e2", "e3", "e4"]);
  forgetSession(file);
  assert.deepEqual((await readSession(file)).map(e => e.id), ["e1", "e2", "e3", "e4"]);
});

test("E4 a torn line repaired by pi (newline appended on load) is skipped by line number; later entries stay visible", async t => {
  const root = await mkdtemp(join(tmpdir(), "dsa-session-read-")), file = join(root, "session.jsonl");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(file, line(1) + '{"type":"cus');
  assert.deepEqual(await readSessionState(file), { entries: [JSON.parse(line(1))], corrupt: [] });
  await appendFile(file, "\n" + line(2) + "\n" + "{oops}\n" + line(3));
  const state = await readSessionState(file);
  assert.deepEqual(state.entries.map(e => e.id), ["e1", "e2", "e3"]);
  assert.deepEqual(state.corrupt, [2, 5]);
  forgetSession(file);
  assert.deepEqual(await readSessionState(file), state, "a full re-read numbers lines identically");
});

test("F3 a replaced or shortened session is read from scratch", async t => {
  const root = await mkdtemp(join(tmpdir(), "dsa-session-read-")), file = join(root, "session.jsonl");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(file, line(1) + line(2) + line(3));
  assert.equal((await readSession(file)).length, 3);
  await writeFile(join(root, "next"), line(7) + line(8) + line(9) + line(10));
  await rename(join(root, "next"), file);
  assert.deepEqual((await readSession(file)).map(e => e.id), ["e7", "e8", "e9", "e10"]);
  await writeFile(file, line(5));
  assert.deepEqual((await readSession(file)).map(e => e.id), ["e5"]);
  await rm(file);
  assert.deepEqual(await readSessionState(file), { entries: [], corrupt: [] });
});

test("F3 an in-place rewrite that grows the session is detected by its first 4 KiB and read from scratch", async t => {
  const root = await mkdtemp(join(tmpdir(), "dsa-session-read-")), file = join(root, "session.jsonl");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(file, line(1) + line(2));
  assert.deepEqual((await readSession(file)).map(e => e.id), ["e1", "e2"]);
  const { ino } = await stat(file);
  // pi's _rewriteFile: same inode (truncate + write), different and longer content.
  await writeFile(file, line(11) + line(12) + line(13));
  assert.equal((await stat(file)).ino, ino);
  assert.deepEqual(await readSessionState(file), { entries: [line(11), line(12), line(13)].map(l => JSON.parse(l)), corrupt: [] });
  await writeFile(file, line(12) + line(11) + line(13));
  assert.deepEqual((await readSessionState(file)).entries.map(e => e.id), ["e12", "e11", "e13"], "a same-size rewrite is also re-read");
});
