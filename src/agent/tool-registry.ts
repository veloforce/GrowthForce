import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

const TOOL_RUNTIME_SYMBOL = Symbol.for("agentstudio.tool-runtime");

type ToolMetadata = {
  name: string;
  description: string;
  entry: string;
};

export type ToolServerContext = {
  requestId?: string;
  browserAutomation?: {
    cdpPort: number;
    cdpWebSocketUrl: string;
  };
  wechatConnector?: {
    appId: string;
    secret: string;
    author: string;
  };
};

type ToolModule = {
  createServer: (context?: ToolServerContext) => McpServerConfig;
};

export function createMcpServers(
  serverIds: string[] | undefined,
  toolsDir = resolveBundledToolsDirectory(),
  context?: ToolServerContext
): Record<string, McpServerConfig> | undefined {
  const ids = normalizeMcpServerIds(serverIds);
  if (ids.length === 0) return undefined;

  installToolRuntime();
  const servers: Record<string, McpServerConfig> = {};
  for (const id of ids) {
    const metadata = readToolMetadata(toolsDir, id);
    const entry = path.resolve(toolsDir, id, metadata.entry);
    if (!fs.existsSync(entry)) {
      throw new Error(`MCP server "${id}" entry not found: ${entry}`);
    }
    delete require.cache[entry];
    const loaded = require(entry) as Partial<ToolModule>;
    if (typeof loaded.createServer !== "function") {
      throw new Error(`MCP server "${id}" entry must export createServer(): ${entry}`);
    }
    servers[id] = loaded.createServer(context);
  }
  return servers;
}

export function installToolRuntime(): void {
  const target = globalThis as unknown as Record<symbol, unknown>;
  if (target[TOOL_RUNTIME_SYMBOL]) return;
  target[TOOL_RUNTIME_SYMBOL] = Object.freeze({
    createSdkMcpServer,
    tool
  });
}

export function requireKnownMcpServerIds(value: unknown, filePath: string, field: string): string[] {
  const ids = requireStringArray(value, filePath, field);
  const known = new Set(listAvailableMcpServerIds());
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown MCP server id in ${filePath}: ${unknown.join(", ")}`);
  }
  return normalizeMcpServerIds(ids);
}

export function listAvailableMcpServerIds(toolsDir = resolveBundledToolsDirectory()): string[] {
  if (!fs.existsSync(toolsDir)) return [];
  return fs.readdirSync(toolsDir)
    .filter((entry) => fs.statSync(path.join(toolsDir, entry)).isDirectory())
    .filter((entry) => fs.existsSync(path.join(toolsDir, entry, "tool.json")))
    .sort();
}

export function resolveBundledToolsDirectory(): string {
  const candidates: string[] = [];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "resources", "tools"));
  }

  candidates.push(path.join(process.cwd(), "resources", "tools"));
  candidates.push(path.join(__dirname, "..", "..", "resources", "tools"));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return candidates[0] ?? path.join(process.cwd(), "resources", "tools");
}

export function resolveToolEntry(serverId: string, toolsDir = resolveBundledToolsDirectory()): string {
  const metadata = readToolMetadata(toolsDir, serverId);
  return path.resolve(toolsDir, serverId, metadata.entry);
}

function readToolMetadata(toolsDir: string, serverId: string): ToolMetadata {
  const metadataPath = path.join(toolsDir, serverId, "tool.json");
  if (!fs.existsSync(metadataPath)) {
    throw new Error(`MCP server "${serverId}" metadata not found: ${metadataPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Partial<ToolMetadata>;
  if (parsed.name !== serverId) {
    throw new Error(`Invalid MCP server metadata ${metadataPath}: expected name "${serverId}"`);
  }
  if (!parsed.description || !parsed.entry) {
    throw new Error(`Invalid MCP server metadata ${metadataPath}: expected description and entry`);
  }
  return parsed as ToolMetadata;
}

function normalizeMcpServerIds(serverIds: string[] | undefined): string[] {
  if (!serverIds) return [];
  return Array.from(new Set(serverIds.map((id) => id.trim()).filter(Boolean)));
}

function requireStringArray(value: unknown, filePath: string, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`Invalid field "${field}" in ${filePath}: expected an array of non-empty strings`);
  }
  return value;
}
