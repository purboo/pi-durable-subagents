// R-AC2 / AC5 mutation checks: removing any surface produces the documented degradation and message.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as coding from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import * as ai from "@earendil-works/pi-ai";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SURFACES, checkCapabilities } from "../../../src/agent/capabilities.ts";
import { childRefusal } from "../../../src/agent/extension.ts";

const fn = () => {};
const api = { on: fn, registerTool: fn, appendEntry: fn, sendMessage: fn, setModel: fn, setThinkingLevel: fn };
const real = () => ({ "@earendil-works/pi-coding-agent": { ...coding }, "@earendil-works/pi-tui": { ...tui }, "@earendil-works/pi-ai": { ...ai } }) as Record<string, Record<string, unknown>>;

test("the installed pi provides every surface", () => {
  const report = checkCapabilities(real(), api, "1.0.2");
  assert.deepEqual(report.missing, []); assert.ok(report.execution && report.ui); assert.deepEqual(report.messages, []);
});

for (const surface of SURFACES) test(`removing ${surface.where}.${surface.name} degrades tier ${surface.tier} with an exact message`, () => {
  const modules = real(), methods: Record<string, unknown> = { ...api };
  if (surface.where === "ExtensionAPI") delete methods[surface.name]; else delete modules[surface.where]![surface.name];
  const report = checkCapabilities(modules, methods, "9.9.9");
  assert.deepEqual(report.missing, [surface]);
  assert.equal(report.execution, surface.tier !== 0);
  assert.equal(report.ui, false);
  assert.equal(report.messages.length, 1);
  assert.match(report.messages[0]!, new RegExp(`pi 9\\.9\\.9 no longer (provides|exports) ${surface.where}\\.${surface.name}`));
  assert.match(report.messages[0]!, surface.tier === 0 ? /^Durable Subagents disabled: .*Running workflows are untouched/ : /^Durable Subagents: native watch view disabled/);
});

test("P21 a child missing execution surfaces is refused; main sessions and complete children proceed", () => {
  const broken = checkCapabilities(real(), { ...api, registerTool: undefined }, "9.9.9"), full = checkCapabilities(real(), api, "1.0.2");
  assert.equal(childRefusal(broken, { DSA_EXEC: "w@1/a@1#1.1" }), broken.messages[0]);
  assert.match(childRefusal(broken, { DSA_EXEC: "w@1/a@1#1.1" })!, /^Durable Subagents disabled: pi 9\.9\.9 no longer provides ExtensionAPI\.registerTool/);
  assert.equal(childRefusal(broken, {}), undefined);
  assert.equal(childRefusal(full, { DSA_EXEC: "w@1/a@1#1.1" }), undefined);
});

test("P21 the child extension exits 3 with the exact message on stderr", { timeout: 30000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "dsa-refusal-")); t.after(() => rm(home, { recursive: true, force: true }));
  const extension = fileURLToPath(new URL("../../../src/agent/extension.ts", import.meta.url));
  const source = `const { default: load } = await import(${JSON.stringify(pathToFileURL(extension).href)}); const f = () => {};
await load({ on: f, appendEntry: f, sendMessage: f, setModel: f, setThinkingLevel: f }); console.log("continued");`;
  const env = { PATH: process.env.PATH, HOME: home, DSA_HOME: join(home, "dsa"), PI_CODING_AGENT_DIR: join(home, "agent"), DSA_EXEC: "w@1/a@1#1.1" };
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env, encoding: "utf8", timeout: 20000 });
  assert.equal(child.status, 3);
  assert.equal(child.stdout, "");
  assert.match(child.stderr, /^Durable Subagents disabled: .* no longer provides ExtensionAPI\.registerTool\. Running workflows are untouched/);
});
