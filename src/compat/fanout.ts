import type { CallSpec } from "../types.ts";

export type Fanout = { tasks: readonly CallSpec[]; chain?: never } | { chain: readonly CallSpec[]; tasks?: never };
export interface CompiledFanout { source: string; steps: { key: string; spec: CallSpec }[] }

/** P34, P11: Compile pinned parallel or sequential calls with deterministic keys. */
export function compileFanout(input: Fanout): CompiledFanout {
  if ((input.tasks === undefined) === (input.chain === undefined)) throw new Error("Provide exactly one of tasks or chain");
  const kind = input.tasks !== undefined ? "tasks" : "chain";
  const specs = input.tasks ?? input.chain!;
  const steps = specs.map((spec, i) => {
    if (typeof spec.agent !== "string" || !spec.agent.trim() || typeof spec.task !== "string") throw new Error(`Invalid ${kind} step ${i}`);
    return { key: `${kind}:${i}`, spec: JSON.parse(JSON.stringify(spec)) as CallSpec };
  });
  const prefix = `const steps = ${JSON.stringify(steps)};\n`;
  const source = kind === "tasks"
    ? prefix + "return await runs.all(steps.map(({key, spec}) => ({...spec, key})));\n"
    : prefix + `const results = [];
let previous = "";
for (let i = 0; i < steps.length; i++) {
  const {key, spec} = steps[i];
  const result = await runs.run(key, {...spec, task: spec.task.replaceAll("{previous}", () => previous)});
  results.push(result);
  if (!result.ok) {
    const skipped = steps.slice(i + 1).map(({key}) => ({key, gen: 1, status: "skipped", ok: false, output: ""}));
    results.push(...skipped);
    if (skipped.length) emit({type: "skipped", keys: skipped.map(result => result.key)});
    break;
  }
  previous = result.output;
}
return results;
`;
  return { source, steps };
}
