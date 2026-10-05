import { AssistantMessageComponent, UserMessageComponent, ToolExecutionComponent, getMarkdownTheme, getSelectListTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { CallSnapshot, WorkflowSnapshot } from "../orchestrator/snapshot.ts";
import { CT } from "../types.ts";
import { UiActions, UiData } from "./data.ts";
import { doneOrder, isOpen, toggleOpen, duration, keepSelection, summaryText, label, listRows, modelLabel, pendingText, resultPhrase, rowText, toolCount, type ListRow, type ViewState } from "./view.ts";
import { fitWidth, frame, inner } from "./frame.ts";
import { thinkingElapsed } from "./thinking.ts";
import { thoughtSummary } from "./session.ts";

const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** UI §2–3: A single pi component owns list/watch navigation while the main agent keeps running. */
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
    this.listNotice = { text: result.applied ? "✓ applied" : `✗ ${result.reason ?? "rejected"}`, until: Date.now() + 4000 };
    this.refresh();
  }
  private report(result: { state: "applied" | "submitted" | "rejected"; reason?: string; rid?: string }) {
    if (result.rid && result.state === "submitted") this.listPending.add(result.rid);
    this.listNotice = { text: result.state === "applied" ? "✓ applied" : result.state === "rejected" ? `✗ ${result.reason ?? "rejected"}` : "submitted…", until: Date.now() + 4000, rid: result.rid };
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
    this.listInput = { kind, call: c, workflow: w, editor: new Input({ prompt: `${kind} ${label(c)}: ` }), ...(kind === "answer" && q ? { qid: q.qid, rev: q.rev } : {}) };
    this.listInput.editor.focused = this.focused;
    this.listNotice = undefined;
  }
  private submitListInput() {
    const draft = this.listInput; if (!draft || this.busy) return;
    const message = draft.editor.getValue().trim(); if (!message) return;
    this.listInput = undefined;
    const { call: c, kind } = draft;
    this.listAction({ action: "send", to: c.callId, kind, message, ...(kind === "answer" ? { qid: draft.qid, rev: draft.rev } : {}) }, `${kind} ${label(c)}: ${JSON.stringify(message)}`);
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
    if (!this.disposed && this.watching === target) { this.notice = result.state === "rejected" ? `${note}: ${result.reason}` : "Submitted"; if (result.state !== "rejected") { this.input.setValue(""); this.uses++; } this.refresh(); }
  }
  private modelMenu(target?: CallSnapshot) {
    const c = target ?? this.current().c; if (!c) return;
    this.menuTitle = `Model for ${c.key}`;
    const models = this.ctx.modelRegistry.getAvailable();
    this.menu = new SelectList(models.map(m => ({ value: `${m.provider}/${m.id}`, label: this.name(`${m.provider}/${m.id}`) })), 12, getSelectListTheme());
    this.search.setValue("");
    this.menu.onCancel = () => { this.menu = undefined; };
    this.menu.onSelect = item => {
      this.menu = undefined;
      const level = this.data.facts.get(c.callId)?.thinking ?? "off";
      const args = { action: "send", to: c.callId, kind: "model", model: `${item.value}:${level}` };
      const note = `switched ${c.key} to ${this.name(item.value)} · ${level}`;
      if (target) this.listAction(args, note); else void this.send(args, note);
    };
  }
  private thinkingMenu() {
    const { c } = this.current(); if (!c) return;
    const model = this.data.facts.get(c.callId)?.model ?? c.model; if (!model) return;
    this.menuTitle = `Thinking for ${c.key}`;
    this.search.setValue("");
    this.menu = new SelectList(levels.map(value => ({ value, label: value })), 7, getSelectListTheme());
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
    const kind = followUp ? "follow-up" : q ? "answer" : "steer";
    void this.send({ action: "send", to: c.callId, kind, message, ...(kind === "answer" ? { qid: q!.qid, rev: q!.rev } : {}) },
      `${kind === "answer" ? "replied to" : followUp ? "queued follow-up for" : c.phase === "sealed" ? "continued" : "steered"} ${label(c)}: ${JSON.stringify(message)}`);
  }
  handleInput(key: string) {
    if (this.disposed) return;
    if (this.menu) {
      if ((["up", "down", "enter", "escape"] as const).some(k => matchesKey(key, k))) this.menu.handleInput(key);
      else { this.search.handleInput(key); this.menu.setFilter(this.search.getValue()); }
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
        else if (key === "x" && (c && c.phase !== "sealed" || row?.kind === "workflow" && w?.status === "running")) {
          this.stopTarget = c ? { id: c.callId, name: label(c) } : { id: w!.wid, name: w!.name ?? w!.wid };
        }
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
      const { c } = this.current(); if (!c) return;
      const facts = this.data.facts.get(c.callId), model = `${label(c)} · ${this.name(facts?.model ?? c.model)} ▾ · `;
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
    const components: (Component | string)[] = [];
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
        const content = m.content.filter(b => b.type !== "toolCall" && (this.expandedThinking || b.type !== "thinking"));
        if (content.length) components.push(new AssistantMessageComponent({ ...m, content } as AssistantMessage, false, markdown, undefined, 0));
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
    if (pending) {
      const elapsed = thinkingElapsed(entries);
      components.push(`Thinking${elapsed === undefined ? "" : ` ${Math.floor(elapsed / 1000)}s`}`);
    }
    if (!components.length) components.push(c.phase === "queued" ? "Waiting for dispatch" : "Waiting for session output");
    for (const component of components) {
      if (typeof component === "string") { if (/^[▸▾]/u.test(component)) thoughts.push(lines.length); lines.push(component); }
      else lines.push(...component.render(width));
    }
    return { lines, thoughts };
  }
  /** UI §2–3, P21: Every view is one full-height framed panel, so the main chat never shows through. */
  render(width: number): string[] {
    const height = Math.max(3, Number(this.tui.terminal?.rows) || 24), size = inner(width, height);
    const panel = (lines: string[], title: string, hints: string) => frame(lines, width, height, this.theme, title, hints);
    if (this.menu) return panel([...this.search.render(size.width), ...this.menu.render(size.width)], this.menuTitle, "Applies from the next model call · Esc back");
    if (!this.watching || this.doneTab) {
      const w = this.current().w;
      this.rows = this.doneTab && w ? doneOrder(w.calls).map(c => {
        const f = this.data.facts.get(c.callId);
        return { id: c.callId, kind: "call" as const, workflow: w, call: c, failed: !c.result?.ok, text: rowText("  ", label(c), this.name(f?.model ?? c.model), resultPhrase(c), [toolCount(f?.tools)], size.width) };
      }) : listRows(this.data.workflows, this.state, this.data.facts, this.name, size.width);
      this.selected = keepSelection(this.rows, this.selectedId, this.selected);
      while (this.rows[this.selected]?.kind === "preview" && this.selected > 0) this.selected--;
      this.selectedId = this.rows[this.selected]?.id;
      const start = Math.max(0, this.selected - size.height + 1);
      const lines = this.rows.slice(start, start + size.height).map((row, i) => {
        const fit = fitWidth(row.text, size.width);
        const text = row.failed ? this.theme.fg("error", fit) : row.kind === "preview" || row.dim ? this.theme.fg("dim", fit) : row.kind === "workflow" ? this.theme.bold(fit) : fit;
        return i + start === this.selected ? this.theme.bg("selectedBg", text) : text;
      });
      const row = this.selectedRow(), c = row?.kind === "call" ? row.call : undefined;
      const asking = c && row?.workflow?.attention.some(a => a.kind === "question" && a.call === c.callId);
      const narrow = size.width < 72;
      const keys = [narrow ? "↑↓" : "↑ ↓ select", row && row.kind !== "preview" ? `Enter ${narrow ? "" : row.kind === "workflow" ? (isOpen(row.workflow!, this.state) ? "collapse" : "expand") : row.kind === "call" ? "watch" : "open"}`.trim() : "",
        c && c.phase !== "sealed" ? (narrow ? "s" : "s steer") : "", c?.phase === "sealed" ? (narrow ? "f" : "f follow-up") : "",
        c && c.phase !== "sealed" || row?.kind === "workflow" && row.workflow?.status === "running" ? (narrow ? "x" : "x stop") : "",
        c ? (narrow ? "m" : "m model") : "", asking ? (narrow ? "a" : "a answer") : "", "Esc back"].filter(Boolean).join(" · ");
      const notice = this.listNotice && this.listNotice.until > Date.now() ? this.listNotice.text : "";
      const footer = this.listInput ? this.listInput.editor.render(size.width) : this.stopTarget ? [`Stop ${this.stopTarget.name}? y confirm · any other key cancels`] : notice ? [notice] : [];
      const body = this.rows.length ? lines.slice(0, Math.max(0, size.height - footer.length)) : ["No subagents"];
      while (body.length < size.height - footer.length) body.push("");
      return panel([...body, ...footer], this.doneTab ? `${w?.name ?? w?.wid} › done` : `Subagents · ${summaryText(this.data.workflows)}`, this.listInput ? "Enter send · Esc cancel" : this.stopTarget ? "y confirm · any other key cancels" : this.doneTab ? `← → switch · ${keys}` : keys);
    }
    const { c, w } = this.current();
    if (!c || !w) return panel(["Subagent is no longer in the current revision"], "Subagents", "Esc back");
    const facts = this.data.facts.get(c.callId), active = w.calls.filter(c => c.phase !== "sealed"), done = w.calls.length - active.length;
    const tabs = size.width < 60 ? `${c.key} ${w.calls.indexOf(c) + 1}/${w.calls.length}` : `${[...active.map(c => c.key), ...(done ? [`${done} done`] : [])].join(" · ")}    ← → switch`;
    const tools = toolCount(facts?.tools), pending = pendingText(c.pending), rule = this.theme.fg("borderMuted", "─".repeat(size.width));
    const head = [tabs, `${label(c)} · ${this.name(facts?.model ?? c.model)} ▾ · ${facts?.thinking ?? "off"} ▾${tools ? ` · ${tools}` : ""}${pending ? ` · ${pending}` : ""}`, rule];
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
    return panel([...head, ...body, rule, ...editor, hint], `${w.name ?? w.wid} › ${label(c)}`, `${duration(Date.now() - (c.startedAt ?? Date.now()))} · Esc back`);
  }
}
