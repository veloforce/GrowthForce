export type SessionStatus = "idle" | "running" | "failed" | "completed" | "cancelled";
export type ChatPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "auto";
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type SessionOrigin = "manual" | "automation";
export type AutomationScheduleType = "once" | "interval" | "hourly" | "daily" | "weekday" | "weekly" | "monthly";
export type AutomationIntervalUnit = "minute" | "hour" | "day";
export type AutomationRunStatus = "running" | "waiting_resource" | "retrying" | "succeeded" | "failed";
export type ConnectorPlatform = "xhs" | "wechat" | "douyin";
export type ConnectorAccountStatus = "unauthorized" | "authorizing" | "authorized" | "needs_refresh" | "error";

export interface SessionRecord {
  id: number;
  sdkSessionId: string | null;
  agentName: string;
  title: string;
  workspacePath: string;
  jsonlPath: string | null;
  status: SessionStatus;
  origin: SessionOrigin;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
}

export interface StoredTextMessage {
  kind: "text";
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
}

export interface StoredSupplementMessage {
  kind: "supplement";
  id: string;
  requestId: string;
  role: "user";
  text: string;
  status: "pending";
  createdAt: string;
}

export interface StoredToolCall {
  id: string;
  toolUseId: string;
  name: string;
  input?: unknown;
  result?: unknown;
  status: "pending" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface StoredToolGroupMessage {
  kind: "toolGroup";
  id: string;
  tools: StoredToolCall[];
}

export interface StoredAssistantTextBlock {
  kind: "text";
  id: string;
  text: string;
}

export interface StoredThinkingBlock {
  kind: "thinking";
  id: string;
  text: string;
  mock?: boolean;
}

export interface StoredToolGroupBlock {
  kind: "toolGroup";
  id: string;
  tools: StoredToolCall[];
}

export type StoredAssistantBlock = StoredAssistantTextBlock | StoredThinkingBlock | StoredToolGroupBlock;

export interface StoredAssistantTurnMessage {
  kind: "assistantTurn";
  id: string;
  blocks: StoredAssistantBlock[];
}

export type StoredChatMessage = StoredTextMessage | StoredSupplementMessage | StoredToolGroupMessage | StoredAssistantTurnMessage;

export interface SessionDetail {
  session: SessionRecord;
  messages: StoredChatMessage[];
  runningRequestId?: string;
}

export type ArtifactFileKind = "markdown" | "html";

export interface ArtifactFilePreview {
  path: string;
  name: string;
  kind: ArtifactFileKind;
  content: string;
}

export interface AgentStudioConfig {
  provider: {
    id: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  imageProvider: {
    id: string;
    name: string;
    providerType: ImageProviderType | "";
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  workspace: {
    defaultDir: string;
  };
  user: {
    name: string;
    avatar: string;
  };
}

export type ModelProviderConfig = AgentStudioConfig["provider"];
export type ImageProviderConfig = AgentStudioConfig["imageProvider"];
export type ImageProviderType = "doubao" | "openai" | "gemini" | "dashscope" | "minimax" | "openai-compatible";

export interface ModelProviderDefinition {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ImageProviderDefinition {
  id: string;
  name: string;
  providerType: ImageProviderType;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ModelProviderSettings {
  providers: ModelProviderDefinition[];
}

export interface ImageProviderSettings {
  imageProviders: ImageProviderDefinition[];
}

export interface SaveModelProviderSettingsInput {
  settings: ModelProviderSettings;
  selectedProviderId: string;
}

export interface SaveImageProviderSettingsInput {
  settings: ImageProviderSettings;
  selectedImageProviderId: string;
}

export interface AgentStudioSettings {
  ui: {
    themeMode: ThemeMode;
  };
  chat: {
    permissionMode: ChatPermissionMode;
  };
  connector: {
    xhs: {
      selected_account: string;
    };
    wechat: {
      selected_account: string;
    };
  };
  workspace: {
    recentDirectories: string[];
  };
  skills: {
    installed: Record<string, {
      agent: string;
      dirName: string;
      source: "builtin" | "user" | "market";
      version?: string;
    }>;
    disabled: string[];
  };
}

export interface ThemeState {
  themeMode: ThemeMode;
  resolvedTheme: ResolvedTheme;
}

export interface AgentListItem {
  name: string;
  displayName: string;
  description: string;
}

export interface SkillInstallInput {
  agent?: string;
  url?: string;
  repo?: string;
  path?: string;
}

export interface RuntimePaths {
  root: string;
  agents: string;
  defaultAgent: string;
  config: string;
  settings: string;
  settingsDir: string;
  modelProviders: string;
  imageProviders: string;
  database: string;
  workspace: string;
  skills: string;
  userResourceSkills: string;
  userProfile: string;
  userData: string;
  runtime: string;
}

export type SkillRuntimeStatus = "enabled" | "disabled" | "enabled_missing_link" | "broken_link" | "conflict";

export interface SkillListItem {
  name: string;
  agent: string;
  description: string;
  sourceType: "builtin" | "user" | "market";
  sourcePath: string;
  version?: string;
  enabled: boolean;
  status: SkillRuntimeStatus;
}

export interface MarketSkillItem {
  name: string;
  description: string;
  agent: string;
  skillMdUrl: string;
  installed: boolean;
}

export interface SkillContent {
  frontmatter: Record<string, unknown>;
  markdown: string;
  raw: string;
  source: "installed" | "market";
}

export interface LocalAttachment {
  name: string;
  path: string;
}

export interface PromptSkillReference {
  name: string;
  agent: string;
  description: string;
}

export interface AgentRunRequest {
  requestId: string;
  sessionId?: number;
  sdkSessionId?: string | null;
  prompt: string;
  permissionMode: ChatPermissionMode;
  disallowedTools?: string[];
  attachments: LocalAttachment[];
  selectedSkills: PromptSkillReference[];
  workspacePath: string;
  agentName: string;
  config: AgentStudioConfig;
  browserAutomation?: BrowserAutomationContext;
  xhsConnector?: XhsConnectorContext;
  wechatConnector?: WechatConnectorContext;
  automationRun?: AutomationRunContext;
}

export interface AutomationRunContext {
  taskId: number;
  runId: number;
  attemptCount: number;
}

export interface AgentSupplementQueueItem {
  id: string;
  requestId: string;
  sessionId: number;
  text: string;
  status: "pending" | "consumed";
  createdAt: string;
  consumedAt?: string;
}

export interface AgentSupplementClaimRequest {
  type: "supplement:claimNext";
  rpcId: string;
  requestId: string;
  sessionId?: number;
}

export interface AgentSupplementClaimResponse {
  type: "supplement:claimNext:response";
  rpcId: string;
  requestId: string;
  item?: AgentSupplementQueueItem | null;
  error?: string;
}

export interface BrowserAutomationContext {
  cdpPort: number;
  cdpWebSocketUrl: string;
}

export interface XhsConnectorContext {
  cliCommand: string;
  cdpPort: number;
  targetId: string;
  profileKey: string;
  processRegistryDir: string;
  netLogPath: string;
  diagnosticsPath: string;
  accountId: string | null;
  accountHandle: string | null;
  displayName: string | null;
}

export interface WechatConnectorContext {
  profileKey: string;
  appId: string;
  secret: string;
  author: string;
  displayName: string;
}

export interface XhsConnectorStatus {
  connected: boolean;
  loggedIn: boolean;
  profilePath: string;
  targetId?: string;
  account?: ConnectorAccount | null;
  error?: string;
  raw?: unknown;
}

export interface XhsLoginResult {
  success: boolean;
  raw?: unknown;
}

export interface XhsConnectorCommandResult {
  exitCode: number;
  payload?: unknown;
  stdout?: string;
  stderr?: string;
}

export type AgentEvent =
  | { type: "session"; requestId: string; sessionId?: number; sdkSessionId: string }
  | { type: "partial"; requestId: string; sessionId?: number; text: string }
  | { type: "thinking"; requestId: string; sessionId?: number; text: string }
  | { type: "message"; requestId: string; sessionId?: number; role: "assistant" | "system"; text: string; raw?: unknown }
  | { type: "supplementQueued"; requestId: string; sessionId: number; item: AgentSupplementQueueItem }
  | { type: "supplementRevoked"; requestId: string; sessionId: number; itemId: string }
  | { type: "supplementConsumed"; requestId: string; sessionId: number; item: AgentSupplementQueueItem }
  | { type: "supplementCleared"; requestId: string; sessionId?: number; itemIds: string[] }
  | {
      type: "tool";
      requestId: string;
      sessionId?: number;
      toolUseId: string;
      name: string;
      input?: unknown;
      result?: unknown;
      status: "pending" | "completed" | "failed";
      startedAt?: string;
      completedAt?: string;
      durationMs?: number;
    }
  | { type: "done"; requestId: string; sessionId?: number; sdkSessionId?: string; result?: string; raw?: unknown }
  | { type: "error"; requestId: string; sessionId?: number; message: string };

export interface WorkspaceState {
  currentPath: string;
  defaultPath: string;
  recentDirectories: string[];
}

export interface WorkbenchPrompts {
  typingPrompts: string[];
  quickPrompts: WorkbenchQuickPrompt[];
}

export interface WorkbenchQuickPrompt {
  title: string;
  prompt: string;
}

export interface AutomationScheduleConfig {
  runAt?: string;
  intervalMinutes?: number;
  intervalValue?: number;
  intervalUnit?: AutomationIntervalUnit;
  minute?: number;
  hour?: number;
  weekdays?: number[];
  monthDays?: number[];
}

export interface AutomationConnectorBinding {
  profileKey: string;
  accountId: string | null;
  displayName: string | null;
}

export interface AutomationConnectorBindings {
  xhs?: AutomationConnectorBinding;
  wechat?: AutomationConnectorBinding;
}

export interface AutomationTask {
  id: number;
  name: string;
  description: string;
  workspacePath: string;
  scheduleType: AutomationScheduleType;
  scheduleConfig: AutomationScheduleConfig;
  maxRetries: number;
  maxRuns: number | null;
  runCount: number;
  connectorBindings: AutomationConnectorBindings;
  selectedSkills: PromptSkillReference[];
  attachments: LocalAttachment[];
  enabled: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorAccount {
  id: number;
  platform: ConnectorPlatform;
  profileKey: string;
  accountId: string | null;
  accountHandle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  status: ConnectorAccountStatus;
  opsState: ConnectorAccountOpsState;
  autoReviewEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
  lastAuthorizedAt: string | null;
}

export interface ConnectorAccountOpsState {
  reviewTaskId: number | null;
}

export interface ConnectorState {
  accounts: ConnectorAccount[];
  selected: {
    xhs: string;
    wechat: string;
  };
  locked?: {
    xhs: Record<string, boolean>;
  };
}

export interface AutomationRun {
  id: number;
  taskId: number;
  taskName: string;
  sessionId: number | null;
  scheduledAt: string;
  startedAt: string | null;
  endedAt: string | null;
  status: AutomationRunStatus;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationTaskInput {
  name: string;
  description: string;
  workspacePath: string;
  scheduleType: AutomationScheduleType;
  scheduleConfig: AutomationScheduleConfig;
  maxRetries: number;
  maxRuns?: number | null;
  connectorBindings?: AutomationConnectorBindings;
  selectedSkills?: PromptSkillReference[];
  attachments?: LocalAttachment[];
  enabled?: boolean;
}

export type AutomationToolOperation = "list" | "get" | "create" | "pause" | "resume" | "delete";

export interface AutomationToolRequest {
  rpcId: string;
  requestId: string;
  operation: AutomationToolOperation;
  input?: unknown;
}

export interface AutomationToolResponse {
  rpcId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type XhsAccountRefreshReason = "not_logged_in" | "account_mismatch";

export interface ConnectorToolRequest {
  rpcId: string;
  requestId: string;
  operation: "xhs_account_mark_needs_refresh";
  input: {
    reason: XhsAccountRefreshReason;
    actualAccountId?: string;
  };
}

export interface ConnectorToolResponse {
  rpcId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface AgentPermissionRequest {
  rpcId: string;
  requestId: string;
  sessionId?: number;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  suggestions?: unknown[];
  agentId?: string;
}

export interface AgentPermissionResponse {
  rpcId: string;
  ok: boolean;
  action?: "allow" | "deny";
  mode?: "allow" | "allow_remember" | "deny" | "suggest_alternative";
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
  message?: string;
  error?: string;
}
