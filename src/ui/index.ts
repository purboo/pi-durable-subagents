import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { UiDeps } from "../agent/main.ts";
import { UiActions, UiData } from "./data.ts";
import { SubagentScreen } from "./screen.ts";
import { oneLine } from "./frame.ts";
import { dockLines, mainLine, modelLabel, orderWorkflows, type ViewState } from "./view.ts";
import { registerCards } from "./cards.ts";
import { toolRenderers } from "./tool.ts";

/** UI §1–3, P16, P21: Register journal-backed list/watch surfaces only in interactive pi. */
export function registerUi(pi: ExtensionAPI, deps: UiDeps): void {
  if (typeof pi.registerMessageRenderer === "function") registerCards(pi, deps.home); // P21: cards are optional
  // UI §5: compact tool calls and results (optional surface; without it pi shows the raw JSON).
  if (typeof pi.registerToolRenderer === "function") pi.registerToolRenderer((name, next) => {
    const n = next();
    return name !== "subagents" ? n : { ...n, renderCall: n?.renderCall ?? toolRenderers.renderCall as never, renderResult: n?.renderResult ?? toolRenderers.renderResult as never };
  });
  let cleanup: (() => void) | undefined, openList: (() => "opened" | "empty" | "busy") | undefined;
  // `/subagents` opens the same list as ↓ (people look for a command first). With pi-subagents also
  // installed, pi names the two commands /subagents:1 and /subagents:2.
  if (typeof pi.registerCommand === "function") pi.registerCommand("subagents", {
    description: "Open the durable subagents list (same as ↓ on an empty editor)",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const result = openList?.();
      if (result === "empty") ctx.ui?.notify?.("No subagent workflows in this session yet. Ask the agent to run some; they appear here and above the editor.", "info");
      else if (!result) ctx.ui?.notify?.("The subagents list needs interactive pi; from a shell use `pi-durable-subagents status`.", "info");
    },
  });
  const start = (_event: unknown, ctx: ExtensionContext) => {
    cleanup?.(); cleanup = undefined;
    if (ctx.mode !== "tui" || !ctx.hasUI || !ctx.ui?.custom || !ctx.ui?.onTerminalInput || !ctx.ui?.setWidget) return;
    const data = new UiData(deps.home), actions = new UiActions(deps);
    const state: ViewState = { folded: new Set(), done: new Map(), viewed: new Set(), finished: false };
    let screen: SubagentScreen | undefined, opening = false, stopped = false, closeScreen: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined, timer: ReturnType<typeof setInterval> | undefined;
    let dockRows: (width: number) => string[] = () => [], dockAt: "above" | "below" | undefined, dockTui: { requestRender(): void } | undefined, lastDock = "";
    const right = (text: string, width: number) => { const t = truncateToWidth(text, width); return " ".repeat(Math.max(0, width - visibleWidth(t))) + t; };
    const stop = () => {
      stopped = true; clearInterval(timer); unsubscribe?.(); screen?.dispose(); closeScreen?.(); openList = undefined;
      try { ctx.ui.setWidget("durable-subagents", undefined); } catch { /* P21: disappearing UI surface. */ }
    };
    const refresh = () => {
      if (stopped) return;
      try {
        data.refresh(); actions.reconcile();
        for (const result of actions.resolutions.splice(0)) screen?.controlResult(result);
        const own = `main:${ctx.sessionManager.getSessionId()}`;
        data.workflows = orderWorkflows(data.workflows, own);
        // UI §1: the dock — live rows per active agent plus a summary line ("auto"), only the summary ("line"), or nothing.
        const name = (model: string | undefined) => modelLabel(model, (p, id) => ctx.modelRegistry.find(p, id), data.aliases);
        const now = Date.now(), dock = data.dock;
        const lines = (width: number) => dock === "off" ? [] : dock === "line" ? [mainLine(data.workflows) ?? ""].filter(Boolean) : dockLines(data.workflows, data.facts, name, width, now);
        dockRows = lines;
        // The widget is installed once, at session start (and again only when its placement changes). pi stacks
        // widgets in the order they were set, so installing once keeps the dock where the extension load order puts
        // it: listed before another extension's editor bar (a powerline bar), the dock sits above that bar. Re-setting
        // it on every refresh pushed it under such bars and rebuilt the whole widget area twice a second.
        const at = dock === "off" ? undefined : data.dockAt;
        if (at !== dockAt) {
          dockAt = at; dockTui = undefined;
          ctx.ui.setWidget("durable-subagents", at ? (tui, theme) => {
            dockTui = tui;
            return {
              invalidate() {},
              render(width) {
                // One column of margin on each side, like pi's own text and status lines.
                const inner = Math.max(1, width - 2);
                const rows = dockRows(inner).map(row => truncateToWidth(oneLine(row), inner));
                // Agent rows read left to right and stay quiet; a question is the one thing that stands out. The last
                // line (the summary or the completion sentence) sits on the right.
                return rows.map((row, i) => ` ${i === rows.length - 1 ? theme.fg("dim", right(row, inner)) : row.startsWith("? ") ? theme.fg("warning", row) : theme.fg("muted", row)}`);
              },
            };
          } : undefined, { placement: at === "above" ? "aboveEditor" : "belowEditor" });
        }
        const shown = dockRows(200).join("\n");
        if (shown !== lastDock) { lastDock = shown; dockTui?.requestRender(); }
        screen?.refresh();
      } catch { /* P21: journal or UI unavailability must not interrupt the main agent. */ }
    };
    try {
      refresh();
      const open = (): "opened" | "empty" | "busy" => {
        if (stopped || opening) return "busy";
        if (!data.workflows.length) return "empty";
        opening = true;
        void (async () => { await ctx.ui.custom<void>((tui, theme, _keys, done) => {
          closeScreen = () => done();
          screen = new SubagentScreen(data, actions, ctx, tui, theme, closeScreen, state);
          return screen;
        }, { overlay: true, overlayOptions: () => screen?.overlay() ?? { anchor: "center", width: "85%", maxHeight: "60%", margin: 1 } }); })().catch(() => {}).finally(() => { screen?.dispose(); screen = undefined; closeScreen = undefined; opening = false; });
        return "opened";
      };
      openList = open;
      unsubscribe = ctx.ui.onTerminalInput(key => {
        if (stopped || opening || !matchesKey(key, "down") || ctx.ui.getEditorText() !== "" || !data.workflows.length) return;
        open();
        return { consume: true };
      });
      timer = setInterval(refresh, 500); timer.unref(); cleanup = stop;
    } catch { stop(); }
  };
  pi.on("session_start", start);
  pi.on("session_shutdown", () => { cleanup?.(); cleanup = undefined; });
}
