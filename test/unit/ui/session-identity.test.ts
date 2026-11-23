import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolved } from "../../../src/agent/main/snapshots.ts";
import { replacePathSync } from "../../../src/kernel/fsx.ts";
import { crc32, openJournal } from "../../../src/kernel/journal.ts";
import { SETTLED_RECHECK_MS } from "../../../src/orchestrator/snapshot.ts";
import { callSession, factsDir, journalPath, orchLedger } from "../../../src/paths.ts";
import { JT } from "../../../src/types.ts";
import { UiData } from "../../../src/ui/data.ts";
import { SessionTail } from "../../../src/ui/session.ts";

test("a session's cache identity describes only bytes actually read", t => {
  const home = mkdtempSync(join(tmpdir(), "session-identity-")), path = join(home, "session.jsonl");
  try {
    writeFileSync(path, '{"type":"test"}\n');
    t.mock.method(fs, "readSync", () => 0);
    syncBuiltinESMExports();
    const tail = new SessionTail();
    assert.deepEqual(tail.read(path), []);
    assert.equal(tail.snapshotIdentity, undefined, "a premature EOF cannot publish final facts under the unread file's size");
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal(tail.read(path).length, 1);
    const stat = fs.statSync(path, { bigint: true });
    assert.equal(tail.snapshotIdentity, `${stat.dev}:${stat.ino}:${stat.size}`);
    writeFileSync(path, "");
    assert.deepEqual(tail.read(path), []);
    assert.equal(tail.snapshotIdentity, `${stat.dev}:${stat.ino}:0`);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(home, { recursive: true, force: true }); }
});

test("UI session tail, final facts, config reload and answered-ask scan distinguish equal-size replacements with adjacent huge 64-bit IDs", async t => {
  const home = mkdtempSync(join(tmpdir(), "ui-huge-identity-"));
  try {
    const ledger = await openJournal(orchLedger(home));
    await ledger.append("create-intent", { wid: "wf", origin: "main:s" });
    await ledger.append(JT.created, { wid: "wf", origin: "main:s" });
    await ledger.close();
    const journal = await openJournal(journalPath(home, "wf"));
    await journal.append("wf-created", { origin: "main:s", revision: 1 });
    await journal.append("call", { key: "a", gen: 1, spec: { agent: "worker", task: "task" } });
    await journal.append(JT.sealed, { call: "wf@1/a@1", result: { key: "a", gen: 1, ok: true, status: "ok", output: "ok" } });
    await journal.append(JT.done, { status: "done" });
    await journal.append(JT.attention, { item: { id: "finished:wf", rev: 1, kind: "finished", wid: "wf", text: "done" } });
    await journal.append(JT.attentionResolved, { id: "finished:wf", rev: 1 });
    await journal.close();

    const realStat = fs.statSync, realFstat = fs.fstatSync;
    const baseDev = 9007199254740992n, baseIno = 18446744073709551600n;
    const ids = new Map<string, bigint>();
    let seq = 0n;
    const mapIno = (dev: bigint, ino: bigint) => {
      const k = `${dev}:${ino}`;
      let v = ids.get(k);
      if (v === undefined) { v = baseIno + seq++; ids.set(k, v); }
      return v;
    };
    const fixedTime = 1795424596000n;
    const patch = (big: fs.BigIntStats, wantBig: boolean) => {
      const dev = baseDev, ino = mapIno(big.dev, big.ino);
      if (wantBig) return Object.assign(big, { dev, ino, mtimeMs: fixedTime, ctimeMs: fixedTime, mtimeNs: fixedTime * 1_000_000n, ctimeNs: fixedTime * 1_000_000n });
      return Object.assign(big, { dev: Number(dev), ino: Number(ino), mtimeMs: Number(fixedTime), ctimeMs: Number(fixedTime) });
    };
    t.mock.method(fs, "statSync", (p: fs.PathLike, opts?: fs.StatSyncOptions) => {
      const big = realStat(p, { ...opts, bigint: true } as fs.StatSyncOptions & { bigint: true }) as fs.BigIntStats | undefined;
      if (!big) return big;
      if (opts?.bigint) return patch(big, true);
      const plain = realStat(p, opts) as fs.Stats, ino = mapIno(big.dev, big.ino);
      return Object.assign(plain, { dev: Number(baseDev), ino: Number(ino), mtimeMs: Number(fixedTime), ctimeMs: Number(fixedTime) });
    });
    t.mock.method(fs, "fstatSync", (fd: number, opts?: fs.StatOptions) => {
      const big = realFstat(fd, { ...opts, bigint: true }) as fs.BigIntStats;
      if (opts?.bigint) return patch(big, true);
      const plain = realFstat(fd, opts) as fs.Stats, ino = mapIno(big.dev, big.ino);
      return Object.assign(plain, { dev: Number(baseDev), ino: Number(ino), mtimeMs: Number(fixedTime), ctimeMs: Number(fixedTime) });
    });
    syncBuiltinESMExports();

    let clock = Date.now() + 60_000;
    t.mock.method(Date, "now", () => clock);

    // 1. SessionTail + UiData final facts & opened transcript on equal-size replacement with adjacent 64-bit IDs.
    const sessionPath = callSession(home, "wf", "a", 1);
    mkdirSync(join(sessionPath, ".."), { recursive: true });
    const msg = (text: string) => JSON.stringify({ id: "m1", type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text }] } }) + "\n";
    const firstMsg = msg("alpha"), secondMsg = msg("bravo");
    assert.equal(Buffer.byteLength(firstMsg), Buffer.byteLength(secondMsg));
    writeFileSync(sessionPath, firstMsg);

    const tail = new SessionTail();
    assert.equal((tail.read(sessionPath)[0] as { message?: { content?: { text?: string }[] } })?.message?.content?.[0]?.text, "alpha");
    assert.match(tail.snapshotIdentity ?? "", new RegExp(`^${baseDev}:\\d+:${Buffer.byteLength(firstMsg)}$`));

    const data = new UiData(home);
    data.refresh("main:s");
    assert.equal(data.facts.get("wf@1/a@1")?.latest, "alpha");
    assert.equal((data.sessions.get("wf@1/a@1")?.[0] as { message?: { content?: { text?: string }[] } })?.message?.content?.[0]?.text, "alpha");
    const cachedFactsPath = join(factsDir(home), "wf", "a@1.json");
    const storedBefore = JSON.parse(readFileSync(cachedFactsPath, "utf8"));
    assert.match(String(storedBefore.session), new RegExp(`^${baseDev}:184467440737095516\\d\\d:${Buffer.byteLength(firstMsg)}$`));

    // Replace session with equal-size file (adjacent 64-bit ino whose float64 Number() equals the previous one).
    writeFileSync(`${sessionPath}.next`, secondMsg);
    replacePathSync(`${sessionPath}.next`, sessionPath);
    assert.equal((tail.read(sessionPath)[0] as { message?: { content?: { text?: string }[] } })?.message?.content?.[0]?.text, "bravo");

    clock += SETTLED_RECHECK_MS + 1;
    data.refresh("main:s");
    assert.equal(data.facts.get("wf@1/a@1")?.latest, "bravo");
    assert.equal((data.sessions.get("wf@1/a@1")?.[0] as { message?: { content?: { text?: string }[] } })?.message?.content?.[0]?.text, "bravo");
    assert.equal(new UiData(home).refresh("main:s") && true, true);
    const freshUi = new UiData(home);
    freshUi.refresh("main:s");
    assert.equal(freshUi.facts.get("wf@1/a@1")?.latest, "bravo");

    // Stored facts with invalid size in session identity safely miss and rebuild.
    const rawFacts = JSON.parse(readFileSync(cachedFactsPath, "utf8"));
    const { checksum: _c, ...body } = rawFacts;
    body.facts.latest = "tampered";
    body.session = `${baseDev}:${baseIno}:${Number.MAX_SAFE_INTEGER + 1}`;
    writeFileSync(cachedFactsPath, JSON.stringify({ ...body, checksum: crc32(Buffer.from(JSON.stringify(body))) }));
    const verifySizeUi = new UiData(home);
    verifySizeUi.refresh("main:s");
    assert.equal(verifySizeUi.facts.get("wf@1/a@1")?.latest, "bravo");

    // 2. UiData config.json reload on equal-size replacement at identical timestamps with adjacent 64-bit ID.
    const cfgPath = join(home, "config.json");
    const cfgA = JSON.stringify({ ui: { dock: "line" } }), cfgB = JSON.stringify({ ui: { dock: "auto" } });
    assert.equal(Buffer.byteLength(cfgA), Buffer.byteLength(cfgB));
    writeFileSync(cfgPath, cfgA);
    data.refresh("main:s");
    assert.equal(data.dock, "line");
    writeFileSync(`${cfgPath}.next`, cfgB);
    replacePathSync(`${cfgPath}.next`, cfgPath);
    data.refresh("main:s");
    assert.equal(data.dock, "auto");

    // 3. Main snapshots answeredAsks scan on equal-size replacement (> 64-byte identical suffix) with adjacent 64-bit ID.
    const askSession = join(home, "ask-child.jsonl");
    const sharedSuffix = JSON.stringify({ type: "custom", pad: "z".repeat(80) }) + "\n";
    const askLine = (qid: string) => JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "ask", isError: false, details: { qid, rev: 1 } } }) + "\n" + sharedSuffix;
    const askYes = askLine("q1"), askNo = askLine("q2");
    assert.equal(Buffer.byteLength(askYes), Buffer.byteLength(askNo));
    const item = { id: "q:wf@1/a@1:q1", rev: 1, kind: "question" as const, text: "?", wid: "wf", call: "wf@1/a@1", qid: "q1", session: askSession };
    writeFileSync(askSession, askYes);
    assert.equal(resolved(home, item), true);
    writeFileSync(`${askSession}.next`, askNo);
    replacePathSync(`${askSession}.next`, askSession);
    assert.equal(resolved(home, item), false, "adjacent 64-bit ID invalidates answeredAsks despite equal size and identical 64-byte tail mark");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(home, { recursive: true, force: true }); }
});
