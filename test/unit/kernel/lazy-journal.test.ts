import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalExpectation, openJournal, openLazyJournal } from "../../../src/kernel/journal.ts";

async function journal(t: test.TestContext, n = 3) {
  const dir = await mkdtemp(join(tmpdir(), "dsa-lazy-journal-")), path = join(dir, "j.jsonl");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const j = await openJournal(path);
  for (let i = 0; i < n; i++) await j.append("e", { i, text: "x".repeat(i * 3000) });
  const expect = journalExpectation(j)!;
  await j.close();
  return { dir, path, expect };
}

test("a lazy journal decodes nothing until its entries or an append are needed", async t => {
  const { path, expect } = await journal(t);
  assert.deepEqual({ count: expect.count, size: expect.size > 0 }, { count: 3, size: true });
  const lazy = (await openLazyJournal(path, expect))!;
  assert.equal(lazy.loaded, false); assert.equal(lazy.count!(), 3); assert.equal(lazy.descriptorOpen, false); assert.equal(lazy.resting, true);
  assert.deepEqual(lazy.entries().map(e => e.i), [0, 1, 2]);
  assert.equal(lazy.loaded, true);
  await lazy.close();
  const appending = (await openLazyJournal(path, expect))!;
  const entry = await appending.append("e", { i: 3 });
  assert.equal(entry.seq, 4); assert.equal(appending.loaded, true); assert.equal(appending.count!(), 4);
  await appending.close();
  const eager = await openJournal(path);
  assert.deepEqual(eager.entries().map(e => e.seq), [1, 2, 3, 4]);
  await eager.close();
});

test("a lazy open refuses a file that is not what was expected", async t => {
  const { path, expect } = await journal(t);
  assert.equal(await openLazyJournal(path, { ...expect, size: expect.size + 1 }), undefined);
  assert.equal(await openLazyJournal(path, { ...expect, ino: expect.ino + 1 }), undefined);
  assert.equal(await openLazyJournal(path, { ...expect, tail: "00000000" }), undefined);
  assert.equal(await openLazyJournal(path, { ...expect, tailLength: expect.tailLength - 1 }), undefined);
  assert.equal(await openLazyJournal(join(path, "..", "absent"), expect), undefined);
  // Same size, a different last line: refused.
  const bytes = await readFile(path), changed = Buffer.from(bytes); changed[changed.length - 3] = changed[changed.length - 3] === 120 ? 121 : 120;
  await writeFile(path, changed);
  assert.equal(await openLazyJournal(path, expect), undefined);
  await writeFile(path, bytes);
  assert.ok(await openLazyJournal(path, expect));
  // Appended to (another writer, or a crash before the record followed): refused.
  await appendFile(path, "garbage\n");
  assert.equal(await openLazyJournal(path, expect), undefined);
});

test("a lazy handle whose file changed after the open throws instead of decoding other bytes", async t => {
  const { path, expect } = await journal(t);
  const lazy = (await openLazyJournal(path, expect))!;
  await truncate(path, expect.size - 1);
  assert.throws(() => lazy.entries(), /Journal changed while not loaded/);
  await assert.rejects(lazy.append("e", {}), /Journal changed while not loaded/);
  await lazy.close();
});

test("journalExpectation needs a committed last entry", async t => {
  const dir = await mkdtemp(join(tmpdir(), "dsa-lazy-journal-")), path = join(dir, "j.jsonl");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const j = await openJournal(path);
  assert.equal(journalExpectation(j), undefined, "an empty journal");
  await j.append("e", {});
  assert.ok(journalExpectation(j));
  await appendFile(path, "torn");
  assert.equal(journalExpectation(j), undefined, "a torn tail is never described");
  await j.close();
});
