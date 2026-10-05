// Runs under a low RLIMIT_NOFILE: exhausts descriptors, stages (EMFILE must propagate), frees them, stages again.
import { existsSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { orchLedger } from "../../../../src/paths.ts";
import { Store } from "../../../../src/orchestrator/store.ts";
import type { Request, RunBody } from "../../../../src/types.ts";

const home = process.env.TEST_HOME!, orch = await openJournal(orchLedger(home)), store = new Store({ home, orch, config: {} });
const req: Request<RunBody> = { rid: "emfile", from: "cli:test", to: "orch", sseq: 1, kind: "run", body: { cwd: join(home, "project"), source: "return 1;", inputs: { data: process.env.TEST_INPUT! } } };
const discovery = { home, agentDir: join(home, "config"), globalNpmRoot: null };
const held: number[] = [];
try { for (;;) held.push(openSync("/dev/null", "r")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EMFILE") throw error; }
const first = await store.stage(req, discovery).then(() => "ok", error => (error as NodeJS.ErrnoException).code ?? String(error));
for (const fd of held) closeSync(fd);
const dir = join(home, "staging", "emfile");
const result = { first, failure: existsSync(join(dir, "failure.json")), snapshot: existsSync(join(dir, "snapshot.json")) };
const second = await store.stage(req, discovery).then(() => "ok", error => String(error));
console.log(JSON.stringify({ ...result, second, source: (await store.staged(req)).source }));
await orch.close();
