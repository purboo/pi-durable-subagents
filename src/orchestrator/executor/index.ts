// Private journal entries (A1): tracked{exec,pid,start}; loss{exec}; settled{exec};
// stop-intent{call}; forward{rid,rid2,dest,hash,envelope:{to,kind,body,cond?}};
// observation{exec,event}; selected{exec,model}; switch-observed{exec,rid,pool}.
// The orchestrator ledger owns
// hold/release{pool,slot,exec}. All transitions are serialized before publication.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
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

type Envelope = Pick<Request, "to" | "kind" | "body" | "cond">;
type Active = { ticket: CallTicket; promise: Promise<CallResult>; wake: () => void; stopped: boolean };
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
export default function createExecutor(ledgers: Ledgers): Executor {
  const { home, config, orch } = ledgers;
  const containment = new Containment();
  const active = new Map<string, Active>(), completed = new Map<string, Promise<CallResult>>(), journals = new Map<string, JournalHandle>();
  let queue: Promise<unknown> = Promise.resolve(), closed = false;
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
  }
  async function fence(journal: JournalHandle, exec: string, child?: Spawned) {
    child?.stdin.end();
    if (!has(journal, JT.fenced, exec)) {
      await containment.fence(exec, tracked(journal, exec));
      await serial(async () => { if (!has(journal, JT.fenced, exec)) await journal.append(JT.fenced, { exec }); });
    }
  }
  async function finish(journal: JournalHandle, call: string, exec: string, result: CallResult) {
    const value = await serial(async () => {
      const old = sealed(journal, call);
      if (old) return old;
      if (!seal({ sealed: false, exec: current(journal, call) ?? "" }, { exec })) throw new Error(`Stale seal: ${exec}`);
      if (!has(journal, JT.fenced, exec)) throw new Error(`Unfenced seal: ${exec}`);
      if (entriesFor(journal, call).some(e => e.type === "stop-intent")) result = buildCallResult({ key: result.key, gen: result.gen, status: "stopped", output: "" });
      await journal.append(JT.sealed, { call, exec, result });
      for (const e of journal.entries().filter(e => e.type === JT.attention)) {
        const item = e.item as { id: string; rev: number; call?: string };
        if (item.call === call && !journal.entries().some(r => r.type === JT.attentionResolved && r.id === item.id && r.rev === item.rev))
          await journal.append(JT.attentionResolved, { id: item.id, rev: item.rev, resolution: "retired" });
      }
      return result;
    });
    await release(exec); return value;
  }
  const stopped = (a: Active) => a.stopped || entriesFor(a.ticket.journal, a.ticket.callId).some(e => e.type === "stop-intent");
  async function acquire(a: Active, exec: string, models: Model[]): Promise<Model | undefined> {
    for (;;) {
      let signal!: () => void;
      const changed = new Promise<void>(resolve => { signal = resolve; waiters.add(resolve); });
      const chosen = await serial(async () => {
        if (stopped(a)) return;
        for (const model of models) {
          const provider = model.provider;
          // Bare IDs and an absent Pi default cannot be provider-constrained before launch.
          if (!provider) { await a.ticket.journal.append("selected", { exec, model, provider: null }); return model; }
          const holders = holdings().filter(e => e.pool === provider);
          const limit = config.providers?.[provider]?.slots ?? Infinity;
          if (!capacity({ kind: "provider", holders: holders.length, capacity: limit })) continue;
          let slot = 0; while (holders.some(e => e.slot === slot)) slot++;
          await orch.append("hold", { pool: provider, slot, exec });
          await a.ticket.journal.append("selected", { exec, model });
          return model;
        }
      });
      if (chosen || stopped(a)) { waiters.delete(signal); return chosen; }
      await changed;
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
        for (const h of holdings().filter(h => h.exec === exec && h.pool !== provider)) await orch.append("release", { pool: h.pool, slot: h.slot, exec });
      }
    });
    wake();
  }
  function pendingSwitch(exec: string) {
    return holdings().find(h => h.exec === exec && h.reserved && !orch.entries().some(e => e.type === "switch-observed" && e.exec === exec && e.rid === h.rid));
  }
  async function observe(a: Active, exec: string, child: Spawned) {
    const t = a.ticket, session = callSession(home, t.wid, t.key, t.gen);
    let signal!: () => void;
    const boundary = new Promise<void>(resolve => { signal = resolve; a.wake = resolve; });
    let failure: unknown, pending: Promise<unknown> = Promise.resolve();
    const enqueue = (fn: () => Promise<unknown>) => { pending = pending.then(fn).catch(error => { failure = error; signal(); }); };
    child.stdin.on("error", () => {});
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      let event: Record<string, unknown>;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "agent_settled") enqueue(async () => {
        await serial(async () => { if (!has(t.journal, "settled", exec)) await t.journal.append("settled", { exec }); }); signal();
      });
      else if (["message_start", "message_end"].includes(String(event.type)) || String(event.type).startsWith("tool_execution_"))
        enqueue(async () => {
          await serial(() => t.journal.append("observation", { exec, event }));
          if (event.type === "message_start") await switched(exec, event);
        });
    });
    let scanning = false;
    const scan = () => {
      if (scanning) return;
      scanning = true;
      enqueue(async () => { try {
        await track(t.journal, exec); await questions(t, await readSession(session));
        const reservation = pendingSwitch(exec);
        // Fence before freeing an expired reservation: a delayed child must not use an unheld provider.
        if (reservation && Date.now() - reservation.ts >= (config.k?.switchTimeoutMs ?? 120000)) signal();
      } finally { scanning = false; } });
    };
    const timer = setInterval(scan, config.k?.trackerMs ?? 1000);
    const watcher = watch(callDir(home, t.wid, t.key, t.gen), scan);
    watcher.on("error", () => {}); // K10 remains the fallback if native watching is unavailable.
    try {
      if (stopped(a)) signal();
      await Promise.race([boundary, child.exited]);
    } finally {
      watcher.close(); clearInterval(timer); a.wake = () => {}; await pending;
      await fence(t.journal, exec, child);
      lines.close(); child.stdout.resume();
    }
    if (failure) throw failure;
  }
  async function execute(a: Active): Promise<CallResult> {
    const t = a.ticket, journal = t.journal;
    const session = callSession(home, t.wid, t.key, t.gen), dir = callDir(home, t.wid, t.key, t.gen);
    const makeResult = (status: CallResult["status"], output = "", error?: string) => buildCallResult({ key: t.key, gen: t.gen, status, output, ...(error ? { error } : {}) });
    for (;;) {
      const old = sealed(journal, t.callId); if (old) return old;
      let exec = current(journal, t.callId);
      let entries = await readSession(session);
      let dangling: string[] = [];
      if (exec) {
        await fence(journal, exec);
        await questions(t, entries = await readSession(session));
        const ev = evidence(entries, exec); dangling = ev.dangling;
        if (stopped(a)) return finish(journal, t.callId, exec, makeResult("stopped"));
        if (ev.report) return finish(journal, t.callId, exec, buildCallResult({ key: t.key, gen: t.gen, status: ev.report.outcome as "ok" | "failed", output: ev.text, usage: ev.usage,
          ...(Object.hasOwn(ev.report, "data") ? { report: { data: ev.report.data } } : {}), ...(Array.isArray(ev.report.artifacts) ? { artifacts: ev.report.artifacts as string[] } : {}) }));
        if (t.spec.schema === undefined && has(journal, "settled", exec) && ev.text)
          return finish(journal, t.callId, exec, { ...makeResult("ok", ev.text), usage: ev.usage });
        if (t.spec.once && dangling.length) return finish(journal, t.callId, exec, makeResult("unknown", "", `Unknown tool outcomes: ${dangling.join(", ")}`));
        await serial(async () => { if (!has(journal, "loss", exec!)) await journal.append("loss", { exec }); });
        const losses = journal.entries().filter(e => e.type === "loss" && String(e.exec).startsWith(`${t.callId}#`)).length;
        if (losses >= (config.k?.lossBound ?? 5)) return finish(journal, t.callId, exec, makeResult("failed", "", `lost ×${losses}`));
        await release(exec);
      }
      const previous = exec;
      const epoch = previous ? Number(previous.split(".").at(-1)) + 1 : 1;
      exec = `${t.callId}#1.${epoch}`;
      await serial(() => journal.append(JT.exec, { exec, call: t.callId }));
      if (stopped(a)) { await fence(journal, exec); return finish(journal, t.callId, exec, makeResult("stopped")); }
      let candidates: Model[];
      try {
        const restored = previous && sessionModel(entries);
        const raw = t.spec.model ?? t.agent.model ?? config.defaultModel ?? await defaultModel();
        candidates = restored ? [restored] : raw ? resolveModel(raw, config.pools) : [{ id: "" }];
      } catch (error) {
        await fence(journal, exec); return finish(journal, t.callId, exec, makeResult("failed", "", String(error)));
      }
      const model = await acquire(a, exec, candidates);
      if (!model || stopped(a)) { await fence(journal, exec); return finish(journal, t.callId, exec, makeResult("stopped")); }
      await mkdir(dir, { recursive: true });
      const prompt = join(dir, "system.txt"), schema = join(dir, "schema.json");
      // These are derived launch inputs, reconstructed from the pinned ticket after a crash.
      await writeFile(prompt, t.agent.body);
      if (t.spec.schema !== undefined) await writeFile(schema, JSON.stringify(t.spec.schema));
      const sender = await outbox;
      await sender.send(t.callId, previous ? "continue" : "task", { message: previous ? `Continue the task. Tool calls whose outcomes are unknown: ${dangling.join(", ") || "none"}.` : t.spec.task }, undefined, { rid: contentHash([exec, "dispatch"]) });
      if (stopped(a)) { await fence(journal, exec); return finish(journal, t.callId, exec, makeResult("stopped")); }
      let child: Spawned;
      try {
        child = await containment.spawn({ exec, command: "pi", args: [...buildPiArgs(t.agent, t.spec, { sessionPath: session, systemPromptPath: prompt, continuation: !!previous, controlTools: t.spec.schema === undefined ? ["ask"] : ["ask", "report"], ...(model.id ? { model } : {}) }), "-e", extension], cwd: t.cwd,
          env: { DSA_HOME: home, DSA_EXEC: exec, DSA_CALL: t.callId, DSA_INBOX: inbox(t.callId), DSA_JOURNAL: journal.path, ...(t.spec.schema !== undefined ? { DSA_SCHEMA: schema } : {}) } });
      } catch (error) {
        await fence(journal, exec); return finish(journal, t.callId, exec, makeResult("failed", "", `Spawn failed: ${String(error)}`));
      }
      try {
        await track(journal, exec, [{ pid: child.pid, start: child.start, ppid: process.pid }]);
        await observe(a, exec, child);
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
      if (closed) return Promise.reject(new Error("Executor closed"));
      journals.set(ticket.wid, ticket.journal);
      const a: Active = { ticket, stopped: false, wake: () => {}, promise: undefined! };
      active.set(ticket.callId, a);
      a.promise = execute(a).finally(() => { active.delete(ticket.callId); wake(); });
      completed.set(ticket.callId, a.promise);
      return a.promise;
    },
    async forward(req, ctx) {
      return serial(async () => {
        const dest = `${ctx.widRev}/${ctx.key}@${ctx.gen}`, hash = contentHash(req);
        journals.set(address(dest).wid, ctx.journal);
        const prior = ctx.journal.entries().find(e => e.type === "forward" && e.rid === req.rid && e.dest === dest);
        if (prior) {
          if (prior.hash !== hash) return { action: "reject", reason: "identity-conflict" } as const;
          await replayForward(prior); return { action: "apply" } as const;
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
      for (const e of journal.entries().filter(e => e.type === "forward")) await replayForward(e);
      await (await outbox).republishPending();
    },
    async retire() { throw new Error("retire: not implemented yet (wave 3 X1)"); },
    async suspend() { throw new Error("suspend: not implemented yet (wave 3 X1)"); },
    busy: () => active.size > 0,
    async shutdown() {
      closed = true;
      for (const wid of journals.keys()) await this.stop({ wid });
      await queue; await (await outbox).close();
    },
  };
}
