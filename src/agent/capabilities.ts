// Upgrade safety (robustness.md layer 3, AC5): probe every pi surface we use before registering anything.
// A missing tier-0 surface disables Durable Subagents with one exact message; a missing UI surface disables only
// the UI. Never a silent failure, never a crash of pi.

/** Tier 0 = execution (tool, boundaries, receipts); tier 2 = native watch UI. */
export interface Surface { tier: 0 | 2; where: string; name: string }
export const SURFACES: readonly Surface[] = [
  ...["on", "registerTool", "appendEntry", "sendMessage", "setModel", "setThinkingLevel"].map(name => ({ tier: 0 as const, where: "ExtensionAPI", name })),
  { tier: 0, where: "@earendil-works/pi-coding-agent", name: "defineTool" },
  { tier: 0, where: "@earendil-works/pi-ai", name: "Type" },
  ...["AssistantMessageComponent", "UserMessageComponent", "ToolExecutionComponent", "getMarkdownTheme", "getSelectListTheme"]
    .map(name => ({ tier: 2 as const, where: "@earendil-works/pi-coding-agent", name })),
  ...["Input", "SelectList", "matchesKey", "truncateToWidth", "visibleWidth"].map(name => ({ tier: 2 as const, where: "@earendil-works/pi-tui", name })),
];
export interface CapabilityReport { version?: string; missing: Surface[]; execution: boolean; ui: boolean; messages: string[] }

/** AC5, P21: Check the surfaces present in pi's modules and extension API; produce exact degradation messages. */
export function checkCapabilities(modules: Record<string, Record<string, unknown> | undefined>, api: object, version?: string): CapabilityReport {
  const has = (s: Surface) => s.where === "ExtensionAPI" ? typeof (api as Record<string, unknown>)[s.name] === "function" : modules[s.where]?.[s.name] !== undefined;
  const missing = SURFACES.filter(s => !has(s));
  const name = (list: Surface[]) => list.map(s => `${s.where}.${s.name}`).join(", ");
  const pi = version ? `pi ${version}` : "this pi version";
  const execution = !missing.some(s => s.tier === 0), ui = execution && !missing.some(s => s.tier === 2);
  const messages: string[] = [];
  if (!execution) messages.push(`Durable Subagents disabled: ${pi} no longer provides ${name(missing.filter(s => s.tier === 0))}. Running workflows are untouched; run \`pi-durable-subagents smoke\` for details.`);
  else if (!ui) messages.push(`Durable Subagents: native watch view disabled (${pi} no longer exports ${name(missing.filter(s => s.tier === 2))}); use \`pi-durable-subagents tail\`.`);
  return { ...(version ? { version } : {}), missing, execution, ui, messages };
}
