// EX1: the capture of a top-level pi session.
//
// The dsa extension, loaded in a session that is not inside a dsa call (DSA_CALL/DSA_EXEC unset), observes every
// provider request the session makes. The payload is not changed: the handler returns nothing. The latest request is
// kept in memory and written to `<dsa home>/exact/<sessionId>.json` (mode 0600, atomic replace), off the request path:
// the write is never awaited by the request, and a failed write neither fails nor delays the request.
//
// While the configuration disables the capture (`exactCapture: false`), no file is written and an exact run falls
// back (reason `no-capture`).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dsaHome } from "../../paths.ts";
import { writeCapture, type Capture, type ProviderPayload } from "./capture.ts";
import { clone } from "./splice.ts";

/** The home of the dsa state (the captures live under it): $DSA_HOME or the default state root. */
export const homeOf = (env: NodeJS.ProcessEnv = process.env) => dsaHome(env);

/** Whether the capture is on (the `exactCapture` key of config.json; default true). */
export async function captureEnabled(home: string): Promise<boolean> {
  if (!home) return false;
  try {
    const raw = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as Record<string, unknown>;
    return raw?.exactCapture !== false;
  } catch { return true; }
}

/**
 * Register the capture of a top-level session. The handler keeps the payload unchanged; the write happens after the
 * request was handed to the provider.
 */
export async function registerCapture(pi: ExtensionAPI, home: string): Promise<void> {
  if (!home || !(await captureEnabled(home))) return;
  let writing: Promise<void> = Promise.resolve();
  pi.on("before_provider_request", (event, ctx: ExtensionContext) => {
    const payload = event.payload as ProviderPayload | undefined;
    if (!payload || typeof payload !== "object") return;
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (!sessionId) return;
    const model = ctx.model;
    // The capture is a snapshot: the payload of the request, not the object the runtime may still change.
    const capture: Capture = { sessionId, provider: model?.provider ?? "", model: model?.id ?? "",
      api: model?.api ?? "", ...(ctx.thinkingLevel ? { thinking: String(ctx.thinkingLevel) } : {}),
      at: Date.now(), payload: clone(payload) };
    // Off the request path: the write is queued, never awaited here, and a failure is swallowed.
    writing = writing.then(() => writeCapture(home, capture).catch(() => undefined)).catch(() => undefined);
  });
}
