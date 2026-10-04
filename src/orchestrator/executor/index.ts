// Private journal entries (A1): tracked{exec,pid,start}; loss{exec}; settled{exec};
// stop-intent{call}; forward{rid,rid2,dest,hash,envelope:{to,kind,body,cond?}};
// observation{exec,event}; selected{exec,model}; switch-observed{exec,rid,pool}.
// The orchestrator ledger owns
// hold/release{pool,slot,exec}. All transitions are serialized before publication.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CT, JT, type CallResult, type Entry, type JournalHandle, type ProcInfo, type Request, type SendBody, type Spawned, type WithdrawBody } from "../../types.ts";
import { callDir, callInbox, callSession, outboxRoot } from "../../paths.ts";
import { Outbox } from "../../kernel/mailbox.ts";
import { contentHash, forwardRid } from "../../kernel/ids.ts";
import { capacity, seal } from "../../kernel/guards.ts";
import { Containment } from "../../platform/containment.ts";
import { buildPiArgs } from "../../compat/pi-args.ts";
import { parseModel, resolveModel, type Model } from "../../compat/model.ts";
import { buildCallResult } from "../../compat/result.ts";
import type { CallTicket, Executor, Ledgers } from "../contract.ts";
import { evidence, readSession, sessionModel, type SessionEntry } from "./session.ts";
import { activeTotal } from "./time.ts";
import { observeExecution } from "./observe.ts";
import { availableMemory } from "./memory.ts";
import { reached, sessionUsage, totalUsage, type Usage } from "./usage.ts";
import { skipLostCandidate, sweepExecutions } from "./sweep.ts";

type Envelope = Pick<Request, "to" | "kind" | "body" | "cond">;
type Active = { ticket: CallTicket; promise: Promise<CallResult>; wake: () => void; stopped: boolean; retired?: boolean; suspended?: boolean };
const shutdownError = () => Object.assign(new Error("executor shutdown; call resumes on recovery"), { name: "ExecutorShutdown" });
const extension = fileURLToPath(new URL(`../../agent/extension.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url));
const entriesFor = (journal: JournalHandle, call: string) => journal.entries().filter(e => e.call === call);
const current = (journal: JournalHandle, call: string) => entriesFor(journal, call).findLast(e => e.type === JT.exec)?.exec as string | undefined;
const sealed = (journal: JournalHandle, call: string) => entriesFor(journal, call).find(e => e.type === JT.sealed)?.result as CallResult | undefined;
const has = (journal: JournalHandle, type: string, exec: string) => journal.entries().some(e => e.type === type && e.exec === exec);
function address(call: string) {
  const match = /^(.*)@(\d+)\/(.*)@(\d+)$/.exec(call);
  if (!match) throw new Error(`Invalid call identity: ${call}`);
  return { wid: match[1]!, key: match[3]!, gen: Number(match[4]) };
}

async function defaultModel(): Promise<string | undefined> {
  const path = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");
  const settings = JSON.parse(await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return "{}"; throw error; })) as { defaultProvider?: string; defaultModel?: string };
  return settings.defaultModel ? `${settings.defaultProvider ? `${settings.defaultProvider}/` : ""}${settings.defaultModel}` : undefined;
}

/** P2, P9, P22: Construct the journal-owned execution authority under the engine's OS lock. */
export default function createExecutor(ledgers: Ledgers, options: { memory?: () => Promise<number>; sweepMs?: number } = {}): Executor {
  const { home, config, orch } = ledgers;
  const containment = new Containment();
  const active = new Map<string, Active>(), completed = new Map<string, Promise<CallResult>>(), journals = new Map<string, JournalHandle>();
  let queue: Promise<unknown> = Promise.resolve(), closed = false;
  let suspending: Promise<void> | undefined;
  let sweeping: Promise<void> | undefined, sweepFailure: unknown;
  const sweepTimer = setInterval(() => {
    if (!sweeping) sweeping = sweepExecutions(journals.values(), containment).catch(error => { sweepFailure = error; }).finally(() => { sweeping = undefined; });
  }, options.sweepMs ?? 30000);
  sweepTimer.unref();
  const waiters = new Set<() => void>();
  const inbox = (call: string) => { const a = address(call); return callInbox(home, a.wid, a.key, a.gen); };
  const outbox = Outbox.open(outboxRoot(home), "orch", inbox);
  // Serial sections contain durable transitions, never slot waits, process waits or fences.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn); queue = next.catch(() => {}); return next;
  };
  const wake = () => { for (const fn of waiters) fn(); waiters.clear(); };
  const holdings = () => {
    const held = new Map<string, Entry>();
    for (const e of orch.entries()) {
      const id = `${e.pool}:${e.slot}`;
      if (e.type === "hold") held.set(id, e);
      if (e.type === "release" && held.get(id)?.exec === e.exec) held.delete(id);
    }
    return [...held.values()];
  };
  async function release(exec: string) {
    await serial(async () => { for (const h of holdings().filter(e => e.exec === exec)) await orch.append("release", { pool: h.pool, slot: h.slot, exec }); });
    wake();
  }
  function tracked(journal: JournalHandle, exec: string): ProcInfo[] {
    return journal.entries().filter(e => e.type === "tracked" && e.exec === exec).map(e => ({ pid: Number(e.pid), ppid: 0, start: String(e.start) }));
  }
  async function track(journal: JournalHandle, exec: string, found?: ProcInfo[]) {
    const known = tracked(journal, exec);
    found ??= (await containment.scan(new Map([[exec, known]]))).get(exec) ?? [];
    await serial(async () => {
      const ids = new Set(tracked(journal, exec).map(p => `${p.pid}:${p.start}`));
      for (const p of found) if (p.start && !ids.has(`${p.pid}:${p.start}`)) {
        await journal.append("tracked", { exec, pid: p.pid, start: p.start }); ids.add(`${p.pid}:${p.start}`);
      }
    });
    return found;
  }
  async function fence(journal: JournalHandle, exec: string, child?: Spawned) {
    child?.stdin.end();
    if (!has(journal, JT.fenced, exec)) {
      await containment.fence(exec, tracked(journal, exec));
      await serial(async () => { if (!has(journal, JT.fenced, exec)) await journal.append(JT.fenced, { exec }); });
    }
  }
  async function retireForwards(journal: JournalHandle, call: string) {
    const a = address(call), entries = await readSession(callSession(home, a.wid, a.key, a.gen));
    const receipts = new Set(entries.flatMap(e => {
      const rid = e.message?.details?.rid ?? ([CT.rejected, CT.withdrawn, CT.model].includes(e.customType as typeof CT.rejected) ? e.data?.rid : undefined);
      return typeof rid === "string" ? [rid] : [];
    }));
    for (const e of journal.entries().filter(e => e.type === "forward" && e.dest === call)) {
      if (!receipts.has(String(e.rid2)) && !journal.entries().some(r => r.type === "forward-retired" && r.rid2 === e.rid2))
        await journal.append("forward-retired", { rid: e.rid, rid2: e.rid2, reason: "retired-without-child-receipt" });
      await (await outbox).markResolved(String(e.rid2));
    }
  }
  async function recordUsage(t: CallTicket, values: { id: string; usage: Usage }[]) {
    await serial(async () => {
      for (const u of values) if (!t.journal.entries().some(e => e.type === "usage" && e.call === t.callId && e.id === u.id)) await t.journal.append("usage", { call: t.callId, ...u });
      await workflowReached(t);
    });
  }
  async function workflowReached(t: CallTicket) {
    const hit = reached(totalUsage(t.journal.entries()), t.workflowBudget), id = `budget:${t.wid}`;
    if (hit && !t.journal.entries().some(e => e.type === JT.attention && (e.item as { id: string }).id === id))
      await t.journal.append(JT.attention, { item: { id, rev: 1, kind: "budget", text: "Workflow budget reached", wid: t.wid } });
    return hit;
  }
  async function retireAttention(journal: JournalHandle, call: string) {
    for (const e of journal.entries().filter(e => e.type === JT.attention)) {
      const item = e.item as { id: string; rev: number; call?: string };
      if (item.call === call && !journal.entries().some(r => r.type === JT.attentionResolved && r.id === item.id && r.rev === item.rev))
        await journal.append(JT.attentionResolved, { id: item.id, rev: item.rev, resolution: "retired" });
    }
  }
  async function finish(journal: JournalHandle, call: string, exec: string, result: CallResult) {
    const value = await serial(async () => {
      const old = sealed(journal, call);
      if (old) return old;
      if (!seal({ sealed: false, exec: current(journal, call) ?? "" }, { exec })) throw new Error(`Stale seal: ${exec}`);
      if (!has(journal, JT.fenced, exec)) throw new Error(`Unfenced seal: ${exec}`);
      if (closed || active.get(call)?.suspended || journal.entries().some(e => e.type === "retired" && e.call === call)) throw shutdownError();
      if (entriesFor(journal, call).some(e => e.type === "stop-intent")) result = buildCallResult({ key: result.key, gen: result.gen, status: "stopped", output: "" });
      result = { ...result, usage: totalUsage(journal.entries(), call) };
      await journal.append(JT.sealed, { call, exec, result });
      await retireForwards(journal, call);
      const selected = journal.entries().find(e => e.type === "selected" && e.exec === exec);
      if (selected?.pool && result.status === "ok") await orch.append("candidate-success", { pool: selected.pool, model: `${(selected.model as Model).provider}/${(selected.model as Model).id}`, exec });
      await retireAttention(journal, call);
      return result;
    });
    await release(exec); return value;
  }
  const stopped = (a: Active) => a.stopped || entriesFor(a.ticket.journal, a.ticket.callId).some(e => e.type === "stop-intent");
  const interrupted = (a: Active) => closed || a.suspended || a.retired || stopped(a);
  async function acquire(a: Active, exec: string, models: Model[], pool?: string): Promise<Model | undefined> {
    for (;;) {
      let signal!: () => void;
      const changed = new Promise<void>(resolve => { signal = resolve; waiters.add(resolve); });
      const chosen = await serial(async () => {
        if (interrupted(a) || await workflowReached(a.ticket)) return;
        if (sweepFailure) throw sweepFailure;
        for (const model of models) {
          if (pool && orch.entries().some(e => e.type === "skip" && e.pool === pool && e.model === `${model.provider}/${model.id}` && Number(e.until) > Date.now())) continue;
          const provider = model.provider;
          const holders = holdings().filter(e => e.pool === provider);
          const limit = config.providers?.[provider ?? ""]?.slots ?? Infinity;
          if (!capacity({ kind: "provider", holders: holders.length, capacity: limit })) continue;
          const available = await (options.memory ?? availableMemory)();
          await orch.append("mem", { available });
          if (!capacity({ kind: "memory", available, reserve: config.memory?.reserveMb ?? 2048, perChild: config.memory?.perChildMb ?? 300 })) return;
          const memory = holdings().filter(e => e.pool === "memory");
          let memorySlot = 0; while (memory.some(e => e.slot === memorySlot)) memorySlot++;
          await orch.append("hold", { pool: "memory", slot: memorySlot, exec });
          if (provider) {
            let slot = 0; while (holders.some(e => e.slot === slot)) slot++;
            await orch.append("hold", { pool: provider, slot, exec });
          }
          await a.ticket.journal.append("selected", { exec, model, ...(pool ? { pool } : {}) });
          return model;
        }
      });
      if (chosen || interrupted(a) || reached(totalUsage(a.ticket.journal.entries()), a.ticket.workflowBudget)) { waiters.delete(signal); return chosen; }
      const timer = setTimeout(signal, config.k?.trackerMs ?? 1000);
      try { await changed; } finally { clearTimeout(timer); waiters.delete(signal); }
    }
  }
  async function questions(t: CallTicket, entries: SessionEntry[]) {
    const sender = await outbox;
    for (const entry of entries) {
      const receipt = entry.message?.details?.rid ?? ([CT.rejected, CT.withdrawn, CT.model].includes(entry.customType as typeof CT.rejected) ? entry.data?.rid : undefined);
      if (typeof receipt === "string") await sender.markResolved(receipt);
    }
    await serial(async () => {
      for (const e of entries) {
        if (e.type !== "custom" || e.customType !== CT.question || !e.data) continue;
        const { qid, rev, question } = e.data;
        if (typeof qid !== "string" || typeof rev !== "number") continue;
        const id = `q:${t.callId}:${qid}`;
        if (!t.journal.entries().some(r => r.type === JT.attention && (r.item as { id: string; rev: number }).id === id && (r.item as { rev: number }).rev === rev))
          await t.journal.append(JT.attention, { item: { id, rev, kind: "question", text: String(question), wid: t.wid, call: t.callId, qid, session: callSession(home, t.wid, t.key, t.gen) } });
        const answered = entries.some(r => r.message?.role === "toolResult" && r.message.details?.qid === qid && r.message.details?.rev === rev && typeof r.message.details?.rid === "string");
        if (answered && !t.journal.entries().some(r => r.type === JT.attentionResolved && r.id === id && r.rev === rev))
          await t.journal.append(JT.attentionResolved, { id, rev, resolution: "answered" });
      }
    });
  }
  async function switched(exec: string, event: Record<string, unknown>) {
    const provider = (event.message as { provider?: string } | undefined)?.provider;
    if (!provider) return;
    await serial(async () => {
      const target = holdings().find(h => h.exec === exec && h.pool === provider && h.reserved);
      if (!target) return;
      if (!orch.entries().some(e => e.type === "switch-observed" && e.exec === exec && e.rid === target.rid)) {
        await orch.append("switch-observed", { exec, rid: target.rid, pool: provider });
        for (const h of holdings().filter(h => h.exec === exec && h.pool !== provider && h.pool !== "memory")) await orch.append("release", { pool: h.pool, slot: h.slot, exec });
      }
    });
    wake();
  }
  function pendingSwitch(exec: string) {
    return holdings().find(h => h.exec === exec && h.reserved && !orch.entries().some(e => e.type === "switch-observed" && e.exec === exec && e.rid === h.rid));
  }
  async function execute(a: Active): Promise<CallResult> {
    const t = a.ticket, journal = t.journal;
    const session = callSession(home, t.wid, t.key, t.gen), dir = callDir(home, t.wid, t.key, t.gen);
    const makeResult = (status: CallResult["status"], output = "", error?: string) => buildCallResult({ key: t.key, gen: t.gen, status, output, ...(error ? { error } : {}) });
    for (;;) {
      const old = sealed(journal, t.callId); if (old) return old;
      if (closed || a.suspended || a.retired || journal.entries().some(e => e.type === "retired" && e.call === t.callId)) throw shutdownError();
      let exec = current(journal, t.callId);
      let entries = await readSession(session);
      let dangling: string[] = [];
      if (exec) {
        await fence(journal, exec);
        await questions(t, entries = await readSession(session));
        await recordUsage(t, sessionUsage(entries));
        const ev = evidence(entries, exec); dangling = ev.dangling;
        if (closed || a.suspended || a.retired) throw shutdownError();
        if (stopped(a)) return finish(journal, t.callId, exec, makeResult("stopped"));
        if (has(journal, "timeout-intent", exec) || t.spec.timeoutMs !== undefined && activeTotal(journal.entries(), t.callId) >= t.spec.timeoutMs)
          return finish(journal, t.callId, exec, makeResult("timeout"));
        if (ev.budget || reached(totalUsage(journal.entries(), t.callId), t.spec.budget)) return finish(journal, t.callId, exec, makeResult("budget"));
        if (ev.report) return finish(journal, t.callId, exec, buildCallResult({ key: t.key, gen: t.gen, status: ev.report.outcome as "ok" | "failed", output: ev.text, usage: ev.usage,
          ...(Object.hasOwn(ev.report, "data") ? { report: { data: ev.report.data } } : {}), ...(Array.isArray(ev.report.artifacts) ? { artifacts: ev.report.artifacts as string[] } : {}) }));
        if (t.spec.schema === undefined && has(journal, "settled", exec) && ev.text)
          return finish(journal, t.callId, exec, { ...makeResult("ok", ev.text), usage: ev.usage });
        if (t.spec.once && dangling.length) return finish(journal, t.callId, exec, makeResult("unknown", "", `Unknown tool outcomes: ${dangling.join(", ")}`));
        await serial(async () => {
          if (!has(journal, "loss", exec!)) await journal.append("loss", { exec });
          await skipLostCandidate(journal, orch, exec!);
        });
        const losses = journal.entries().filter(e => e.type === "loss" && String(e.exec).startsWith(`${t.callId}#`)).length;
        if (losses >= (config.k?.lossBound ?? 5)) return finish(journal, t.callId, exec, makeResult("failed", "", `lost ×${losses}`));
        await release(exec);
      }
      const previous = exec;
      const epoch = previous ? Number(previous.split(".").at(-1)) + 1 : 1;
      exec = `${t.callId}#1.${epoch}`;
      await serial(() => journal.append(JT.exec, { exec, call: t.callId }));
      if (interrupted(a)) { await fence(journal, exec); return finish(journal, t.callId, exec, makeResult("stopped")); }
      if (await serial(() => workflowReached(t))) { await fence(journal, exec); return finish(journal, t.callId, exec, makeResult("failed", "", "workflow budget reached")); }
      let candidates: Model[], pool: string | undefined;
      try {
        const restored = previous && sessionModel(entries);
        const raw = t.spec.model ?? t.agent.model ?? config.defaultModel ?? await defaultModel();
        pool = raw && config.pools?.[raw] ? raw : undefined;
        // C5 restores the current candidate; K7 may choose a new candidate after repeated loss.
        candidates = pool ? resolveModel(raw!, config.pools) : restored ? [restored] : raw ? resolveModel(raw, config.pools) : [{ id: "" }];
      } catch (error) {
        await fence(journal, exec); return finish(journal, t.callId, exec, makeResult("failed", "", String(error)));
      }
      const model = await acquire(a, exec, candidates, pool);
      if (!model || interrupted(a)) {
        await fence(journal, exec);
        return finish(journal, t.callId, exec, !interrupted(a) ? makeResult("failed", "", "workflow budget reached") : makeResult("stopped"));
      }
      await mkdir(dir, { recursive: true });
      const prompt = join(dir, "system.txt"), schema = join(dir, "schema.json");
      // These are derived launch inputs, reconstructed from the pinned ticket after a crash.
      await writeFile(prompt, t.agent.body);
      if (t.spec.schema !== undefined) await writeFile(schema, JSON.stringify(t.spec.schema));
      const sender = await outbox;
      if (previous && pool) {
        const restored = sessionModel(entries);
        if (restored && (restored.provider !== model.provider || restored.id !== model.id))
          await sender.send(t.callId, "model", { provider: model.provider, model: model.id }, undefined, { rid: contentHash([exec, "pool-switch"]) });
      }
      await sender.send(t.callId, previous ? "continue" : "task", { message: previous ? `Continue the task. Tool calls whose outcomes are unknown: ${dangling.join(", ") || "none"}.` : t.spec.task }, undefined, { rid: contentHash([exec, "dispatch"]) });
      if (interrupted(a)) { await fence(journal, exec); return finish(journal, t.callId, exec, makeResult("stopped")); }
      let child: Spawned;
      try {
        child = await containment.spawn({ exec, command: "pi", args: [...buildPiArgs(t.agent, t.spec, { sessionPath: session, systemPromptPath: prompt, continuation: !!previous, controlTools: t.spec.schema === undefined ? ["ask"] : ["ask", "report"], ...(model.id ? { model } : {}) }), "-e", extension], cwd: t.cwd,
          env: { DSA_HOME: home, DSA_EXEC: exec, DSA_CALL: t.callId, DSA_INBOX: inbox(t.callId), DSA_JOURNAL: journal.path, ...(t.spec.schema !== undefined ? { DSA_SCHEMA: schema } : {}), ...(t.spec.budget ? { DSA_BUDGET: JSON.stringify(t.spec.budget) } : {}) } });
      } catch (error) {
        await fence(journal, exec); return finish(journal, t.callId, exec, makeResult("failed", "", `Spawn failed: ${String(error)}`));
      }
      try {
        await track(journal, exec, [{ pid: child.pid, start: child.start, ppid: process.pid }]);
        await observeExecution({ home, config, ticket: t, exec, child, serial,
          setWake: fn => { a.wake = fn; }, interrupted: () => !!interrupted(a),
          track: () => track(journal, exec!), fence: () => fence(journal, exec!, child),
          questions: entries => questions(t, entries), recordUsage: values => recordUsage(t, values),
          switched: event => switched(exec!, event), pendingSwitch: () => pendingSwitch(exec!),
        });
      } finally { await fence(journal, exec, child); }
    }
  }
  async function replayForward(e: Entry) {
    const envelope = e.envelope as Envelope;
    await (await outbox).send(envelope.to, envelope.kind, envelope.body, envelope.cond, { rid: String(e.rid2) });
  }
  return {
    run(ticket) {
      const existing = completed.get(ticket.callId); if (existing) return existing;
      if (closed || suspending) return Promise.reject(shutdownError());
      journals.set(ticket.wid, ticket.journal);
      const a: Active = { ticket, stopped: false, wake: () => {}, promise: undefined! };
      active.set(ticket.callId, a);
      a.promise = execute(a).catch(error => {
        completed.delete(ticket.callId);
        if (a.retired || ticket.journal.entries().some(e => e.type === "retired" && e.call === ticket.callId)) return buildCallResult({ key: ticket.key, gen: ticket.gen, status: "stopped", output: "", error: "retired" });
        throw error;
      }).finally(async () => {
        const exec = current(ticket.journal, ticket.callId);
        try { if (exec) { await fence(ticket.journal, exec); await release(exec); } }
        finally { active.delete(ticket.callId); wake(); }
      });
      // Shutdown rejection is still delivered to callers, without an unhandled rejection during teardown.
      void a.promise.catch(() => {});
      completed.set(ticket.callId, a.promise);
      return a.promise;
    },
    async forward(req, ctx) {
      return serial(async () => {
        const dest = `${ctx.widRev}/${ctx.key}@${ctx.gen}`, hash = contentHash(req);
        journals.set(address(dest).wid, ctx.journal);
        if (ctx.journal.entries().some(e => e.type === "retired" && e.call === dest)) return { action: "reject", reason: "stale-revision" } as const;
        const prior = ctx.journal.entries().find(e => e.type === "forward" && e.rid === req.rid && e.dest === dest);
        if (prior) {
          if (prior.hash !== hash) return { action: "reject", reason: "identity-conflict" } as const;
          if (!ctx.journal.entries().some(e => e.type === "forward-retired" && e.rid2 === prior.rid2)) await replayForward(prior);
          return { action: "apply" } as const;
        }
        if (sealed(ctx.journal, dest)) return { action: "reject", reason: "call-sealed" } as const;
        let kind: Request["kind"], body: unknown;
        if (req.kind === "withdraw") {
          kind = "withdraw";
          const targets = (req.body as WithdrawBody).rids;
          body = { rids: ctx.journal.entries().filter(e => e.type === "forward" && e.dest === dest && targets.includes(String(e.rid))).map(e => String(e.rid2)) };
        } else if (req.kind === "send") {
          const send = req.body as SendBody; kind = send.kind;
          if (kind === "model") {
            try { const m = parseModel(send.model ?? ""); if (!m.provider) throw new Error("Missing provider"); body = { provider: m.provider, model: m.id, ...(m.thinking ? { thinking: m.thinking } : {}) }; }
            catch { return { action: "reject", reason: "unknown-model" } as const; }
          } else body = { message: send.message ?? "" };
        } else return { action: "reject", reason: "unsupported" } as const;
        const cond = { ...req.cond }; delete cond.epoch;
        if (cond.after) {
          const dependency = ctx.journal.entries().find(e => e.type === "forward" && e.dest === dest && e.rid === cond.after);
          if (dependency) cond.after = String(dependency.rid2); else delete cond.after;
        }
        const envelope: Envelope = { to: dest, kind, body, ...(Object.keys(cond).length ? { cond } : {}) };
        const rid2 = forwardRid(req.rid, ctx.widRev, ctx.key, hash);
        if (kind === "model") {
          const exec = current(ctx.journal, dest), provider = (body as { provider: string }).provider;
          if (!exec || has(ctx.journal, JT.fenced, exec) || !has(ctx.journal, "tracked", exec)) return { action: "reject", reason: "call-not-running" } as const;
          if (pendingSwitch(exec)) return { action: "reject", reason: "switch-pending" } as const;
          const held = holdings().filter(h => h.exec === exec);
          if (!held.some(h => h.pool === provider)) {
            const target = holdings().filter(h => h.pool === provider);
            if (!capacity({ kind: "provider", holders: target.length, capacity: config.providers?.[provider]?.slots ?? Infinity }))
              return { action: "reject", reason: "provider-full" } as const;
            let slot = 0; while (target.some(h => h.slot === slot)) slot++;
            await orch.append("hold", { pool: provider, slot, exec, reserved: true, rid: req.rid });
          }
        }
        const entry = await ctx.journal.append("forward", { rid: req.rid, rid2, dest, hash, envelope });
        await replayForward(entry);
        if (kind === "withdraw") {
          const exec = current(ctx.journal, dest), reservation = exec && pendingSwitch(exec);
          if (reservation && (req.body as WithdrawBody).rids.includes(String(reservation.rid))) active.get(dest)?.wake();
        }
        return { action: "apply" } as const;
      });
    },
    async stop(target) {
      const journal = journals.get(target.wid); if (!journal) return;
      const calls = new Set(journal.entries().filter(e => e.type === JT.exec && (!target.callId || e.call === target.callId)).map(e => String(e.call)));
      for (const a of active.values()) if (a.ticket.wid === target.wid && (!target.callId || a.ticket.callId === target.callId)) calls.add(a.ticket.callId);
      for (const call of calls) { const a = active.get(call); if (a) a.stopped = true; }
      await serial(async () => {
        for (const call of calls) if (!sealed(journal, call) && !entriesFor(journal, call).some(e => e.type === "stop-intent")) await journal.append("stop-intent", { call });
      });
      for (const call of calls) active.get(call)?.wake();
      wake();
      for (const call of calls) {
        const a = active.get(call);
        if (a) await a.promise;
        else {
          const exec = current(journal, call); if (!exec || sealed(journal, call)) continue;
          await fence(journal, exec);
          const { key, gen } = address(call);
          await finish(journal, call, exec, buildCallResult({ key, gen, status: "stopped", output: "" }));
        }
      }
    },
    async recover(wid, journal) {
      journals.set(wid, journal);
      for (const e of journal.entries().filter(e => e.type === JT.exec)) {
        const exec = String(e.exec); await fence(journal, exec); await release(exec);
      }
      for (const call of new Set(journal.entries().filter(e => e.type === JT.exec).map(e => String(e.call)))) {
        const a = address(call), values = sessionUsage(await readSession(callSession(home, a.wid, a.key, a.gen)));
        await serial(async () => {
          for (const u of values) if (!journal.entries().some(e => e.type === "usage" && e.call === call && e.id === u.id)) await journal.append("usage", { call, ...u });
          if (sealed(journal, call) || journal.entries().some(e => e.type === "retired" && e.call === call)) {
            await retireForwards(journal, call); await retireAttention(journal, call);
          }
        });
      }
      for (const e of journal.entries().filter(e => e.type === "forward" && !journal.entries().some(r => r.type === "forward-retired" && r.rid2 === e.rid2))) await replayForward(e);
      await (await outbox).republishPending();
    },
    async retire(widRev) {
      const journal = journals.get(widRev.slice(0, widRev.lastIndexOf("@"))); if (!journal) return;
      const calls = new Set(journal.entries().filter(e => e.type === JT.exec && String(e.call).startsWith(`${widRev}/`)).map(e => String(e.call)));
      for (const a of active.values()) if (a.ticket.widRev === widRev) { a.retired = true; calls.add(a.ticket.callId); }
      await serial(async () => { for (const call of calls) if (!journal.entries().some(e => e.type === "retired" && e.call === call)) await journal.append("retired", { call }); });
      for (const call of calls) active.get(call)?.wake();
      wake();
      for (const call of calls) {
        const a = active.get(call); if (a) await a.promise;
        for (const e of journal.entries().filter(e => e.type === JT.exec && e.call === call)) { await fence(journal, String(e.exec)); await release(String(e.exec)); }
        await serial(async () => { await retireForwards(journal, call); await retireAttention(journal, call); });
      }
    },
    busy: () => active.size > 0,
    suspend() {
      if (suspending) return suspending;
      for (const a of active.values()) { a.suspended = true; a.wake(); }
      wake();
      suspending = (async () => {
        const results = await Promise.allSettled([...active.values()].map(a => a.promise));
        await queue;
        const failed = results.find(r => r.status === "rejected" && r.reason?.name !== "ExecutorShutdown");
        if (failed?.status === "rejected") throw failed.reason;
      })().finally(() => { suspending = undefined; });
      return suspending;
    },
    async shutdown() {
      if (closed) return;
      closed = true; clearInterval(sweepTimer);
      try { await this.suspend(); await sweeping; }
      finally { await queue; await (await outbox).close(); }
    },
  };
}
