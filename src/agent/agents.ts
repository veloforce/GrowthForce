import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { AgentDefinition, Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { AgentListItem } from "../shared/types";
import { createMcpServers, requireKnownMcpServerIds, type ToolServerContext } from "./tool-registry";

export const DEFAULT_AGENT_NAME = "orchestrator";

const SUPPORTED_AGENT_FIELDS = new Set([
  "display_name",
  "subagents",
  "description",
  "prompt",
  "tools",
  "disallowedTools",
  "skills",
  "mcpServers",
  "model",
  "maxTurns",
  "permissionMode"
]);

const VALID_PERMISSION_MODES = new Set<PermissionMode>(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]);

type SupportedAgentDefinition = Pick<AgentDefinition, "description" | "prompt"> &
  Partial<Pick<AgentDefinition, "tools" | "disallowedTools" | "skills" | "model" | "maxTurns" | "permissionMode">> & {
    mcpServers?: string[];
  };

export type MainAgentDefinition = SupportedAgentDefinition & {
  subagents?: Record<string, AgentDefinition>;
};

export function loadBundledAgents(): Record<string, MainAgentDefinition> {
  return loadAgentsFromDirectory(resolveBundledAgentsDirectory());
}

export function listBundledAgents(): AgentListItem[] {
  return listAgentsFromDirectory(resolveBundledAgentsDirectory());
}

export function buildDefaultAgentOptions(
  agents: Record<string, MainAgentDefinition>,
  fallbackModel?: string,
  toolContext?: ToolServerContext
): Pick<
  Options,
  "agents" | "systemPrompt" | "tools" | "disallowedTools" | "model" | "maxTurns" | "permissionMode" | "mcpServers"
> {
  const mainAgent = agents[DEFAULT_AGENT_NAME];
  if (!mainAgent) {
    throw new Error(`Missing default agent configuration: ${DEFAULT_AGENT_NAME}`);
  }
  const sdkSubAgents: Record<string, AgentDefinition> = {};

  for (const [agentName, agent] of Object.entries(mainAgent.subagents ?? {})) {
    sdkSubAgents[agentName] = { ...agent };
  }

  return {
    agents: sdkSubAgents,
    systemPrompt: mainAgent.prompt,
    tools: mainAgent.tools,
    disallowedTools: mainAgent.disallowedTools,
    model: mainAgent.model || fallbackModel || undefined,
    maxTurns: mainAgent.maxTurns,
    permissionMode: mainAgent.permissionMode,
    mcpServers: createMcpServers(mainAgent.mcpServers, undefined, toolContext)
  };
}

export function resolveBundledAgentsDirectory(): string {
  const candidates: string[] = [];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "resources", "agents"));
  }

  candidates.push(path.join(process.cwd(), "resources", "agents"));
  candidates.push(path.join(__dirname, "..", "..", "resources", "agents"));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return candidates[0] ?? path.join(process.cwd(), "resources", "agents");
}

export function loadAgentsFromDirectory(agentsDir: string): Record<string, MainAgentDefinition> {
  if (!fs.existsSync(agentsDir)) {
    throw new Error(`Agent configuration directory not found: ${agentsDir}`);
  }

  const agents: Record<string, MainAgentDefinition> = {};
  const files = fs.readdirSync(agentsDir).filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"));

  for (const file of files) {
    const agentName = path.basename(file, path.extname(file));
    agents[agentName] = loadAgentFile(path.join(agentsDir, file), agentName);
  }

  if (!agents[DEFAULT_AGENT_NAME]) {
    throw new Error(`Missing default agent configuration: ${path.join(agentsDir, `${DEFAULT_AGENT_NAME}.yml`)}`);
  }

  return agents;
}

export function listAgentsFromDirectory(agentsDir: string): AgentListItem[] {
  if (!fs.existsSync(agentsDir)) {
    throw new Error(`Agent configuration directory not found: ${agentsDir}`);
  }

  const agents = fs.readdirSync(agentsDir)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .map((file) => {
      const agentName = path.basename(file, path.extname(file));
      const raw = loadRawAgentFile(path.join(agentsDir, file), agentName);
      return {
        name: agentName,
        displayName: optionalString(raw.display_name) ?? agentName,
        description: requireString(raw.description, path.join(agentsDir, file), "description")
      };
    });
  return agents.sort((a, b) => {
    if (a.name === DEFAULT_AGENT_NAME) return -1;
    if (b.name === DEFAULT_AGENT_NAME) return 1;
    return compareAgentDisplayName(a, b);
  });
}

function loadAgentFile(filePath: string, agentName: string): MainAgentDefinition {
  const raw = loadRawAgentFile(filePath, agentName);
  for (const field of Object.keys(raw)) {
    if (!SUPPORTED_AGENT_FIELDS.has(field)) {
      throw new Error(`Unsupported field "${field}" in agent configuration ${filePath}`);
    }
  }

  const agent: Partial<MainAgentDefinition> = {};
  agent.description = requireString(raw.description, filePath, "description");
  agent.prompt = requireString(raw.prompt, filePath, "prompt");

  if (raw.tools !== undefined) agent.tools = requireStringArray(raw.tools, filePath, "tools");
  if (raw.disallowedTools !== undefined) agent.disallowedTools = requireStringArray(raw.disallowedTools, filePath, "disallowedTools");
  if (raw.skills !== undefined) agent.skills = requireStringArray(raw.skills, filePath, "skills");
  if (raw.mcpServers !== undefined) agent.mcpServers = requireKnownMcpServerIds(raw.mcpServers, filePath, "mcpServers");
  if (raw.model !== undefined) agent.model = requireString(raw.model, filePath, "model");
  if (raw.maxTurns !== undefined) agent.maxTurns = requirePositiveInteger(raw.maxTurns, filePath, "maxTurns");
  if (raw.permissionMode !== undefined) agent.permissionMode = requirePermissionMode(raw.permissionMode, filePath);
  if (raw.subagents !== undefined) agent.subagents = requireSubagents(raw.subagents, filePath);

  return agent as MainAgentDefinition;
}

function loadRawAgentFile(filePath: string, agentName: string): Record<string, unknown> {
  const parsed = yaml.load(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid agent configuration for ${agentName}: expected a YAML object`);
  }

  return parsed as Record<string, unknown>;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function compareAgentDisplayName(a: AgentListItem, b: AgentListItem): number {
  return a.displayName.localeCompare(b.displayName);
}

function requireString(value: unknown, filePath: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid field "${field}" in ${filePath}: expected a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, filePath: string, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`Invalid field "${field}" in ${filePath}: expected an array of non-empty strings`);
  }
  return value;
}

function requireSubagents(value: unknown, filePath: string): Record<string, AgentDefinition> {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid field "subagents" in ${filePath}: expected an array`);
  }
  const agents: Record<string, AgentDefinition> = {};
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Invalid field "subagents[${index}]" in ${filePath}: expected an object`);
    }
    const raw = item as Record<string, unknown>;
    for (const field of Object.keys(raw)) {
      if (field !== "name" && field !== "description" && field !== "prompt") {
        throw new Error(`Unsupported field "${field}" in subagents[${index}] of ${filePath}`);
      }
    }
    const name = requireString(raw.name, filePath, `subagents[${index}].name`);
    if (agents[name]) {
      throw new Error(`Duplicate subagent "${name}" in ${filePath}`);
    }
    agents[name] = {
      description: requireString(raw.description, filePath, `subagents[${index}].description`),
      prompt: requireString(raw.prompt, filePath, `subagents[${index}].prompt`)
    };
  }
  return agents;
}

function requirePositiveInteger(value: unknown, filePath: string, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid field "${field}" in ${filePath}: expected a positive integer`);
  }
  return value;
}

function requirePermissionMode(value: unknown, filePath: string): PermissionMode {
  if (typeof value !== "string" || !VALID_PERMISSION_MODES.has(value as PermissionMode)) {
    throw new Error(`Invalid field "permissionMode" in ${filePath}: expected a valid SDK permission mode`);
  }
  return value as PermissionMode;
}
