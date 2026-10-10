import { AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, getMarkdownTheme, getSelectListTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth, type Component, type SelectItem, type OverlayOptions, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { CallSnapshot, WorkflowSnapshot } from "../orchestrator/snapshot.ts";
import { CT } from "../types.ts";
import { UiActions, UiData } from "./data.ts";
import { callName, workflowName, doneOrder, isOpen, plainReason, toggleOpen, duration, keepSelection, summaryText, listRows, modelLabel, pendingText, resultPhrase, rowText, toolCount, type ListRow, type ViewState } from "./view.ts";
import { fitWidth, frame, inner } from "./frame.ts";
import { thinkingElapsed } from "./thinking.ts";
import { thoughtSummary } from "./session.ts";

const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** UI §2–3: A single pi component owns list/watch navigation while the main agent keeps running. */
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export class SubagentScreen implements Component {
  readonly state: ViewState;
  private data: UiData;
  private actions: UiActions;
  private ctx: ExtensionContext;
  private tui: TUI;
  private theme: Theme;
  private close: () => void;
  private selected = 0;
  private selectedId?: string;
  private rows: ListRow[] = [];
  private watching?: string;
  private workflow?: string;
  private doneTab = false;
  private input = new Input();
  private menu?: SelectList;
  private menuTitle = "";
  private search = new Input({ prompt: "> ", placeholder: "Search models" });
  private menuItems: SelectItem[] = [];
  private expandedThinking = false;
  private expandedTools = false;
  private following = true;
  private scroll = 0;
  private busy = false;
  private disposed = false;
  private notice = "";
  private listNotice?: { text: string; until: number; rid?: string };
  private listInput?: { kind: "steer" | "follow-up" | "answer"; call: CallSnapshot; workflow: WorkflowSnapshot; editor: Input; qid?: string; rev?: number };
  private stopTarget?: { id: string; name: string };
  private listPending = new Set<string>();
  private uses = 0;
  private thinkingRows = new Set<number>();
  private inputRow = 0;
  /** Panel row of the "Jump to latest message" badge while following is paused (0 when not shown). */
  private jumpRow = 0;
  private _focused = false;
  get focused() { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value; this.search.focused = value; if (this.listInput) this.listInput.editor.focused = value; }
  constructor(data: UiData, actions: UiActions, ctx: ExtensionContext, tui: TUI, theme: Theme, close: () => void, state: ViewState) {
    this.data = data; this.actions = actions; this.ctx = ctx; this.tui = tui; this.theme = theme; this.close = close; this.state = state;
  }
  invalidate() { this.input.invalidate(); this.search.invalidate(); this.listInput?.editor.invalidate(); this.menu?.invalidate(); }
  /** v12 §5: Show a durable control decision on the list for a bounded interval. */
  controlResult(result: { rid: string; applied: boolean; reason?: string }) {
    if (!this.listPending.delete(result.rid) || this.disposed) return;
    this.listNotice = { text: result.applied ? "✓ applied" : `✗ ${plainReason(result.reason)}`, until: Date.now() + 4000 };
    this.refresh();
  }
  private report(result: { state: "applied" | "submitted" | "rejected"; reason?: string; rid?: string }) {
    if (result.rid && result.state === "submitted") this.listPending.add(result.rid);
    this.listNotice = { text: result.state === "applied" ? "✓ applied" : result.state === "rejected" ? `✗ ${plainReason(result.reason)}` : "submitted…", until: Date.now() + 4000, rid: result.rid };
    this.refresh();
  }
  private selectedRow() { return this.rows[this.selected]; }
  private listAction(args: Record<string, unknown>, note: string) {
    if (this.busy) return;
    this.busy = true;
    void this.actions.send(args, note).then(result => { if (!this.disposed) this.report(result); }).finally(() => { this.busy = false; this.refresh(); });
  }
  private beginListInput(kind: "steer" | "follow-up" | "answer", row: ListRow) {
    const c = row.call!, w = row.workflow!;
    const q = w.attention.find(a => a.kind === "question" && a.call === c.callId);
    this.listInput = { kind, call: c, workflow: w, editor: new Input({ prompt: `${kind} ${callName(w, c)}: ` }), ...(kind === "answer" && q ? { qid: q.qid, rev: q.rev } : {}) };
    this.listInput.editor.focused = this.focused;
    this.listNotice = undefined;
  }
  private submitListInput() {
    const draft = this.listInput; if (!draft || this.busy) return;
    const message = draft.editor.getValue().trim(); if (!message) return;
    this.listInput = undefined;
    const { call: c, workflow: w, kind } = draft;
    this.listAction({ action: "send", to: c.callId, kind, message, ...(kind === "answer" ? { qid: draft.qid, rev: draft.rev } : {}) }, `${kind} ${callName(w, c)}: ${JSON.stringify(message)}`);
  }
  dispose() { this.disposed = true; }
  refresh() { if (!this.disposed) this.tui.requestRender(); }
  private name = (model: string | undefined) => modelLabel(model, (p, id) => this.ctx.modelRegistry.find(p, id), this.data.aliases);
  private current() {
    const w = this.data.workflows.find(w => w.wid === this.workflow);
    let c = w?.calls.find(c => c.callId === this.watching);
    // P37: watching a key follows its newest generation (a continued call reopens on the same session).
    const newest = c && w!.calls.filter(x => x.key === c!.key && x.gen > c!.gen).sort((a, b) => b.gen - a.gen)[0];
    if (newest) { this.watching = newest.callId; c = newest; }
    return { w, c };
  }
  private open(w: WorkflowSnapshot, c: CallSnapshot) {
    this.workflow = w.wid; this.watching = c.callId; this.doneTab = false; this.state.viewed.add(c.callId);
    this.input.setValue(""); this.following = true; this.scroll = 0; this.notice = "";
  }
  private tabs(w: WorkflowSnapshot) { return [...w.calls.filter(c => c.phase !== "sealed").map(c => c.callId), ...(w.calls.some(c => c.phase === "sealed") ? ["done"] : [])]; }
  private switchTab(delta: number) {
    const { w } = this.current(); if (!w) return;
    const tabs = this.tabs(w), index = tabs.indexOf(this.doneTab ? "done" : this.watching!);
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next === "done") { this.doneTab = true; this.selected = 0; this.selectedId = undefined; }
    else { const c = w.calls.find(c => c.callId === next); if (c) this.open(w, c); }
  }
  private selectRow(row: ListRow | undefined) {
    if (!row) return;
    if (row.kind === "call") this.open(row.workflow!, row.call!);
    else if (row.kind === "workflow") toggleOpen(row.workflow!, this.state);
    else if (row.kind === "finished") this.state.finished = !this.state.finished;
    else if (row.workflow) {
      const w = row.workflow, count = this.state.done.get(w.wid) ?? (w.calls.every(c => c.phase === "sealed") || w.calls.some(c => c.phase === "sealed" && c.result && !c.result.ok && c.result.status !== "skipped" && !this.state.viewed.has(c.callId)) ? 8 : 0);
      this.state.done.set(w.wid, row.kind === "more" ? count + 8 : count ? 0 : 8);
    }
  }
  private async send(args: Record<string, unknown>, note: string) {
    if (this.busy || this.disposed) return;
    this.busy = true;
    const target = this.watching;
    const result = await this.actions.send(args, note);
    this.busy = false;
    if (!this.disposed && this.watching === target) { this.notice = result.state === "rejected" ? `${note}: ${plainReason(result.reason)}` : "Submitted"; if (result.state !== "rejected") { this.input.setValue(""); this.uses++; } this.refresh(); }
  }
  private modelMenu(target?: CallSnapshot) {
    const c = target ?? this.current().c; if (!c) return;
    this.menuTitle = `Model for ${c.key}`;
    const models = this.ctx.modelRegistry.getAvailable();
    this.menuItems = models.map(m => ({ value: `${m.provider}/${m.id}`, label: this.name(`${m.provider}/${m.id}`) }));
    this.menu = new SelectList(this.menuItems, 12, getSelectListTheme());
    this.search = new Input({ prompt: "> ", placeholder: "Search models (e.g. bedrock opus)" }); this.search.focused = this._focused;
    this.menu.onCancel = () => { this.menu = undefined; };
    this.menu.onSelect = item => {
      this.menu = undefined;
      const level = this.data.facts.get(c.callId)?.thinking ?? "off";
      const args = { action: "send", to: c.callId, kind: "model", model: `${item.value}:${level}` };
      const note = `switched ${c.key} to ${this.name(item.value)} · ${level}`;
      if (target) this.listAction(args, note); else void this.send(args, note);
    };
  }
  /** Fuzzy search like pi's own selectors: "bedrock opus" finds amazon-bedrock/claude-opus-4-5 by its id or display name. */
  private filterMenu(query: string) {
    if (!this.menu) return;
    const matches = fuzzyFilter(this.menuItems, query, item => `${item.value} ${item.label ?? ""}`);
    const { onSelect, onCancel } = this.menu;
    this.menu = new SelectList(matches, this.menuItems.length === levels.length ? 7 : 12, getSelectListTheme());
    this.menu.onSelect = onSelect; this.menu.onCancel = onCancel;
  }
  private thinkingMenu() {
    const { c } = this.current(); if (!c) return;
    const model = this.data.facts.get(c.callId)?.model ?? c.model; if (!model) return;
    this.menuTitle = `Thinking for ${c.key}`;
    this.menuItems = levels.map(value => ({ value, label: value }));
    this.search = new Input({ prompt: "> ", placeholder: "Search thinking levels" }); this.search.focused = this._focused;
    this.menu = new SelectList(this.menuItems, 7, getSelectListTheme());
    this.menu.onCancel = () => { this.menu = undefined; };
    this.menu.onSelect = item => {
      this.menu = undefined;
      void this.send({ action: "send", to: c.callId, kind: "model", model: `${model.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "")}:${item.value}` }, `switched ${c.key} thinking to ${item.value}`);
    };
  }
  private cycleThinking() {
    const { c } = this.current(); if (!c) return;
    const facts = this.data.facts.get(c.callId), model = facts?.model ?? c.model;
    if (!model) { this.notice = "Model not yet recorded"; return; }
    const level = levels[(levels.indexOf(facts?.thinking ?? "off") + 1) % levels.length]!;
    void this.send({ action: "send", to: c.callId, kind: "model", model: `${model.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "")}:${level}` }, `switched ${c.key} thinking to ${level}`);
  }
  private submit(followUp = false) {
    const { w, c } = this.current(); if (!w || !c) return;
    const message = this.input.getValue().trim(); if (!message) return;
    if (message === "/model") { this.modelMenu(); this.input.setValue(""); return; }
    if (message.startsWith("/model ")) {
      const model = message.slice(7).trim();
      void this.send({ action: "send", to: c.callId, kind: "model", model }, `switched ${c.key} to ${model}`); return;
    }
    if (message === "/stop") { void this.send({ action: "stop", target: c.callId }, `stopped ${c.key}`); return; }
    if (message.startsWith("/")) { this.notice = "Commands: /model, /stop"; return; }
    const q = w.attention.find(a => a.kind === "question" && a.call === c.callId);
    // A finished call cannot be steered: typing to it continues it (a follow-up), as the note says.
    const kind = followUp || c.phase === "sealed" ? "follow-up" : q ? "answer" : "steer";
    void this.send({ action: "send", to: c.callId, kind, message, ...(kind === "answer" ? { qid: q!.qid, rev: q!.rev } : {}) },
      `${kind === "answer" ? "replied to" : followUp ? "queued follow-up for" : c.phase === "sealed" ? "continued" : "steered"} ${callName(w, c)}: ${JSON.stringify(message)}`);
  }
  handleInput(key: string) {
    if (this.disposed) return;
    if (this.menu) {
      if ((["up", "down", "enter", "escape"] as const).some(k => matchesKey(key, k))) this.menu.handleInput(key);
      else { this.search.handleInput(key); this.filterMenu(this.search.getValue()); }
    } else if (this.listInput) {
      if (matchesKey(key, "escape")) this.listInput = undefined;
      else if (matchesKey(key, "enter")) this.submitListInput();
      else this.listInput.editor.handleInput(key.replace(/\r\n|\r|\n/g, " ")); // pasted lines (LF or CR) join with spaces
    } else if (this.stopTarget) {
      const target = this.stopTarget; this.stopTarget = undefined;
      if (key === "y") this.listAction({ action: "stop", target: target.id }, `stopped ${target.name}`);
    } else if (matchesKey(key, "escape")) {
      // Back in the list, the selection lands on the call just watched (UI §2 stable selection).
      if (this.watching) { this.selectedId = this.doneTab ? this.selectedId : this.watching; this.watching = undefined; this.workflow = undefined; this.doneTab = false; }
      else this.close();
    } else if (!this.watching || this.doneTab) {
      if (this.doneTab && (matchesKey(key, "left") || matchesKey(key, "right"))) this.switchTab(matchesKey(key, "left") ? -1 : 1);
      else if (matchesKey(key, "up") || matchesKey(key, "down")) {
        // Preview lines belong to the agent row above them; the cursor skips them.
        const step = matchesKey(key, "up") ? -1 : 1;
        let next = this.selected + step;
        while (this.rows[next]?.kind === "preview") next += step;
        if (this.rows[next]) this.selected = next;
        this.selectedId = this.rows[this.selected]?.id;
      }
      else if (matchesKey(key, "enter")) this.selectRow(this.selectedRow());
      else if (!this.busy) {
        const row = this.selectedRow(), c = row?.kind === "call" ? row.call : undefined, w = row?.workflow;
        const asking = c && w?.attention.some(a => a.kind === "question" && a.call === c.callId);
        if (key === "s" && c && c.phase !== "sealed") this.beginListInput("steer", row!);
        else if (key === "f" && c?.phase === "sealed") this.beginListInput("follow-up", row!);
        else if (key === "a" && c && asking) this.beginListInput("answer", row!);
        else if (key === "m" && c) this.modelMenu(c);
        else if (key === "r" && w?.paused) this.listAction({ action: "resume", wid: w.wid }, `resume ${workflowName(w) ?? w.wid}`);
        else if (key === "x" && (c && c.phase !== "sealed" || row?.kind === "workflow" && w?.status === "running")) {
          this.stopTarget = c ? { id: c.callId, name: callName(w!, c) } : { id: w!.wid, name: workflowName(w!) ?? w!.wid };
        }
        // Typing that is not a list key is meant for pi (a message typed with the list still open would
        // otherwise have its Enter open a watch view): close the list and hand the text to the editor.
        else if (!"sfamxr".includes(key) && /^[^\x00-\x1f\x7f]+$/u.test(key)) { this.close(); this.ctx.ui.pasteToEditor(key); }
      }
    } else if (this.busy) {
      // Preserve the draft and target until its durable submission resolves.
    } else if (!this.input.getValue() && (matchesKey(key, "left") || matchesKey(key, "right"))) this.switchTab(matchesKey(key, "left") ? -1 : 1);
    else if (matchesKey(key, "ctrl+l")) this.modelMenu();
    else if (matchesKey(key, "shift+tab")) this.cycleThinking();
    else if (matchesKey(key, "ctrl+t")) this.expandedThinking = !this.expandedThinking;
    else if (matchesKey(key, "ctrl+o")) this.expandedTools = !this.expandedTools;
    else if (matchesKey(key, "pageUp")) { this.following = false; this.scroll = Math.max(0, this.scroll - 10); }
    else if (matchesKey(key, "pageDown")) { this.following = false; this.scroll += 10; }
    else if (matchesKey(key, "end")) this.following = true;
    else if (matchesKey(key, "alt+enter")) this.submit(true);
    else if (matchesKey(key, "enter")) this.submit();
    else this.input.handleInput(key);
    this.refresh();
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.type === "wheel" && this.watching) { this.following = false; this.scroll = Math.max(0, this.scroll + (event.wheelDelta ?? 0)); return { handled: true, render: true }; }
    if (event.type !== "click" || event.button !== "left" || !this.watching || this.doneTab) return;
    // Panel coordinates: row 0 is the top border, column 2 is the first content column.
    if (event.y === 2) {
      const { c, w } = this.current(); if (!c || !w) return;
      const facts = this.data.facts.get(c.callId), model = `${callName(w, c)} · ${this.name(facts?.model ?? c.model)} ▾ · `;
      const x = event.x - 2;
      if (x < visibleWidth(model)) this.modelMenu();
      else if (x < visibleWidth(`${model}${facts?.thinking ?? "off"} ▾`)) this.thinkingMenu();
      else return;
      return { handled: true, render: true };
    }
    if (this.jumpRow && event.y === this.jumpRow) { this.following = true; return { handled: true, render: true }; }
    if (this.thinkingRows.has(event.y)) { this.expandedThinking = !this.expandedThinking; return { handled: true, render: true }; }
    if (event.y === this.inputRow) return this.input.handleMouse({ ...event, x: event.x - 2, y: 0 });
  }
  private transcript(c: CallSnapshot, w: WorkflowSnapshot, width: number): { lines: string[]; thoughts: number[] } {
    const entries = this.data.sessions.get(c.callId) ?? [], lines: string[] = [], thoughts: number[] = [];
    const tools = new Map<string, ToolExecutionComponent>();
    // A `{ thought }` part is an expanded thinking block: like pi, a click anywhere on it collapses it again.
    const components: (Component | string | { thought: Component })[] = [];
    const assistant = (content: AssistantMessage["content"], m?: AssistantMessage) =>
      new AssistantMessageComponent({ ...(m ?? { role: "assistant", api: "", provider: "", model: "", usage: undefined, stopReason: "stop", timestamp: Date.now() }), content } as unknown as AssistantMessage, false, markdown, undefined, 0);
    const markdown = getMarkdownTheme();
    const task = this.data.facts.get(c.callId)?.task;
    if (task) components.push(new UserMessageComponent(task, markdown, 0));
    for (const [index, e] of entries.entries()) {
      if (e.type === "custom_message" && e.customType === CT.msg && (e.details as { kind?: string })?.kind !== "task") {
        const text = typeof e.content === "string" ? e.content : e.content.filter(b => b.type === "text").map(b => b.text).join("\n");
        components.push(new UserMessageComponent(text, markdown, 0));
      }
      if (e.type !== "message") continue;
      const m = e.message;
      if (m.role === "user") components.push(new UserMessageComponent(typeof m.content === "string" ? m.content : m.content.filter(b => b.type === "text").map(b => b.text).join("\n"), markdown, 0));
      if (m.role === "assistant") {
        const thinking = m.content.filter(b => b.type === "thinking").map(b => b.thinking).join("\n");
        const hasThinking = m.content.some(b => b.type === "thinking");
        const elapsed = thinkingElapsed(entries, index);
        const clock = elapsed === undefined ? "" : ` ${Math.floor(elapsed / 1000)}s`;
        if (hasThinking) components.push(`${thinking.trim() ? (this.expandedThinking ? "▾ " : "▸ ") : ""}Thinking${clock}${thoughtSummary(thinking) ? ` · ${thoughtSummary(thinking)}` : ""}`);
        const thoughtBlocks = m.content.filter(b => b.type === "thinking"), rest = m.content.filter(b => b.type !== "toolCall" && b.type !== "thinking");
        if (this.expandedThinking && thoughtBlocks.some(b => b.thinking?.trim())) components.push({ thought: assistant(thoughtBlocks, m) });
        if (rest.length) components.push(assistant(rest, m));
        for (const b of m.content) if (b.type === "toolCall") {
          const component = new ToolExecutionComponent(b.name, b.id, b.arguments, { showImages: false }, undefined, this.tui, w.cwd ?? this.ctx.cwd);
          component.markExecutionStarted(); component.setArgsComplete(); component.setExpanded(this.expandedTools);
          tools.set(b.id, component); components.push(component);
        }
      }
      if (m.role === "toolResult") tools.get(m.toolCallId)?.updateResult({ content: m.content, details: m.details, isError: m.isError });
    }
    const last = entries.at(-1);
    const pending = c.phase === "running" && !this.data.facts.get(c.callId)?.activity &&
      !(last?.type === "message" && last.message.role === "assistant");
    // UI §3 "be pi": the response in flight, from the child's live state: waiting for the provider, or the thinking
    // and text streaming in (thinking collapsed like pi's, Ctrl+T or a click expands it).
    const live = c.phase === "running" ? this.data.facts.get(c.callId)?.live : undefined;
    if (live?.phase === "waiting") components.push(`${SPIN[Math.floor(Date.now() / 500) % SPIN.length]} Waiting for the model · ${duration(Date.now() - live.since)}`);
    else if (live?.phase === "streaming") {
      const age = ` ${Math.floor((Date.now() - live.since) / 1000)}s`;
      if (live.thinking) components.push(`${this.expandedThinking ? "▾ " : "▸ "}Thinking${age}${thoughtSummary(live.thinking) ? ` · ${thoughtSummary(live.thinking)}` : ""}`);
      if (this.expandedThinking && live.thinking) components.push({ thought: assistant([{ type: "thinking", thinking: live.thinking }] as AssistantMessage["content"]) });
      if (live.text) components.push(assistant([{ type: "text", text: live.text }] as AssistantMessage["content"]));
      if (live.tool) components.push(`${SPIN[Math.floor(Date.now() / 500) % SPIN.length]} Writing a ${live.tool} call`);
      if (!live.thinking && !live.text && !live.tool) components.push(`${SPIN[Math.floor(Date.now() / 500) % SPIN.length]} Responding · ${duration(Date.now() - live.since)}`);
    } else if (pending) {
      const elapsed = thinkingElapsed(entries);
      components.push(`Thinking${elapsed === undefined ? "" : ` ${Math.floor(elapsed / 1000)}s`}`);
    }
    if (!components.length) components.push(c.phase === "queued" ? "Waiting for dispatch" : "Waiting for session output");
    for (const component of components) {
      if (typeof component === "string") { if (/^[▸▾]/u.test(component)) thoughts.push(lines.length); lines.push(component); }
      else if ("thought" in component) { const rows = component.thought.render(width); for (let i = 0; i < rows.length; i++) thoughts.push(lines.length + i); lines.push(...rows); }
      else lines.push(...component.render(width));
    }
    return { lines, thoughts };
  }
  /** UI §2–3: A floating panel over pi, like pi's own overlays: the list and menus are compact (they grow with their
   *  content up to 60% of the terminal); watching a subagent takes most of the screen (85%). */
  overlay(): OverlayOptions {
    // One fixed frame (pi sizes an overlay when it opens): the panel's own height decides how much of it is used.
    return this.termRows() < 20 ? { anchor: "center", width: "100%", maxHeight: "100%" } : { anchor: "center", width: "90%", minWidth: 40, maxHeight: "85%", margin: 1 };
  }
  private termRows() { return Math.max(3, Number(this.tui.terminal?.rows) || 24); }
  /** UI §3: What this subagent costs and how full its context is, in pi's footer terms: "↑12.3k ↓1.2k $0.04 · 45k/200k (22%)". */
  private spend(c: CallSnapshot, facts: { model?: string; context?: number } | undefined): string {
    const k = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
    const u = c.usage, parts: string[] = [];
    if (u && (u.input || u.output)) parts.push(`tokens ↑${k(u.input)} ↓${k(u.output)}${u.costUsd > 0 ? ` $${u.costUsd.toFixed(u.costUsd < 0.01 ? 4 : 2)}` : ""}`);
    if (facts?.context) {
      const [p, ...rest] = (facts.model ?? c.model ?? "").split("/"), window = p && rest.length ? this.ctx.modelRegistry.find(p, rest.join("/"))?.contextWindow : undefined;
      parts.push(window ? `context ${k(facts.context)}/${k(window)} (${Math.round(facts.context / window * 100)}%)` : `context ${k(facts.context)}`);
    }
    return parts.length ? parts.join(" · ") : "tokens: none reported yet";
  }
  /** UI §2: One fixed-size dialog for every view, a little smaller than the terminal on all sides, so it always reads
   *  as a window over pi rather than part of the chat (it does not grow or shrink with its content). */
  private height(_content?: number): number {
    const rows = this.termRows();
    return rows < 20 ? rows : Math.floor(rows * 0.85) - 2;
  }
  render(width: number): string[] {
    let height = this.height(), size = inner(width, height);
    const panel = (lines: string[], title: string, hints: string) => frame(lines, width, height, this.theme, title, hints);
    if (this.menu) {
      const lines = [...this.search.render(size.width), ...this.menu.render(size.width)];
      height = this.height(lines.length); return panel(lines, this.menuTitle, "Applies from the next model call · Esc back");
    }
    if (!this.watching || this.doneTab) {
      const w = this.current().w;
      const footerRows = this.listInput ? 1 : this.stopTarget || (this.listNotice && this.listNotice.until > Date.now()) ? 1 : 0;
      // A two-column gutter carries the selection marker: a background alone is invisible in some themes and in
      // plain-text captures, and x must show which row it would stop.
      const rowWidth = Math.max(1, size.width - 2);
      this.rows = this.doneTab && w ? doneOrder(w.calls).map(c => {
        const f = this.data.facts.get(c.callId);
        return { id: c.callId, kind: "call" as const, workflow: w, call: c, failed: !c.result?.ok, text: rowText("  ", callName(w, c), this.name(f?.model ?? c.model), resultPhrase(c), [toolCount(f?.tools)], rowWidth) };
      }) : listRows(this.data.workflows, this.state, this.data.facts, this.name, rowWidth);
      height = this.height(Math.max(1, this.rows.length) + footerRows); size = inner(width, height); // inner width does not depend on height
      this.selected = keepSelection(this.rows, this.selectedId, this.selected);
      while (this.rows[this.selected]?.kind === "preview" && this.selected > 0) this.selected--;
      this.selectedId = this.rows[this.selected]?.id;
      const start = Math.max(0, this.selected - size.height + 1);
      const lines = this.rows.slice(start, start + size.height).map((row, i) => {
        const fit = fitWidth(row.text, rowWidth);
        const text = row.failed ? this.theme.fg("error", fit) : row.kind === "preview" || row.dim ? this.theme.fg("dim", fit) : row.kind === "workflow" ? this.theme.bold(fit) : fit;
        return i + start === this.selected ? this.theme.bg("selectedBg", this.theme.fg("accent", "› ") + text) : `  ${text}`;
      });
      const row = this.selectedRow(), c = row?.kind === "call" ? row.call : undefined;
      const asking = c && row?.workflow?.attention.some(a => a.kind === "question" && a.call === c.callId);
      const narrow = size.width < 72;
      const keys = [narrow ? "↑↓" : "↑ ↓ select", row && row.kind !== "preview" ? `Enter ${narrow ? "" : row.kind === "workflow" ? (isOpen(row.workflow!, this.state) ? "collapse" : "expand") : row.kind === "call" ? "watch" : "open"}`.trim() : "",
        c && c.phase !== "sealed" ? (narrow ? "s" : "s steer") : "", c?.phase === "sealed" ? (narrow ? "f" : "f follow-up") : "",
        c && c.phase !== "sealed" || row?.kind === "workflow" && row.workflow?.status === "running" ? (narrow ? "x" : "x stop") : "",
        c ? (narrow ? "m" : "m model") : "", asking ? (narrow ? "a" : "a answer") : "", row?.workflow?.paused ? (narrow ? "r" : "r resume") : "", "Esc back"].filter(Boolean).join(" · ");
      const notice = this.listNotice && this.listNotice.until > Date.now() ? this.listNotice.text : "";
      const footer = this.listInput ? this.listInput.editor.render(size.width) : this.stopTarget ? [`Stop ${this.stopTarget.name}? y confirm · any other key cancels`] : notice ? [notice] : [];
      const body = this.rows.length ? lines.slice(0, Math.max(0, size.height - footer.length)) : ["No subagents"];
      while (body.length < size.height - footer.length) body.push("");
      return panel([...body, ...footer], this.doneTab ? `${w?.name ?? w?.wid} › done` : `Subagents · ${summaryText(this.data.workflows)}`, this.listInput ? "Enter send · Esc cancel" : this.stopTarget ? "y confirm · any other key cancels" : this.doneTab ? `← → switch · ${keys}` : keys);
    }
    const { c, w } = this.current();
    if (!c || !w) return panel(["Subagent is no longer in the current revision"], "Subagents", "Esc back");
    const facts = this.data.facts.get(c.callId), active = w.calls.filter(c => c.phase !== "sealed"), done = w.calls.length - active.length;
    const tabs = size.width < 60 ? `${callName(w, c)} ${w.calls.indexOf(c) + 1}/${w.calls.length}` : `${[...active.map(c => callName(w, c)), ...(done ? [`${done} done`] : [])].join(" · ")}    ← → switch`;
    const tools = toolCount(facts?.tools), pending = pendingText(c.pending), rule = this.theme.fg("borderMuted", "─".repeat(size.width));
    const switching = c.switching ? ` → ${this.name(c.switching)} (requested)` : "";
    const head = [tabs, `${callName(w, c)} · ${this.name(facts?.model ?? c.model)} ▾${switching} · ${facts?.thinking ?? "off"} ▾${tools ? ` · ${tools}` : ""}${pending ? ` · ${pending}` : ""}`,
      this.theme.fg("dim", this.spend(c, facts)), rule];
    const asking = w.attention.some(a => a.kind === "question" && a.call === c.callId);
    const placeholder = `${c.phase === "sealed" ? "Continue" : asking ? "Reply to" : "Steer"} ${c.key}…${this.uses < 3 ? "   / for commands" : ""}`;
    const empty = new Input({ prompt: "", placeholder, placeholderStyle: text => this.theme.fg("dim", text) });
    empty.focused = this.focused;
    const editor = this.input.getValue() ? this.input.render(size.width) : empty.render(size.width);
    const hint = this.input.getValue().startsWith("/") ? "/model · /stop" : this.notice;
    const transcript = this.transcript(c, w, size.width), available = Math.max(1, size.height - head.length - editor.length - 2);
    const bottom = Math.max(0, transcript.lines.length - available);
    // Scrolling back down to the end resumes following, as in pi's own transcript.
    if (this.following || this.scroll >= bottom) { this.following = true; this.scroll = bottom; }
    this.thinkingRows = new Set(transcript.thoughts.filter(n => n >= this.scroll && n < this.scroll + available).map(n => n - this.scroll + head.length + 1));
    const body = transcript.lines.slice(this.scroll, this.scroll + available);
    while (body.length < available) body.push(""); // the editor stays at the bottom of the panel, as in the main session
    // pi's own transcript affordance: while following is paused, a badge offers the way back (End or a click).
    this.jumpRow = 0;
    if (!this.following && available > 1) {
      const badge = " ↓ Jump to latest message · End ", pad = Math.max(0, size.width - visibleWidth(badge));
      body[available - 1] = " ".repeat(pad) + this.theme.bg("selectedBg", this.theme.fg("text", truncateToWidth(badge, size.width)));
      this.jumpRow = 1 + head.length + available - 1;
    }
    this.inputRow = 1 + head.length + available + 1;
    // pi's own keys for the transcript, spelled out: thinking and tool output expand in place.
    return panel([...head, ...body, rule, ...editor, hint], new Set(w.calls.map(x => x.key)).size === 1 && workflowName(w) ? callName(w, c) : `${workflowName(w) ?? w.wid} › ${callName(w, c)}`, `${duration(Date.now() - (c.startedAt ?? Date.now()))} · ctrl+t thinking · ctrl+o tools · Esc back`);
  }
}
