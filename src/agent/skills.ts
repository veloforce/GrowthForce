import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";
import type { AgentStudioSettings, MarketSkillItem, SkillContent, SkillInstallInput, SkillListItem, SkillRuntimeStatus } from "../shared/types";
import { readSettings, updateSettings, writeSettings } from "../main/settings";

export { readSettings, writeSettings } from "../main/settings";

export type SkillSourceType = "builtin" | "user";

export interface SkillSourceRoot {
  type: SkillSourceType;
  dir: string;
}

export interface SkillDefinition {
  name: string;
  agent: string;
  description: string;
  sourceType: SkillSourceType;
  sourcePath: string;
  skillFile: string;
  version?: string;
}

export interface SkillDiscoveryResult {
  skills: SkillDefinition[];
  errors: string[];
}

export interface SkillRuntimePaths {
  bundledSkills: string;
  userResourceSkills: string;
  runtimeSkills: string;
  settings: string;
  marketSkills?: string;
}

export interface SkillSyncResult extends SkillDiscoveryResult {
  linked: string[];
  disabled: string[];
  removedStale: string[];
  conflicts: string[];
}

const SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const DEFAULT_INSTALL_AGENT = "orchestrator";

export function resolveBundledSkillsDirectory(): string {
  const candidates: string[] = [];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "resources", "skills"));
  }

  candidates.push(path.join(process.cwd(), "resources", "skills"));
  candidates.push(path.join(__dirname, "..", "..", "resources", "skills"));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return candidates[0] ?? path.join(process.cwd(), "resources", "skills");
}

export function resolveBundledMarketSkillsFile(): string {
  const candidates: string[] = [];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "resources", "market", "skills.yml"));
  }

  candidates.push(path.join(process.cwd(), "resources", "market", "skills.yml"));
  candidates.push(path.join(__dirname, "..", "..", "resources", "market", "skills.yml"));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return candidates[0] ?? path.join(process.cwd(), "resources", "market", "skills.yml");
}

export function syncRuntimeSkills(paths: SkillRuntimePaths): SkillSyncResult {
  fs.mkdirSync(paths.runtimeSkills, { recursive: true });
  fs.mkdirSync(paths.userResourceSkills, { recursive: true });
  const settings = reconcileSkillSettings(paths);
  const disabled = new Set(settings.skills.disabled);
  const discovery = discoverInstalledSkills(paths);
  const linked: string[] = [];
  const disabledSkills: string[] = [];
  const removedStale: string[] = [];
  const conflicts: string[] = [];
  const enabledSkillNames = new Set(discovery.skills.filter((skill) => settings.skills.installed[skill.name] && !disabled.has(skill.name)).map((skill) => skill.name));

  for (const entry of listDirectoryEntries(paths.runtimeSkills)) {
    const runtimePath = path.join(paths.runtimeSkills, entry.name);
    if (!enabledSkillNames.has(entry.name)) {
      if (removeRuntimeLink(runtimePath)) removedStale.push(entry.name);
    }
  }

  for (const skill of discovery.skills) {
    if (!settings.skills.installed[skill.name]) continue;
    const runtimePath = path.join(paths.runtimeSkills, skill.name);
    if (disabled.has(skill.name)) {
      if (removeRuntimeLink(runtimePath)) disabledSkills.push(skill.name);
      continue;
    }

    const linkStatus = getRuntimeLinkStatus(runtimePath, skill.sourcePath);
    if (linkStatus === "valid") {
      linked.push(skill.name);
      continue;
    }
    if (linkStatus === "missing" || linkStatus === "stale") {
      if (linkStatus === "stale") removeRuntimeLink(runtimePath);
      createRuntimeLink(skill.sourcePath, runtimePath);
      linked.push(skill.name);
      continue;
    }
    conflicts.push(skill.name);
  }

  return {
    ...discovery,
    linked,
    disabled: Array.from(disabled).filter((name) => settings.skills.installed[name]),
    removedStale,
    conflicts
  };
}

export function listSkills(paths: SkillRuntimePaths): { skills: SkillListItem[]; errors: string[]; conflicts: string[] } {
  const settings = reconcileSkillSettings(paths);
  const disabled = new Set(settings.skills.disabled);
  const discovery = discoverInstalledSkills(paths);
  const conflicts: string[] = [];
  const skills = discovery.skills.map((skill): SkillListItem => {
    const installed = settings.skills.installed[skill.name];
    const status = getSkillRuntimeStatus(paths.runtimeSkills, skill, disabled);
    if (status === "conflict") conflicts.push(skill.name);
    return {
      name: skill.name,
      agent: skill.agent,
      description: skill.description,
      sourceType: installed?.source ?? skill.sourceType,
      sourcePath: skill.sourcePath,
      version: installed?.version ?? skill.version,
      enabled: status === "enabled",
      status
    };
  });

  return { skills, errors: discovery.errors, conflicts };
}

export function setSkillDisabled(paths: SkillRuntimePaths, name: string, disabled: boolean): SkillSyncResult {
  const settings = reconcileSkillSettings(paths);
  const discovery = discoverInstalledSkills(paths);
  if (!settings.skills.installed[name]) {
    throw new Error(`Skill not found: ${name}`);
  }
  if (!disabled) {
    const skill = discovery.skills.find((item) => item.name === name);
    if (!skill) throw new Error(`Skill source not found: ${name}`);
    if (skill) assertCanActivate(paths, skill);
  }

  const disabledSkills = new Set(settings.skills.disabled);
  if (disabled) {
    disabledSkills.add(name);
  } else {
    disabledSkills.delete(name);
  }
  updateSettings(paths.settings, (current) => ({
    ...current,
    skills: {
      ...current.skills,
      installed: settings.skills.installed,
      disabled: Array.from(disabledSkills).sort()
    }
  }));

  return syncRuntimeSkills(paths);
}

export function listMarketSkills(paths: SkillRuntimePaths): { skills: MarketSkillItem[]; errors: string[] } {
  const settings = reconcileSkillSettings(paths);
  const marketPath = paths.marketSkills ?? resolveBundledMarketSkillsFile();
  if (!fs.existsSync(marketPath)) return { skills: [], errors: [] };

  const parsed = yaml.load(fs.readFileSync(marketPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { skills: [], errors: [`Invalid market skills file: ${marketPath}`] };
  }

  const skills: MarketSkillItem[] = [];
  const errors: string[] = [];
  for (const [agent, rawItems] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(rawItems)) {
      errors.push(`Invalid market skill group "${agent}": expected an array`);
      continue;
    }
    for (const rawItem of rawItems) {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
        errors.push(`Invalid market skill item under "${agent}"`);
        continue;
      }
      const item = rawItem as Record<string, unknown>;
      const name = readObjectString(item, "name");
      const description = readObjectString(item, "description");
      const skillMdUrl = readObjectString(item, "skillMdUrl");
      if (!name || !description || !skillMdUrl) {
        errors.push(`Invalid market skill item under "${agent}": missing required fields`);
        continue;
      }
      try {
        assertMarketSkillMdUrl(skillMdUrl);
      } catch (error) {
        errors.push(`Invalid market skill item under "${agent}": ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      skills.push({
        name,
        description,
        agent,
        skillMdUrl,
        installed: Boolean(settings.skills.installed[name])
      });
    }
  }

  skills.sort((a, b) => a.agent.localeCompare(b.agent) || a.name.localeCompare(b.name));
  return { skills, errors };
}

export async function getSkillContent(paths: SkillRuntimePaths, input: { source: "installed" | "market"; name: string; agent?: string }): Promise<SkillContent> {
  if (input.source === "installed") {
    reconcileSkillSettings(paths);
    const discovery = discoverInstalledSkills(paths);
    const skill = discovery.skills.find((item) => item.name === input.name && (!input.agent || item.agent === input.agent));
    if (!skill) throw new Error(`Skill not found: ${input.name}`);
    return splitSkillContent(fs.readFileSync(skill.skillFile, "utf8"), "installed");
  }

  const market = listMarketSkills(paths).skills.find((item) => item.name === input.name && (!input.agent || item.agent === input.agent));
  if (!market) throw new Error(`Market skill not found: ${input.name}`);
  let raw: string;
  try {
    raw = await fetchText(market.skillMdUrl);
  } catch {
    raw = buildMarketSkillPreview(market);
  }
  return splitSkillContent(raw, "market");
}

export async function installGithubSkill(paths: SkillRuntimePaths, input: SkillInstallInput): Promise<SkillSyncResult> {
  const settings = reconcileSkillSettings(paths);
  const agent = input.agent?.trim() || DEFAULT_INSTALL_AGENT;
  const parsed = parseGitHubSkillSource(input);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-skill-install-"));
  const clonedDir = path.join(tempDir, parsed.repoName);
  const sourceDir = parsed.dirPath ? path.join(clonedDir, ...parsed.dirPath.split("/")) : clonedDir;

  try {
    cloneGitHubRepository(parsed, clonedDir);
    const skillFile = path.join(sourceDir, "SKILL.md");
    if (!fs.existsSync(skillFile)) throw new Error("Cloned skill path does not contain SKILL.md");
    normalizeSkillAgent(skillFile, agent);

    const content = splitSkillContent(fs.readFileSync(skillFile, "utf8"), "installed");
    const skillName = readObjectString(content.frontmatter, "name");
    if (!skillName || !SKILL_NAME_PATTERN.test(skillName)) {
      throw new Error("Downloaded SKILL.md must contain a valid frontmatter name");
    }
    assertInstallPathAvailable(paths, settings, agent, skillName);

    const targetDir = path.join(paths.userResourceSkills, agent, skillName);
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true, errorOnExist: true });
    updateSettings(paths.settings, (current) => ({
      ...current,
      skills: {
        ...current.skills,
        installed: {
          ...current.skills.installed,
          [skillName]: withoutUndefined({
            agent,
            dirName: skillName,
            source: "market",
            version: readObjectString(content.frontmatter, "version") ?? undefined
          })
        },
        disabled: current.skills.disabled.filter((item) => item !== skillName)
      }
    }));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return syncRuntimeSkills(paths);
}

export function discoverSkills(roots: SkillSourceRoot[]): SkillDiscoveryResult {
  const skills: SkillDefinition[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (!fs.existsSync(root.dir)) continue;
    for (const agentEntry of listDirectoryEntries(root.dir)) {
      if (!agentEntry.isDirectory()) continue;
      const agent = agentEntry.name;
      const agentDir = path.join(root.dir, agent);
      for (const skillEntry of listDirectoryEntries(agentDir)) {
        if (!skillEntry.isDirectory()) continue;
        const sourcePath = path.join(agentDir, skillEntry.name);
        const skillFile = path.join(sourcePath, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;

        let loaded: SkillDefinition | string;
        try {
          loaded = loadSkillFile(skillFile, agent, sourcePath, root.type);
        } catch (error) {
          errors.push(`Failed to load skill ${skillFile}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        if (typeof loaded === "string") {
          errors.push(loaded);
          continue;
        }
        if (seen.has(loaded.name)) {
          errors.push(`Duplicate skill name "${loaded.name}" at ${sourcePath}`);
          continue;
        }
        seen.add(loaded.name);
        skills.push(loaded);
      }
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, errors };
}

function discoverInstalledSkills(paths: SkillRuntimePaths): SkillDiscoveryResult {
  return discoverSkills([{ type: "user", dir: paths.userResourceSkills }]);
}

export function splitSkillContent(raw: string, source: "installed" | "market"): SkillContent {
  const parsed = splitFrontmatter(raw);
  if (!parsed) throw new Error("Missing YAML frontmatter in SKILL.md");
  return {
    frontmatter: parsed.frontmatter,
    markdown: parsed.markdown,
    raw,
    source
  };
}

export function reconcileSkillSettings(paths: SkillRuntimePaths): AgentStudioSettings {
  const settings = readSettings(paths.settings);
  fs.mkdirSync(paths.userResourceSkills, { recursive: true });
  const builtinDiscovery = discoverSkills([{ type: "builtin", dir: paths.bundledSkills }]);
  const installed = { ...settings.skills.installed };
  let changed = false;

  for (const skill of builtinDiscovery.skills) {
    const targetDir = getUserSkillPath(paths.userResourceSkills, skill.agent, skill.name);
    const existing = installed[skill.name];
    if (existing?.source !== "user") {
      copyBuiltinSkillToUserResource(skill.sourcePath, targetDir);
    }
    if (existing) continue;
    installed[skill.name] = {
      agent: skill.agent,
      dirName: skill.name,
      source: "builtin",
      ...(skill.version ? { version: skill.version } : {})
    };
    changed = true;
  }

  const installedDiscovery = discoverInstalledSkills(paths);
  const builtinNames = new Set(builtinDiscovery.skills.map((skill) => skill.name));
  for (const skill of installedDiscovery.skills) {
    const existing = installed[skill.name];
    const source = existing?.source ?? (builtinNames.has(skill.name) ? "builtin" : "user");
    const next = withoutUndefined({
      agent: skill.agent,
      dirName: path.basename(skill.sourcePath),
      source,
      version: skill.version
    });
    if (!existing || existing.agent !== next.agent || existing.dirName !== next.dirName || existing.source !== next.source || existing.version !== next.version) {
      installed[skill.name] = next;
      changed = true;
    }
  }

  const reconciled: AgentStudioSettings = {
    ...settings,
    skills: {
      installed,
      disabled: settings.skills.disabled
    }
  };
  if (changed) writeSettings(paths.settings, reconciled);
  return reconciled;
}

function loadSkillFile(skillFile: string, expectedAgent: string, sourcePath: string, sourceType: SkillSourceType): SkillDefinition | string {
  const frontmatter = parseFrontmatter(fs.readFileSync(skillFile, "utf8"));
  if (!frontmatter) return `Missing YAML frontmatter in ${skillFile}`;

  const name = readFrontmatterString(frontmatter, "name");
  if (!name) return `Invalid field "name" in ${skillFile}: expected a non-empty string`;
  const agent = readFrontmatterString(frontmatter, "agent");
  if (!agent) return `Invalid field "agent" in ${skillFile}: expected a non-empty string`;
  const description = readFrontmatterString(frontmatter, "description");
  const version = readFrontmatterOptionalString(frontmatter, "version");
  if (!description) return `Invalid field "description" in ${skillFile}: expected a non-empty string`;
  if (!SKILL_NAME_PATTERN.test(name)) return `Invalid skill name "${name}" in ${skillFile}`;
  if (agent !== expectedAgent) {
    return `Invalid agent "${agent}" in ${skillFile}: expected "${expectedAgent}" from parent directory`;
  }

  return {
    name,
    agent,
    description,
    sourceType,
    sourcePath,
    skillFile,
    ...(version ? { version } : {})
  };
}

function parseFrontmatter(raw: string): Record<string, unknown> | null {
  return splitFrontmatter(raw)?.frontmatter ?? null;
}

function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown>; markdown: string } | null {
  if (!raw.startsWith("---\n")) return null;
  const end = raw.indexOf("\n---", 4);
  if (end < 0) return null;
  const parsed = yaml.load(raw.slice(4, end));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const markdownStart = raw.indexOf("\n", end + 4);
  return {
    frontmatter: parsed as Record<string, unknown>,
    markdown: markdownStart >= 0 ? raw.slice(markdownStart + 1) : ""
  };
}

function readFrontmatterString(frontmatter: Record<string, unknown>, field: string): string | null {
  const value = frontmatter[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

function readFrontmatterOptionalString(frontmatter: Record<string, unknown>, field: string): string | undefined {
  const value = frontmatter[field];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function getRuntimeLinkStatus(runtimePath: string, sourcePath: string): "missing" | "valid" | "stale" | "conflict" {
  const stat = lstatOrNull(runtimePath);
  if (!stat) return "missing";
  if (!stat.isSymbolicLink()) return "conflict";
  let target: string;
  try {
    target = fs.realpathSync(runtimePath);
  } catch {
    return "stale";
  }
  if (normalizePath(target) === normalizePath(fs.realpathSync(sourcePath))) return "valid";
  return "stale";
}

function assertCanActivate(paths: SkillRuntimePaths, skill: SkillDefinition): void {
  const runtimePath = path.join(paths.runtimeSkills, skill.name);
  const status = getRuntimeLinkStatus(runtimePath, skill.sourcePath);
  if (status === "conflict") {
    throw new Error(`Cannot enable skill "${skill.name}": runtime path is occupied: ${runtimePath}`);
  }
}

function getSkillRuntimeStatus(runtimeSkills: string, skill: SkillDefinition, disabled: Set<string>): SkillRuntimeStatus {
  if (disabled.has(skill.name)) return "disabled";
  const status = getRuntimeLinkStatus(path.join(runtimeSkills, skill.name), skill.sourcePath);
  return status === "conflict" ? "conflict" : "enabled";
}

function createRuntimeLink(sourcePath: string, runtimePath: string): void {
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.symlinkSync(sourcePath, runtimePath, process.platform === "win32" ? "junction" : "dir");
}

function copyBuiltinSkillToUserResource(sourcePath: string, targetDir: string): void {
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.cpSync(sourcePath, targetDir, { recursive: true, errorOnExist: true });
}

function removeRuntimeLink(runtimePath: string): boolean {
  const stat = lstatOrNull(runtimePath);
  if (!stat) return false;
  if (!stat.isSymbolicLink()) return false;
  fs.unlinkSync(runtimePath);
  return true;
}

function normalizePath(input: string): string {
  const normalized = path.resolve(input);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function listDirectoryEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function getUserSkillPath(userResourceSkills: string, agent: string, skillName: string): string {
  return path.join(userResourceSkills, agent, skillName);
}

function withoutUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function assertInstallPathAvailable(paths: SkillRuntimePaths, settings: AgentStudioSettings, agent: string, installDirName: string): void {
  if (settings.skills.installed[installDirName]) {
    throw new Error(`Skill is already installed: ${installDirName}`);
  }
  const runtimePath = path.join(paths.runtimeSkills, installDirName);
  if (fs.existsSync(runtimePath)) throw new Error(`Skill runtime path already exists: ${runtimePath}`);

  const userTarget = path.join(paths.userResourceSkills, agent, installDirName);
  if (fs.existsSync(userTarget)) throw new Error(`User skill already exists: ${userTarget}`);

  const builtinTarget = path.join(paths.bundledSkills, agent, installDirName);
  if (fs.existsSync(builtinTarget)) throw new Error(`Built-in skill already exists: ${builtinTarget}`);
}

function normalizeSkillAgent(skillFile: string, agent: string): void {
  const raw = fs.readFileSync(skillFile, "utf8");
  const parsed = splitFrontmatter(raw);
  if (!parsed) throw new Error("Missing YAML frontmatter in SKILL.md");
  parsed.frontmatter.agent = agent;
  fs.writeFileSync(skillFile, `---\n${yaml.dump(parsed.frontmatter, { lineWidth: 100 }).trimEnd()}\n---\n${parsed.markdown}`, "utf8");
}

function readObjectString(input: Record<string, unknown>, field: string): string | null {
  const value = input[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function assertMarketSkillMdUrl(input: string): void {
  const url = new URL(input.trim());
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname !== "github.com" || parts.length < 5 || parts[2] !== "blob" || parts.at(-1) !== "SKILL.md") {
    throw new Error("market skillMdUrl must point to a GitHub SKILL.md blob URL");
  }
  parseGitHubSkillSource({ url: input });
}

function buildMarketSkillPreview(skill: MarketSkillItem): string {
  return [
    "---",
    `name: ${skill.name}`,
    `agent: ${skill.agent}`,
    `description: ${JSON.stringify(skill.description)}`,
    "---",
    "",
    "## 市场 Skill 预览",
    "",
    skill.description,
    "",
    "当前网络无法读取远程 SKILL.md，以下是市场索引中的元信息。",
    "",
    `- SKILL.md: ${skill.skillMdUrl}`,
    ""
  ].join("\n");
}

export interface ParsedGitHubSkillSource {
  owner: string;
  repoName: string;
  ref?: string;
  dirPath: string;
}

export function parseGitHubSkillSource(input: SkillInstallInput): ParsedGitHubSkillSource {
  if (input.repo && input.path) {
    const [owner, repoName] = parseGitHubRepo(input.repo);
    return {
      owner,
      repoName,
      dirPath: normalizeGitHubSkillDirPath(input.path, { allowSkillFile: true })
    };
  }
  if (input.url) return parseGitHubTreeUrl(input.url);
  throw new Error("GitHub skill source is required");
}

function parseGitHubTreeUrl(input: string): ParsedGitHubSkillSource {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("请输入 GitHub skill 链接，例如 https://github.com/owner/repo/tree/main/example/SKILL.md");

  const url = new URL(trimmed);
  if (url.hostname !== "github.com") throw new Error("Only GitHub URLs are supported");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || (parts[2] !== "tree" && parts[2] !== "blob")) {
    throw new Error("请输入 GitHub skill 链接，例如 https://github.com/owner/repo/tree/main/example/SKILL.md");
  }
  const isBlobUrl = parts[2] === "blob";
  const rawPath = normalizeGitHubSkillDirPath(parts.slice(4).join("/"), { allowSkillFile: true, requireSkillFile: isBlobUrl });
  return {
    owner: parts[0],
    repoName: parts[1],
    ref: parts[3],
    dirPath: rawPath
  };
}

function normalizeGitHubSkillDirPath(input: string, options: { allowSkillFile?: boolean; requireSkillFile?: boolean } = {}): string {
  const normalized = input.replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("\\") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid GitHub skill path");
  }
  const parts = normalized.split("/");
  const fileName = parts.at(-1);
  if (fileName === "SKILL.md") {
    if (!options.allowSkillFile) throw new Error("Invalid GitHub skill path");
    return parts.slice(0, -1).join("/");
  }
  if (options.requireSkillFile) {
    throw new Error("GitHub blob skill URL must point to SKILL.md");
  }
  return parts.join("/");
}

function parseGitHubRepo(input: string): [string, string] {
  const parts = input.trim().replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0 || part.includes(".."))) {
    throw new Error("Invalid GitHub repo, expected owner/repo");
  }
  return [parts[0], parts[1].replace(/\.git$/, "")];
}

function cloneGitHubRepository(parsed: ParsedGitHubSkillSource, targetDir: string): void {
  const args = ["clone", "--depth", "1"];
  if (parsed.ref) {
    args.push("--branch", parsed.ref);
  }
  args.push(`https://github.com/${parsed.owner}/${parsed.repoName}.git`, targetDir);
  execFileSync("git", args, { stdio: "ignore" });
}

async function fetchText(url: string): Promise<string> {
  const fetchUrl = toFetchableSkillMdUrl(url);
  const headers: Record<string, string> = { "User-Agent": "GrowthForce" };
  if (isGitHubContentsUrl(fetchUrl)) {
    headers.Accept = "application/vnd.github.raw+json";
  }
  const response = await fetch(fetchUrl, { headers });
  if (!response.ok) throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  return response.text();
}

function toFetchableSkillMdUrl(input: string): string {
  try {
    const parsed = parseGitHubSkillSource({ url: input });
    const url = new URL(input);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "github.com" && parts[2] === "blob") {
      const skillFilePath = parsed.dirPath ? `${parsed.dirPath}/SKILL.md` : "SKILL.md";
      return `https://api.github.com/repos/${parsed.owner}/${parsed.repoName}/contents/${skillFilePath}?ref=${encodeURIComponent(parsed.ref ?? parts[3])}`;
    }
  } catch {
    // Non-GitHub page URLs are fetched as-is so callers can surface the original request failure.
  }
  return input;
}

function isGitHubContentsUrl(input: string): boolean {
  try {
    const url = new URL(input);
    const parts = url.pathname.split("/").filter(Boolean);
    return url.hostname === "api.github.com" && parts.length >= 5 && parts[0] === "repos" && parts[3] === "contents";
  } catch {
    return false;
  }
}

function lstatOrNull(input: string): fs.Stats | null {
  try {
    return fs.lstatSync(input);
  } catch {
    return null;
  }
}
