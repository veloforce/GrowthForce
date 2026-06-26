import path from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";
import type { AgentEvent, AgentPermissionRequest, AgentPermissionResponse, AgentRunRequest, AgentSupplementClaimRequest, AgentSupplementClaimResponse, AgentSupplementQueueItem, AutomationToolRequest, AutomationToolResponse, ConnectorToolRequest, ConnectorToolResponse } from "../shared/types";
import { logEvent } from "../shared/log";

type Listener = (event: AgentEvent) => void;
type AutomationToolHandler = (request: AutomationToolRequest, context: AgentRunRequest) => Promise<unknown>;
type ConnectorToolHandler = (request: ConnectorToolRequest, context: AgentRunRequest) => Promise<unknown>;
type PermissionRequestHandler = (request: AgentPermissionRequest, context: AgentRunRequest) => Promise<AgentPermissionResponse>;
type SupplementClaimHandler = (request: { requestId: string; sessionId?: number }) => Promise<AgentSupplementQueueItem | null>;

export class AgentProcessHost {
  private child: UtilityProcess | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly requests = new Map<string, AgentRunRequest>();
  private automationToolHandler: AutomationToolHandler | null = null;
  private connectorToolHandler: ConnectorToolHandler | null = null;
  private permissionRequestHandler: PermissionRequestHandler | null = null;
  private supplementClaimHandler: SupplementClaimHandler | null = null;

  constructor(private readonly agentEntry: string) {}

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  run(request: AgentRunRequest): void {
    this.ensureChild();
    this.requests.set(request.requestId, request);
    this.child?.postMessage({ type: "run", payload: request });
  }

  onAutomationToolRequest(handler: AutomationToolHandler): void {
    this.automationToolHandler = handler;
  }

  onConnectorToolRequest(handler: ConnectorToolHandler): void {
    this.connectorToolHandler = handler;
  }

  onPermissionRequest(handler: PermissionRequestHandler): void {
    this.permissionRequestHandler = handler;
  }

  cancel(requestId: string): void {
    this.child?.postMessage({ type: "cancel", requestId });
  }

  onSupplementClaimRequest(handler: SupplementClaimHandler): void {
    this.supplementClaimHandler = handler;
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
  }

  private ensureChild(): void {
    if (this.child) return;
    logEvent("main.agentProcess", { event: "fork", agentEntry: this.agentEntry });
    this.child = utilityProcess.fork(this.agentEntry, [], {
      serviceName: "GrowthForce Agent Process",
      stdio: "pipe"
    });

    this.child.on("message", (message) => {
      logEvent("main.agentProcess.message", summarizeAgentProcessMessage(message));
      logEvent("main.agentProcess.message.raw", message, { detail: true });
      const supplementClaimRequest = getSupplementClaimRequest(message);
      if (supplementClaimRequest) {
        void this.handleSupplementClaimRequest(supplementClaimRequest);
        return;
      }
      if (isAgentEvent(message)) {
        for (const listener of this.listeners) listener(message);
        if (message.type === "done" || message.type === "error") this.requests.delete(message.requestId);
        return;
      }
      const toolRequest = getAutomationToolRequest(message);
      if (toolRequest) void this.handleAutomationToolRequest(toolRequest);
      const connectorToolRequest = getConnectorToolRequest(message);
      if (connectorToolRequest) void this.handleConnectorToolRequest(connectorToolRequest);
      const permissionRequest = getPermissionRequest(message);
      if (permissionRequest) void this.handlePermissionRequest(permissionRequest);
    });

    this.child.on("exit", () => {
      logEvent("main.agentProcess", { event: "exit" });
      this.child = null;
    });

    this.child.stdout?.on("data", (data) => {
      const text = data.toString().trim();
      if (text) logEvent("agent.stdout", { length: text.length }, { detail: true });
      console.log(`[agent] ${text}`);
    });

    this.child.stderr?.on("data", (data) => {
      const text = data.toString().trim();
      if (text) logEvent("agent.stderr", { length: text.length, text }, { detail: true });
      console.error(`[agent] ${text}`);
    });
  }

  private async handleAutomationToolRequest(request: AutomationToolRequest): Promise<void> {
    const context = this.requests.get(request.requestId);
    let response: AutomationToolResponse;
    if (!context || !this.automationToolHandler) {
      response = { rpcId: request.rpcId, ok: false, error: "Automation tool request context is unavailable" };
    } else {
      try {
        response = { rpcId: request.rpcId, ok: true, result: await this.automationToolHandler(request, context) };
      } catch (error) {
        response = { rpcId: request.rpcId, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    this.child?.postMessage({ type: "automationToolResponse", payload: response });
  }

  private async handleConnectorToolRequest(request: ConnectorToolRequest): Promise<void> {
    const context = this.requests.get(request.requestId);
    let response: ConnectorToolResponse;
    if (!context || !this.connectorToolHandler) {
      response = { rpcId: request.rpcId, ok: false, error: "Connector tool request context is unavailable" };
    } else {
      try {
        response = { rpcId: request.rpcId, ok: true, result: await this.connectorToolHandler(request, context) };
      } catch (error) {
        response = { rpcId: request.rpcId, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    this.child?.postMessage({ type: "connectorToolResponse", payload: response });
  }

  private async handlePermissionRequest(request: AgentPermissionRequest): Promise<void> {
    const context = this.requests.get(request.requestId);
    let response: AgentPermissionResponse;
    if (!context || !this.permissionRequestHandler) {
      response = { rpcId: request.rpcId, ok: false, error: "Permission request context is unavailable" };
    } else {
      try {
        response = await this.permissionRequestHandler(request, context);
      } catch (error) {
        response = { rpcId: request.rpcId, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    this.child?.postMessage({ type: "agentPermissionResponse", payload: response });
  }

  private async handleSupplementClaimRequest(request: AgentSupplementClaimRequest): Promise<void> {
    let response: AgentSupplementClaimResponse;
    if (!this.supplementClaimHandler) {
      response = { type: "supplement:claimNext:response", rpcId: request.rpcId, requestId: request.requestId, item: null };
    } else {
      try {
        response = {
          type: "supplement:claimNext:response",
          rpcId: request.rpcId,
          requestId: request.requestId,
          item: await this.supplementClaimHandler({ requestId: request.requestId, sessionId: request.sessionId })
        };
      } catch (error) {
        response = {
          type: "supplement:claimNext:response",
          rpcId: request.rpcId,
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
    this.child?.postMessage(response);
  }
}

export function resolveAgentEntry(): string {
  return path.join(__dirname, "..", "agent", "agent.js");
}

function isAgentEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== "object") return false;
  const maybe = value as { type?: unknown; requestId?: unknown };
  return typeof maybe.type === "string" && typeof maybe.requestId === "string";
}

function getSupplementClaimRequest(value: unknown): AgentSupplementClaimRequest | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Partial<AgentSupplementClaimRequest>;
  if (message.type !== "supplement:claimNext") return null;
  if (typeof message.rpcId !== "string" || typeof message.requestId !== "string") return null;
  if (message.sessionId !== undefined && typeof message.sessionId !== "number") return null;
  return message as AgentSupplementClaimRequest;
}

function getAutomationToolRequest(value: unknown): AutomationToolRequest | null {
  if (!value || typeof value !== "object") return null;
  const message = value as { type?: unknown; payload?: unknown };
  if (message.type !== "automationToolRequest" || !message.payload || typeof message.payload !== "object") return null;
  const payload = message.payload as Partial<AutomationToolRequest>;
  if (typeof payload.rpcId !== "string" || typeof payload.requestId !== "string") return null;
  if (payload.operation !== "list" && payload.operation !== "get" && payload.operation !== "create" && payload.operation !== "pause" && payload.operation !== "resume" && payload.operation !== "delete") return null;
  return payload as AutomationToolRequest;
}

function getConnectorToolRequest(value: unknown): ConnectorToolRequest | null {
  if (!value || typeof value !== "object") return null;
  const message = value as { type?: unknown; payload?: unknown };
  if (message.type !== "connectorToolRequest" || !message.payload || typeof message.payload !== "object") return null;
  const payload = message.payload as Partial<ConnectorToolRequest>;
  if (typeof payload.rpcId !== "string" || typeof payload.requestId !== "string") return null;
  if (payload.operation !== "xhs_account_mark_needs_refresh") return null;
  if (!payload.input || typeof payload.input !== "object") return null;
  if (payload.input.reason !== "not_logged_in" && payload.input.reason !== "account_mismatch") return null;
  if (payload.input.actualAccountId !== undefined && typeof payload.input.actualAccountId !== "string") return null;
  return payload as ConnectorToolRequest;
}

function getPermissionRequest(value: unknown): AgentPermissionRequest | null {
  if (!value || typeof value !== "object") return null;
  const message = value as { type?: unknown; payload?: unknown };
  if (message.type !== "agentPermissionRequest" || !message.payload || typeof message.payload !== "object") return null;
  const payload = message.payload as Partial<AgentPermissionRequest>;
  if (typeof payload.rpcId !== "string" || typeof payload.requestId !== "string") return null;
  if (typeof payload.toolUseId !== "string" || typeof payload.toolName !== "string") return null;
  if (!payload.input || typeof payload.input !== "object" || Array.isArray(payload.input)) return null;
  return payload as AgentPermissionRequest;
}

function summarizeAgentProcessMessage(value: unknown): unknown {
  if (!isAgentEvent(value)) return { messageType: typeof value };
  if (value.type === "session") {
    return {
      type: value.type,
      requestId: value.requestId,
      sdkSessionId: value.sdkSessionId
    };
  }
  if (value.type === "partial" || value.type === "message" || value.type === "thinking") {
    return {
      type: value.type,
      requestId: value.requestId,
      role: "role" in value ? value.role : undefined,
      textLength: value.text.length
    };
  }
  if (value.type === "tool") {
    return {
      type: value.type,
      requestId: value.requestId,
      toolUseId: value.toolUseId,
      name: value.name,
      status: value.status,
      hasInput: value.input !== undefined,
      hasResult: value.result !== undefined
    };
  }
  if (value.type === "supplementQueued" || value.type === "supplementConsumed") {
    return {
      type: value.type,
      requestId: value.requestId,
      sessionId: value.sessionId,
      itemId: value.item.id,
      textLength: value.item.text.length
    };
  }
  if (value.type === "supplementRevoked" || value.type === "supplementCleared") {
    return {
      type: value.type,
      requestId: value.requestId,
      sessionId: value.sessionId ?? null
    };
  }
  if (value.type === "done") {
    return {
      type: value.type,
      requestId: value.requestId,
      sdkSessionId: value.sdkSessionId ?? null,
      resultLength: value.result?.length ?? 0
    };
  }
  return {
    type: value.type,
    requestId: value.requestId,
    message: value.type === "error" ? value.message : undefined
  };
}
