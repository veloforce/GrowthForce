import type * as ClaudeAgentSdk from "@anthropic-ai/claude-agent-sdk";

const TOOL_RUNTIME_SYMBOL = Symbol.for("agentstudio.tool-runtime");

type ToolRuntime = Pick<typeof ClaudeAgentSdk, "createSdkMcpServer" | "tool">;

const runtime = (globalThis as unknown as Record<symbol, ToolRuntime | undefined>)[TOOL_RUNTIME_SYMBOL];

if (!runtime) {
  throw new Error("GrowthForce tool runtime is not installed. Load tools through the tool registry.");
}

export const createSdkMcpServer = runtime.createSdkMcpServer;
export const tool = runtime.tool;
