import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { UiDeps } from "../agent/main.ts";
import { UiActions, UiData } from "./data.ts";
import { SubagentScreen } from "./screen.ts";
import { mainLine, orderWorkflows, type ViewState } from "./view.ts";
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
  let cleanup: (() => void) | undefined;
  const start = (_event: unknown, ctx: ExtensionContext) => {
    cleanup?.(); cleanup = undefined;
    if (ctx.mode !== "tui" || !ctx.hasUI || !ctx.ui?.custom || !ctx.ui?.onTerminalInput || !ctx.ui?.setWidget) return;
    const data = new UiData(deps.home), actions = new UiActions(deps);
    const state: ViewState = { folded: new Set(), done: new Map(), viewed: new Set(), finished: false };
    let screen: SubagentScreen | undefined, opening = false, stopped = false, closeScreen: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined, timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      stopped = true; clearInterval(timer); unsubscribe?.(); screen?.dispose(); closeScreen?.();
      try { ctx.ui.setWidget("durable-subagents", undefined); } catch { /* P21: disappearing UI surface. */ }
    };
    const refresh = () => {
      if (stopped) return;
      try {
        data.refresh(); actions.reconcile();
        for (const result of actions.resolutions.splice(0)) screen?.controlResult(result);
        const own = `main:${ctx.sessionManager.getSessionId()}`;
        data.workflows = orderWorkflows(data.workflows, own);
        const line = mainLine(data.workflows);
        ctx.ui.setWidget("durable-subagents", line ? (_tui, theme) => ({
          invalidate() {},
          render(width) { const text = truncateToWidth(line, width); return [theme.fg("dim", " ".repeat(Math.max(0, width - visibleWidth(text))) + text)]; },
        }) : undefined, { placement: "aboveEditor" });
        screen?.refresh();
      } catch { /* P21: journal or UI unavailability must not interrupt the main agent. */ }
    };
    try {
      refresh();
      unsubscribe = ctx.ui.onTerminalInput(key => {
        if (stopped || opening || !matchesKey(key, "down") || ctx.ui.getEditorText() !== "" || !data.workflows.length) return;
        opening = true;
        void (async () => { await ctx.ui.custom<void>((tui, theme, _keys, done) => {
          closeScreen = () => done();
          screen = new SubagentScreen(data, actions, ctx, tui, theme, closeScreen, state);
          return screen;
        }, { overlay: true, overlayOptions: () => screen?.overlay() ?? { anchor: "center", width: "85%", maxHeight: "60%", margin: 1 } }); })().catch(() => {}).finally(() => { screen?.dispose(); screen = undefined; closeScreen = undefined; opening = false; });
        return { consume: true };
      });
      timer = setInterval(refresh, 500); timer.unref(); cleanup = stop;
    } catch { stop(); }
  };
  pi.on("session_start", start);
  pi.on("session_shutdown", () => { cleanup?.(); cleanup = undefined; });
}
