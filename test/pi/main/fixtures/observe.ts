import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { journalPath } from "../../../../src/paths.ts";
import { JT } from "../../../../src/types.ts";

/** C6, P15, P16: Record isolated pi boundary and outgoing-context evidence. */
export default function observe(pi: ExtensionAPI): void {
  const log = (kind: string, value: unknown) => appendFileSync(join(process.env.PROBE_DIR!, "observed.jsonl"), `${JSON.stringify({ kind, value })}\n`);
  pi.on("context", event => { log("context", event.messages); });
  pi.on("turn_end", async event => {
    log("turn_end", event.entries);
    const path = join(process.env.DSA_HOME!, "late-attention.json");
    if (existsSync(path)) {
      const item = JSON.parse(readFileSync(path, "utf8")); unlinkSync(path);
      const journal = await openJournal(journalPath(process.env.DSA_HOME!, item.wid));
      try { await journal.append(JT.attention, { item }); } finally { await journal.close(); }
    }
  });
  pi.on("agent_before_settle", event => { log("agent_before_settle", event.entries); });
}
