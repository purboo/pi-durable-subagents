// Restart guards shared by the orchestrator and the legacy client. The caller owns the launch gate;
// these checks never change durable state. A1: only an accepted restart is appended to the ledger.
import { contentHash } from "../kernel/ids.ts";
import { holdDetail, leaseState, who } from "../platform/lease.ts";
import type { RestartBody, RestartInitiator } from "../types.ts";
import type { LiveExecution } from "./contract.ts";

export type RestartExecution = LiveExecution & { origin?: string };
export const subagentRestartError = "a subagent cannot force a restart: it would fence itself and other sessions' work; ask the user";
export const restartToken = (live: readonly { exec: string }[]): string => contentHash(live.map(l => l.exec).sort()).slice(0, 12);
/** Old senders' boolean force is read only to refuse it when executions are live. */
export const isForceRestart = (body: RestartBody): boolean => body.token !== undefined || (body as { force?: unknown }).force === true;
export function restartInputError(body: RestartBody, subagent = false): string | undefined {
  const force = isForceRestart(body);
  if (force && (subagent || body.initiator && "call" in body.initiator)) return subagentRestartError;
  // An old client's bare `force: true` carries no reason: it is never a force (no token) and is refused with the
  // list of running executions, so it is not rejected for the missing reason first.
  if ((body.token !== undefined || body.reason !== undefined) && (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 500)) return "restart reason must be non-empty and at most 500 characters (force requires --reason)";
  if (body.token !== undefined && (typeof body.token !== "string" || !/^[a-f0-9]{12}$/.test(body.token))) return "restart force needs the 12-hex token from a refused restart; first show the user the running executions";
  return undefined;
}
export function restartRefusal(home: string, live: readonly RestartExecution[], body: RestartBody, tool = false, now = Date.now()): string | undefined {
  const invalid = restartInputError(body);
  if (invalid) return invalid;
  if (!live.length) return undefined;
  const token = restartToken(live);
  if (body.token === token) return undefined;
  // What a fence would cut short: each lease a listed call holds, with its age and command. Holders outside these
  // executions (a shell, a systemd unit, another call) keep their lease across the restart; they are listed so the
  // machine is not mistaken for free.
  const leases = new Map<string, string>(), others: string[] = [], calls = new Set(live.map(l => l.callId));
  for (const { resource, holders } of leaseState(home)) for (const t of holders) {
    if (t.call && calls.has(t.call)) leases.set(t.call, [leases.get(t.call), `holds lease ${resource} (${holdDetail(t, now)})`].filter(Boolean).join(", "));
    else others.push(`  ${resource} held by ${who(t)} (${holdDetail(t, now)})`);
  }
  const groups = new Map<string, RestartExecution[]>();
  for (const l of live) { const origin = l.origin ?? "unknown"; groups.set(origin, [...(groups.get(origin) ?? []), l]); }
  const age = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`;
  return [
    ...(body.token ? [`the running executions changed since ${body.token}`] : isForceRestart(body) ? ["force without a token is refused; first show the user the running executions"] : []),
    `busy: ${live.length} running execution${live.length === 1 ? "" : "s"} — fencing them interrupts these sessions:`,
    ...[...groups].sort(([a], [b]) => a.localeCompare(b)).flatMap(([origin, executions]) => [
      `${origin}:`, ...executions.map(l => `  ${l.wid}/${l.key} ${age(now - l.since)}${l.phase === "gate" ? " gate" : ""}${leases.has(l.callId) ? ` ${leases.get(l.callId)}` : ""}`),
    ]),
    ...(others.length ? ["not fenced (a restart leaves these leases held):", ...others] : []),
    `token: ${token}`,
    tool ? `to fence exactly these: subagents {action:"restart", force:"${token}", reason:"<why>"}` : `to fence exactly these: pi-durable-subagents restart --force ${token} --reason "<why>"`,
  ].join("\n");
}
/** Status is one line even if the reason or parent command contained newlines. */
export const restartLine = (s: string): string => s.replace(/\s+/g, " ").trim();
export function initiatorSummary(initiator: RestartInitiator | undefined, from?: string): string {
  if (initiator && "call" in initiator) return restartLine(initiator.call);
  if (initiator && "origin" in initiator) return restartLine(initiator.origin);
  if (initiator && "cli" in initiator) return restartLine(`cli:${initiator.cli.user}@${initiator.cli.host}`);
  return restartLine(from ?? "unknown");
}
