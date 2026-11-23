import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { appendFile, mkdtemp, open, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { replacePath } from "../../../src/kernel/fsx.ts";
import { JOURNAL_REST_MS, frameLine, journalExpectation, openJournal, openLazyJournal, readJournalFold, readJournalRecord, readJournalSnapshot, readJournalUncached } from "../../../src/kernel/journal.ts";

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
  assert.equal(typeof expect.ino, "string");
  assert.equal(await openLazyJournal(path, { ...expect, size: expect.size + 1 }), undefined);
  assert.equal(await openLazyJournal(path, { ...expect, ino: String(BigInt(expect.ino) + 1n) }), undefined);
  assert.equal(await openLazyJournal(path, { ...expect, dev: String(BigInt(expect.dev) + 1n) }), undefined);
  assert.equal(await openLazyJournal(path, { ...expect, ino: Number(expect.ino) as never }), undefined, "numeric IDs are never trusted");
  assert.equal(await openLazyJournal(path, { ...expect, size: -1 }), undefined);
  assert.equal(await openLazyJournal(path, { ...expect, size: expect.size + 0.5 }), undefined);
  assert.equal(await openLazyJournal(path, { ...expect, size: Number.MAX_SAFE_INTEGER + 1 }), undefined);
  assert.equal(await openLazyJournal(path, { ...expect, tail: "00000000" }), undefined);
  assert.equal(await openLazyJournal(path, { ...expect, tailLength: expect.tailLength - 1 }), undefined);
  assert.equal(await openLazyJournal(join(path, "..", "absent"), expect), undefined);
  // Same size, a different last line: refused.
  const bytes = await readFile(path), changed = Buffer.from(bytes); changed[changed.length - 3] = changed[changed.length - 3] === 120 ? 121 : 120;
  await writeFile(path, changed);
  assert.equal(await openLazyJournal(path, expect), undefined);
  await writeFile(path, bytes);
  const reopened = await openLazyJournal(path, expect);
  assert.ok(reopened);
  await reopened.close();
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

test("real equal-size replacement and adjacent huge 64-bit file IDs invalidate lazy, resting and reader journal caches", async t => {
  const dir = await mkdtemp(join(tmpdir(), "dsa-huge-journal-")), path = join(dir, "j.jsonl"), next = join(dir, "next.jsonl");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const content = (tag: string) => [
    frameLine(JSON.stringify({ seq: 1, ts: 100, type: "head", tag })),
    frameLine(JSON.stringify({ seq: 2, ts: 101, type: "done", same: "tail" })),
  ].join("");
  const firstBytes = content("alpha"), secondBytes = content("bravo");
  assert.equal(Buffer.byteLength(firstBytes), Buffer.byteLength(secondBytes), "equal-size replacement with identical last line");
  await writeFile(path, firstBytes);
  await writeFile(next, secondBytes);

  // Real equal-size replacement without mocks: identical size and identical last line, different file identity.
  const j1 = await openJournal(path);
  const realExpect = journalExpectation(j1)!;
  j1.resting = true;
  for (let i = 0; i < 40 && j1.descriptorOpen !== false; i++) await delay(JOURNAL_REST_MS / 10);
  await delay(JOURNAL_REST_MS + 100);
  assert.equal(j1.descriptorOpen, false);
  const lazyBefore = (await openLazyJournal(path, realExpect))!;
  assert.equal(readJournalSnapshot(path)[0]?.tag, "alpha");
  const foldBefore = readJournalFold(path, undefined, () => [] as string[], (s, e) => s.push(String(e.tag ?? e.same)))!;
  assert.deepEqual(foldBefore.state, ["alpha", "tail"]);

  await replacePath(next, path);
  assert.equal(await openLazyJournal(path, realExpect), undefined, "lazy open refuses equal-size replacement");
  assert.throws(() => lazyBefore.entries(), /Journal changed while not loaded/);
  await assert.rejects(j1.append("after", {}), /Journal changed while closed/);
  await lazyBefore.close();
  await j1.close();
  assert.equal(readJournalSnapshot(path)[0]?.tag, "bravo");
  assert.deepEqual(readJournalFold(path, foldBefore, () => [] as string[], (s, e) => s.push(String(e.tag ?? e.same)))!.state, ["bravo", "tail"]);

  // Simulated Windows 64-bit NTFS/ReFS IDs where Number(idA) === Number(idB) (2^53 vs 2^53 + 1, and 2^64 - 2 vs 2^64 - 1).
  await writeFile(path, firstBytes);
  await writeFile(next, secondBytes);
  const probe = await open(path, "r");
  const fhProto = Object.getPrototypeOf(probe);
  await probe.close();
  const realStatSync = fs.statSync, realFstatSync = fs.fstatSync, realFhStat = fhProto.stat;
  const baseDev = 9007199254740992n, highInoA = 18446744073709551614n, highInoB = 18446744073709551615n;
  assert.equal(Number(baseDev), Number(baseDev + 1n));
  assert.equal(Number(highInoA), Number(highInoB));
  const idMap = new Map<string, { dev: bigint; ino: bigint }>();
  let seq = 0n, oversize = false;
  const assign = (rawDev: bigint, rawIno: bigint) => {
    const key = `${rawDev}:${rawIno}`;
    let mapped = idMap.get(key);
    if (!mapped) {
      mapped = seq === 0n ? { dev: baseDev, ino: highInoA } : seq === 1n ? { dev: baseDev, ino: highInoB } : { dev: baseDev + seq - 1n, ino: baseDev + seq };
      seq++;
      idMap.set(key, mapped);
    }
    return mapped;
  };
  const patch = (big: fs.BigIntStats, wantBig: boolean) => {
    const { dev, ino } = assign(big.dev, big.ino);
    const size = oversize ? BigInt(Number.MAX_SAFE_INTEGER) + 1n : big.size;
    if (wantBig) return Object.assign(big, { dev, ino, size });
    return Object.assign(big, { dev: Number(dev), ino: Number(ino), size: Number(size) });
  };
  t.mock.method(fs, "statSync", (p: fs.PathLike, opts?: fs.StatSyncOptions) => {
    const big = realStatSync(p, { ...opts, bigint: true } as fs.StatSyncOptions & { bigint: true }) as fs.BigIntStats | undefined;
    if (!big) return big;
    if (opts?.bigint) return patch(big, true);
    const plain = realStatSync(p, opts) as fs.Stats;
    const { dev, ino } = assign(big.dev, big.ino);
    return Object.assign(plain, { dev: Number(dev), ino: Number(ino), size: oversize ? Number.MAX_SAFE_INTEGER + 1 : plain.size });
  });
  t.mock.method(fs, "fstatSync", (fd: number, opts?: fs.StatOptions) => {
    const big = realFstatSync(fd, { ...opts, bigint: true }) as fs.BigIntStats;
    if (opts?.bigint) return patch(big, true);
    const plain = realFstatSync(fd, opts) as fs.Stats;
    const { dev, ino } = assign(big.dev, big.ino);
    return Object.assign(plain, { dev: Number(dev), ino: Number(ino), size: oversize ? Number.MAX_SAFE_INTEGER + 1 : plain.size });
  });
  t.mock.method(fhProto, "stat", async function (this: { stat: typeof realFhStat }, opts?: fs.StatOptions) {
    const big = await realFhStat.call(this, { ...opts, bigint: true }) as fs.BigIntStats;
    if (opts?.bigint) return patch(big, true);
    const plain = await realFhStat.call(this, opts) as fs.Stats;
    const { dev, ino } = assign(big.dev, big.ino);
    return Object.assign(plain, { dev: Number(dev), ino: Number(ino), size: oversize ? Number.MAX_SAFE_INTEGER + 1 : plain.size });
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  const hugeHandle = await openJournal(path);
  const hugeExpect = journalExpectation(hugeHandle)!;
  assert.equal(hugeExpect.ino, highInoA.toString());
  const recA = readJournalRecord(path)!;
  assert.equal(recA.dev, baseDev.toString());
  assert.equal(recA.ino, highInoA.toString());
  assert.equal(readJournalUncached(path)?.ino, highInoA.toString());
  const foldA = readJournalFold(path, undefined, () => [] as string[], (s, e) => s.push(String(e.tag ?? e.same)))!;
  assert.deepEqual(foldA.state, ["alpha", "tail"]);
  const hugeLazy = (await openLazyJournal(path, hugeExpect))!;

  await replacePath(next, path);
  assert.equal(await openLazyJournal(path, hugeExpect), undefined, "adjacent 64-bit ino invalidates lazy open");
  assert.throws(() => hugeLazy.entries(), /Journal changed while not loaded/);
  await hugeLazy.close();
  await hugeHandle.close();

  const recB = readJournalRecord(path)!;
  assert.equal(recB.ino, highInoB.toString());
  assert.equal(recB.entries[0]?.tag, "bravo");
  assert.equal(readJournalUncached(path)?.entries[0]?.tag, "bravo");
  assert.deepEqual(readJournalFold(path, foldA, () => [] as string[], (s, e) => s.push(String(e.tag ?? e.same)))!.state, ["bravo", "tail"]);

  oversize = true;
  assert.throws(() => readJournalRecord(path), RangeError, "oversized files beyond MAX_SAFE_INTEGER fail size validation");
});
