import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { discoverAgents, parseAgent } from "../../../src/compat/agents.ts";
import { parseFrontmatter, parseFrontmatterList } from "../../../src/compat/frontmatter.ts";

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "dsa-compat-"));
  const cwd = join(home, "project");
  mkdirSync(cwd);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const put = (p: string, text: string) => { mkdirSync(dirname(join(home, p)), { recursive: true }); writeFileSync(join(home, p), text); };
  const agent = (p: string, description: string, name = "worker", fields = "") => put(p, `---\nname: ${name}\ndescription: ${description}\n${fields}---\nbody ${description}`);
  const discover = (scope: "user" | "project" | "both" = "both", at = cwd) => discoverAgents(at, { home, agentDir: join(home, ".pi/agent"), scope, builtinDir: join(home, "builtins"), globalNpmRoot: null, extraAgentDirs: [] });
  return { home, cwd, put, agent, discover };
}

test("upstream agents.js:2178: shipped native builtins are package-relative, isolated from HOME", t => {
  const f = fixture(t);
  const agents = discoverAgents(f.cwd, { home: f.home, agentDir: join(f.home, ".pi/agent"), globalNpmRoot: null, extraAgentDirs: [] }).agents;
  assert.deepEqual(agents.map(a => a.name).sort(), ["delegate", "evidence-auditor", "oracle", "researcher", "reviewer", "scout", "worker"]);
  for (const agent of agents) {
    assert.equal(agent.source, "builtin");
    assert.ok(agent.sourcePath.startsWith(fileURLToPath(new URL("../../../agents/", import.meta.url))));
    assert.ok(!agent.tools?.some(t => ["contact_supervisor", "watchdog_diff", "intercom"].includes(t)));
  }
  f.put("project/.pi/settings.json", JSON.stringify({ subagents: { disableBuiltins: true } }));
  assert.deepEqual(discoverAgents(f.cwd, { home: f.home, agentDir: join(f.home, ".pi/agent"), globalNpmRoot: null, extraAgentDirs: [] }).agents, []);
});

test("upstream agents.js:2370–2397,2522–2545: user/project and legacy precedence", t => {
  const f = fixture(t);
  f.agent("builtins/worker.md", "builtin");
  f.agent(".pi/agent/agents/nested/worker.md", "old user");
  f.agent(".agents/worker.md", "new user");
  f.agent("project/.agents/worker.md", "legacy project");
  f.agent("project/.pi/agents/deep/worker.md", "project");
  assert.equal(f.discover().agents[0]?.description, "project");
  assert.equal(f.discover("user").agents[0]?.description, "new user");
  assert.equal(f.discover("project").agents[0]?.description, "project");
  assert.equal(f.discover("both", f.home).agents[0]?.description, "new user");
});

test("upstream agents.js:238–399,2530–2540: manifest shapes, package roots and first package wins", t => {
  const f = fixture(t);
  f.put("project/package.json", JSON.stringify({ "pi-subagents": { agents: ["./roles"] } }));
  f.agent("project/roles/worker.md", "root package");
  f.put("project/.pi/npm/node_modules/@scope/pkg/package.json", JSON.stringify({ pi: { subagents: { agents: ["./roles"] } } }));
  f.agent("project/.pi/npm/node_modules/@scope/pkg/roles/worker.md", "project package");
  f.agent("project/.pi/npm/node_modules/@scope/pkg/roles/extra.md", "extra", "extra");
  f.put(".pi/agent/settings.json", JSON.stringify({ packages: [{ source: "./local" }] }));
  f.put(".pi/agent/local/package.json", JSON.stringify({ "pi-subagents": { agents: ["roles"] } }));
  f.agent(".pi/agent/local/roles/user.md", "user package", "user-package");
  assert.equal(f.discover().agents.find(a => a.name === "worker")?.description, "root package");
  assert.ok(f.discover().agents.some(a => a.name === "extra"));
  assert.ok(f.discover().agents.some(a => a.name === "user-package"));
  assert.ok(!f.discover("project").agents.some(a => a.name === "user-package"));
  assert.ok(!f.discover("user").agents.some(a => a.name === "extra"));
  f.agent("project/.pi/agents/custom.md", "custom");
  assert.equal(f.discover().agents.find(a => a.name === "worker")?.description, "custom");
});

test("upstream agents.js:1604–1613,1680–1752: recursive pruning, symlink cycles and chain exclusion", t => {
  const f = fixture(t);
  f.agent("project/.agents/nested/good.md", "good", "good");
  for (const dir of ["skills", ".git", "node_modules", ".pi", "sync-backups"]) f.agent(`project/.agents/${dir}/bad.md`, "bad", dir);
  f.agent("project/.agents/nested/ignore.chain.md", "chain", "chain");
  f.agent("project/.agents/embedded/bad.md", "nested project", "nested");
  f.put("project/.agents/embedded/.git", "gitdir: elsewhere");
  symlinkSync(join(f.cwd, ".agents"), join(f.cwd, ".agents/nested/cycle"));
  assert.deepEqual(f.discover().agents.map(a => a.name), ["good"]);
});

test("upstream agents.js:600–657: nearest project and explicit git-root resolution", t => {
  const f = fixture(t);
  f.agent("project/.pi/agents/root.md", "root");
  f.agent("project/nested/.pi/agents/near.md", "near");
  f.put("project/.git", "gitdir");
  assert.equal(f.discover("both", join(f.cwd, "nested")).agents[0]?.description, "near");
  f.put("project/.pi/settings.json", JSON.stringify({ subagents: { projectRootResolution: "git-root" } }));
  assert.equal(f.discover("both", join(f.cwd, "nested")).agents[0]?.description, "root");
});

test("upstream agents.js:2186–2280,2390: scan roots, literal exclusions and fixed-root priority", t => {
  const f = fixture(t);
  f.agent("extras/a/roles/scan.md", "scan");
  f.agent("extras/b/roles/other.md", "other", "other");
  f.agent("project/.pi/agents/fixed.md", "fixed");
  f.agent("project/.pi/agents/excluded/no.md", "excluded", "excluded");
  f.agent("project/.agents/legacy.md", "legacy", "legacy");
  f.put("project/.pi/settings.json", JSON.stringify({ subagents: { agentScanDirs: [join(f.home, "extras/*/roles")], agentExcludeDirs: ["agents/excluded"] } }));
  symlinkSync(join(f.cwd, ".pi/agents/excluded"), join(f.cwd, ".pi/agents/alias"));
  const names = f.discover().agents.map(a => a.name).sort();
  assert.deepEqual(names, ["legacy", "other", "worker"]);
  assert.equal(f.discover().agents.find(a => a.name === "worker")?.description, "fixed");
});

test("upstream frontmatter.js:61–144 and agents.js:1893–1952: scalar/block normalization", () => {
  const text = `---\r\nname: 'delegate'\r\ndescription: >-\r\n  first\r\n  second\r\n\r\n  paragraph\r\ntools:\r\n  - read, grep\r\n  - custom-tool\r\nskill: chosen\r\nskills: ignored\r\nmodel: provider/id:high\r\nthinking: false\r\ndefaultContext: fork\r\ninheritSkills: true\r\n---\r\n  body  \r\n`;
  const agent = parseAgent(text, "/tmp/agent.md")!;
  assert.equal(agent.description, "first second\nparagraph");
  assert.equal(agent.body, "body");
  assert.equal(agent.systemPromptMode, "append");
  assert.equal(agent.inheritProjectContext, true);
  assert.equal(agent.inheritSkills, true);
  assert.equal(agent.defaultContext, "fork");
  assert.equal(agent.thinking, false);
  assert.deepEqual(agent.tools, ["read", "grep", "custom-tool"]);
  assert.deepEqual(agent.skills, ["chosen"]);
  assert.equal(parseAgent("---\nname: no-description\n---\nbody", "/tmp/x"), undefined);
  assert.equal(parseFrontmatter("plain\r\ntext").body, "plain\ntext");
  assert.equal(parseFrontmatter("---\nunfinished").body, "---\nunfinished");
  assert.deepEqual(parseFrontmatterList("[read, grep]"), ["[read", "grep]"]); // Upstream intentionally is not a YAML sequence parser.
  assert.equal(parseFrontmatter("---\na: |\n  a\n\n  b\n---").frontmatter.a, "a\n\nb");
  assert.equal(parseFrontmatter("---\na: >\n  a\n    code\n  b\n---").frontmatter.a, "a\n  code\nb");
});

test("upstream identity.js:1–25 and agents.js:1884–2105: identities and invalid definitions", t => {
  const f = fixture(t);
  f.agent("project/.pi/agents/name.md", "packaged", "reader", "package: Acme Tools!\n");
  f.agent("project/.pi/agents/bad.md", "invalid", "bad", "fallbackModels: old\n");
  const result = f.discover();
  assert.equal(result.agents[0]?.name, "acme-tools.reader");
  assert.equal(result.diagnostics.length, 1);
  assert.ok(result.agents[0]?.sourcePath.endsWith("name.md"));
});

test("upstream agents.js:1337–1364: project builtin override precedes bulk disable", t => {
  const f = fixture(t);
  f.agent("builtins/worker.md", "builtin");
  f.agent("builtins/scout.md", "builtin scout", "scout");
  f.put("project/.pi/settings.json", JSON.stringify({ subagents: {
    disableBuiltins: true, agentOverrides: { worker: { disabled: false } },
  } }));
  assert.deepEqual(f.discover().agents.map(a => a.name), ["worker"]);
});

test("upstream agents.js:1337–1364,1375–1388: whole project builtin override; custom fields merge", t => {
  const f = fixture(t);
  f.agent("builtins/worker.md", "builtin");
  f.agent("project/.pi/agents/custom.md", "custom", "custom");
  f.put(".pi/agent/settings.json", JSON.stringify({ subagents: { agentOverrides: {
    worker: { disabled: true, model: "user/model" }, custom: { disabled: true },
  } } }));
  f.put("project/.pi/settings.json", JSON.stringify({ subagents: { agentOverrides: {
    worker: { description: "project worker" }, custom: { description: "project custom" },
  } } }));
  const agents = f.discover().agents;
  assert.deepEqual(agents.map(a => a.name), ["worker"]);
  assert.equal(agents[0]?.description, "project worker");
  assert.equal(agents[0]?.model, undefined);
});

test("upstream agents.js:1337–1364: builtin user overrides and thinking respect project policy", t => {
  const f = fixture(t);
  f.agent("builtins/worker.md", "builtin", "worker", "thinking: high\n");
  f.agent("builtins/scout.md", "builtin scout", "scout", "thinking: high\n");
  f.put(".pi/agent/settings.json", JSON.stringify({ subagents: {
    disableBuiltins: true, disableThinking: true, agentOverrides: { worker: { disabled: false, thinking: "low" } },
  } }));
  assert.deepEqual(f.discover().agents.map(a => [a.name, a.thinking]), [["worker", "low"]]);
  f.put("project/.pi/settings.json", JSON.stringify({ subagents: { disableBuiltins: false, disableThinking: true } }));
  assert.deepEqual(f.discover().agents.map(a => [a.name, a.thinking]), [["scout", undefined], ["worker", undefined]]);
  f.put("project/.pi/settings.json", JSON.stringify({ subagents: {
    disableBuiltins: true, disableThinking: true, agentOverrides: { worker: { thinking: "medium" } },
  } }));
  assert.deepEqual(f.discover().agents.map(a => [a.name, a.thinking]), [["worker", "medium"]]);
  f.put("project/.pi/settings.json", JSON.stringify({ subagents: { disableBuiltins: true } }));
  assert.deepEqual(f.discover().agents, []);
});

test("upstream agents.js:725–933,2510–2545: project overrides and malformed selected settings", t => {
  const f = fixture(t);
  f.agent(".pi/agent/agents/worker.md", "original", "worker", "tools: read\n");
  f.put(".pi/agent/settings.json", JSON.stringify({ subagents: { defaultModel: "a/b", agentOverrides: { worker: { description: "user", tools: "inherit" } } } }));
  f.put("project/.pi/settings.json", JSON.stringify({ subagents: { agentOverrides: { worker: { description: "project", systemPrompt: "override" } } } }));
  const agent = f.discover().agents[0]!;
  assert.equal(agent.description, "project");
  assert.equal(agent.model, "a/b");
  assert.equal(agent.body, "override");
  assert.equal(agent.tools, undefined);
  f.put(".pi/agent/settings.json", "bad json");
  assert.throws(() => f.discover("user"));
  assert.doesNotThrow(() => f.discover("project"));
});
