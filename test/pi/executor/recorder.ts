// Native pi session evidence fixture; it does not implement child mailbox consumption.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CT } from "../../../src/types.ts";

/** C5, P9: Produce real session receipts for executor recovery tests. */
export default function recorder(pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    pi.appendEntry(CT.exec, { exec: process.env.TEST_EXEC });
    if (process.env.TEST_QUESTION) pi.appendEntry(CT.question, { qid: "q1", rev: 1, question: "Need input" });
  });
  pi.on("turn_end", async () => {
    if (process.env.TEST_REPORT) pi.appendEntry(CT.report, { exec: process.env.TEST_EXEC, outcome: "ok", data: JSON.parse(process.env.TEST_REPORT) });
  });
}
