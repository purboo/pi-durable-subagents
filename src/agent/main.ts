import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { defineTool, type ExtensionAPI, type ExtensionContext, type CustomMessageEntryDraft } from "@earendil-works/pi-coding-agent";
import { Outbox, scanInbox } from "../kernel/mailbox.ts";
import { readJournalSnapshot } from "../kernel/journal.ts";
import { reduceLifecycle, type DecisionRecord } from "../kernel/lifecycle.ts";
import { OsLock } from "../platform/lock.ts";
import { dsaHome, orchInbox, orchLedger, orchLock, outboxRoot } from "../paths.ts";
import { CT, JT, type AttentionItem, type RunBody } from "../types.ts";
import { attention, presented, resolved, unfinishedWorkflow, workflows } from "./main/snapshots.ts";
import { parameters, request } from "./main/tool.ts";

/** Capabilities the UI (U1) receives from the main agent; every action goes through the same durable outbox. */
export interface UiDeps {
  home: string;
  /** Same semantics as the `subagents` tool (P25, P38); returns its reply value. Actions are journaled with by:"user". */
  submit(args: Record<string, unknown>): Promise<unknown>;
  presentNote(text: string): void;
}

let noteSink: ((text: string) => void) | undefined;
/** P16: Queue a UI note for the next boundary without waking the model. */
export function presentNote(text: string): void { noteSink?.(text); }

/** P1, P15, P16, P25, P38: Register durable submission and serialized main-session presentation. */
export function registerMain(pi: ExtensionAPI, ui?: (pi: ExtensionAPI, deps: UiDeps) => void): void {
  const home = dsaHome();
  let ctx: ExtensionContext | undefined, sender = "", outbox: Outbox | undefined;
  let queue: Promise<unknown> = Promise.resolve(), timer: ReturnType<typeof setInterval> | undefined;
  let reserved: AttentionItem[] = [], notes: string[] = [], stopped = true, lastStarter = 0;
  let polling = false;
  const sink = (text: string) => { notes.push(text); };
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn); queue = result.catch(() => {}); return result;
  }
  function ledger() { return readJournalSnapshot(orchLedger(home)); }
  async function reconcile() {
    const records = ledger().filter(e => [JT.admitted, JT.applied, JT.rejected, JT.withdrawn].includes(e.type as typeof JT.admitted)) as unknown as DecisionRecord[];
    for (const rid of reduceLifecycle(records).resolved.keys()) await outbox?.markResolved(rid);
    for (const entry of ledger()) if (entry.type === JT.created) await outbox?.markResolved(String(entry.rid));
  }
  function pendingOutbox() {
    const pending = new Set<string>();
    for (const entry of readJournalSnapshot(join(outboxRoot(home), "outbox", `${sender}.jsonl`))) {
      if (entry.type === "sent") pending.add((entry.request as { rid: string }).rid);
      else if (entry.type === "resolved") pending.delete(String(entry.rid));
    }
    return pending.size > 0;
  }
  async function starter(submitting = false) {
    if (stopped) return;
    await reconcile();
    const pending = submitting || pendingOutbox() || (await scanInbox(orchInbox(home))).length > 0 || unfinishedWorkflow(home);
    if (!pending) return;
    await mkdir(home, { recursive: true });
    const lock = await new OsLock().tryAcquire(orchLock(home));
    if (!lock) return;
    await lock.release();
    const entry = process.env.DSA_ORCHESTRATOR_ENTRY ?? fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../orchestrator/main.ts" : "../orchestrator/main.js", import.meta.url));
    const child = spawn(process.execPath, [entry], { detached: true, stdio: "ignore", env: { ...process.env, DSA_HOME: home } });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
  }
  function collect() { return ctx ? attention(home, sender, [...presented(ctx), ...reserved]) : []; }
  function message(items: AttentionItem[]): CustomMessageEntryDraft {
    return { type: "custom_message", customType: CT.attention, content: items.map(i => i.text).join("\n"), display: true, details: { items } };
  }
  async function idle() {
    if (stopped || !ctx?.isIdle()) return;
    const items = collect();
    if (!items.length) return;
    // Reserve until pi has appended its receipt; all presentation paths share this queue.
    reserved.push(...items);
    try { pi.sendMessage(message(items), { triggerTurn: true }); }
    catch (error) { reserved = reserved.filter(item => !items.includes(item)); throw error; }
  }
  const boundary = async (_event: unknown, context: ExtensionContext) => serial(async () => {
    if (stopped) return;
    ctx = context;
    const items = collect(), entries: CustomMessageEntryDraft[] = [];
    if (items.length) { entries.push(message(items)); reserved.push(...items); }
    if (notes.length) entries.push({ type: "custom_message", customType: CT.note, content: notes.splice(0).join("\n"), display: true });
    return entries.length ? { entries, ...(items.length ? { continue: true } : {}) } : undefined;
  });
  async function close() {
    stopped = true; clearInterval(timer); timer = undefined;
    await queue; await outbox?.close(); outbox = undefined;
    if (noteSink === sink) noteSink = undefined;
    reserved = []; notes = []; ctx = undefined;
  }
  async function start(context: ExtensionContext) {
    await close(); ctx = context; sender = `main:${context.sessionManager.getSessionId()}`; stopped = false;
    outbox = await Outbox.open(outboxRoot(home), sender, () => orchInbox(home)); noteSink = sink;
    await reconcile(); await outbox.republishPending(); await starter(); lastStarter = Date.now();
    timer = setInterval(() => {
      if (polling || stopped) return;
      polling = true;
      void serial(async () => {
        if (stopped) return;
        if (Date.now() - lastStarter >= 30_000) { lastStarter = Date.now(); await starter(); }
        await idle();
      }).catch(error => console.error("durable-subagents:", error)).finally(() => { polling = false; });
    }, 200);
    timer.unref();
  }
  pi.on("session_start", async (_event, context) => start(context));
  pi.on("session_shutdown", close);
  pi.on("turn_end", boundary); pi.on("agent_before_settle", boundary);
  pi.on("context", async event => ({ messages: event.messages.map(msg => {
    if (msg.role !== "custom" || msg.customType !== CT.attention) return msg;
    const items = (msg.details as { items?: AttentionItem[] } | undefined)?.items;
    if (!items) return msg;
    return { ...msg, content: items.map(item => resolved(home, item) ? `(resolved: ${item.text})` : item.text).join("\n") };
  }) }));
  /** P25, P38: One durable submission path for the tool and the UI. */
  async function submit(args: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<unknown> {
    if (args.action === "status") return workflows(home).sort((a, b) => Number(b.origin === sender) - Number(a.origin === sender));
    const normalized = request(args as Parameters<typeof request>[0], cwd);
    // P33: any call of the run may fork the origin context, so the origin branch is always offered for pinning.
    const sessionFile = ctx?.sessionManager.getSessionFile();
    if (normalized.kind === "run" && sessionFile) (normalized.body as RunBody).origin = { sessionFile, leafId: ctx!.sessionManager.getLeafId() };
    const sent = await serial(async () => {
      if (!outbox || stopped) throw new Error("Main session is not active");
      signal?.throwIfAborted();
      await starter(true);
      if (normalized.replaces?.length) {
        const withdrawn = await outbox.send("orch", "withdraw", { rids: normalized.replaces });
        normalized.cond = { ...normalized.cond, after: withdrawn.rid };
      }
      return outbox.send("orch", normalized.kind, normalized.body, normalized.cond);
    });
    if (sent.kind === "run") {
      const deadline = performance.now() + 10_000;
      while (true) {
        const receipt = ledger().find(e => e.type === JT.created && e.rid === sent.rid);
        if (receipt) { await serial(async () => { await outbox?.markResolved(sent.rid); }); return { wid: receipt.wid }; }
        if (performance.now() >= deadline || signal?.aborted) break;
        await delay(Math.min(100, deadline - performance.now()));
      }
    }
    return { submitted: { rid: sent.rid } };
  }
  ui?.(pi, { home, presentNote, submit: args => submit({ ...args, by: "user" }, ctx?.cwd ?? process.cwd()) });
  pi.registerTool(defineTool({
    name: "subagents", label: "Subagents", description: [
      "Durable subagents: crash-safe, never run twice, survive pi restarts. Always asynchronous: run returns {wid}; you are woken once when it finishes or a subagent asks you something.",
      "run — exactly one of: agent+task (one subagent; optional model 'provider/id[:thinking]', cwd, timeoutMs, schema, gate, isolation:'worktree', context:'fork', budget); tasks:[...] (parallel); chain:[...] ({previous} = previous output); workflow:'./script.js' or source (a script using runs.run(key, spec), runs.all([...]), emit(value), args, runs.input(name); return value = result). Optional: args, name, usageBudget {tokens|costUsd}, maxCalls, inputs {name: path}.",
      "send — to: '<wid>/<key>' or a call id; kind: steer | follow-up | answer (with qid, rev from the question) | model (model:'provider/id[:thinking]'); replaces: [rid] supersedes your earlier send.",
      "status — fresh snapshot of all workflows. stop target:<wid|call>. revise wid + workflow/source/args. resume [wid]. drain.",
    ].join("\n"), parameters,
    async execute(_id, args, signal, _update, context) {
      const value = await submit(args as Record<string, unknown>, context.cwd, signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
    },
  }));
}
