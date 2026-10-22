// FC1 E2E: a real fork child of a compacted origin sends the compaction summary, the kept and later messages and the
// task, and nothing from before the compaction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FAUX, REPO, tempRoot } from "../../harness/pi.ts";
import { journalPath, orchInbox, orchLedger, pinnedDir } from "../../../src/paths.ts";
import { readJournalSnapshot } from "../../../src/kernel/journal.ts";
import { publishRequest } from "../../../src/kernel/mailbox.ts";
import { JT, type Request } from "../../../src/types.ts";
import { main } from "../../../src/orchestrator/main.ts";

const RECORDER = join(REPO, "test/fixtures/fork-context/recorder.ts");
async function until<T>(fn: () => T | Promise<T>, what: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 60000;
  for (;;) { const value = await fn(); if (value) return value as NonNullable<T>; if (Date.now() > deadline) throw new Error(`timeout: ${what}`); await delay(25); }
}
const text = (m: any): string => typeof m.content === "string" ? m.content : (m.content ?? []).map((b: any) => b?.text ?? "").join("");

test("FC1 E2E: a fork child's first request carries the origin's compaction summary, kept and later messages only", { timeout: 120000 }, async t => {
  const root = tempRoot("dsa-fork-context-"), home = join(root, "dsa"), cwd = join(root, "work"), agentDir = join(root, "agent");
  const values = { PATH: `${join(REPO, "node_modules/.bin")}:${process.env.PATH}`, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PROBE_DIR: root };
  const old = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  await mkdir(join(cwd, ".pi/agents"), { recursive: true }); await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [FAUX, RECORDER] }));
  await writeFile(join(cwd, ".pi/agents/test.md"), "---\nname: test\ndescription: test\nmodel: rec/model\n---\nTest.");
  const ts = new Date().toISOString(), origin = join(root, "origin.jsonl");
  const msg = (id: string, parentId: string | null, content: string) => ({ type: "message", id, parentId, timestamp: ts, message: { role: "user", content, timestamp: Date.now() } });
  const rows = [{ type: "session", version: 3, id: "origin", cwd, timestamp: ts },
    msg("a", null, "EARLY-RAW-MESSAGE"), msg("k", "a", "KEPT-MESSAGE"),
    { type: "custom", id: "receipt", parentId: "k", timestamp: ts, customType: "dsa-exec", data: {} },
    { type: "compaction", id: "c", parentId: "receipt", timestamp: ts, summary: "COMPACTION-SUMMARY-TEXT", firstKeptEntryId: "k", tokensBefore: 5000 },
    msg("l", "c", "LATER-MESSAGE")];
  await writeFile(origin, rows.map(e => JSON.stringify(e)).join("\n") + "\n");
  const controller = new AbortController(), running = main({ home, signal: controller.signal, discovery: { home: root } });
  t.after(async () => { controller.abort(); await running; for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } if (process.env.DSA_KEEP) t.diagnostic(`kept ${root}`); else await rm(root, { recursive: true, force: true }); });
  const req: Request = { rid: "run", from: "main:test", to: "orch", sseq: 1, kind: "run", body: { cwd, source: `return await runs.run('a', {agent:'test', context:'fork', task:'FORK-TASK'});`, origin: { sessionFile: origin } } };
  await publishRequest(orchInbox(home), req);
  const created = await until(() => readJournalSnapshot(orchLedger(home)).find(e => e.type === JT.created), "created");
  const wid = String(created.wid), entries = () => readJournalSnapshot(journalPath(home, wid));
  const done = await until(() => entries().find(e => e.type === JT.done), "workflow done");
  const sealed = entries().find(e => e.type === JT.sealed);
  assert.equal((sealed?.result as { status?: string } | undefined)?.status, "ok", JSON.stringify({ done, sealed }));
  const pinned = (await readFile(join(pinnedDir(home, wid), "origin.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(pinned.map(e => e.id), ["origin", "k", "c", "l"]);
  const first = JSON.parse((await readFile(join(root, "requests.jsonl"), "utf8")).split("\n")[0]!) as { messages: any[] };
  const texts = first.messages.map(text);
  const at = (needle: string) => texts.findIndex(s => s.includes(needle));
  assert.ok(at("COMPACTION-SUMMARY-TEXT") >= 0, JSON.stringify(texts));
  assert.ok(at("COMPACTION-SUMMARY-TEXT") < at("KEPT-MESSAGE") && at("KEPT-MESSAGE") < at("LATER-MESSAGE") && at("LATER-MESSAGE") < at("FORK-TASK"), JSON.stringify(texts));
  assert.equal(at("EARLY-RAW-MESSAGE"), -1, JSON.stringify(texts));
});
