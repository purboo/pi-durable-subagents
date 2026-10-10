import { appendFile, access } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OsLock } from "../../../../src/platform/lock.ts";
import { openJournal } from "../../../../src/kernel/journal.ts";
import { scanInbox } from "../../../../src/kernel/mailbox.ts";
import { orchLedger, orchLock } from "../../../../src/paths.ts";
import { JT } from "../../../../src/types.ts";

const home = process.env.DSA_HOME!;
const lock = await new OsLock().tryAcquire(orchLock(home));
if (lock) {
  await appendFile(join(home, "spawn.log"), `${process.pid}\n`);
  await appendFile(join(home, "spawn-session.log"), `${process.env.DSA_SESSION ?? "-"}\n`);
  const ledger = await openJournal(orchLedger(home));
  const seen = new Set<string>();
  try {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (await access(join(home, "stop-fake")).then(() => true, () => false)) break;
      for (const req of await scanInbox(join(home, "inbox"))) {
        if (seen.has(req.rid)) continue;
        seen.add(req.rid);
        if (req.kind === "run" && process.env.DSA_FAKE_RECEIPT !== "no") {
          await ledger.append(JT.created, { rid: req.rid, wid: `w-${req.rid}`, origin: req.from });
        }
      }
      await delay(30);
    }
  } finally { await ledger.close(); await lock.release(); await appendFile(join(home, "exited.log"), "exit\n"); }
}
