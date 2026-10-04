import { readFile } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { callSession } from "../../paths.ts";
import { publishFile } from "../../kernel/mailbox.ts";
import type { CallTicket } from "../contract.ts";

/** P37, C11: Publish the sealed predecessor's session once, retaining its native session identity. */
export async function continueSession(home: string, t: CallTicket, session: string): Promise<void> {
  if (!t.continueFrom) return;
  const match = /^(.*)@\d+\/(.*)@(\d+)$/.exec(t.continueFrom);
  if (!match || match[1] !== t.wid || match[2] !== t.key) throw new Error("Invalid generation predecessor");
  // An executing session is mutable; never compare it to its original publication on recovery.
  try { await readFile(session); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const bytes = await readFile(callSession(home, t.wid, t.key, Number(match[3])));
  if (await publishFile(dirname(session), basename(session), bytes) === "conflict") throw new Error("Generation session publication conflict");
}
