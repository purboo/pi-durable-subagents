// R-AC2 / AC5 mutation checks: removing any surface produces the documented degradation and message.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as coding from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import * as ai from "@earendil-works/pi-ai";
import { SURFACES, checkCapabilities } from "../../../src/agent/capabilities.ts";

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
