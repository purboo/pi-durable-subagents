// Diagnostic entry only: all orchestration is performed by the product's real main.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../orchestrator/main.ts";
import { captureStart } from "../../platform/proctable.ts";

const root = process.env.DSA_CHAOS_ROOT!;
appendFileSync(join(root, "hosts.jsonl"), JSON.stringify({ pid: process.pid, start: await captureStart(process.pid) }) + "\n");
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
try { await main({ signal: controller.signal }); }
catch (error) { appendFileSync(join(root, "host-errors.log"), String(error) + "\n"); process.exitCode = 1; }
