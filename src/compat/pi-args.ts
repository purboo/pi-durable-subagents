import type { CallSpec } from "../types.ts";
import type { AgentDefinition } from "./agents.ts";
import { parseModel, thinkingLevels, type Model } from "./model.ts";

export interface PiArgsOptions {
  sessionPath: string;
  systemPromptPath: string;
  continuation?: boolean;
  /** A candidate selected and recorded by the orchestrator when using pools. */
  model?: Model;
  /** Resolve logical skill names to pinned skill files or directories. */
  resolveSkill?: (name: string) => string;
}

/** C5, C8, P35: Build pi 1.0.2 RPC flags, preserving restored models on continuation. */
export function buildPiArgs(agent: AgentDefinition, spec: CallSpec, options: PiArgsOptions): string[] {
  const args = ["--mode", "rpc", "--session", options.sessionPath,
    agent.systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt", options.systemPromptPath];
  const tools = spec.tools ?? agent.tools;
  if (tools) args.push(...(tools.length ? ["--tools", tools.join(",")] : ["--no-tools"]));
  if (!agent.inheritProjectContext) args.push("--no-context-files");
  if (!agent.inheritSkills) args.push("--no-skills");
  for (const skill of spec.skills ?? agent.skills ?? []) args.push("--skill", options.resolveSkill?.(skill) ?? skill);
  if (!options.continuation) {
    const raw = spec.model ?? agent.model;
    const model = options.model ?? (raw ? parseModel(raw) : undefined);
    if (model) args.push("--model", model.provider ? `${model.provider}/${model.id}` : model.id);
    const thinking = model?.thinking ?? agent.thinking;
    if (thinking !== undefined && thinking !== false) {
      if (!thinkingLevels.includes(thinking as typeof thinkingLevels[number])) throw new Error(`Invalid thinking level: ${thinking}`);
      args.push("--thinking", thinking);
    }
  }
  return args;
}
