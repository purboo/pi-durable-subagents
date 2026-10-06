import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callSession, orchInbox } from "../../paths.ts";
import { scanInbox } from "../../kernel/mailbox.ts";
import { CT, JT, type AttentionItem } from "../../types.ts";
import { rows, script, stack, until } from "./stack.ts";

const tailOf = (path: string) => { try { return readFileSync(path, "utf8").slice(-600); } catch { return ""; } };

/** Construct the rolling DAG; verdict and dependency skips are script decisions. */
export function workflow(n: number): string {
  const writer: unknown[] = n === 1 ? [{ tool: "bash", args: { command: "printf PARTIAL-KEPT" } }, { error: "chaos stream dropped" }] :
    n === 2 ? [{ tool: "bash", args: { command: "node -e 'for (;;) {}'" } }] : n === 3 ? [{ empty: true }] :
    n === 8 ? Array.from({ length: 8 }, () => ({ empty: true })) : n === 5 ? [
      { tool: "ask", args: { question: "CHAOS-QUESTION" } }, { tool: "ask", args: { question: "CHAOS-QUESTION" } }] :
    // Scenario 6 keeps the writer busy while two sends each wait up to 10 s for the stopped orchestrator to resolve them.
    n === 4 ? [{ tool: "bash", args: { command: "sleep 3" } }] : n === 6 ? [{ tool: "bash", args: { command: "sleep 28" } }] : [];
  writer.push({ text: "LEAF: writer-ok" });
  const reviewer = n === 9 ? [{ tool: "bash", args: { command: "sleep 45" } }, { text: "REVIEW: accept" }] : [{ text: `REVIEW: ${n === 7 ? "reject" : "accept"}` }];
  const specs = [ { agent: "writer", task: script(writer), ...(n === 2 ? { timeoutMs: 2200 } : {}) },
    { agent: "reviewer", task: script(reviewer.map(step => ({ ...step, requires: "LEAF: writer-ok" }))) },
    { agent: "integrator", task: script([{ text: "INTEGRATE: integrated", requires: "REVIEW: accept" }]) } ];
  return `const specs = ${JSON.stringify(specs)};
const keys = ["writer", "reviewer", "integrator"], results = {}, pending = new Map();
const launch = (i, input) => {
  const task = "#chaos: " + JSON.stringify(JSON.parse(specs[i].task.slice(8)).map(step => ({...step, input})));
  pending.set(i, runs.run(keys[i], {...specs[i], task}).then(result => ({i, result})));
};
launch(0);
while (pending.size) {
  const {i, result} = await Promise.race([...pending.values()]); pending.delete(i); results[keys[i]] = result;
  const line = result.output.split("\\n").find(s => s.startsWith(i === 0 ? "LEAF:" : "REVIEW:"));
  if (i < 2 && result.ok && (i === 0 ? line === "LEAF: writer-ok" : line === "REVIEW: accept")) launch(i + 1, result.output);
  else if (i < 2) for (let j = i + 1; j < 3; j++) results[keys[j]] = {status: "skipped", output: "", ok: false};
}
return results;`;
}
/** Exercise one fault on real pi sessions and return evidence-derived invariant counts. */
export async function scenario(n: number, root: string, env: NodeJS.ProcessEnv) {
  const s = stack(root, env); let pi = s.launch();
  const prefixes = new Map<string, string>();
  const check = (ok: unknown, invariant: string) => { if (!ok) throw new Error(invariant); };
  try {
    await pi.prompt([{ tool: "subagents", args: { action: "run", source: workflow(n) } }, { text: "Submitted." }]);
    const wid = String((await until(() => s.ledger().find(e => e.type === JT.created), "workflow created")).wid);
    const journal = () => {
      const entries = s.journal(wid);
      for (const e of entries.filter(e => e.type === "call")) {
        const path = callSession(s.home, wid, String(e.key), Number(e.gen));
        if (!existsSync(path)) continue;
        const text = readFileSync(path, "utf8"), previous = prefixes.get(path) ?? "";
        check(text.startsWith(previous), `restarted from scratch: ${path}`); prefixes.set(path, text);
      }
      return entries;
    };
    const child = (key = "writer") => rows(callSession(s.home, wid, key, 1));
    const main = () => rows(s.session);
    const send = async (args: Record<string, unknown>) => {
      await pi.prompt([{ tool: "subagents", args: { action: "send", to: `${wid}/writer`, ...args } }, { text: "Sent." }]);
      const result = main().filter(e => e.message?.toolName === "subagents").at(-1)?.message;
      const rid = result?.details?.rid ?? result?.details?.submitted?.rid;
      check(!result?.isError && rid && result.details.applied !== false, "main send receipt"); return String(rid);
    };
    if (n === 4) {
      await until(() => child().some(e => e.message?.role === "assistant"), "writer started");
      const before = readFileSync(s.session, "utf8"); pi.child.kill("SIGKILL");
      await until(() => pi.child.signalCode, "main exited"); pi = s.launch();
      await pi.prompt([{ text: "Main restarted." }]);
      check(readFileSync(s.session, "utf8").startsWith(before), "main restarted from scratch");
    }
    if (n === 5) {
      await until(() => child().some(e => e.customType === CT.question), "open question");
      await send({ kind: "steer", message: "STEER-WHILE-OPEN" });
      await until(() => child().some(e => e.message?.toolName === "ask" && JSON.stringify(e.message.content).includes("interrupted_by")), "steer interrupts ask");
      check(!child().some(e => e.message?.details?.qid), "steer must leave question open");
      const q = await until(() => child().find(e => e.customType === CT.question && e.data.rev === 2)?.data, "question re-asked");
      await send({ kind: "answer", message: "ANSWER-COMPLETE", qid: q.qid, rev: q.rev });
      await until(() => child().some(e => e.message?.details?.qid === q.qid && e.message.details.rev === q.rev), "answer receipt");
    }
    if (n === 6) {
      await until(() => child().some(e => e.message?.role === "assistant"), "writer tool started");
      await s.signalHost("SIGSTOP");
      const first = await send({ kind: "steer", message: "SUPERSEDED-FIRST" });
      const second = await send({ kind: "steer", message: "WINNING-SECOND", replaces: [first] });
      const requests = (await scanInbox(orchInbox(s.home))).filter(r => r.rid === first || r.rid === second || r.kind === "withdraw").sort((a, b) => b.sseq - a.sseq);
      for (const req of requests) renameSync(join(orchInbox(s.home), `${req.rid}.json`), join(root, `${req.rid}.held`));
      await s.signalHost("SIGCONT");
      for (const req of requests) { renameSync(join(root, `${req.rid}.held`), join(orchInbox(s.home), `${req.rid}.json`)); await new Promise(resolve => setTimeout(resolve, 150)); }
      writeFileSync(join(root, "reverse-publication.json"), JSON.stringify(requests));
      await until(() => s.ledger().some(e => e.type === JT.rejected && e.rid === first && e.reason === "withdrawn"), "first steer withdrawn");
      await until(() => JSON.stringify(child()).includes("WINNING-SECOND"), "winning steer delivered");
      check(!child().some(e => e.content === "SUPERSEDED-FIRST"), "superseded steer applied");
    }
    if (n === 9) {
      await until(() => child("reviewer").some(e => e.message?.role === "assistant"), "reviewer running after writer seal");
      check(journal().filter(e => e.type === JT.sealed).length === 1, "kill window: one sealed predecessor");
      await s.signalHost("SIGKILL");
      // Wait for the real K1 main starter, without submitting a resume or launching a host ourselves.
      await until(() => rows(join(root, "hosts.jsonl")).length >= 2, "K1 starter restarts host", 40_000);
    }
    const done = await until(() => journal().find(e => e.type === JT.done), "workflow completion");
    check(done.status === "done", `workflow outcome: ${JSON.stringify(done)}`);
    await until(() => main().some(e => e.customType === CT.attention && e.details.items.some((i: AttentionItem) => i.kind === "finished")), "finished presentation");
    await pi.prompt([{ text: "Refresh resolved attention." }]);
    const entries = journal(), seals = entries.filter(e => e.type === JT.sealed), result = done.result as Record<string, any>;
    check(seals.length === (n === 2 || n === 8 ? 1 : n === 7 ? 2 : 3), `dispatch count / skipped dependents: seals ${JSON.stringify(seals.map(e => [e.call, (e.result as { status?: string })?.status, (e.result as { error?: string })?.error]))}; result ${JSON.stringify(Object.fromEntries(Object.entries(result ?? {}).map(([k, v]) => [k, [v?.status, String(v?.output ?? v?.error ?? "").slice(0, 80)]])))}; journal ${entries.filter(e => !["time", "observation", "usage", "tracked"].includes(e.type)).map(e => `${e.type}${e.reason ? `(${String(e.reason).slice(0, 60)})` : ""}`).join(" ").slice(-1500)}; writer stderr ${JSON.stringify(tailOf(join(callSession(s.home, wid, "writer", 1), "..", "stderr.log")))}; writer session ${child().map(e => e.type === "message" ? `${e.message?.role}/${e.message?.stopReason ?? ""}${e.message?.errorMessage ? `[${e.message.errorMessage}]` : ""}` : e.customType ?? e.type).join(" ").slice(-800)}`);
    const expected = n === 2 ? "timeout" : n === 8 ? "failed" : "ok";
    check(result.writer.status === expected, `writer expected ${expected}: ${JSON.stringify(result.writer)}`);
    if ([2, 8].includes(n)) check(result.reviewer.status === "skipped" && result.integrator.status === "skipped", "dependency skips");
    else {
      check(result.writer.output === "LEAF: writer-ok", "lost results: LEAF");
      check(result.reviewer.output === `REVIEW: ${n === 7 ? "reject" : "accept"}`, "lost results: REVIEW");
      check(n === 7 ? result.integrator.status === "skipped" : result.integrator.output === "INTEGRATE: integrated", "lost results: INTEGRATE");
    }
    if ([1, 3, 8, 9].includes(n)) check(entries.filter(e => e.type === JT.exec).length > seals.length, "fault did not cause continuation");
    if (n === 1) check(child().some(e => e.message?.toolName === "bash" && JSON.stringify(e.message.content).includes("PARTIAL-KEPT")), "partial tool result lost");
    if (n === 2) {
      check(entries.some(e => e.type === "time" && Number(e.active) >= 2200), "silent CPU tracker timeout evidence");
      check(entries.some(e => e.type === "observation" && (e.event as any).type === "tool_execution_start" && (e.event as any).toolName === "bash"), "silent CPU tool must start before timeout");
    }
    if (n === 8) check(entries.filter(e => e.type === "loss").length === 5, "K2 loss bound");
    for (const seal of seals) {
      check(seals.filter(e => e.call === seal.call).length === 1, "duplicate runs: duplicate seal");
      check(!entries.some(e => e.type === JT.exec && e.call === seal.call && e.seq > seal.seq), "duplicate runs: sealed call re-executed");
    }
    for (const [path] of prefixes) {
      const session = rows(path), receipts = session.flatMap(e => e.customType === CT.msg ? [e.details?.rid] :
        [CT.rejected, CT.model, CT.withdrawn].includes(e.customType) ? [e.data?.rid] : e.message?.role === "toolResult" ? [e.message.details?.rid] : []).filter(Boolean);
      check(new Set(receipts).size === receipts.length, `duplicate runs: request receipts ${path}`);
      for (const exec of entries.filter(e => e.type === JT.exec && String(e.call).includes(`/${path.split("/").at(-2)}`)))
        check(session.some(e => e.customType === CT.exec && e.data.exec === exec.exec), `continuation session missing ${exec.exec}`);
    }
    const attention = main().filter(e => e.customType === CT.attention), items = attention.flatMap(e => e.details.items as AttentionItem[]);
    check(new Set(items.map(i => `${i.id}@${i.rev}`)).size === items.length, "AC4 duplicate presentation");
    check(items.filter(i => i.kind === "finished").length === 1, "one finished presentation");
    const questions = [...prefixes.keys()].flatMap(rows).filter(e => e.customType === CT.question).length;
    const observations = rows(join(root, "provider.jsonl"));
    for (const observation of observations.filter(e => e.kind === "response" && e.bytes))
      check(createHash("sha256").update(readFileSync(observation.session).subarray(0, observation.bytes)).digest("hex") === observation.hash, `restarted from scratch: session prefix ${observation.session}`);
    const wakes = rows(join(root, "rpc.jsonl")).filter(e => e.type === "agent_start").length - observations.filter(e => e.kind === "start" && e.prompted).length;
    check(wakes >= 0 && wakes <= 6 + questions && attention.length <= 6 + questions, "AC4 wake bound");
    for (const observation of observations.filter(e => e.kind === "context")) for (const message of observation.messages) {
      for (const item of message.details?.items ?? []) {
        const resolved = entries.some(e => e.type === JT.attentionResolved && e.id === item.id && e.rev === item.rev && e.ts <= observation.at) ||
          (item.session && rows(item.session).some(e => e.message?.toolName === "ask" && e.message.details?.qid === item.qid && e.message.details?.rev === item.rev && Date.parse(e.timestamp) <= observation.at));
        check(!resolved || String(message.content).includes(`(resolved: ${item.text})`), `AC4 stale reminder ${item.id}@${item.rev}`);
      }
    }
    return { scenario: n, passed: true, duplicateRuns: 0, lostResults: 0, restartedFromScratch: 0, wakes, presentations: attention.length, questions, evidence: root };
  } finally { await s.close(); }
}
