import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseFrontmatter, parseFrontmatterList } from "./frontmatter.ts";

export interface AgentDefinition {
  name: string; description: string; model?: string; thinking?: string | false;
  tools?: string[]; skills?: string[];
  systemPromptMode: "append" | "replace";
  inheritProjectContext: boolean; inheritSkills: boolean;
  defaultContext?: "fresh" | "fork";
  body: string; sourcePath: string; source: "builtin" | "package" | "user" | "project";
}
export interface DiscoveryOptions {
  home?: string; agentDir?: string; scope?: "user" | "project" | "both";
  builtinDir?: string; extraAgentDirs?: readonly string[];
  globalNpmRoot?: string | null;
}
type Settings = Record<string, any>;
const directory = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const canonical = (p: string): string => { try { return fs.realpathSync(p); } catch { const parent = path.dirname(p); return parent === p ? p : path.join(canonical(parent), path.basename(p)); } };
const within = (root: string, p: string) => { const r = path.relative(root, p); return r === "" || (!r.startsWith(`..${path.sep}`) && r !== ".." && !path.isAbsolute(r)); };
function json(file: string, strict = false): Settings {
  try {
    const result: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error(`Expected an object: ${file}`);
    return result as Settings;
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {};
  }
}
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
const expand = (value: string, home: string) => value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
function projectRoot(cwd: string, home: string): string | undefined {
  const candidates: string[] = [];
  let git: string | undefined;
  for (let p = cwd;; p = path.dirname(p)) {
    if (canonical(p) === canonical(home)) break;
    if (!git && fs.existsSync(path.join(p, ".git"))) git = p;
    if (directory(path.join(p, ".pi")) || directory(path.join(p, ".agents"))) candidates.push(p);
    if (p === path.dirname(p)) break;
  }
  for (const [i, candidate] of candidates.entries()) {
    const mode = json(path.join(candidate, ".pi/settings.json"), true).subagents?.projectRootResolution;
    if (mode === undefined) continue;
    if (mode === "nearest") break;
    if (mode !== "git-root") throw new Error(`Invalid projectRootResolution in ${candidate}`);
    return candidates.slice(i).find(p => p === git) ?? (fs.existsSync(path.join(candidate, ".git")) ? candidate : candidates[0]);
  }
  return candidates[0];
}
function files(root: string, excluded: (p: string) => boolean): string[] {
  const found: string[] = [], seen = new Set<string>();
  const visit = (dir: string) => {
    if (excluded(dir) || !directory(dir)) return;
    const real = canonical(dir);
    if (seen.has(real)) return;
    seen.add(real);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, entry.name);
      if (excluded(p)) continue;
      if (directory(p)) {
        if ([".git", "node_modules", ".pi", "sync-backups"].includes(entry.name) || fs.existsSync(path.join(p, ".git")) || directory(path.join(p, ".pi")) || directory(path.join(p, ".agents"))) continue;
        visit(p);
      } else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md") && !entry.name.endsWith(".chain.md")) {
        const parts = path.relative(root, p).toLowerCase().split(path.sep);
        if (path.basename(root).toLowerCase() === ".agents") parts.unshift(".agents");
        if (!parts.some((part, i) => part === ".agents" && parts[i + 1] === "skills")) found.push(p);
      }
    }
  };
  visit(root);
  return found;
}

/** P35: Normalize the supported native-agent fields using upstream agents.js:1884–2105. */
export function parseAgent(content: string, sourcePath: string, source: AgentDefinition["source"] = "user"): AgentDefinition | undefined {
  const { frontmatter: f, body } = parseFrontmatter(content);
  if (!f.name || !f.description) return undefined;
  if (f.fallbackModels !== undefined) throw new Error("fallbackModels is removed; configure one model");
  if (f.runner && !/^type:\s*pi\s*$/.test(f.runner)) throw new Error("External runners are unsupported");
  const pkg = f.package?.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9.-]/g, "").replace(/-+/g, "-").replace(/\.+/g, ".").replace(/(?:^[-.]+|[-.]+$)/g, "");
  if (f.package && (!pkg || !/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/.test(pkg))) throw new Error("Invalid agent package");
  const name = pkg ? `${pkg}.${f.name}` : f.name;
  return {
    name, description: f.description,
    ...(f.model !== undefined ? { model: f.model } : {}),
    ...(f.thinking !== undefined ? { thinking: f.thinking === "false" ? false : f.thinking } : {}),
    ...(f.tools !== undefined ? { tools: parseFrontmatterList(f.tools) } : {}),
    ...(f.skill || f.skills ? { skills: parseFrontmatterList(f.skill || f.skills) } : {}),
    systemPromptMode: f.systemPromptMode === "append" || f.systemPromptMode === "replace" ? f.systemPromptMode : f.name === "delegate" ? "append" : "replace",
    inheritProjectContext: f.inheritProjectContext === "true" || (f.inheritProjectContext !== "false" && f.name === "delegate"),
    inheritSkills: f.inheritSkills === "true",
    ...(f.defaultContext === "fork" || f.defaultContext === "fresh" ? { defaultContext: f.defaultContext } : {}),
    body, sourcePath: path.resolve(sourcePath), source,
  };
}
function packageRoots(nodeModules: string): string[] {
  if (!directory(nodeModules)) return [];
  return fs.readdirSync(nodeModules).filter(n => !n.startsWith(".")).flatMap(n => {
    const p = path.join(nodeModules, n);
    if (!directory(p)) return [];
    return n.startsWith("@") ? fs.readdirSync(p).filter(n => !n.startsWith(".")).map(n => path.join(p, n)).filter(directory) : [p];
  });
}
function settingsPackage(source: string, base: string, home: string): string | undefined {
  if (source.startsWith("npm:")) {
    const name = source.slice(4).trim().match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/)?.[1];
    if (name && !path.isAbsolute(name) && name.split(/[\\/]/).every(p => p && p !== "." && p !== "..")) return path.join(base, "npm/node_modules", name);
    return;
  }
  if (source.startsWith("git:") || /^https?:\/\//.test(source)) {
    const s = source.replace(/^git:/, "");
    let host: string, repo: string;
    try {
      const scp = s.match(/^git@([^:]+):(.+)$/);
      if (scp) { host = scp[1]!; repo = scp[2]!; }
      else { const url = new URL(s.includes("://") ? s : `https://${s}`); host = url.hostname; repo = url.pathname.replace(/^\/+/, ""); }
      repo = repo.split(/[@#]/)[0]!.replace(/\.git$/, "");
      if (repo.split("/").length >= 2 && [host, ...repo.split("/")].every(p => p && p !== "." && p !== "..")) return path.join(base, "git", host, repo);
    } catch { return; }
    return;
  }
  const local = expand(source.replace(/^file:/, ""), home);
  return path.isAbsolute(local) || /^\.{1,2}(\/|$)/.test(local) ? path.resolve(base, local) : undefined;
}
function scans(values: unknown, cwd: string, home: string): string[] {
  return strings(values).flatMap(value => {
    const p = path.resolve(cwd, expand(value.trim(), home).replace(/[\\/]+/g, path.sep));
    if (!p.includes("*")) return [p];
    const parts = p.split(path.sep), i = parts.indexOf("*");
    if (i < 0 || p.split("*").length !== 2) return [];
    const base = parts.slice(0, i).join(path.sep) || path.sep;
    if (!directory(base)) return [];
    return fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(base, e.name, ...parts.slice(i + 1)));
  });
}

/** P35, P11: Discover a fresh snapshot with upstream roots and scope precedence; never write. */
export function discoverAgents(cwd: string, options: DiscoveryOptions = {}): { agents: AgentDefinition[]; diagnostics: { sourcePath: string; error: string }[] } {
  cwd = path.resolve(cwd);
  const home = path.resolve(options.home ?? homedir());
  const agentDir = path.resolve(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi/agent"));
  const scope = options.scope ?? "both", root = projectRoot(cwd, home) ?? cwd;
  const projectDir = path.join(root, ".pi");
  const userSettings = json(path.join(agentDir, "settings.json"), scope !== "project");
  const projectSettings = json(path.join(projectDir, "settings.json"), scope !== "user");
  const user = scope === "project" ? {} : userSettings.subagents ?? {};
  const project = scope === "user" ? {} : projectSettings.subagents ?? {};
  const exclusionRoots = [[agentDir, userSettings], [projectDir, projectSettings]].flatMap(([base, settings]) => strings((settings as Settings).subagents?.agentExcludeDirs).map(p => path.resolve(base as string, expand(p.trim(), home))));
  const excluded = (p: string) => exclusionRoots.some(r => within(r, p) || within(canonical(r), canonical(p)));
  const agents = new Map<string, AgentDefinition>(), diagnostics: { sourcePath: string; error: string }[] = [];
  const load = (dir: string, source: AgentDefinition["source"], first = false) => {
    for (const file of files(dir, source === "builtin" ? () => false : excluded)) {
      try {
        const agent = parseAgent(fs.readFileSync(file, "utf8"), file, source);
        if (agent && (!first || !agents.has(agent.name) || agents.get(agent.name)!.source === "builtin")) agents.set(agent.name, agent);
      } catch (error) { diagnostics.push({ sourcePath: file, error: String(error) }); }
    }
  };
  load(options.builtinDir ?? fileURLToPath(new URL("../../agents/", import.meta.url)), "builtin");
  const roots = [root];
  for (const [base, settings, enabled] of [[projectDir, projectSettings, scope !== "user"], [agentDir, userSettings, scope !== "project"]] as const) {
    if (!enabled) continue;
    roots.push(...packageRoots(path.join(base, "npm/node_modules")));
    for (const entry of Array.isArray(settings.packages) ? settings.packages : []) {
      const source = typeof entry === "string" ? entry : entry?.source;
      if (typeof source === "string") { const resolved = settingsPackage(source.trim(), base, home); if (resolved) roots.push(resolved); }
    }
  }
  let globalRoot = options.globalNpmRoot;
  if (globalRoot === undefined && scope !== "project" && !/^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? "")) {
    try { globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { globalRoot = null; }
  }
  if (globalRoot && scope !== "project") roots.push(...packageRoots(globalRoot));
  for (const packageRoot of new Set(roots)) {
    const pkg = json(path.join(packageRoot, "package.json"));
    for (const metadata of [pkg["pi-subagents"], pkg.pi?.subagents]) for (const dir of strings(metadata?.agents)) load(path.resolve(packageRoot, dir), "package", true);
  }
  if (scope !== "project") for (const dir of [...(options.extraAgentDirs ?? process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS?.split(path.delimiter).map(p => p.trim()).filter(Boolean) ?? []), ...scans(user.agentScanDirs, cwd, home), path.join(agentDir, "agents"), path.join(home, ".agents")]) load(dir, "user");
  if (scope !== "user" && canonical(root) !== canonical(home)) for (const dir of [...scans(project.agentScanDirs, cwd, home), path.join(root, ".agents"), path.join(projectDir, "agents")]) load(dir, "project");
  const result: AgentDefinition[] = [];
  for (const agent of agents.values()) {
    const userOverride = user.agentOverrides?.[agent.name];
    const projectOverride = project.agentOverrides?.[agent.name];
    // Upstream agents.js:1337–1364 selects whole builtin overrides before bulk disables.
    const override = agent.source === "builtin"
      ? projectOverride ?? (project.disableBuiltins === true ? { disabled: true }
        : userOverride ?? (project.disableBuiltins === undefined && user.disableBuiltins === true ? { disabled: true } : {}))
      : { ...userOverride, ...projectOverride };
    if (override.disabled) continue;
    const defaults = { model: project.defaultModel ?? user.defaultModel, thinking: project.defaultThinking ?? user.defaultThinking };
    for (const key of ["model", "thinking"] as const) {
      if (agent[key] === undefined && defaults[key] !== undefined) agent[key] = defaults[key];
      if (Object.hasOwn(override, key)) { if (override[key] === false) delete agent[key]; else agent[key] = override[key]; }
    }
    for (const key of ["description", "systemPromptMode", "inheritProjectContext", "inheritSkills", "defaultContext"] as const) {
      if (Object.hasOwn(override, key)) {
        if (key === "defaultContext" && override[key] === false) delete agent.defaultContext;
        else Object.assign(agent, { [key]: override[key] });
      }
    }
    for (const key of ["tools", "skills"] as const) if (Object.hasOwn(override, key)) {
      if (override[key] === false || override[key] === "inherit") delete agent[key];
      else agent[key] = strings(override[key]).map(s => s.trim());
    }
    if (agent.source === "builtin") {
      const projectThinkingConfigured = project.disableThinking !== undefined;
      const disableThinking = projectThinkingConfigured ? project.disableThinking === true : user.disableThinking === true;
      const explicitThinking = override.thinking !== undefined && (projectOverride !== undefined || !projectThinkingConfigured);
      if (disableThinking && !explicitThinking) delete agent.thinking;
    }
    if (typeof override.systemPrompt === "string") agent.body = override.systemPrompt;
    result.push(agent);
  }
  return { agents: result, diagnostics };
}
