import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
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
import { attention, presentText, presented, resolved, unfinishedWorkflow } from "./main/snapshots.ts";
import { isLive, pausedElsewhere, runningOrchestrator, statusBrief, statusCallDetail, statusCompactDetail, statusDetail, statusView, widOfRid } from "../orchestrator/snapshot.ts";
import { parameters, request, sendReceipt } from "./main/tool.ts";
import { discoverAgents } from "../compat/agents.ts";

/** Capabilities the UI (U1) receives from the main agent; every action goes through the same durable outbox. */
export interface UiDeps {
  home: string;
  /** Same requests as the `subagents` tool (P25, P38), journaled with by:"user"; control actions return {submitted} at once and
   *  the UI learns their resolution from the ledger. */
  submit(args: Record<string, unknown>): Promise<unknown>;
  presentNote(text: string): void;
}

let noteSink: ((text: string) => void) | undefined;
/** P16: Queue a UI note for the next boundary without waking the model. */
export function presentNote(text: string): void { noteSink?.(text); }

/** P1, P15, P16, P25, P38: Register durable submission and serialized main-session presentation. */
/** v12 §6: Agent discovery per cwd, reused for a few seconds (discovery may shell out to `npm root -g`). */
const discovered = new Map<string, { at: number; agents: ReturnType<typeof discoverAgents>["agents"] }>();
function agentsAt(cwd: string) {
  const hit = discovered.get(cwd);
  if (hit && Date.now() - hit.at < 10_000) return hit.agents;
  const agents = discoverAgents(cwd).agents;
  discovered.set(cwd, { at: Date.now(), agents });
  return agents;
}
/** Quit pause: "pause" (default) holds this session's running workflows when pi quits; "continue" lets them run on. */
function quitPolicy(home: string): "pause" | "continue" {
  try { return (JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { onQuit?: string }).onQuit === "continue" ? "continue" : "pause"; }
  catch { return "pause"; }
}
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
  function decisions() {
    return reduceLifecycle(ledger().filter(e => [JT.admitted, JT.applied, JT.rejected, JT.withdrawn].includes(e.type as typeof JT.admitted)) as unknown as DecisionRecord[]).resolved;
  }
  async function reconcile() {
    for (const rid of decisions().keys()) await outbox?.markResolved(rid);
    for (const entry of ledger()) if (entry.type === JT.created) await outbox?.markResolved(String(entry.rid));
  }
  function pendingOutbox() { return pendingRids().size > 0; }
  function pendingRids() {
    const pending = new Set<string>();
    for (const entry of readJournalSnapshot(join(outboxRoot(home), "outbox", `${sender}.jsonl`))) {
      if (entry.type === "sent") pending.add((entry.request as { rid: string }).rid);
      else if (entry.type === "resolved") pending.delete(String(entry.rid));
    }
    return pending;
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
  // Version visibility: say once per orchestrator process when it runs another version than this pi loaded (after an
  // update its running work stays on the old one); status shows the same note.
  let versionTold: string | undefined;
  function tellVersion() {
    const { orchestrator, versionNote } = runningOrchestrator(home);
    if (!versionNote || orchestrator === versionTold || !ctx?.hasUI) return;
    versionTold = orchestrator;
    ctx.ui.notify(`Durable Subagents: ${versionNote}.`, "warning");
  }
  function collect() { return ctx ? attention(home, sender, [...presented(ctx), ...reserved]) : []; }
  function message(items: AttentionItem[]): CustomMessageEntryDraft {
    return { type: "custom_message", customType: CT.attention, content: items.map(presentText).join("\n"), display: true, details: { items } };
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
    try { tellVersion(); } catch (error) { console.error("durable-subagents:", error); }
    timer = setInterval(() => {
      if (polling || stopped) return;
      polling = true;
      void serial(async () => {
        if (stopped) return;
        if (Date.now() - lastStarter >= 30_000) { lastStarter = Date.now(); await starter(); tellVersion(); }
        await idle();
      }).catch(error => console.error("durable-subagents:", error)).finally(() => { polling = false; });
    }, 200);
    timer.unref();
  }
  pi.on("session_start", async (_event, context) => {
    await start(context);
    // Quit pause: say once, at the session's start, which of its workflows wait for a resume.
    const paused = statusView(home, { origin: sender }).workflows.filter(w => w.origin === sender && isLive(w) && w.paused);
    if (paused.length) pi.sendMessage({ customType: CT.note, display: true, content: `${paused.length} subagent workflow${paused.length > 1 ? "s were" : " was"} paused when pi quit (${paused.map(w => w.name ?? w.wid).join(", ")}). Ask to resume, or open /subagents (or ↓) and press r.` });
  });
  // Quitting pi is a stop-burning-tokens moment: on a quit (Ctrl+D, /quit, a closed terminal, SIGTERM) this session's
  // running workflows are held — fenced without sealing, so nothing is lost and `resume` continues them in the same
  // sessions. A crash or SIGKILL runs no handler: then the work keeps running, as durability promises.
  // Switching sessions (/new, /resume, fork) or reloading does not pause. config.json "onQuit": "continue" opts out.
  pi.on("session_shutdown", async event => {
    if (event.reason === "quit" && quitPolicy(home) === "pause" && outbox && !stopped) {
      try {
        const running = statusView(home, { origin: sender }).workflows.some(w => w.origin === sender && isLive(w) && !w.paused);
        if (running) await serial(async () => { await outbox?.send("orch", "drain", { fence: true, origin: sender }); });
      } catch (error) { console.error("durable-subagents: could not pause on quit:", error); }
    }
    await close();
  });
  pi.on("turn_end", boundary); pi.on("agent_before_settle", boundary);
  pi.on("context", async event => ({ messages: event.messages.map(msg => {
    if (msg.role !== "custom" || msg.customType !== CT.attention) return msg;
    const items = (msg.details as { items?: AttentionItem[] } | undefined)?.items;
    if (!items) return msg;
    return { ...msg, content: items.map(item => resolved(home, item) ? `(resolved: ${presentText(item)})` : presentText(item)).join("\n") };
  }) }));
  /** P25, P38, T6, T10: One durable submission path for the tool and the UI; replies say what happened when known within 10 s. */
  /** v12 §2, §6: An answer finds its open question (qid, rev and target) from whatever the caller gave; a send without a
   *  target names the addresses that would work. */
  function completeSend(args: Record<string, unknown>): Record<string, unknown> {
    const own = statusView(home, { origin: sender }).workflows;
    const short = (call: string) => call.replace(/@\d+\/([^@/]+)@\d+$/, "/$1");
    if (args.kind === "answer" && !(typeof args.to === "string" && args.qid !== undefined && args.rev !== undefined)) {
      const open = own.flatMap(w => w.attention.filter(a => a.kind === "question" && a.call && a.qid));
      const to = typeof args.to === "string" ? args.to : undefined;
      const match = open.filter(a => args.qid !== undefined ? a.qid === args.qid : to ? a.call === to || short(a.call!) === to || a.call!.startsWith(`${to}@`) : true);
      if (match.length !== 1) throw new Error(match.length ? `Several questions are open; give qid: ${match.map(a => `${short(a.call!)} qid=${a.qid}`).join(", ")}` :
        `No open question matches${open.length ? `; open: ${open.map(a => `${short(a.call!)} qid=${a.qid} rev=${a.rev}`).join(", ")}` : " (none is open)"}`);
      const q = match[0]!;
      return { ...args, to: to ?? q.call, qid: q.qid, rev: args.rev ?? q.rev };
    }
    if (typeof args.to !== "string" || !args.to) {
      const want = args.kind === "follow-up" ? (c: { phase: string }) => c.phase === "sealed" : (c: { phase: string }) => c.phase !== "sealed";
      const targets = own.flatMap(w => w.calls.filter(want).map(c => `${w.wid}/${c.key}`));
      throw new Error(`to is required: '<wid>/<key>'${targets.length ? `; ${args.kind === "follow-up" ? "finished" : "running"}: ${targets.slice(0, 12).join(", ")}` : ""}`);
    }
    return args;
  }
  /** "<rid>" or "<rid>/<key>" of a created run → the same address with its wid; anything else is unchanged. */
  function ridToWid(value: string): string { return widOfRid(ledger(), value); }
  /** A run request without a workflow yet (still pending, or rejected), asked about by its rid. */
  function pendingRun(rid: string): unknown {
    const decision = decisions().get(rid);
    if (decision?.type === "rejected") throw new Error(`${rid} is a run request that was rejected: ${decision.reason}`);
    if (pendingRids().has(rid)) return { submitted: { rid }, state: "pending: no workflow yet; its wid arrives with the next notice" };
    return undefined;
  }
  /** A session's resume found nothing of its own: name the workflows other sessions hold, which need resume wid=<wid>. */
  function resumeElsewhere(reason: string): string {
    if (reason !== "nothing-to-resume") return reason;
    const others = pausedElsewhere(home, sender);
    return others.length ? `nothing-to-resume: nothing of this session is paused; paused in other sessions: ${others.slice(0, 8).join(", ")} — resume wid=<wid> continues one` : reason;
  }
  async function submit(args: Record<string, unknown>, cwd: string, signal?: AbortSignal, wait = true): Promise<unknown> {
    // A run answers {submitted:{rid}} when its workflow is not created within 10 s; that rid then stands for the wid.
    for (const field of ["wid", "to", "target"]) if (typeof args[field] === "string") args = { ...args, [field]: ridToWid(args[field] as string) };
    if (args.action === "status") {
      if (typeof args.wid !== "string" || !args.wid) return statusBrief(home, { origin: sender });
      const pending = pendingRun(args.wid);
      if (pending) return pending;
      if (typeof args.key === "string" && args.key) return statusCallDetail(home, args.wid, args.key);
      return args.full === true ? statusDetail(home, args.wid) : statusCompactDetail(home, args.wid);
    }
    if (args.action === "agents") return agentsAt(cwd).map(({ name, description, model, source }) =>
      ({ name, description, ...(model === undefined ? {} : { model }), source }));
    // A send addressed like a stop (target:) means the same call; the field name is not worth a failed round trip.
    if (args.action === "send" && args.to === undefined && typeof args.target === "string") { const { target, ...rest } = args; args = { ...rest, to: target }; }
    if (args.action === "send") args = completeSend(args);
    // A session resumes its own held work (what its quit paused); the CLI `resume` remains the global one.
    if (args.action === "resume" && args.wid === undefined) args = { ...args, origin: sender };
    const normalized = request(args as Parameters<typeof request>[0], cwd);
    if (normalized.kind === "run") {
      const body = normalized.body as RunBody;
      // v12 §2: Reject unknown explicit call agents before starter or outbox publication; scripts remain call-local.
      const names = [...(body.call ? [body.call] : []), ...(body.tasks ?? []), ...(body.chain ?? [])].map(call => call.agent);
      if (names.length) {
        const available = agentsAt(cwd).map(agent => agent.name);
        const unknown = [...new Set(names.filter(name => !available.includes(name)))];
        if (unknown.length) throw new Error(`Unknown agent${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Available agents: ${available.join(", ") || "(none)"}`);
      }
    }
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
    // P25: run waits for `created`; control requests wait for their terminal lifecycle record (applied or rejected+reason).
    const deadline = performance.now() + 10_000;
    while (wait || sent.kind === "run") {
      const receipt = sent.kind === "run" ? ledger().find(e => e.type === JT.created && e.rid === sent.rid) : undefined;
      const decision = receipt ? undefined : decisions().get(sent.rid);
      if (receipt || decision) {
        await serial(async () => { await outbox?.markResolved(sent.rid); });
        if (receipt) return { wid: receipt.wid };
        // The rid is returned so a later send can supersede this one (replaces: [rid]).
        if (decision!.type === "rejected") return { applied: false, reason: sent.kind === "resume" && args.wid === undefined ? resumeElsewhere(String(decision!.reason)) : decision!.reason, rid: sent.rid };
        if (sent.kind !== "run") {
          return { applied: true, rid: sent.rid, ...sendReceipt(ledger(), sent.rid) };
        }
      }
      if (performance.now() >= deadline || signal?.aborted) break;
      await delay(Math.min(100, deadline - performance.now()));
    }
    return { submitted: { rid: sent.rid } };
  }
  ui?.(pi, { home, presentNote, submit: args => submit({ ...args, by: "user" }, ctx?.cwd ?? process.cwd(), undefined, false) });
  // The model must name a real agent; list the ones this project can use (names are checked again per run).
  let agents = "";
  try {
    agents = discoverAgents(process.cwd()).agents.map(a => `${a.name} (${a.description.split(/[.\n]/)[0]!.trim().slice(0, 80)})`).join("; ");
  } catch { /* Discovery problems surface when a run is pinned. */ }
  pi.registerTool(defineTool({
    name: "subagents", label: "Subagents", description: [
      "Durable asynchronous subagents; run returns {wid} when created (or {submitted:{rid}} while pending). A finished workflow (its notice carries every agent's result) or a question wakes you, so after starting work end your turn: never poll with sleep or repeated status. Crash recovery resumes sessions, not external side effects. Background helper processes (orchestrator, evaluator) exit by themselves about 10 s after all work ends: never kill processes or delete files to 'clean up'. When the user quits pi, this session's running workflows pause (nothing is spent); resume continues them.",
      "run (action optional for exactly one launch form): agent+task; tasks:[call specs] parallel; chain:[call specs] sequential ({previous}); workflow:'./script.js' or source (runs.run(key,spec), runs.all([...]), emit(value), args, runs.input(name)). Optional name, cwd, usageBudget, maxCalls, inputs. With tasks/chain, top-level model, timeoutMs, budget, isolation, context, tools, skills, once are defaults for every step (a step's own value wins); a workflow/source script sets them per runs.run call. timeoutMs is milliseconds of active time (a number); omit it unless a hard limit is needed. Explicit unknown agents are rejected BEFORE creation, with available names; unknown script agents fail only their call.",
      "agents: list names, descriptions, default models and source for this cwd; use these names for run.",
      "send to:'<wid>/<key>' (bare '<wid>' only for a single-call workflow): steer on a running call delivers at the next safe point (receipt in status/UI); a steer to a call waiting on its question interrupts the question and the subagent usually asks again — use answer to answer it; sealed → finished:<status> — use kind 'follow-up'. follow-up continues a sealed call as generation g+1 or queues after a running turn; follow-up model:'provider/id' or a pool name runs that generation on it. answer: give the qid (or just the call, or nothing when one question is open); to and rev are filled in. A question that needs the user's decision goes to the user; if you answer one yourself, tell the user what you chose. model ('provider/id' or a pool name — its first model not used up): a running call switches at its next provider request; an asking, hibernated or queued call launches on it when it runs again; the reply's model/effect (next-request|next-execution|next-generation) says which. status model = model actually used by the last request; switching = requested, not used yet; switchFailed = refused. A provider content refusal (ToS/usage policy) fails the call at once, not retried. Unknown targets list valid addresses. replaces:[rid] supersedes an earlier send.",
      "stop target:<wid|<wid>/<key>> is terminal stopped (usage and partial edits kept); a sealed call → already-sealed:<status>, a finished workflow → terminal:<status>. drain holds existing workflows reversibly (new runs unaffected); resume [wid] releases held workflows. status: without wid, what runs, asks (with its answer address; hibernated:true holds no slot) or failed, sharedWorktree names calls sharing observed edit/write roots (reminder only), finished workflows one line each, provider slots held/limit, the config in effect and providers whose usage window is used up (avoided until a probe finds them answering again), and the orchestrator version (versionNote when it differs from the loaded one); wid: one workflow, outputs clipped; wid+key: one call's full result; full:true: everything. A run's rid from {submitted:{rid}} works wherever a wid is expected. revise wid + workflow/source/args starts a revision.",
      "Control replies are {applied:true,rid} or {applied:false,reason,rid} when decided; otherwise {submitted:{rid}} after 10s.",
      ...(agents ? [`Available agents: ${agents}.`] : []),
      "User sees a summary line above the editor; ↓ on an empty editor (or /subagents) opens the list, Enter watches live OR finished calls (finished transcripts remain on disk) and expands finished workflows. List keys: s steer (paste-capable input), x stop (confirm y), m model, a answer when asked, f follow-up on finished calls; action feedback appears in footer.",
    ].join("\n"), parameters,
    async execute(_id, args, signal, _update, context) {
      const value = await submit(args as Record<string, unknown>, context.cwd, signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
    },
  }));
}
