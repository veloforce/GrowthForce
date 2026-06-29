import { parentPort } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query, type CanUseTool, type PermissionResult, type PermissionUpdate, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildDefaultAgentOptions, loadBundledAgents } from "./agents";
import { shouldEnableModelHttpLogging, startModelHttpLogger, type ModelHttpLoggerRuntime } from "./model-http-logger";
import { composePrompt } from "./prompt";
import { composeSupplementPrompt } from "./supplement-flow";
import { flushLogEvents, logEvent } from "../shared/log";
import type { AgentEvent, AgentPermissionRequest, AgentPermissionResponse, AgentRunRequest, AgentSupplementClaimResponse, AgentSupplementQueueItem, AutomationToolResponse, ConnectorToolResponse } from "../shared/types";

const abortControllers = new Map<string, AbortController>();

if (!process.parentPort && !parentPort) {
  throw new Error("Agent process must be launched by Electron utilityProcess");
}

process.parentPort?.on("message", (event: { data?: unknown }) => {
  logEvent("agent.ipc.inbound", summarizeInboundMessage(event.data));
  logEvent("agent.ipc.inbound.raw", event.data, { detail: true });
  void handleMessage(event.data);
});

async function handleMessage(message: unknown): Promise<void> {
  logEvent("agent.message", summarizeInboundMessage(message));
  if (!message || typeof message !== "object") return;
  const typed = message as { type?: string; payload?: AgentRunRequest | AutomationToolResponse | AgentPermissionResponse; requestId?: string };
  if (typed.type === "run" && typed.payload) {
    await runAgent(typed.payload as AgentRunRequest);
  }
  if (typed.type === "cancel" && typed.requestId) {
    logEvent("agent.cancel", { requestId: typed.requestId });
    abortControllers.get(typed.requestId)?.abort();
    abortControllers.delete(typed.requestId);
  }
  if (typed.type === "automationToolResponse" && typed.payload) {
    process.emit("agentstudio:automationToolResponse", typed.payload as AutomationToolResponse);
  }
  if (typed.type === "connectorToolResponse" && typed.payload) {
    process.emit("agentstudio:connectorToolResponse", typed.payload as ConnectorToolResponse);
  }
  if (typed.type === "agentPermissionResponse" && typed.payload) {
    process.emit("agentstudio:permissionResponse", typed.payload as AgentPermissionResponse);
  }
  if (typed.type === "supplement:claimNext:response") {
    process.emit("agentstudio:supplementClaimResponse", message as AgentSupplementClaimResponse);
  }
}

async function runAgent(request: AgentRunRequest): Promise<void> {
  const controller = new AbortController();
  let modelHttpLogger: ModelHttpLoggerRuntime | null = null;
  abortControllers.set(request.requestId, controller);
  logEvent("agent.run", {
    requestId: request.requestId,
    sessionId: request.sessionId ?? null,
    sdkSessionId: request.sdkSessionId ?? null,
    workspacePath: request.workspacePath,
    promptLength: request.prompt.length
  });

  try {
    validateConfig(request);
    const env = buildAgentEnv(request);
    if (shouldEnableModelHttpLogging(process.env, isPackagedRuntime())) {
      modelHttpLogger = await startModelHttpLogger({
        upstreamBaseUrl: env.ANTHROPIC_BASE_URL ?? "",
        requestId: request.requestId,
        sdkSessionId: request.sdkSessionId ?? null,
        model: env.ANTHROPIC_MODEL ?? null
      });
      env.ANTHROPIC_BASE_URL = modelHttpLogger.baseUrl;
      logEvent("agent.modelHttpLogger", {
        requestId: request.requestId,
        enabled: true,
        proxyBaseUrl: modelHttpLogger.baseUrl
      });
    }
    const agents = loadBundledAgents();
    let sdkSessionId: string | undefined = request.sdkSessionId || undefined;
    let announcedSdkSessionId: string | undefined;
    let resultText = "";
    const defaultOptions = buildDefaultAgentOptions(
      agents,
      request.config.provider.model || undefined,
      {
        requestId: request.requestId,
        browserAutomation: request.browserAutomation,
        wechatConnector: request.wechatConnector
      }
    );

    let prompt = composePrompt(request);
    let isInitialQuery = true;
    while (!controller.signal.aborted) {
      const queryResult = await runSdkQuery({
        request,
        prompt,
        resume: isInitialQuery ? request.sdkSessionId || undefined : sdkSessionId,
        env,
        controller,
        defaultOptions,
        onExtractedMessage: (extracted) => {
          if (extracted.sdkSessionId) {
            sdkSessionId = extracted.sdkSessionId;
            if (announcedSdkSessionId !== extracted.sdkSessionId) {
              announcedSdkSessionId = extracted.sdkSessionId;
              post({ type: "session", requestId: request.requestId, sdkSessionId: extracted.sdkSessionId });
            }
          }
          for (const event of extracted.events) post(event);
        }
      });
      if (queryResult.resultText) resultText = queryResult.resultText;
      if (controller.signal.aborted) break;

      const supplement = await claimNextSupplement(request, controller.signal);
      if (!supplement) break;
      if (!sdkSessionId) {
        throw new Error("无法发送补充消息：Claude session 尚未建立");
      }
      logEvent("agent.supplement:drained", {
        requestId: request.requestId,
        sessionId: request.sessionId,
        itemId: supplement.id,
        textLength: supplement.text.length
      });
      prompt = composeSupplementPrompt(supplement);
      isInitialQuery = false;
    }

    if (controller.signal.aborted) {
      logEvent("agent.run", { requestId: request.requestId, event: "cancelled" });
      post({ type: "error", requestId: request.requestId, message: "任务已取消" });
      return;
    }

    logEvent("agent.run", {
      requestId: request.requestId,
      event: "done",
      sdkSessionId,
      resultLength: resultText.length
    });
    post({ type: "done", requestId: request.requestId, sdkSessionId, result: resultText });
  } catch (error) {
    logEvent("agent.run:error", {
      requestId: request.requestId,
      error
    });
    post({
      type: "error",
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    await modelHttpLogger?.close().catch((error) => {
      logEvent("agent.modelHttpLogger:closeError", { requestId: request.requestId, error });
    });
    abortControllers.delete(request.requestId);
  }
}

async function runSdkQuery(input: {
  request: AgentRunRequest;
  prompt: string;
  resume?: string;
  env: Record<string, string | undefined>;
  controller: AbortController;
  defaultOptions: ReturnType<typeof buildDefaultAgentOptions>;
  onExtractedMessage: (message: ReturnType<typeof extractMessage>) => void;
}): Promise<{ resultText: string }> {
  const { request, prompt, resume, env, controller, defaultOptions, onExtractedMessage } = input;
  let resultText = "";
  const stream = query({
    prompt,
    options: {
      ...defaultOptions,
      disallowedTools: mergeDisallowedTools(defaultOptions.disallowedTools, request.disallowedTools),
      cwd: request.workspacePath,
      additionalDirectories: getAdditionalDirectories(request),
      permissionMode: request.permissionMode || "auto",
      allowDangerouslySkipPermissions: request.permissionMode === "bypassPermissions" ? true : undefined,
      settings: request.permissionMode === "bypassPermissions" ? { skipDangerousModePermissionPrompt: true } : undefined,
      pathToClaudeCodeExecutable: resolveClaudeCodeExecutable(),
      resume,
      env,
      abortController: controller,
      settingSources: ["user", "project"],
      includePartialMessages: true,
      toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
      canUseTool: createCanUseTool(request.requestId)
    }
  });

  for await (const message of stream) {
    if (controller.signal.aborted) break;
    logEvent("agent.sdk.message", summarizeSdkMessage(message), { detail: true });
    const extracted = extractMessage(request.requestId, message);
    onExtractedMessage(extracted);
    if (extracted.resultText) {
      resultText = extracted.resultText;
      break;
    }
  }
  return { resultText };
}

async function claimNextSupplement(request: AgentRunRequest, signal: AbortSignal): Promise<AgentSupplementQueueItem | null> {
  if (signal.aborted) return null;
  const rpcId = randomUUID();
  const response = await new Promise<AgentSupplementClaimResponse>((resolve) => {
    const onResponse = (message: AgentSupplementClaimResponse) => {
      if (message.rpcId !== rpcId) return;
      process.off("agentstudio:supplementClaimResponse", onResponse);
      resolve(message);
    };
    process.on("agentstudio:supplementClaimResponse", onResponse);
    process.parentPort?.postMessage({
      type: "supplement:claimNext",
      rpcId,
      requestId: request.requestId,
      sessionId: request.sessionId
    });
  });
  if (response.error) throw new Error(response.error);
  return response.item ?? null;
}

function createCanUseTool(requestId: string): CanUseTool {
  return async (toolName, input, options): Promise<PermissionResult> => {
    const toolUseID = options.toolUseID;
    const fallbackDeny = (message: string): PermissionResult => ({ behavior: "deny", message, toolUseID });
    if (options.signal.aborted) return fallbackDeny("操作已取消");
    try {
      const response = await requestPermissionFromHost({
        rpcId: randomUUID(),
        requestId,
        toolUseId: toolUseID,
        toolName,
        input,
        title: options.title,
        displayName: options.displayName,
        description: options.description,
        decisionReason: options.decisionReason,
        blockedPath: options.blockedPath,
        suggestions: options.suggestions,
        agentId: options.agentID
      }, options.signal);

      if (!response.ok) return fallbackDeny(response.error || "权限请求失败");
      const mode = response.mode ?? (response.action === "allow" ? "allow" : "deny");
      if (mode !== "allow" && mode !== "allow_remember") return fallbackDeny(response.message || "用户拒绝了该操作");
      return {
        behavior: "allow",
        updatedInput: response.updatedInput ?? input,
        updatedPermissions: response.updatedPermissions as PermissionUpdate[] | undefined,
        toolUseID
      };
    } catch (error) {
      return fallbackDeny(error instanceof Error ? error.message : String(error));
    }
  };
}

function mergeDisallowedTools(base: string[] | undefined, override: string[] | undefined): string[] | undefined {
  const merged = [...(base ?? []), ...(override ?? [])].filter((tool) => tool.trim().length > 0);
  return merged.length > 0 ? [...new Set(merged)] : undefined;
}

function requestPermissionFromHost(request: AgentPermissionRequest, signal: AbortSignal): Promise<AgentPermissionResponse> {
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      process.off("agentstudio:permissionResponse", listener);
      signal.removeEventListener("abort", abort);
    };
    const settle = (response: AgentPermissionResponse) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };
    const listener = (response: AgentPermissionResponse) => {
      if (response.rpcId !== request.rpcId) return;
      settle(response);
    };
    const abort = () => {
      settle({ rpcId: request.rpcId, ok: true, action: "deny", message: "操作已取消" });
    };
    signal.addEventListener("abort", abort, { once: true });
    process.on("agentstudio:permissionResponse", listener);
    if (!process.parentPort) {
      settle({ rpcId: request.rpcId, ok: true, action: "deny", message: "权限请求通道不可用" });
      return;
    }
    process.parentPort.postMessage({ type: "agentPermissionRequest", payload: request });
  });
}

function getAdditionalDirectories(request: AgentRunRequest): string[] | undefined {
  const directories = Array.from(new Set((request.attachments ?? []).map((file) => path.dirname(file.path)).filter((dir) => dir && path.resolve(dir) !== path.resolve(request.workspacePath))));
  return directories.length > 0 ? directories : undefined;
}

function resolveClaudeCodeExecutable(): string | undefined {
  const packageName = getClaudeBinaryPackageName();
  if (!packageName) return undefined;
  const executable = process.platform === "win32" ? "claude.exe" : "claude";

  const candidates = [
    path.join(process.cwd(), "node_modules", packageName, executable),
    path.join(__dirname, "..", "..", "node_modules", packageName, executable)
  ];

  if (process.resourcesPath) {
    candidates.unshift(path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", packageName, executable));
  }

  for (const candidate of candidates.map(toUnpackedAsarPath)) {
    if (fs.existsSync(candidate)) return candidate;
  }

  if (isPackagedRuntime()) {
    throw new Error(`Claude Code executable not found for ${process.platform}-${process.arch}. Expected package ${packageName} to be unpacked with the app.`);
  }

  return undefined;
}

function getClaudeBinaryPackageName(): string | null {
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : null;
  if (!arch) return null;
  if (process.platform === "darwin") return `@anthropic-ai/claude-agent-sdk-darwin-${arch}`;
  if (process.platform === "win32") return `@anthropic-ai/claude-agent-sdk-win32-${arch}`;
  if (process.platform === "linux") return `@anthropic-ai/claude-agent-sdk-linux-${arch}`;
  return null;
}

function toUnpackedAsarPath(candidate: string): string {
  return candidate.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function isPackagedRuntime(): boolean {
  return __dirname.includes(`${path.sep}app.asar${path.sep}`) || Boolean(process.resourcesPath && !process.env.VITE_DEV_SERVER_URL);
}

function validateConfig(request: AgentRunRequest): void {
  const provider = request.config.provider;
  if ((!provider.baseUrl || !provider.apiKey || !provider.model) && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("请先配置模型供应商：请完整填写 Base URL、API Key 和 Model 后再提交。");
  }
}

function buildAgentEnv(request: AgentRunRequest): Record<string, string | undefined> {
  const provider = request.config.provider;
  return {
    ...process.env,
    CLAUDE_CODE_DISABLE_CRON: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "GrowthForce",
    CLAUDE_CONFIG_DIR: getDefaultAgentConfigDir(request.agentName),
    ANTHROPIC_API_KEY: provider.apiKey || process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: provider.apiKey || process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: provider.baseUrl || process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_MODEL: provider.model || process.env.ANTHROPIC_MODEL,
    AGENTSTUDIO_BROWSER_CDP_PORT: request.browserAutomation ? String(request.browserAutomation.cdpPort) : undefined,
    AGENTSTUDIO_BROWSER_CDP_WS_URL: request.browserAutomation?.cdpWebSocketUrl,
    AGENTSTUDIO_XHS_CLI: request.xhsConnector?.cliCommand,
    AGENTSTUDIO_XHS_CDP_PORT: request.xhsConnector ? String(request.xhsConnector.cdpPort) : undefined,
    AGENTSTUDIO_XHS_TARGET_ID: request.xhsConnector?.targetId,
    AGENTSTUDIO_XHS_PROFILE_KEY: request.xhsConnector?.profileKey,
    AGENTSTUDIO_XHS_PROCESS_REGISTRY_DIR: request.xhsConnector?.processRegistryDir,
    AGENTSTUDIO_XHS_NETLOG_PATH: request.xhsConnector?.netLogPath,
    AGENTSTUDIO_XHS_DIAGNOSTICS_PATH: request.xhsConnector?.diagnosticsPath,
    AGENTSTUDIO_XHS_ACCOUNT_ID: request.xhsConnector?.accountId ?? undefined,
    AGENTSTUDIO_XHS_ACCOUNT_HANDLE: request.xhsConnector?.accountHandle ?? undefined,
    AGENTSTUDIO_XHS_DISPLAY_NAME: request.xhsConnector?.displayName ?? undefined,
    WECHAT_APPID: request.wechatConnector?.appId,
    WECHAT_SECRET: request.wechatConnector?.secret,
    WECHAT_AUTHOR: request.wechatConnector?.author,
    AGENTSTUDIO_AGENT_REQUEST_ID: request.requestId
  };
}

function getAgentStudioRoot(): string {
  return path.join(os.homedir(), ".agentstudio");
}

function getDefaultAgentConfigDir(agentName = "orchestrator"): string {
  return path.join(getAgentStudioRoot(), "agents", agentName);
}

function extractMessage(requestId: string, message: SDKMessage): { events: AgentEvent[]; sdkSessionId?: string; resultText?: string } {
  const events: AgentEvent[] = [];
  const raw = message as Record<string, unknown>;
  const type = raw.type;
  const timestamp = normalizeEventTimestamp(raw.timestamp) ?? new Date().toISOString();
  let sdkSessionId: string | undefined;
  let resultText: string | undefined;

  if (typeof raw.session_id === "string") sdkSessionId = raw.session_id;
  if (typeof raw.sessionId === "string") sdkSessionId = raw.sessionId;

  if (type === "assistant" && Array.isArray(raw.message ? (raw.message as { content?: unknown }).content : raw.content)) {
    const content = raw.message ? (raw.message as { content?: unknown }).content : raw.content;
    const thinking = extractThinking(content);
    if (thinking) events.push({ type: "thinking", requestId, text: thinking });
    const text = extractText(content);
    if (text) events.push({ type: "message", requestId, role: "assistant", text });
    events.push(...extractToolUseEvents(requestId, content, timestamp));
  }

  if (type === "user") {
    const content = raw.message ? (raw.message as { content?: unknown }).content : raw.content;
    events.push(...extractToolResultEvents(requestId, content, raw.tool_use_result, timestamp));
  }

  if (type === "partial" || type === "assistant_partial") {
    const text = typeof raw.text === "string" ? raw.text : extractText(raw.content);
    if (text) events.push({ type: "partial", requestId, text });
  }

  if (type === "stream_event") {
    const text = extractStreamEventText(raw.event);
    if (text) events.push({ type: "partial", requestId, text });
    const thinking = extractStreamEventThinking(raw.event);
    if (thinking) events.push({ type: "thinking", requestId, text: thinking });
  }

  if (type === "result" && typeof raw.result === "string") {
    resultText = raw.result;
  }

  if (type === "system" && typeof raw.subtype === "string" && shouldShowSystemMessage(raw.subtype)) {
    events.push({ type: "message", requestId, role: "system", text: raw.subtype, raw: message });
  }

  return { events, sdkSessionId, resultText };
}

function shouldShowSystemMessage(subtype: unknown): boolean {
  return typeof subtype === "string" && !["init", "api_retry", "status"].includes(subtype);
}

function extractStreamEventText(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const typed = event as { type?: string; delta?: { type?: string; text?: string } };
  if (typed.type === "content_block_delta" && typed.delta?.type === "text_delta") {
    return typed.delta.text ?? "";
  }
  return "";
}

function extractStreamEventThinking(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const typed = event as { type?: string; delta?: { type?: string; thinking?: string; text?: string; summary?: string } };
  if (typed.type !== "content_block_delta") return "";
  if (typed.delta?.type === "thinking_delta") return typed.delta.thinking ?? typed.delta.text ?? "";
  if (typed.delta?.type === "signature_delta") return "";
  return "";
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const block = item as { type?: string; text?: string };
      return block.type === "text" && block.text ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const block = item as { type?: string; thinking?: string; text?: string; summary?: string; content?: unknown };
      if (block.type === "thinking") return block.thinking ?? block.text ?? block.summary ?? "";
      if (block.type === "thinking_summary" || block.type === "summarized_thinking") return block.summary ?? block.text ?? "";
      if (typeof block.content === "string" && (block.type === "agent.thinking" || block.type === "thinking_delta")) return block.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractToolUseEvents(requestId: string, content: unknown, startedAt: string): AgentEvent[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const block = item as { type?: string; id?: string; name?: string; input?: unknown };
    if (block.type !== "tool_use" || !block.name) return [];
    return [
      {
        type: "tool",
        requestId,
        toolUseId: block.id || `${block.name}:${randomUUID()}`,
        name: block.name,
        input: block.input,
        status: "pending",
        startedAt
      }
    ];
  });
}

function extractToolResultEvents(requestId: string, content: unknown, directResult: unknown, completedAt: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const block = item as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      events.push({
        type: "tool",
        requestId,
        toolUseId: block.tool_use_id,
        name: "工具调用",
        result: normalizeToolResult(block.content),
        status: block.is_error ? "failed" : "completed",
        completedAt
      });
    }
  }

  if (events.length === 0 && directResult !== undefined) {
    const raw = directResult as { tool_use_id?: string; toolUseId?: string; name?: string; tool_name?: string; is_error?: boolean; result?: unknown; content?: unknown };
    const toolUseId = raw.tool_use_id || raw.toolUseId;
    if (toolUseId) {
      events.push({
        type: "tool",
        requestId,
        toolUseId,
        name: raw.tool_name || raw.name || "工具调用",
        result: normalizeToolResult(raw.result ?? raw.content ?? directResult),
        status: raw.is_error ? "failed" : "completed",
        completedAt
      });
    }
  }

  return events;
}

function normalizeEventTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString();
}

function normalizeToolResult(result: unknown): unknown {
  if (!Array.isArray(result)) return result;
  const text = extractText(result);
  return text || result;
}

function post(event: AgentEvent): void {
  logEvent("agent.event.outbound", summarizeAgentEvent(event));
  logEvent("agent.event.outbound.raw", event, { detail: true });
  process.parentPort?.postMessage(event);
}

function summarizeInboundMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") return { messageType: typeof message };
  const typed = message as { type?: string; requestId?: string; payload?: Partial<AgentRunRequest> };
  return {
    type: typed.type ?? null,
    requestId: typed.requestId ?? typed.payload?.requestId ?? null,
    sessionId: typed.payload?.sessionId ?? null,
    sdkSessionId: typed.payload?.sdkSessionId ?? null,
    workspacePath: typed.payload?.workspacePath ?? null,
    promptLength: typed.payload?.prompt?.length ?? null,
    hasConfig: Boolean(typed.payload?.config)
  };
}

function summarizeSdkMessage(message: SDKMessage): unknown {
  const raw = message as Record<string, unknown>;
  const content = raw.message && typeof raw.message === "object" ? (raw.message as { content?: unknown }).content : raw.content;
  return {
    type: raw.type ?? null,
    subtype: raw.subtype ?? null,
    sessionId: raw.session_id ?? raw.sessionId ?? null,
    contentBlockCount: Array.isArray(content) ? content.length : null,
    resultLength: typeof raw.result === "string" ? raw.result.length : null,
    raw: message
  };
}

function summarizeAgentEvent(event: AgentEvent): unknown {
  if (event.type === "session") {
    return {
      type: event.type,
      requestId: event.requestId,
      sdkSessionId: event.sdkSessionId
    };
  }
  if (event.type === "partial" || event.type === "message" || event.type === "thinking") {
    return {
      type: event.type,
      requestId: event.requestId,
      role: "role" in event ? event.role : undefined,
      textLength: event.text.length
    };
  }
  if (event.type === "tool") {
    return {
      type: event.type,
      requestId: event.requestId,
      toolUseId: event.toolUseId,
      name: event.name,
      status: event.status,
      hasInput: event.input !== undefined,
      hasResult: event.result !== undefined
    };
  }
  if (event.type === "supplementQueued" || event.type === "supplementConsumed") {
    return {
      type: event.type,
      requestId: event.requestId,
      sessionId: event.sessionId,
      itemId: event.item.id,
      textLength: event.item.text.length
    };
  }
  if (event.type === "supplementRevoked" || event.type === "supplementCleared") {
    return {
      type: event.type,
      requestId: event.requestId,
      sessionId: event.sessionId ?? null
    };
  }
  if (event.type === "done") {
    return {
      type: event.type,
      requestId: event.requestId,
      sdkSessionId: event.sdkSessionId ?? null,
      resultLength: event.result?.length ?? 0
    };
  }
  return {
    type: event.type,
    requestId: event.requestId,
    message: event.type === "error" ? event.message : undefined
  };
}

process.on("beforeExit", () => {
  void flushLogEvents();
});
