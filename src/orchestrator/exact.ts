// EX2, EX3, EX5: the exact side of the orchestrator.
//
// Admission (EX2): a run that can ask for `context: "exact"` pins the capture of its origin session: the bytes are
// copied into the run's pinned files and its sha256, size, `at`, provider, model, api and thinking are recorded.
// Later captures never change a pinned run: the pinned bytes are the ones the child splices.
//
// Launch (EX3, EX5): an exact call runs on the captured provider/model and thinking (it holds that provider's slot
// and waits for it like any launch; there is no pool failover). When it cannot be exact, it runs as `context: "fork"`
// (with FC1) and the reason is recorded: `no-capture`, `api:<name>`, `model-unknown` or `no-payload-hook`.
import { readFile } from "node:fs/promises";
import { captureFacts, readCapture, supportedApi, type Capture, type CaptureFacts } from "../agent/exact/capture.ts";

/** Why an exact call could not be exact and runs as a fork instead. */
export type ExactReason = "no-capture" | "model-unknown" | "no-payload-hook" | `api:${string}`;
/** What a call knows about its exactness. */
export interface ExactFacts {
  mode: "exact" | "rebuilt";
  reason?: ExactReason;
  /** The pinned capture's identity (absent when there was none). */
  capture?: CaptureFacts;
  /** The provider and model of the capture (the model the exact call runs on). */
  provider?: string;
  model?: string;
  /** The age of the capture at the launch of the call (ms). */
  ageMsAtLaunch?: number;
}

/** The capture of a session, read from the capture directory of the dsa home. */
export async function captureOf(home: string, sessionId: string | undefined): Promise<Capture | undefined> {
  if (!sessionId) return undefined;
  return readCapture(home, sessionId);
}

/** The facts of a capture, with its bytes (the pinned copy the child splices). */
export function factsOf(capture: Capture): { facts: CaptureFacts; bytes: string } {
  return { facts: captureFacts(capture), bytes: JSON.stringify(capture.payload) };
}

/**
 * Whether the captured provider/model is still configured (EX5: `model-unknown`).
 *
 * The orchestrator knows the providers of its own configuration (their slots and their quota state) and the models of
 * its pools. A capture of a provider that none of them names is a capture of a provider that is no longer configured
 * here: the exact call cannot run on it and is rebuilt as a fork. A configuration that names no provider at all (the
 * default: every provider is unlimited) configures every provider.
 */
export function modelConfigured(config: { providers?: Record<string, unknown>; pools?: Record<string, unknown>; defaultModel?: string },
  provider: string, model: string): boolean {
  if (!provider || !model) return false;
  const providers = config.providers ?? {}, pools = config.pools ?? {};
  // Every provider the configuration names: its slots, its pools and its default model.
  const named = new Set<string>(Object.keys(providers));
  for (const list of Object.values(pools)) {
    for (const entry of (Array.isArray(list) ? list : []) as unknown[]) {
      const name = typeof entry === "string" ? entry : entry && typeof entry === "object" ? String((entry as { model?: unknown }).model ?? "") : "";
      if (name) named.add(name.split("/")[0]!);
    }
  }
  if (config.defaultModel) named.add(config.defaultModel.split("/")[0]!);
  // A configuration that names no provider at all configures every provider.
  return named.size ? named.has(provider) : true;
}

/** The decision of an exact call at launch (EX5): it is exact, or it is rebuilt as a fork with a reason. */
export function exactDecision(options: { capture?: Capture; configured: boolean }): { mode: "exact" | "rebuilt"; reason?: ExactReason } {
  const { capture } = options;
  if (!capture) return { mode: "rebuilt", reason: "no-capture" };
  if (!supportedApi(capture.api)) return { mode: "rebuilt", reason: `api:${capture.api}` };
  if (!options.configured) return { mode: "rebuilt", reason: "model-unknown" };
  return { mode: "exact" };
}

/** The pinned capture of a run, read from its pinned file. */
export async function readPinnedCapture(path: string | undefined): Promise<Capture | undefined> {
  if (!path) return undefined;
  try {
    const capture = JSON.parse(await readFile(path, "utf8")) as Capture;
    if (!capture || typeof capture !== "object" || !capture.payload || typeof capture.payload !== "object") return undefined;
    return capture;
  } catch { return undefined; }
}
