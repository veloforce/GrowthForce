import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { calculateAutomationDispatchPlan, calculateNextRunAt, getRetryDelayMs, normalizeAutomationTaskInput } from "../shared/automation";
import { ipcChannels } from "../shared/ipc";
import { flushLogEvents, logEvent } from "../shared/log";
import { stripSystemReminders } from "../shared/prompt";
import type { AgentEvent, AgentPermissionRequest, AgentPermissionResponse, AgentRunRequest, AgentSupplementQueueItem, ArtifactFileKind, ArtifactFilePreview, AutomationRun, AutomationScheduleConfig, AutomationScheduleType, AutomationTask, AutomationTaskInput, AutomationToolRequest, ChatPermissionMode, ConnectorAccount, ConnectorState, ConnectorToolRequest, LocalAttachment, ModelProviderConfig, PromptSkillReference, ResolvedTheme, RuntimePaths, SaveImageProviderSettingsInput, SaveModelProviderSettingsInput, SessionDetail, SessionRecord, SkillInstallInput, StoredChatMessage, StoredSupplementMessage, StoredTextMessage, StoredToolCall, ThemeMode, ThemeState, WorkbenchPrompts, WorkspaceState } from "../shared/types";
import { listBundledAgents } from "../agent/agents";
import { getSkillContent, installGithubSkill, listMarketSkills, listSkills, resolveBundledMarketSkillsFile, resolveBundledSkillsDirectory, setSkillDisabled, syncRuntimeSkills, type SkillRuntimePaths } from "../agent/skills";
import { AgentProcessHost, resolveAgentEntry } from "./agent-process";
import { markRunXhsAccountNeedsRefresh } from "./xhs-account-refresh";
import { claimNextSupplement, createSupplementQueue, revokePendingSupplement, type SupplementQueueState } from "./supplement-queue";
import { BrowserSessionManager, configureRemoteDebugging, findAvailableCdpPort, type BrowserSurfaceState } from "./browser-session";
import { resolveAutomationToolAttachments, resolveAutomationToolSkills, validateAutomationAttachments, validateAutomationSelectedSkills } from "./automation-tool";
import { AppDatabase } from "./database";
import { ensureRuntimeLayout, expandHome, needsProviderOnboarding, readConfig, writeProviderConfig } from "./paths";
import { normalizeThemeMode, readSettings, updatePermissionMode, updateRecentWorkspaceDirectories, updateSettings, updateThemeMode } from "./settings";
import { isXhsLoginWaitCancelledError, XhsConnectorRuntimeManager } from "./xhs-connector";
import { createInitialModelProviderSettings, imageProviderSettingsEqual, modelProviderSettingsEqual, normalizeSaveImageProviderSettingsInput, normalizeSaveModelProviderSettingsInput, readImageProviderSettings, readModelProviderSettings, splitModels, writeActiveImageProviderConfig, writeActiveModelConfig, writeActiveModelProviderConfig, writeImageProviderSettings, writeModelProviderSettings } from "./model-providers";

let mainWindow: BrowserWindow | null = null;
let db: AppDatabase;
let paths: RuntimePaths;
let agentHost: AgentProcessHost;
let browserSessions: BrowserSessionManager;
let xhsConnector: XhsConnectorRuntimeManager;
let cdpPort = 0;
let currentWorkspace = "";
const cancelledRequestIds = new Set<string>();
const sessionRuntimeCache = new Map<number, RuntimeSessionState>();
const supplementQueues = new Map<string, SupplementQueueState>();
const automationRequests = new Map<string, AutomationRequestState>();
const permissionRequests = new Map<string, {
  request: AgentPermissionRequest;
  resolve: (response: AgentPermissionResponse) => void;
}>();
let automationTimer: NodeJS.Timeout | null = null;
const xhsAuthCheckIntervalMs = 5 * 60 * 60 * 1000;
const xhsAuthCheckRetryMs = 15 * 60 * 1000;
const xhsAuthCheckTimers = new Map<string, NodeJS.Timeout>();
const xhsAuthChecksInFlight = new Set<string>();

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const defaultAgentName = "orchestrator";

configurePackagedRendering();

interface RuntimeSessionState {
  session: SessionRecord;
  messages: StoredChatMessage[];
  requestId?: string;
}

interface AutomationRequestState {
  runId: number;
  taskId: number;
  sessionId: number;
  attemptCount: number;
}

function resolveTheme(): ResolvedTheme {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function getThemeState(themeMode = readSettings(paths.settings).ui.themeMode): ThemeState {
  return {
    themeMode,
    resolvedTheme: resolveTheme()
  };
}

function applyThemeMode(themeMode: ThemeMode): ThemeState {
  nativeTheme.themeSource = themeMode;
  const theme = getThemeState(themeMode);
  updateNativeWindowTheme(theme.resolvedTheme);
  return theme;
}

function updateNativeWindowTheme(resolvedTheme: ResolvedTheme): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const colors = getNativeWindowThemeColors(resolvedTheme);
  mainWindow.setBackgroundColor(colors.backgroundColor);
  if (process.platform === "win32") {
    mainWindow.setTitleBarOverlay({
      color: colors.backgroundColor,
      symbolColor: colors.symbolColor,
      height: 48
    });
  }
}

function getNativeWindowThemeColors(resolvedTheme: ResolvedTheme): { backgroundColor: string; symbolColor: string } {
  return resolvedTheme === "dark"
    ? { backgroundColor: "#151615", symbolColor: "#c3c9c0" }
    : { backgroundColor: "#f8fafc", symbolColor: "#5d6870" };
}

function broadcastThemeState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const settings = readSettings(paths.settings);
  const theme = getThemeState(settings.ui.themeMode);
  updateNativeWindowTheme(theme.resolvedTheme);
  sendToMainWindow(ipcChannels.themeChanged, theme);
}

function sendToMainWindow(channel: string, ...args: unknown[]): boolean {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return false;
  mainWindow.webContents.send(channel, ...args);
  return true;
}

function configurePackagedRendering(): void {
  if (isDev) return;
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  logEvent("main.app.rendering", { hardwareAcceleration: false, reason: "packaged-default" });
}

function createWindow(): void {
  configureDockIcon();

  const windowThemeColors = getNativeWindowThemeColors(resolveTheme());
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: "小G",
    icon: getWindowIconPath(),
    backgroundColor: windowThemeColors.backgroundColor,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 15 }
        }
      : process.platform === "win32"
        ? {
            titleBarStyle: "hidden" as const,
            titleBarOverlay: {
              color: windowThemeColors.backgroundColor,
              symbolColor: windowThemeColors.symbolColor,
              height: 48
            }
          }
        : {}),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  browserSessions?.setMainWindow(mainWindow);
  xhsConnector?.setMainWindow(mainWindow);
  const createdWindow = mainWindow;
  mainWindow.on("closed", () => {
    if (mainWindow === createdWindow) mainWindow = null;
  });

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
  } else {
    void mainWindow.loadURL(pathToFileURL(path.join(__dirname, "..", "renderer", "index.html")).toString());
  }
}

function getWindowIconPath(): string {
  const iconFile = process.platform === "win32" ? "app-icon.ico" : process.platform === "darwin" ? "app-icon.icns" : "app-icon.png";
  const packagedIcon = path.join(process.resourcesPath, "resources", "icons", iconFile);
  if (app.isPackaged && fs.existsSync(packagedIcon)) return packagedIcon;
  const devIcon = path.join(app.getAppPath(), "build", process.platform === "win32" ? "icon.ico" : process.platform === "darwin" ? "icon.icns" : "icon.png");
  if (fs.existsSync(devIcon)) return devIcon;
  return path.join(app.getAppPath(), "build", "icon.png");
}

function configureDockIcon(): void {
  if (process.platform !== "darwin" || !app.dock) return;

  const icon = nativeImage.createFromPath(getDockIconPath());
  if (!icon.isEmpty()) app.dock.setIcon(icon);
}

function getDockIconPath(): string {
  const packagedIcon = path.join(process.resourcesPath, "resources", "icons", "app-icon.png");
  if (app.isPackaged && fs.existsSync(packagedIcon)) return packagedIcon;

  const devPngIcon = path.join(app.getAppPath(), "build", "icon.png");
  if (fs.existsSync(devPngIcon)) return devPngIcon;

  return getWindowIconPath();
}

function readWorkbenchPrompts(): WorkbenchPrompts {
  const fallback: WorkbenchPrompts = {
    typingPrompts: ["我是小G"],
    quickPrompts: [
      "帮我分析当前项目结构并给出改进建议",
      "总结这个目录下最近的关键文件",
      "生成一份本地项目执行计划",
      "检查 README 和配置是否一致",
      "帮我创建一个可执行的任务清单",
      "优化这段文案的表达"
    ]
  };
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, "resources", "prompts", "workbench-examples.json") : "",
    path.join(process.cwd(), "resources", "prompts", "workbench-examples.json"),
    path.join(__dirname, "..", "..", "resources", "prompts", "workbench-examples.json")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as Partial<WorkbenchPrompts>;
      const typingPrompts = normalizePromptList(parsed.typingPrompts);
      const quickPrompts = normalizePromptList(parsed.quickPrompts);
      return {
        typingPrompts: typingPrompts.length > 0 ? typingPrompts : fallback.typingPrompts,
        quickPrompts: quickPrompts.length > 0 ? quickPrompts : fallback.quickPrompts
      };
    } catch (error) {
      logEvent("main.workbenchPrompts:error", { candidate, error });
    }
  }

  return fallback;
}

function normalizePromptList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())));
}

function registerIpc(): void {
  ipcMain.handle(ipcChannels.appBootstrap, () => {
    const config = readConfig();
    let modelProviderSettingsError = "";
    let modelProviderSettings;
    try {
      modelProviderSettings = readModelProviderSettings(paths.modelProviders);
    } catch (error) {
      modelProviderSettings = { providers: [] };
      modelProviderSettingsError = error instanceof Error ? error.message : String(error);
      logEvent("main.modelProviders.readFailed", { message: modelProviderSettingsError });
    }
    let imageProviderSettingsError = "";
    let imageProviderSettings;
    try {
      imageProviderSettings = readImageProviderSettings(paths.imageProviders);
    } catch (error) {
      imageProviderSettings = { imageProviders: [] };
      imageProviderSettingsError = error instanceof Error ? error.message : String(error);
      logEvent("main.imageProviders.readFailed", { message: imageProviderSettingsError });
    }
    const settings = readSettings(paths.settings);
    const theme = applyThemeMode(settings.ui.themeMode);
    const installedSkills = listSkills(getSkillRuntimePaths());
    const marketSkills = listMarketSkills(getSkillRuntimePaths());
    const bootstrap = {
      paths,
      config,
      modelProviderSettings,
      modelProviderSettingsError,
      imageProviderSettings,
      imageProviderSettingsError,
      needsOnboarding: needsProviderOnboarding(config),
      settings,
      theme,
      workbenchPrompts: readWorkbenchPrompts(),
      platform: process.platform,
      connectorState: getConnectorState(),
      workspace: getWorkspaceState(),
      sessions: db.listSessions(),
      skills: {
        installed: installedSkills,
        market: marketSkills
      }
    };
    logEvent("main.ipc.appBootstrap", {
      sessionCount: bootstrap.sessions.length,
      workspace: bootstrap.workspace,
      skills: {
        installed: installedSkills.skills.length,
        market: marketSkills.skills.length,
        errors: [...installedSkills.errors, ...marketSkills.errors],
        conflicts: installedSkills.conflicts
      }
    });
    return bootstrap;
  });

  ipcMain.handle(ipcChannels.configSaveProvider, async (_event, provider: ModelProviderConfig) => {
    const normalized = normalizeProviderConfig(provider);
    const currentSettings = readModelProviderSettings(paths.modelProviders);
    let providerId = "";
    do {
      providerId = `provider-${randomUUID().slice(0, 8)}`;
    } while (currentSettings.providers.some((item) => item.id === providerId));
    const modelProviderSettings = createInitialModelProviderSettings(providerId, normalized);
    const nextProvider = { ...normalized, id: providerId };
    await testProviderConnectivity(normalized);
    writeModelProviderSettings(paths.modelProviders, {
      providers: [...currentSettings.providers, ...modelProviderSettings.providers]
    });
    const config = writeProviderConfig(paths.config, nextProvider);
    logEvent("main.ipc.config:saveProvider", {
      baseUrl: config.provider.baseUrl,
      model: config.provider.model
    });
    return {
      config,
      modelProviderSettings: readModelProviderSettings(paths.modelProviders),
      needsOnboarding: needsProviderOnboarding(config)
    };
  });

  ipcMain.handle(ipcChannels.configGetModelProviders, () => {
    const config = readConfig();
    return {
      settings: readModelProviderSettings(paths.modelProviders),
      config
    };
  });

  ipcMain.handle(ipcChannels.configSaveModelProviders, async (_event, input: SaveModelProviderSettingsInput) => {
    const normalized = normalizeSaveModelProviderSettingsInput(input);
    const currentSettings = readModelProviderSettings(paths.modelProviders);
    const settingsChanged = !modelProviderSettingsEqual(currentSettings, normalized.settings);
    const selectedProvider = normalized.settings.providers.find((provider) => provider.id === normalized.selectedProviderId);
    if (!selectedProvider) throw new Error("当前普通模型供应商不存在。");
    const firstModel = splitModels(selectedProvider.model)[0];
    if (!firstModel) throw new Error("当前普通模型供应商至少需要一个模型。");
    if (settingsChanged) {
      await testProviderConnectivity({
        id: selectedProvider.id,
        baseUrl: selectedProvider.baseUrl,
        apiKey: selectedProvider.apiKey,
        model: firstModel
      });
      writeModelProviderSettings(paths.modelProviders, normalized.settings);
    }
    const config = writeActiveModelProviderConfig(paths.config, readConfig(), normalized);
    logEvent("main.ipc.config:saveModelProviders", {
      providerId: normalized.selectedProviderId,
      model: config.provider.model,
      settingsChanged
    });
    return {
      settings: normalized.settings,
      config,
      needsOnboarding: needsProviderOnboarding(config)
    };
  });

  ipcMain.handle(ipcChannels.configSetActiveModel, (_event, value: string) => {
    const model = typeof value === "string" ? value.trim() : "";
    if (!model) throw new Error("请选择模型。");
    const currentConfig = readConfig();
    const currentSettings = readModelProviderSettings(paths.modelProviders);
    const provider = currentSettings.providers.find((item) => item.id === currentConfig.provider.id);
    if (!provider) throw new Error("当前普通模型供应商不存在。");
    const models = splitModels(provider.model);
    if (!models.includes(model)) throw new Error("所选模型不属于当前普通模型供应商。");
    const config = writeActiveModelConfig(paths.config, currentConfig, model);
    logEvent("main.ipc.config:setActiveModel", {
      providerId: config.provider.id,
      model: config.provider.model
    });
    return {
      settings: currentSettings,
      config,
      needsOnboarding: needsProviderOnboarding(config)
    };
  });

  ipcMain.handle(ipcChannels.configGetImageProviders, () => {
    const config = readConfig();
    return {
      settings: readImageProviderSettings(paths.imageProviders),
      config
    };
  });

  ipcMain.handle(ipcChannels.configSaveImageProviders, async (_event, input: SaveImageProviderSettingsInput) => {
    const normalized = normalizeSaveImageProviderSettingsInput(input);
    const currentSettings = readImageProviderSettings(paths.imageProviders);
    const settingsChanged = !imageProviderSettingsEqual(currentSettings, normalized.settings);
    if (settingsChanged) {
      writeImageProviderSettings(paths.imageProviders, normalized.settings);
    }
    const config = writeActiveImageProviderConfig(paths.config, readConfig(), normalized);
    logEvent("main.ipc.config:saveImageProviders", {
      imageProviderId: normalized.selectedImageProviderId || null,
      settingsChanged
    });
    return {
      settings: normalized.settings,
      config,
      needsOnboarding: needsProviderOnboarding(config)
    };
  });

  ipcMain.handle(ipcChannels.sessionsList, () => {
    const sessions = db.listSessions();
    logEvent("main.ipc.sessions:list", { count: sessions.length });
    return sessions;
  });
  ipcMain.handle(ipcChannels.sessionsGet, async (_event, id: number): Promise<SessionDetail | null> => {
    logEvent("main.ipc.sessions:get", { id });
    const runtime = sessionRuntimeCache.get(id);
    if (runtime) {
      refreshRuntimeSession(id);
      const detail = {
        session: sessionRuntimeCache.get(id)?.session ?? runtime.session,
        messages: runtime.messages,
        runningRequestId: runtime.requestId
      };
      logEvent("main.ipc.sessions:get:runtimeResult", {
        id,
        messageCount: detail.messages.length,
        status: detail.session.status
      });
      return detail;
    }

    const session = db.getSession(id);
    if (!session) return null;
    const detail = {
      session,
      messages: await loadSessionMessages(session),
      runningRequestId: undefined
    };
    logEvent("main.ipc.sessions:get:result", {
      id,
      messageCount: detail.messages.length,
      status: detail.session.status
    });
    return detail;
  });
  ipcMain.handle(ipcChannels.workspaceGet, () => {
    const workspace = getWorkspaceState();
    logEvent("main.ipc.workspace:get", workspace);
    return workspace;
  });

  ipcMain.handle(ipcChannels.workspaceSet, (_event, workspacePath: string) => {
    const nextWorkspace = resolveWorkspaceDirectory(workspacePath);
    if (!nextWorkspace) {
      throw new Error("请选择有效的项目目录");
    }
    currentWorkspace = nextWorkspace;
    updateRecentWorkspaceDirectories(paths.settings, currentWorkspace);
    logEvent("main.ipc.workspace:set", { workspacePath: currentWorkspace });
    return getWorkspaceState();
  });

  ipcMain.handle(ipcChannels.workspaceChoose, async () => {
    logEvent("main.ipc.workspace:choose", { currentWorkspace });
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "选择项目目录",
      defaultPath: currentWorkspace,
      properties: ["openDirectory", "createDirectory"]
    });
    if (!result.canceled && result.filePaths[0]) {
      currentWorkspace = result.filePaths[0];
      updateRecentWorkspaceDirectories(paths.settings, currentWorkspace);
    }
    logEvent("main.ipc.workspace:choose:result", {
      canceled: result.canceled,
      workspacePath: currentWorkspace
    });
    return getWorkspaceState();
  });

  ipcMain.handle(ipcChannels.filesChoose, async (): Promise<LocalAttachment[]> => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "添加文件",
      defaultPath: currentWorkspace,
      properties: ["openFile", "multiSelections"]
    });
    if (result.canceled) return [];
    return result.filePaths.map((filePath) => ({
      name: path.basename(filePath),
      path: filePath
    }));
  });

  ipcMain.handle(ipcChannels.filesArtifactRead, async (_event, input: { sessionId: number; filePath: string }): Promise<ArtifactFilePreview> => {
    const session = db.getSession(input.sessionId);
    if (!session) throw new Error("会话不存在");
    const filePath = path.resolve(expandHome(input.filePath));
    const kind = getArtifactFileKind(filePath);
    if (!kind) throw new Error("不支持预览该文件类型");
    const messages = sessionRuntimeCache.get(session.id)?.messages ?? await loadSessionMessages(session);
    if (!isArtifactReadAllowed(filePath, session, messages)) {
      throw new Error("该文件不属于当前会话，已拒绝读取");
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      throw new Error("文件不存在");
    }
    if (!stat.isFile()) throw new Error("文件不存在或不是普通文件");
    const content = fs.readFileSync(filePath, "utf8");
    logEvent("main.ipc.files.artifact:read", {
      sessionId: session.id,
      filePath,
      kind,
      bytes: Buffer.byteLength(content, "utf8")
    });
    return {
      path: filePath,
      name: path.basename(filePath),
      kind,
      content
    };
  });

  ipcMain.handle(ipcChannels.settingsUpdatePermissionMode, (_event, permissionMode: ChatPermissionMode) => {
    const settings = updatePermissionMode(paths.settings, normalizePermissionMode(permissionMode));
    logEvent("main.ipc.settings:updatePermissionMode", { permissionMode: settings.chat.permissionMode });
    return settings;
  });

  ipcMain.handle(ipcChannels.settingsUpdateThemeMode, (_event, themeMode: ThemeMode) => {
    const settings = updateThemeMode(paths.settings, normalizeThemeMode(themeMode));
    const theme = applyThemeMode(settings.ui.themeMode);
    logEvent("main.ipc.settings:updateThemeMode", theme);
    broadcastThemeState();
    return { settings, theme };
  });

  ipcMain.handle(ipcChannels.skillsList, () => {
    const result = listSkills(getSkillRuntimePaths());
    logEvent("main.ipc.skills:list", {
      count: result.skills.length,
      errors: result.errors,
      conflicts: result.conflicts
    });
    return result;
  });

  ipcMain.handle(ipcChannels.agentsList, () => {
    const result = listBundledAgents();
    logEvent("main.ipc.agents:list", { count: result.length });
    return result;
  });

  ipcMain.handle(ipcChannels.skillsEnable, (_event, name: string) => {
    const result = setSkillDisabled(getSkillRuntimePaths(), name, false);
    logEvent("main.ipc.skills:enable", {
      name,
      linked: result.linked.length,
      errors: result.errors,
      conflicts: result.conflicts
    });
    return listSkills(getSkillRuntimePaths());
  });

  ipcMain.handle(ipcChannels.skillsDisable, (_event, name: string) => {
    const result = setSkillDisabled(getSkillRuntimePaths(), name, true);
    logEvent("main.ipc.skills:disable", {
      name,
      disabled: result.disabled,
      errors: result.errors,
      conflicts: result.conflicts
    });
    return listSkills(getSkillRuntimePaths());
  });

  ipcMain.handle(ipcChannels.skillsMarketList, () => {
    const result = listMarketSkills(getSkillRuntimePaths());
    logEvent("main.ipc.skills.market:list", {
      count: result.skills.length,
      errors: result.errors
    });
    return result;
  });

  ipcMain.handle(ipcChannels.skillsContentGet, async (_event, input: { source: "installed" | "market"; name: string; agent?: string }) => {
    const content = await getSkillContent(getSkillRuntimePaths(), input);
    logEvent("main.ipc.skills.content:get", {
      source: input.source,
      name: input.name,
      agent: input.agent ?? null,
      markdownLength: content.markdown.length
    });
    return content;
  });

  ipcMain.handle(ipcChannels.skillsInstallGithub, async (_event, input: SkillInstallInput) => {
    const result = await installGithubSkill(getSkillRuntimePaths(), input);
    logEvent("main.ipc.skills.installGithub", {
      agent: input.agent ?? "orchestrator",
      linked: result.linked.length,
      errors: result.errors,
      conflicts: result.conflicts
    });
    return {
      sync: result,
      installed: listSkills(getSkillRuntimePaths()),
      market: listMarketSkills(getSkillRuntimePaths())
    };
  });

  ipcMain.handle(ipcChannels.automationTasksList, () => {
    const tasks = db.listAutomationTasks();
    logEvent("main.ipc.automation.tasks:list", { count: tasks.length });
    return tasks;
  });

  ipcMain.handle(ipcChannels.automationTaskGet, (_event, id: number) => {
    return db.getAutomationTask(id);
  });

  ipcMain.handle(ipcChannels.automationTaskCreate, (_event, raw: AutomationTaskInput) => {
    const input = normalizeAutomationTaskInput(raw);
    const nextRunAt = input.enabled === false ? null : calculateNextRunAt(input);
    if (input.enabled !== false && !nextRunAt) throw new Error("计划时间必须晚于当前时间");
    const task = db.createAutomationTask(input, nextRunAt);
    rescheduleAutomationTimer();
    emitAutomationChanged("task:create");
    return task;
  });

  ipcMain.handle(ipcChannels.automationTaskUpdate, (_event, payload: { id: number; input: AutomationTaskInput }) => {
    const existing = db.getAutomationTask(payload.id);
    if (!existing) throw new Error("自动化任务不存在");
    const input = normalizeAutomationTaskInput(payload.input);
    const enabled = payload.input.enabled ?? existing.enabled;
    const nextRunAt = enabled ? calculateNextRunAt({ ...input, enabled }) : null;
    if (enabled && !nextRunAt) throw new Error("计划时间必须晚于当前时间");
    const resetRunCount = didAutomationIntervalPlanChange(existing, input);
    const task = db.updateAutomationTask(payload.id, { ...input, enabled }, nextRunAt, resetRunCount);
    rescheduleAutomationTimer();
    emitAutomationChanged("task:update");
    return task;
  });

  ipcMain.handle(ipcChannels.automationTaskSetEnabled, (_event, payload: { id: number; enabled: boolean }) => {
    return setAutomationTaskEnabled(payload.id, payload.enabled, "task:setEnabled");
  });

  ipcMain.handle(ipcChannels.automationTaskDelete, (_event, id: number) => {
    unlinkAccountReviewTask(id, "task:delete");
    db.deleteAutomationTask(id);
    rescheduleAutomationTimer();
    emitAutomationChanged("task:delete");
    return { ok: true };
  });

  ipcMain.handle(ipcChannels.automationRunsList, () => {
    const runs = db.listAutomationRuns();
    logEvent("main.ipc.automation.runs:list", { count: runs.length });
    return runs;
  });

  ipcMain.handle(ipcChannels.automationRunSessionGet, async (_event, runId: number): Promise<SessionDetail | null> => {
    const run = db.getAutomationRun(runId);
    if (!run?.sessionId) return null;
    const session = db.getSession(run.sessionId);
    if (!session) return null;
    return {
      session,
      messages: sessionRuntimeCache.get(session.id)?.messages ?? await loadSessionMessages(session)
    };
  });

  ipcMain.handle(ipcChannels.connectorsStateGet, (): ConnectorState => {
    return getConnectorState();
  });

  ipcMain.handle(ipcChannels.connectorsXhsAccountCreate, () => {
    const profileKey = `xhs_${randomProfileKey()}`;
    const account = db.upsertConnectorAccount({
      platform: "xhs",
      profileKey,
      status: "authorizing"
    });
    logEvent("main.ipc.connectors.xhs:create", { profileKey });
    return {
      account,
      state: getConnectorState()
    };
  });

  ipcMain.handle(ipcChannels.connectorsXhsAccountSelect, async (_event, profileKey: string) => {
    const account = db.getConnectorAccountByProfileKey("xhs", normalizeProfileKeyInput(profileKey));
    if (!account) throw new Error("小红书账号不存在");
    assertXhsProfileUnlocked(account.profileKey);
    if (account.status !== "authorized") throw new Error("只能选择已授权的小红书账号");
    const settings = updateSettings(paths.settings, (current) => ({
      ...current,
      connector: {
        ...current.connector,
        xhs: {
          ...current.connector.xhs,
          selected_account: account.profileKey
        }
      }
    }));
    scheduleXhsAuthCheck(account);
    logEvent("main.ipc.connectors.xhs:select", { profileKey: account.profileKey });
    return {
      valid: true,
      settings,
      state: getConnectorState()
    };
  });

  ipcMain.handle(ipcChannels.connectorsXhsAccountClearSelection, () => {
    clearSelectedXhsAccount();
    logEvent("main.ipc.connectors.xhs:clearSelection", {});
    return getConnectorState();
  });

  ipcMain.handle(ipcChannels.connectorsXhsAccountDelete, (_event, profileKey: string) => {
    const normalized = normalizeProfileKeyInput(profileKey);
    const account = db.getConnectorAccountByProfileKey("xhs", normalized);
    if (!account) throw new Error("小红书账号不存在");
    assertXhsProfileUnlocked(normalized);
    disableAccountReviewTask(account, "xhs:delete");
    clearXhsAuthCheckTimer(normalized);
    xhsConnector.deleteProfile(normalized);
    db.deleteConnectorAccount("xhs", normalized);
    clearSelectedXhsAccountIf(normalized);
    logEvent("main.ipc.connectors.xhs:delete", { profileKey: normalized });
    return getConnectorState();
  });

  ipcMain.handle(ipcChannels.connectorsWechatAccountCreate, (_event, input: { displayName?: string; appId?: string; secret?: string }) => {
    const displayName = normalizeRequiredConnectorInput(input?.displayName, "请输入公众号昵称");
    const appId = normalizeRequiredConnectorInput(input?.appId, "请输入 WECHAT_APPID");
    const secret = normalizeRequiredConnectorInput(input?.secret, "请输入 WECHAT_SECRET");
    if (db.getConnectorAccountByAccountId("wechat", appId)) throw new Error("该公众号 APPID 已存在，请先删除原账号");
    const account = db.upsertConnectorAccount({
      platform: "wechat",
      profileKey: `wechat_${randomProfileKey()}`,
      accountId: appId,
      displayName,
      credentialSecret: secret,
      status: "authorized",
      lastAuthorizedAt: new Date().toISOString()
    });
    selectWechatAccount(account.profileKey);
    logEvent("main.ipc.connectors.wechat:create", { profileKey: account.profileKey, appId, displayName });
    return { account, state: getConnectorState() };
  });

  ipcMain.handle(ipcChannels.connectorsWechatAccountSelect, (_event, profileKey: string) => {
    const account = getTargetWechatAccount(profileKey);
    selectWechatAccount(account.profileKey);
    logEvent("main.ipc.connectors.wechat:select", { profileKey: account.profileKey });
    return { valid: true, state: getConnectorState() };
  });

  ipcMain.handle(ipcChannels.connectorsWechatAccountClearSelection, () => {
    clearSelectedWechatAccount();
    logEvent("main.ipc.connectors.wechat:clearSelection", {});
    return getConnectorState();
  });

  ipcMain.handle(ipcChannels.connectorsWechatCredentialGet, (_event, profileKey: string) => {
    const account = getTargetWechatAccount(profileKey);
    const secret = db.getConnectorCredentialSecret("wechat", account.profileKey);
    if (!secret) throw new Error("公众号 APPSECRET 不存在，请删除后重新添加账号");
    return { secret };
  });

  ipcMain.handle(ipcChannels.connectorsWechatAccountDelete, (_event, profileKey: string) => {
    const account = getTargetWechatAccount(profileKey);
    disableAccountReviewTask(account, "wechat:delete");
    db.deleteConnectorAccount("wechat", account.profileKey);
    clearSelectedWechatAccountIf(account.profileKey);
    logEvent("main.ipc.connectors.wechat:delete", { profileKey: account.profileKey });
    return getConnectorState();
  });

  ipcMain.handle(ipcChannels.connectorsAccountAutoReviewSet, (_event, input: { platform?: string; profileKey?: string; enabled?: boolean }) => {
    const platform = normalizeReviewPlatform(input?.platform);
    const profileKey = normalizeProfileKeyInput(input?.profileKey);
    const account = db.getConnectorAccountByProfileKey(platform, profileKey);
    if (!account) throw new Error("账号不存在");
    if (input.enabled) syncAccountReviewTask(account, true, "user:enableAutoReview");
    else disableAccountReviewTask(account, "user:disableAutoReview");
    return getConnectorState();
  });

  ipcMain.handle(ipcChannels.xhsStatus, () => {
    logEvent("main.ipc.xhs:status", {});
    return xhsConnector.status(getSelectedXhsAccount());
  });

  ipcMain.handle(ipcChannels.xhsLoginStart, (_event, profileKey?: string) => {
    const account = getTargetXhsAccount(profileKey);
    assertXhsProfileUnlocked(account.profileKey);
    logEvent("main.ipc.xhs:loginStart", { profileKey: account.profileKey });
    return xhsConnector.startLogin(account.profileKey);
  });

  ipcMain.handle(ipcChannels.xhsLoginWait, async (_event, input?: number | { profileKey?: string; timeout?: number }) => {
    const timeout = typeof input === "number" ? input : typeof input?.timeout === "number" ? input.timeout : undefined;
    const profileKey = typeof input === "object" ? input.profileKey : undefined;
    const account = getTargetXhsAccount(profileKey);
    assertXhsProfileUnlocked(account.profileKey);
    logEvent("main.ipc.xhs:loginWait", { profileKey: account.profileKey, timeout: timeout ?? null });
    let login;
    try {
      login = await xhsConnector.waitLogin(account.profileKey, timeout);
    } catch (error) {
      if (isXhsLoginWaitCancelledError(error)) {
        logEvent("main.ipc.xhs:loginWait:cancelled", {
          profileKey: account.profileKey,
          error: error instanceof Error ? error.message : String(error)
        });
        return {
          success: false,
          cancelled: true,
          state: getConnectorState(),
          raw: { cancelled: true }
        };
      }
      const systemError = isXhsConnectorSystemError(error);
      if (!isXhsConnectorSystemError(error)) {
        const updated = db.upsertConnectorAccount({
          platform: "xhs",
          profileKey: account.profileKey,
          accountId: account.accountId,
          accountHandle: account.accountHandle,
          displayName: account.displayName,
          avatarUrl: account.avatarUrl,
          status: "needs_refresh"
        });
        disableAccountReviewTask(updated, "xhs:loginWaitFailed");
        clearXhsAuthCheckTimer(account.profileKey);
      }
      logEvent("main.ipc.xhs:loginWait:failed", {
        profileKey: account.profileKey,
        systemError,
        statusUpdated: systemError ? null : "needs_refresh",
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
    logEvent("main.ipc.xhs:loginWait:result", { profileKey: account.profileKey, payload: summarizeXhsConnectorPayload(login.raw) });
    let info = normalizeXhsAccountInfo(login.raw);
    if (!info) {
      const accountInfo = await xhsConnector.getAccountInfo(account.profileKey);
      logEvent("main.ipc.xhs:loginWait:accountInfoFallback", { profileKey: account.profileKey, payload: summarizeXhsConnectorPayload(accountInfo.payload) });
      info = normalizeXhsAccountInfo(accountInfo.payload);
    }
    if (!hasCompleteXhsAccountInfo(info)) {
      const updated = db.upsertConnectorAccount({
        platform: "xhs",
        profileKey: account.profileKey,
        accountId: account.accountId,
        accountHandle: account.accountHandle,
        displayName: account.displayName,
        avatarUrl: account.avatarUrl,
        status: "needs_refresh"
      });
      disableAccountReviewTask(updated, "xhs:incompleteAccountInfo");
      clearXhsAuthCheckTimer(account.profileKey);
      logEvent("main.ipc.xhs:loginWait:incompleteAccountInfo", {
        profileKey: account.profileKey,
        statusUpdated: "needs_refresh",
        payload: summarizeXhsConnectorPayload(login.raw),
        normalized: info
      });
      return {
        ...login,
        account: updated,
        state: getConnectorState()
      };
    }
    if (account.accountId && info.accountId !== account.accountId) {
      const updated = resetXhsAccountProfileAfterMismatch(account, "loginWait:accountMismatch", { source: "loginWait", actualAccountId: info.accountId });
      const targetLabel = getConnectorAccountLabel(account);
      logEvent("main.ipc.xhs:loginWait:accountMismatch", {
        profileKey: account.profileKey,
        statusUpdated: "needs_refresh",
        expectedAccountId: account.accountId,
        actualAccountId: info.accountId
      });
      return {
        success: false,
        accountMismatch: true,
        message: `当前 profile 登录到了另一个小红书账号，已清空本地登录态，请重新授权「${targetLabel}」。`,
        account: updated,
        state: getConnectorState(),
        raw: login.raw
      };
    }
    const existing = db.getConnectorAccountByAccountId("xhs", info.accountId);
    if (existing && existing.profileKey !== account.profileKey) {
      const updatedExisting = db.upsertConnectorAccount({
        platform: "xhs",
        profileKey: existing.profileKey,
        accountId: info.accountId,
        accountHandle: info.accountHandle,
        displayName: info.displayName,
        avatarUrl: info.avatarUrl,
        status: "authorized",
        lastAuthorizedAt: new Date().toISOString()
      });
      disableAccountReviewTask(account, "xhs:duplicateAccountDeleted");
      db.deleteConnectorAccount("xhs", account.profileKey);
      xhsConnector.deleteProfile(account.profileKey);
      selectXhsAccount(updatedExisting.profileKey);
      scheduleXhsAuthCheck(updatedExisting);
      xhsConnector.updateSurface({ visible: false });
      logEvent("main.ipc.xhs:loginWait:duplicateAccount", {
        profileKey: account.profileKey,
        existingProfileKey: updatedExisting.profileKey,
        accountId: info.accountId,
        statusUpdated: "authorized"
      });
      return {
        success: true,
        duplicate: true,
        message: "该小红书账号已授权，已切换到已有账号",
        account: updatedExisting,
        state: getConnectorState(),
        raw: login.raw
      };
    }
    await xhsConnector.saveAuthCookies(account.profileKey);
    const updated = db.upsertConnectorAccount({
      platform: "xhs",
      profileKey: account.profileKey,
      accountId: info.accountId,
      accountHandle: info.accountHandle,
      displayName: info.displayName,
      avatarUrl: info.avatarUrl,
      status: "authorized",
      lastAuthorizedAt: new Date().toISOString()
    });
    selectXhsAccount(updated.profileKey);
    scheduleXhsAuthCheck(updated);
    xhsConnector.updateSurface({ visible: false });
    logEvent("main.ipc.xhs:loginWait:authorized", {
      profileKey: updated.profileKey,
      accountId: updated.accountId,
      accountHandle: updated.accountHandle,
      displayName: updated.displayName,
      statusUpdated: "authorized"
    });
    return {
      ...login,
      account: updated,
      state: getConnectorState()
    };
  });

  ipcMain.handle(ipcChannels.xhsLogout, async (_event, profileKey?: string) => {
    const account = getTargetXhsAccount(profileKey);
    assertXhsProfileUnlocked(account.profileKey);
    logEvent("main.ipc.xhs:logout", { profileKey: account.profileKey });
    const result = await xhsConnector.logout(account.profileKey);
    const updated = db.upsertConnectorAccount({
      platform: "xhs",
      profileKey: account.profileKey,
      accountId: account.accountId,
      accountHandle: account.accountHandle,
      displayName: account.displayName,
      avatarUrl: account.avatarUrl,
      status: "needs_refresh"
    });
    disableAccountReviewTask(updated, "xhs:logout");
    clearSelectedXhsAccountIf(account.profileKey);
    clearXhsAuthCheckTimer(account.profileKey);
    logEvent("main.ipc.xhs:logout:needsRefresh", { profileKey: account.profileKey, source: "userAction", statusUpdated: "needs_refresh" });
    return {
      ...result,
      state: getConnectorState()
    };
  });

  ipcMain.handle(ipcChannels.automationWorkspaceChoose, async (_event, currentPath?: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "选择自动化任务目录",
      defaultPath: currentPath ? expandHome(currentPath) : currentWorkspace,
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(ipcChannels.browserSurfaceUpdate, (_event, surface: BrowserSurfaceState) => {
    browserSessions.updateSurface(surface);
    return { ok: true };
  });

  ipcMain.handle(ipcChannels.agentStartTurn, async (_event, input: { prompt: string; sessionId?: number; permissionMode?: ChatPermissionMode; attachments?: LocalAttachment[]; selectedSkills?: PromptSkillReference[]; useBrowserAutomation?: boolean; xhsProfileKey?: string; wechatProfileKey?: string }) => {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("请输入内容");

    const config = readConfig();
    const permissionMode = normalizePermissionMode(input.permissionMode);
    const attachments = normalizeAttachments(input.attachments);
    const selectedSkills = normalizeSelectedSkills(input.selectedSkills);
    const session = input.sessionId ? db.getSession(input.sessionId) : db.createSession({ prompt, workspacePath: currentWorkspace });
    if (!session) throw new Error("会话不存在");
    const activeRequest = sessionRuntimeCache.get(session.id)?.requestId;
    if (activeRequest) throw new Error("当前会话已有任务正在运行，请等待完成或先停止任务");
    const workspacePath = session.workspacePath;

    logEvent("main.ipc.agent:startTurn", {
      sessionId: session.id,
      requestedSessionId: input.sessionId ?? null,
      workspacePath,
      currentWorkspace,
      promptLength: prompt.length,
      permissionMode,
      attachmentCount: attachments.length,
      selectedSkillCount: selectedSkills.length,
      xhsProfileKey: input.xhsProfileKey ?? null,
      wechatProfileKey: input.wechatProfileKey ?? null
    });

    db.markRunning(session.id);
    const runningSession = db.getSession(session.id) ?? { ...session, status: "running" as const };

    const request: AgentRunRequest = {
      requestId: `${session.id}:${Date.now()}`,
      sessionId: session.id,
      sdkSessionId: session.sdkSessionId,
      prompt,
      permissionMode,
      attachments,
      selectedSkills,
      workspacePath,
      agentName: session.agentName,
      config
    };
    let browserAutomation: AgentRunRequest["browserAutomation"];
    let xhsContext: AgentRunRequest["xhsConnector"];
    let wechatContext: AgentRunRequest["wechatConnector"];
    if (input.useBrowserAutomation !== false) {
      try {
        browserAutomation = await browserSessions.ensureSession(session.id);
      } catch (error) {
        logEvent("main.browser.session:ensureFailed", {
          requestId: request.requestId,
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    try {
      xhsContext = input.xhsProfileKey ? await ensureXhsContext(input.xhsProfileKey, request.requestId) : undefined;
      wechatContext = input.wechatProfileKey ? ensureWechatContext(input.wechatProfileKey) : undefined;
    } catch (error) {
      xhsConnector.releaseRequest(request.requestId);
      browserSessions.markIdle(session.id);
      db.updateStatus(session.id, "failed");
      refreshRuntimeSession(session.id);
      throw error;
    }
    request.browserAutomation = browserAutomation;
    request.xhsConnector = xhsContext;
    request.wechatConnector = wechatContext;
    initializeSupplementQueue(request.requestId, session.id);
    await cacheUserPrompt(runningSession, request.requestId, prompt);
    agentHost.run(request);
    logEvent("main.ipc.agent:startTurn:dispatched", {
      requestId: request.requestId,
      sessionId: session.id
    });
    return { requestId: request.requestId, session: db.getSession(session.id) };
  });

  ipcMain.handle(ipcChannels.agentCancelTurn, (_event, requestId: string) => {
    logEvent("main.ipc.agent:cancelTurn", { requestId });
    cancelledRequestIds.add(requestId);
    rejectPermissionRequestsForRequest(requestId, "任务已取消");
    closeSupplementQueue(requestId, "任务已取消");
    agentHost.cancel(requestId);
    xhsConnector.cancelRequest(requestId);
    const sessionId = Number(requestId.split(":")[0]);
    if (Number.isFinite(sessionId)) db.updateStatus(sessionId, "cancelled");
    if (Number.isFinite(sessionId)) browserSessions.markIdle(sessionId);
    xhsConnector.releaseRequest(requestId);
    const event: AgentEvent = {
      type: "error",
      requestId,
      sessionId: Number.isFinite(sessionId) ? sessionId : undefined,
      message: "任务已取消"
    };
    if (Number.isFinite(sessionId)) {
      updateRuntimeFromEvent(sessionId, event);
      refreshRuntimeSession(sessionId);
    }
    sendToMainWindow(ipcChannels.agentEvent, event);
  });

  ipcMain.handle(ipcChannels.agentEnqueueSupplement, (_event, input: { requestId?: string; sessionId?: number; text?: string }) => {
    const item = enqueueSupplement(input);
    return { item };
  });

  ipcMain.handle(ipcChannels.agentRevokeSupplement, (_event, input: { requestId?: string; sessionId?: number; itemId?: string }) => {
    const itemId = revokeSupplement(input);
    return { ok: true, itemId };
  });

  ipcMain.handle(ipcChannels.agentQueueSnapshot, (_event, input: { requestId?: string; sessionId?: number }) => {
    const requestId = normalizeRequestId(input?.requestId);
    const sessionId = normalizeSessionId(input?.sessionId);
    const queue = assertSupplementQueue(requestId, sessionId);
    return {
      items: queue.items.filter((item) => item.status === "pending")
    };
  });

  ipcMain.handle(ipcChannels.agentPermissionRespond, (_event, response: AgentPermissionResponse) => {
    const pending = permissionRequests.get(response.rpcId);
    if (!pending) return { ok: false, error: "权限请求已失效" };
    permissionRequests.delete(response.rpcId);
    const normalized: AgentPermissionResponse = {
      rpcId: response.rpcId,
      ok: true,
      mode: normalizeAgentPermissionResponseMode(response),
      updatedInput: isPlainRecord(response.updatedInput) ? response.updatedInput : undefined,
      updatedPermissions: Array.isArray(response.updatedPermissions) ? response.updatedPermissions : undefined,
      message: typeof response.message === "string" ? response.message : undefined
    };
    normalized.action = normalized.mode === "allow" || normalized.mode === "allow_remember" ? "allow" : "deny";
    pending.resolve(normalized);
    logEvent("main.ipc.agent:permissionRespond", {
      requestId: pending.request.requestId,
      rpcId: response.rpcId,
      toolName: pending.request.toolName,
      action: normalized.action
    });
    return { ok: true };
  });
}

function initializeSupplementQueue(requestId: string, sessionId: number): void {
  supplementQueues.set(requestId, createSupplementQueue(requestId, sessionId));
}

function enqueueSupplement(input: { requestId?: string; sessionId?: number; text?: string }): AgentSupplementQueueItem {
  const requestId = normalizeRequestId(input.requestId);
  const sessionId = normalizeSessionId(input.sessionId);
  const text = normalizeSupplementText(input.text);
  const queue = assertSupplementQueue(requestId, sessionId);
  if (queue.closed) throw new Error("当前任务已结束，请作为下一轮消息发送");
  const runtime = sessionRuntimeCache.get(sessionId);
  if (runtime?.requestId !== requestId) throw new Error("当前任务已结束，请作为下一轮消息发送");

  const item: AgentSupplementQueueItem = {
    id: randomUUID(),
    requestId,
    sessionId,
    text,
    status: "pending",
    createdAt: new Date().toISOString()
  };
  queue.items.push(item);
  const event: AgentEvent = { type: "supplementQueued", requestId, sessionId, item };
  updateRuntimeFromEvent(sessionId, event);
  sendToMainWindow(ipcChannels.agentEvent, event);
  logEvent("main.agent.supplement:queued", { requestId, sessionId, itemId: item.id, textLength: text.length });
  return item;
}

function revokeSupplement(input: { requestId?: string; sessionId?: number; itemId?: string }): string {
  const requestId = normalizeRequestId(input.requestId);
  const sessionId = normalizeSessionId(input.sessionId);
  const itemId = normalizeSupplementItemId(input.itemId);
  const queue = assertSupplementQueue(requestId, sessionId);
  const item = queue.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error("补充消息不存在或已失效");
  if (item.status !== "pending") throw new Error("补充消息已被小G读取，无法撤销");
  if (!revokePendingSupplement(queue, itemId)) throw new Error("补充消息已被小G读取，无法撤销");
  const event: AgentEvent = { type: "supplementRevoked", requestId, sessionId, itemId };
  updateRuntimeFromEvent(sessionId, event);
  sendToMainWindow(ipcChannels.agentEvent, event);
  logEvent("main.agent.supplement:revoked", { requestId, sessionId, itemId });
  return itemId;
}

function closeSupplementQueue(requestId: string, reason: string): void {
  const queue = supplementQueues.get(requestId);
  if (!queue) {
    return;
  }
  queue.closed = true;
  const itemIds = queue.items.filter((item) => item.status === "pending").map((item) => item.id);
  supplementQueues.delete(requestId);
  if (itemIds.length > 0) {
    const event: AgentEvent = { type: "supplementCleared", requestId, sessionId: queue.sessionId, itemIds };
    updateRuntimeFromEvent(queue.sessionId, event);
    sendToMainWindow(ipcChannels.agentEvent, event);
  }
  logEvent("main.agent.supplement:closed", { requestId, sessionId: queue.sessionId, reason, pendingCount: itemIds.length });
}

function claimSupplement(input: { requestId: string; sessionId?: number }): AgentSupplementQueueItem | null {
  const queue = supplementQueues.get(input.requestId);
  if (!queue) return null;
  if (input.sessionId !== undefined && queue.sessionId !== input.sessionId) return null;
  const item = claimNextSupplement(queue);
  if (!item) return null;
  const event: AgentEvent = { type: "supplementConsumed", requestId: input.requestId, sessionId: queue.sessionId, item };
  updateRuntimeFromEvent(queue.sessionId, event);
  sendToMainWindow(ipcChannels.agentEvent, event);
  logEvent("main.agent.supplement:claimed", {
    requestId: input.requestId,
    sessionId: queue.sessionId,
    itemId: item.id,
    textLength: item.text.length
  });
  return item;
}

function assertSupplementQueue(requestId: string, sessionId: number): SupplementQueueState {
  const queue = supplementQueues.get(requestId);
  if (!queue || queue.sessionId !== sessionId) throw new Error("当前任务已结束，请作为下一轮消息发送");
  return queue;
}

function normalizeRequestId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("requestId 无效");
  return value.trim();
}

function normalizeSessionId(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("sessionId 无效");
  return value;
}

function normalizeSupplementItemId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("补充消息无效");
  return value.trim();
}

function normalizeSupplementText(value: unknown): string {
  if (typeof value !== "string") throw new Error("请输入补充内容");
  const text = value.trim();
  if (!text) throw new Error("请输入补充内容");
  return text;
}

function normalizePermissionMode(value: unknown): ChatPermissionMode {
  return value === "default" || value === "acceptEdits" || value === "bypassPermissions" || value === "auto" ? value : readSettings(paths.settings).chat.permissionMode;
}

function getConnectorState(): ConnectorState {
  const settings = readSettings(paths.settings);
  const tasksById = new Map(db.listAutomationTasks().map((task) => [task.id, task]));
  const accounts = db.listConnectorAccounts().map((account) => ({
    ...account,
    autoReviewEnabled: Boolean(account.opsState.reviewTaskId && tasksById.get(account.opsState.reviewTaskId)?.enabled)
  }));
  const selectedXhs = accounts.some((account) => account.platform === "xhs" && account.profileKey === settings.connector.xhs.selected_account)
    ? settings.connector.xhs.selected_account
    : "";
  const selectedWechat = accounts.some((account) => account.platform === "wechat" && account.profileKey === settings.connector.wechat.selected_account)
    ? settings.connector.wechat.selected_account
    : "";
  if (selectedXhs !== settings.connector.xhs.selected_account) clearSelectedXhsAccountIf(settings.connector.xhs.selected_account);
  if (selectedWechat !== settings.connector.wechat.selected_account) clearSelectedWechatAccountIf(settings.connector.wechat.selected_account);
  return {
    accounts,
    selected: {
      xhs: selectedXhs,
      wechat: selectedWechat
    },
    locked: {
      xhs: xhsConnector.getLockSnapshot(accounts.filter((account) => account.platform === "xhs").map((account) => account.profileKey))
    }
  };
}

function getSelectedXhsAccount(): ConnectorAccount | null {
  const selected = readSettings(paths.settings).connector.xhs.selected_account;
  if (!selected) return null;
  return db.getConnectorAccountByProfileKey("xhs", selected);
}

function getTargetXhsAccount(profileKey?: string): ConnectorAccount {
  const normalized = profileKey ? normalizeProfileKeyInput(profileKey) : readSettings(paths.settings).connector.xhs.selected_account;
  if (!normalized) throw new Error("请先添加或选择小红书账号");
  const account = db.getConnectorAccountByProfileKey("xhs", normalized);
  if (!account) throw new Error("小红书账号不存在");
  return account;
}

async function ensureXhsContext(profileKey: string, requestId: string): Promise<NonNullable<AgentRunRequest["xhsConnector"]>> {
  const account = getTargetXhsAccount(profileKey);
  if (account.status !== "authorized") throw new Error("当前小红书账号未授权，请重新授权后再试");
  return xhsConnector.ensureContext(account, requestId);
}

function ensureWechatContext(profileKey: string): NonNullable<AgentRunRequest["wechatConnector"]> {
  const account = getTargetWechatAccount(profileKey);
  const secret = db.getConnectorCredentialSecret("wechat", account.profileKey);
  if (!secret) throw new Error("当前公众号账号缺少 WECHAT_SECRET，请删除后重新添加");
  return {
    profileKey: account.profileKey,
    appId: account.accountId!,
    secret,
    author: account.displayName!,
    displayName: account.displayName!
  };
}

function getTargetWechatAccount(profileKey: string): ConnectorAccount {
  const normalized = normalizeProfileKeyInput(profileKey);
  const account = db.getConnectorAccountByProfileKey("wechat", normalized);
  if (!account) throw new Error("公众号账号不存在");
  if (account.status !== "authorized" || !account.accountId || !account.displayName) throw new Error("公众号账号配置不完整，请删除后重新添加");
  return account;
}

function selectXhsAccount(profileKey: string): void {
  updateSettings(paths.settings, (current) => ({
    ...current,
    connector: {
      ...current.connector,
      xhs: {
        ...current.connector.xhs,
        selected_account: profileKey
      }
    }
  }));
}

function clearSelectedXhsAccount(): void {
  updateSettings(paths.settings, (current) => ({
    ...current,
    connector: {
      ...current.connector,
      xhs: {
        ...current.connector.xhs,
        selected_account: ""
      }
    }
  }));
}

function clearSelectedXhsAccountIf(profileKey: string): void {
  if (!profileKey) return;
  const settings = readSettings(paths.settings);
  if (settings.connector.xhs.selected_account !== profileKey) return;
  clearSelectedXhsAccount();
}

function selectWechatAccount(profileKey: string): void {
  updateSettings(paths.settings, (current) => ({
    ...current,
    connector: {
      ...current.connector,
      wechat: {
        ...current.connector.wechat,
        selected_account: profileKey
      }
    }
  }));
}

function clearSelectedWechatAccount(): void {
  updateSettings(paths.settings, (current) => ({
    ...current,
    connector: {
      ...current.connector,
      wechat: {
        ...current.connector.wechat,
        selected_account: ""
      }
    }
  }));
}

function clearSelectedWechatAccountIf(profileKey: string): void {
  if (!profileKey) return;
  const settings = readSettings(paths.settings);
  if (settings.connector.wechat.selected_account !== profileKey) return;
  clearSelectedWechatAccount();
}

function normalizeRequiredConnectorInput(value: unknown, message: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(message);
  return normalized;
}

function scheduleXhsAuthChecks(): void {
  for (const account of db.listConnectorAccounts("xhs")) scheduleXhsAuthCheck(account);
}

function scheduleXhsAuthCheck(account: ConnectorAccount): void {
  clearXhsAuthCheckTimer(account.profileKey);
  if (account.status !== "authorized") return;
  const lastAuthorizedAt = account.lastAuthorizedAt ? Date.parse(account.lastAuthorizedAt) : NaN;
  const dueAt = Number.isFinite(lastAuthorizedAt) ? lastAuthorizedAt + xhsAuthCheckIntervalMs : Date.now();
  const delayMs = Math.max(0, dueAt - Date.now());
  const timer = setTimeout(() => {
    xhsAuthCheckTimers.delete(account.profileKey);
    void runXhsAuthCheck(account.profileKey);
  }, delayMs);
  xhsAuthCheckTimers.set(account.profileKey, timer);
  logEvent("main.xhs.authCheck:schedule", { profileKey: account.profileKey, delayMs });
}

function clearXhsAuthCheckTimer(profileKey: string): void {
  const timer = xhsAuthCheckTimers.get(profileKey);
  if (!timer) return;
  clearTimeout(timer);
  xhsAuthCheckTimers.delete(profileKey);
}

function clearXhsAuthCheckTimers(): void {
  for (const profileKey of [...xhsAuthCheckTimers.keys()]) clearXhsAuthCheckTimer(profileKey);
}

async function runXhsAuthCheck(profileKey: string): Promise<void> {
  if (xhsAuthChecksInFlight.has(profileKey)) {
    logEvent("main.xhs.authCheck:skip", { profileKey, reason: "inFlight" });
    return;
  }
  const account = db.getConnectorAccountByProfileKey("xhs", profileKey);
  if (!account || account.status !== "authorized") {
    logEvent("main.xhs.authCheck:skip", { profileKey, reason: "notAuthorized", status: account?.status ?? null });
    return;
  }
  if (sessionRuntimeCacheHasActiveRequest() || automationRequests.size > 0 || xhsConnector.isLocked(profileKey)) {
    logEvent("main.xhs.authCheck:skip", {
      profileKey,
      reason: "busy",
      hasAgentRequest: sessionRuntimeCacheHasActiveRequest(),
      automationRequestCount: automationRequests.size,
      xhsLocked: xhsConnector.isLocked(profileKey)
    });
    scheduleXhsAuthCheckAfter(profileKey, xhsAuthCheckRetryMs);
    return;
  }

  xhsAuthChecksInFlight.add(profileKey);
  logEvent("main.xhs.authCheck:start", { profileKey, accountId: account.accountId });
  try {
    const result = await xhsConnector.checkSession(profileKey);
    logEvent("main.xhs.authCheck:result", {
      profileKey,
      exitCode: result.exitCode,
      payload: summarizeXhsConnectorPayload(result.payload)
    });
    const info = normalizeXhsAccountInfo(result.payload);
    if (!info?.accountId) {
      markXhsAccountNeedsRefresh(account, "silentAuthCheck:notLoggedIn", {
        source: "silentAuthCheck",
        payload: summarizeXhsConnectorPayload(result.payload)
      });
      return;
    }
    if (account.accountId && info.accountId !== account.accountId) {
      resetXhsAccountProfileAfterMismatch(account, "silentAuthCheck:accountMismatch", { source: "silentAuthCheck", actualAccountId: info.accountId });
      return;
    }
    const updated = db.upsertConnectorAccount({
      platform: "xhs",
      profileKey: account.profileKey,
      accountId: info.accountId,
      accountHandle: info.accountHandle ?? account.accountHandle,
      displayName: info.displayName ?? account.displayName,
      avatarUrl: info.avatarUrl ?? account.avatarUrl,
      status: "authorized",
      lastAuthorizedAt: new Date().toISOString()
    });
    logEvent("main.xhs.authCheck:authorized", { profileKey, accountId: updated.accountId });
    scheduleXhsAuthCheck(updated);
  } catch (error) {
    if (isXhsConnectorSystemError(error)) {
      logEvent("main.xhs.authCheck:systemError", {
        profileKey,
        source: "silentAuthCheck",
        error: error instanceof Error ? error.message : String(error)
      });
      scheduleXhsAuthCheckAfter(profileKey, xhsAuthCheckRetryMs);
      return;
    }
    markXhsAccountNeedsRefresh(account, "silentAuthCheck:failed", { source: "silentAuthCheck", error: error instanceof Error ? error.message : String(error) });
  } finally {
    xhsAuthChecksInFlight.delete(profileKey);
  }
}

function scheduleXhsAuthCheckAfter(profileKey: string, delayMs: number): void {
  clearXhsAuthCheckTimer(profileKey);
  const timer = setTimeout(() => {
    xhsAuthCheckTimers.delete(profileKey);
    void runXhsAuthCheck(profileKey);
  }, delayMs);
  xhsAuthCheckTimers.set(profileKey, timer);
  logEvent("main.xhs.authCheck:reschedule", { profileKey, delayMs });
}

function markXhsAccountNeedsRefresh(account: ConnectorAccount, reason: string, detail: Record<string, unknown> = {}): void {
  const updated = db.upsertConnectorAccount({
    platform: "xhs",
    profileKey: account.profileKey,
    accountId: account.accountId,
    accountHandle: account.accountHandle,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl,
    status: "needs_refresh"
  });
  disableAccountReviewTask(updated, "xhs:needsRefresh");
  clearSelectedXhsAccountIf(account.profileKey);
  clearXhsAuthCheckTimer(account.profileKey);
  logEvent("main.xhs.authCheck:needsRefresh", { profileKey: account.profileKey, accountId: updated.accountId, reason, ...detail });
}

function resetXhsAccountProfileAfterMismatch(account: ConnectorAccount, reason: string, detail: Record<string, unknown> = {}): ConnectorAccount {
  xhsConnector.deleteProfile(account.profileKey);
  const updated = db.upsertConnectorAccount({
    platform: "xhs",
    profileKey: account.profileKey,
    accountId: account.accountId,
    accountHandle: account.accountHandle,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl,
    status: "needs_refresh"
  });
  disableAccountReviewTask(updated, "xhs:accountMismatch");
  clearSelectedXhsAccountIf(account.profileKey);
  clearXhsAuthCheckTimer(account.profileKey);
  logEvent("main.xhs.accountMismatch:profileReset", { profileKey: account.profileKey, accountId: updated.accountId, reason, ...detail });
  return updated;
}

function normalizeXhsAccountInfo(value: unknown): { accountId: string; accountHandle: string | null; displayName: string | null; avatarUrl: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const loggedIn = record.logged_in === true || record.success === true;
  const accountId = readNonEmptyString(record.account_id) ?? readNonEmptyString(record.accountId) ?? readNonEmptyString(record.user_id) ?? readNonEmptyString(record.userId);
  if (!loggedIn && !accountId) return null;
  return {
    accountId: accountId ?? "",
    accountHandle: readNonEmptyString(record.account_handle) ?? readNonEmptyString(record.accountHandle) ?? readNonEmptyString(record.red_id) ?? readNonEmptyString(record.redId),
    displayName: readNonEmptyString(record.nickname) ?? readNonEmptyString(record.display_name) ?? readNonEmptyString(record.displayName),
    avatarUrl: readNonEmptyString(record.avatar_url) ?? readNonEmptyString(record.avatarUrl)
  };
}

function summarizeXhsConnectorPayload(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of [
    "success",
    "logged_in",
    "guest",
    "failure_reason",
    "last_failure_reason",
    "message",
    "error",
    "account_id",
    "account_handle",
    "nickname",
    "status"
  ]) {
    if (record[key] !== undefined) summary[key] = record[key];
  }
  return Object.keys(summary).length > 0 ? summary : { type: Object.prototype.toString.call(value) };
}

function getConnectorAccountLabel(account: ConnectorAccount): string {
  return account.displayName || account.accountHandle || account.accountId || account.profileKey;
}

function hasCompleteXhsAccountInfo(info: ReturnType<typeof normalizeXhsAccountInfo>): info is NonNullable<ReturnType<typeof normalizeXhsAccountInfo>> {
  return Boolean(info?.accountId && info.accountHandle && info.displayName);
}

function hasCompleteStoredXhsAccount(account: ConnectorAccount): boolean {
  return Boolean(account.accountId && account.accountHandle && account.displayName);
}

function isXhsConnectorSystemError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "XHS sidecar not found",
    "Packaged XHS CLI binary not found",
    "Python source XHS CLI requires",
    "No module named",
    "CDP target",
    "ECONNREFUSED",
    "timed out"
  ].some((pattern) => message.includes(pattern));
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeProfileKeyInput(value: unknown): string {
  if (typeof value !== "string") throw new Error("profileKey 无效");
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(trimmed)) throw new Error("profileKey 无效");
  return trimmed;
}

function randomProfileKey(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

function assertXhsProfileUnlocked(profileKey: string): void {
  if (xhsConnector.isLocked(profileKey)) throw new Error("其他任务正在运行");
}

function sessionRuntimeCacheHasActiveRequest(): boolean {
  for (const runtime of sessionRuntimeCache.values()) {
    if (runtime.requestId) return true;
  }
  return false;
}

function normalizeProviderConfig(value: ModelProviderConfig): ModelProviderConfig {
  const provider: Partial<ModelProviderConfig> = value && typeof value === "object" ? value : { id: "", baseUrl: "", apiKey: "", model: "" };
  const normalized = {
    id: typeof provider.id === "string" ? provider.id.trim() : "",
    baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "",
    apiKey: typeof provider.apiKey === "string" ? provider.apiKey.trim() : "",
    model: typeof provider.model === "string" ? provider.model.trim() : ""
  };
  if (!normalized.baseUrl || !normalized.apiKey || !normalized.model) {
    throw new Error("请完整填写 Base URL、API Key 和 Model。");
  }
  return normalized;
}

async function testProviderConnectivity(provider: ModelProviderConfig): Promise<void> {
  const endpoint = resolveMessagesEndpoint(provider.baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with OK only." }]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(await readConnectivityError(response));
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("模型连通性测试超时，请检查 Base URL、网络或模型服务状态。");
    }
    if (error instanceof Error) {
      throw new Error(`模型连通性测试失败：${error.message}`);
    }
    throw new Error(`模型连通性测试失败：${String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function resolveMessagesEndpoint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    url.pathname = normalizedPath.endsWith("/v1") ? `${normalizedPath}/messages` : `${normalizedPath}/v1/messages`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    throw new Error("Base URL 格式无效，请填写完整 URL，例如 https://api.anthropic.com。");
  }
}

async function readConnectivityError(response: Response): Promise<string> {
  const fallback = `HTTP ${response.status} ${response.statusText}`.trim();
  const text = (await response.text()).trim();
  if (!text) return fallback;
  try {
    const payload = JSON.parse(text) as unknown;
    const message = extractErrorMessage(payload);
    return message ? `${fallback}: ${message}` : fallback;
  } catch {
    return text ? `${fallback}: ${text.slice(0, 500)}` : fallback;
  }
}

function extractErrorMessage(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  const message = record.message;
  return typeof message === "string" ? message : "";
}

function normalizeAttachments(value: unknown): LocalAttachment[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const attachments: LocalAttachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as { name?: unknown; path?: unknown };
    if (typeof raw.path !== "string" || raw.path.trim().length === 0) continue;
    const filePath = path.resolve(expandHome(raw.path));
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    attachments.push({
      name: typeof raw.name === "string" && raw.name.trim().length > 0 ? raw.name.trim() : path.basename(filePath),
      path: filePath
    });
  }
  return attachments;
}

function normalizeSelectedSkills(value: unknown): PromptSkillReference[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const skills: PromptSkillReference[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as { name?: unknown; agent?: unknown; description?: unknown };
    if (typeof raw.name !== "string" || raw.name.trim().length === 0) continue;
    if (seen.has(raw.name)) continue;
    seen.add(raw.name);
    skills.push({
      name: raw.name.trim(),
      agent: typeof raw.agent === "string" ? raw.agent.trim() : "",
      description: typeof raw.description === "string" ? raw.description.trim() : ""
    });
  }
  return skills;
}

function getSkillRuntimePaths(): SkillRuntimePaths {
  return {
    bundledSkills: resolveBundledSkillsDirectory(),
    userResourceSkills: paths.userResourceSkills,
    runtimeSkills: paths.skills,
    settings: paths.settings,
    marketSkills: resolveBundledMarketSkillsFile()
  };
}

async function loadSessionMessages(session: Pick<SessionRecord, "id" | "sdkSessionId" | "workspacePath" | "agentName" | "jsonlPath">): Promise<StoredChatMessage[]> {
  if (!session.sdkSessionId) return [];
  const jsonlPath = resolveSessionJsonlPath(session);
  if (jsonlPath) {
    try {
      const messages = readSessionJsonlMessages(jsonlPath);
      if (messages.length > 0) {
        if (session.jsonlPath !== jsonlPath) db.updateJsonlPath(session.id, jsonlPath);
        logEvent("main.session.rawMessages:file", {
          sdkSessionId: session.sdkSessionId,
          workspacePath: session.workspacePath,
          agentName: session.agentName,
          jsonlPath,
          messageCount: messages.length
        }, { detail: true });
        return mapSdkSessionMessages(messages);
      }
    } catch (error) {
      logEvent("main.session.rawMessages:fileError", {
        sdkSessionId: session.sdkSessionId,
        workspacePath: session.workspacePath,
        agentName: session.agentName,
        jsonlPath,
        error
      });
    }
  }

  try {
    const messages = await withAgentConfigDir(session.agentName, () => getSessionMessages(session.sdkSessionId!, { dir: session.workspacePath, includeSystemMessages: true }));
    logEvent("main.session.rawMessages", {
      sdkSessionId: session.sdkSessionId,
      workspacePath: session.workspacePath,
      agentName: session.agentName,
      messageCount: messages.length,
      messages
    }, { detail: true });
    return mapSdkSessionMessages(messages);
  } catch (error) {
    logEvent("main.session.rawMessages:error", {
      sdkSessionId: session.sdkSessionId,
      workspacePath: session.workspacePath,
      agentName: session.agentName,
      error
    });
    console.warn("Failed to load session messages", error);
    return [];
  }
}

function resolveSessionJsonlPath(session: Pick<SessionRecord, "sdkSessionId" | "workspacePath" | "agentName" | "jsonlPath">): string | null {
  if (session.jsonlPath) {
    const resolved = path.resolve(expandHome(session.jsonlPath));
    if (fs.existsSync(resolved)) return resolved;
  }
  if (!session.sdkSessionId) return null;
  const candidate = getSessionJsonlCandidatePath(session.agentName, session.workspacePath, session.sdkSessionId);
  return fs.existsSync(candidate) ? candidate : null;
}

function persistSessionJsonlPath(sessionId: number, sdkSessionId: string): void {
  const jsonlPath = getExistingSessionJsonlPath(sessionId, sdkSessionId);
  if (!jsonlPath) return;
  db.updateJsonlPath(sessionId, jsonlPath);
}

function getExistingSessionJsonlPath(sessionId: number, sdkSessionId: string): string | null {
  const session = db.getSession(sessionId);
  if (!session) return null;
  const jsonlPath = getSessionJsonlCandidatePath(session.agentName, session.workspacePath, sdkSessionId);
  if (!fs.existsSync(jsonlPath)) {
    logEvent("main.session.jsonl:notFound", {
      sessionId,
      sdkSessionId,
      agentName: session.agentName,
      workspacePath: session.workspacePath,
      jsonlPath
    });
    return null;
  }
  return jsonlPath;
}

function getSessionJsonlCandidatePath(agentName: string | null | undefined, workspacePath: string, sdkSessionId: string): string {
  return path.join(paths.agents, normalizeAgentName(agentName), "projects", getClaudeProjectDirectoryName(workspacePath), `${sdkSessionId}.jsonl`);
}

function getClaudeProjectDirectoryName(workspacePath: string): string {
  return path.resolve(expandHome(workspacePath)).replace(/[^A-Za-z0-9]/g, "-");
}

function readSessionJsonlMessages(jsonlPath: string): SessionMessage[] {
  const content = fs.readFileSync(jsonlPath, "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Partial<SessionMessage> & { message?: unknown; uuid?: unknown; type?: unknown };
        if (!parsed || typeof parsed !== "object") return [];
        if (!["user", "assistant", "system"].includes(String(parsed.type))) return [];
        if (!parsed.message || typeof parsed.uuid !== "string") return [];
        return [parsed as SessionMessage];
      } catch {
        return [];
      }
    });
}

async function withAgentConfigDir<T>(agentName: string | null | undefined, action: () => Promise<T>): Promise<T> {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = getAgentConfigDir(agentName);
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
}

function getAgentConfigDir(agentName: string | null | undefined): string {
  return path.join(paths.agents, normalizeAgentName(agentName));
}

function normalizeAgentName(agentName: string | null | undefined): string {
  const trimmed = agentName?.trim();
  return trimmed || defaultAgentName;
}

function mapSdkSessionMessages(messages: SessionMessage[]): StoredChatMessage[] {
  const mapped: StoredChatMessage[] = [];
  const toolIndex = new Map<string, StoredToolCall>();

  for (const message of messages) {
    if (message.type === "system") {
      const subtype = getHistorySystemSubtype(message.message);
      if (!shouldShowHistorySystemMessage(subtype)) continue;
    }

    if (isHistorySourceToolResultMessage(message)) {
      const result = extractHistorySourceToolResult(message);
      if (result) appendHistoryTool(mapped, toolIndex, result);
      continue;
    }

    if (isHistoryUserToolResultMessage(message)) {
      for (const result of extractHistoryToolResults(message)) {
        appendHistoryTool(mapped, toolIndex, result);
      }
      continue;
    }

    const thinking = extractHistoryThinking(message.message);
    if (thinking && message.type === "assistant") {
      appendHistoryAssistantThinking(mapped, {
        kind: "thinking",
        id: `thinking:${message.uuid}`,
        text: thinking
      });
    }

    const text = message.type === "user" ? stripSystemReminders(extractHistoryText(message.message)) : extractHistoryText(message.message);
    if (text) {
      if (message.type === "assistant") {
        appendHistoryAssistantText(mapped, {
          kind: "text",
          id: message.uuid,
          text
        });
      } else {
        mapped.push({
          kind: "text",
          id: message.uuid,
          role: message.type,
          text
        });
      }
    }

    for (const tool of extractHistoryToolUses(message)) {
      appendHistoryTool(mapped, toolIndex, tool);
    }

    for (const result of extractHistoryToolResults(message)) {
      appendHistoryTool(mapped, toolIndex, result);
    }
  }

  return mapped;
}

function isHistorySourceToolResultMessage(message: SessionMessage): boolean {
  const role = getHistoryRole(message.message) ?? message.type;
  return role === "user" && Boolean(getHistorySourceToolUseId(message));
}

function getHistorySourceToolUseId(message: SessionMessage): string | undefined {
  const typed = message as { sourceToolUseID?: unknown };
  return typeof typed.sourceToolUseID === "string" && typed.sourceToolUseID.trim() ? typed.sourceToolUseID : undefined;
}

function extractHistorySourceToolResult(message: SessionMessage): StoredToolCall | null {
  const toolUseId = getHistorySourceToolUseId(message);
  if (!toolUseId) return null;
  return {
    id: message.uuid,
    toolUseId,
    name: "工具调用",
    result: normalizeHistoryToolResultContent(getHistoryContent(message.message)),
    status: "completed",
    completedAt: getHistoryMessageTimestamp(message)
  };
}

function isHistoryUserToolResultMessage(message: SessionMessage): boolean {
  const role = getHistoryRole(message.message) ?? message.type;
  return role === "user" && historyContentHasToolResult(message.message);
}

function getHistoryRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const typed = message as { role?: unknown };
  return typeof typed.role === "string" ? typed.role : undefined;
}

function historyContentHasToolResult(message: unknown): boolean {
  const content = getHistoryContent(message);
  if (!Array.isArray(content)) return false;
  return content.some((item) => Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "tool_result"));
}

function extractHistoryText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const maybe = message as { content?: unknown };
  if (typeof maybe.content === "string") return maybe.content;
  if (!Array.isArray(maybe.content)) return "";
  return maybe.content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const typed = block as { type?: string; text?: string; content?: unknown };
      if (typed.type === "tool_use" || typed.type === "tool_result") return "";
      if (typed.type === "text" && typed.text) return typed.text;
      if (typeof typed.content === "string") return typed.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function getHistorySystemSubtype(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const typed = message as { subtype?: unknown };
  return typeof typed.subtype === "string" ? typed.subtype : undefined;
}

function shouldShowHistorySystemMessage(subtype: string | undefined): boolean {
  return Boolean(subtype && !["init", "api_retry", "status"].includes(subtype));
}

function extractHistoryThinking(message: unknown): string {
  const content = getHistoryContent(message);
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const typed = block as { type?: string; thinking?: string; text?: string; summary?: string; content?: unknown };
      if (typed.type === "thinking") return typed.thinking ?? typed.text ?? typed.summary ?? "";
      if (typed.type === "thinking_summary" || typed.type === "summarized_thinking") return typed.summary ?? typed.text ?? "";
      if (typeof typed.content === "string" && (typed.type === "agent.thinking" || typed.type === "thinking_delta")) return typed.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function appendHistoryAssistantText(messages: StoredChatMessage[], block: { kind: "text"; id: string; text: string }): void {
  const turn = ensureHistoryAssistantTurn(messages, `assistant:${block.id}`);
  turn.blocks.push(block);
}

function appendHistoryAssistantThinking(messages: StoredChatMessage[], block: { kind: "thinking"; id: string; text: string }): void {
  const turn = ensureHistoryAssistantTurn(messages, `assistant:${block.id}`);
  const last = turn.blocks.at(-1);
  if (last?.kind === "thinking") {
    last.text += block.text;
    return;
  }
  turn.blocks.push(block);
}

function ensureHistoryAssistantTurn(messages: StoredChatMessage[], id: string): Extract<StoredChatMessage, { kind: "assistantTurn" }> {
  const last = messages.at(-1);
  if (last?.kind === "assistantTurn") return last;
  const turn: Extract<StoredChatMessage, { kind: "assistantTurn" }> = {
    kind: "assistantTurn",
    id,
    blocks: []
  };
  messages.push(turn);
  return turn;
}

function extractHistoryToolUses(message: SessionMessage): StoredToolCall[] {
  const content = getHistoryContent(message.message);
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const block = item as { type?: string; id?: string; name?: string; input?: unknown };
    if (block.type !== "tool_use" || !block.name) return [];
    return [
      {
        id: message.uuid,
        toolUseId: block.id || `${message.uuid}:${block.name}`,
        name: block.name,
        input: block.input,
        status: "pending" as const,
        startedAt: getHistoryMessageTimestamp(message)
      }
    ];
  });
}

function extractHistoryToolResults(message: SessionMessage): StoredToolCall[] {
  const content = getHistoryContent(message.message);
  const tools: StoredToolCall[] = [];
  if (Array.isArray(content)) {
    const wholeContentResult = normalizeHistoryToolResultContent(content);
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const block = item as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      tools.push({
        id: message.uuid,
        toolUseId: block.tool_use_id,
        name: "工具调用",
        result: wholeContentResult || normalizeHistoryToolResult(block.content),
        status: block.is_error ? "failed" : "completed",
        completedAt: getHistoryMessageTimestamp(message)
      });
    }
  }

  const directResult = (message as { tool_use_result?: unknown }).tool_use_result;
  if (tools.length === 0 && directResult && typeof directResult === "object") {
    const raw = directResult as { tool_use_id?: string; toolUseId?: string; name?: string; tool_name?: string; is_error?: boolean; result?: unknown; content?: unknown };
    const toolUseId = raw.tool_use_id || raw.toolUseId;
    if (toolUseId) {
      tools.push({
        id: message.uuid,
        toolUseId,
        name: raw.tool_name || raw.name || "工具调用",
        result: normalizeHistoryToolResult(raw.result ?? raw.content ?? directResult),
        status: raw.is_error ? "failed" : "completed",
        completedAt: getHistoryMessageTimestamp(message)
      });
    }
  }

  return tools;
}

function normalizeHistoryToolResultContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  const text = content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const block = item as { type?: string; text?: string; content?: unknown };
      if (block.type === "text" && block.text) return block.text;
      if (block.type === "tool_result") {
        const result = normalizeHistoryToolResult(block.content);
        return typeof result === "string" ? result : JSON.stringify(result);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

function appendHistoryTool(messages: StoredChatMessage[], toolIndex: Map<string, StoredToolCall>, next: StoredToolCall): void {
  const existing = toolIndex.get(next.toolUseId);
  if (existing) {
    existing.name = existing.name === "工具调用" ? next.name : existing.name;
    existing.input = existing.input ?? next.input;
    existing.result = mergeHistoryToolResult(existing.result, next.result);
    existing.status = next.status === "pending" && existing.result !== undefined ? existing.status : next.status;
    existing.startedAt = existing.startedAt ?? next.startedAt;
    existing.completedAt = existing.completedAt ?? next.completedAt;
    existing.durationMs = calculateToolDurationMs(existing.startedAt, existing.completedAt);
    return;
  }

  const tool = withToolDuration({ ...next, id: `${next.id}:${next.toolUseId}` });
  const turn = ensureHistoryAssistantTurn(messages, `assistant:tools:${next.id}`);
  const lastBlock = turn.blocks.at(-1);
  if (lastBlock?.kind === "toolGroup") {
    lastBlock.tools.push(tool);
  } else {
    turn.blocks.push({ kind: "toolGroup", id: `tools:${next.id}`, tools: [tool] });
  }
  toolIndex.set(tool.toolUseId, tool);
}

function getHistoryMessageTimestamp(message: SessionMessage): string | undefined {
  const value = (message as { timestamp?: unknown }).timestamp;
  return normalizeToolTimestamp(value);
}

function mergeHistoryToolResult(current: unknown, next: unknown): unknown {
  if (next === undefined) return current;
  if (current === undefined) return next;
  const currentText = historyResultToText(current);
  const nextText = historyResultToText(next);
  if (!currentText) return nextText || next;
  if (!nextText || currentText === nextText) return currentText;
  return `${currentText}\n${nextText}`;
}

function historyResultToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getHistoryContent(message: unknown): unknown {
  if (!message || typeof message !== "object") return undefined;
  return (message as { content?: unknown }).content;
}

function normalizeHistoryToolResult(result: unknown): unknown {
  if (!Array.isArray(result)) return result;
  const text = result
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const typed = item as { type?: string; text?: string; content?: unknown };
      if (typed.type === "text" && typed.text) return typed.text;
      if (typeof typed.content === "string") return typed.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return text || result;
}

function isArtifactReadAllowed(filePath: string, session: SessionRecord, messages: StoredChatMessage[]): boolean {
  if (!getArtifactFileKind(filePath)) return false;
  const mentionedPaths = extractArtifactPaths(messages);
  if (mentionedPaths.has(filePath)) return true;
  return isPathInside(filePath, session.workspacePath);
}

function extractArtifactPaths(messages: StoredChatMessage[]): Set<string> {
  const paths = new Set<string>();
  const collect = (value: unknown) => {
    for (const candidate of extractPathCandidates(value)) {
      const resolved = path.resolve(expandHome(candidate));
      if (getArtifactFileKind(resolved)) paths.add(resolved);
    }
  };
  for (const message of messages) {
    if (message.kind === "text") {
      collect(message.text);
      continue;
    }
    if (message.kind === "supplement") continue;
    if (message.kind === "toolGroup") {
      for (const tool of message.tools) {
        collect(tool.input);
        collect(tool.result);
      }
      continue;
    }
    for (const block of message.blocks) {
      if (block.kind === "text" || block.kind === "thinking") collect(block.text);
      if (block.kind === "toolGroup") {
        for (const tool of block.tools) {
          collect(tool.input);
          collect(tool.result);
        }
      }
    }
  }
  return paths;
}

function extractPathCandidates(value: unknown): string[] {
  const candidates: string[] = [];
  const visit = (item: unknown) => {
    if (typeof item === "string") {
      candidates.push(...extractPathsFromText(item));
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (item && typeof item === "object") {
      Object.values(item as Record<string, unknown>).forEach(visit);
    }
  };
  visit(value);
  return candidates;
}

function extractPathsFromText(text: string): string[] {
  const matches = text.match(/(?:~|\/)[^\s"'<>`]+?\.(?:md|markdown|html|htm)\b/gi);
  return matches?.map((item) => item.replace(/[),.;，。；）]+$/u, "")) ?? [];
}

function getArtifactFileKind(filePath: string): ArtifactFileKind | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".html" || ext === ".htm") return "html";
  return null;
}

function isPathInside(filePath: string, parentPath: string): boolean {
  const parent = path.resolve(expandHome(parentPath));
  const relative = path.relative(parent, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function wireAgentEvents(): void {
  agentHost.onEvent((event) => {
    logEvent("main.agentEvent", summarizeAgentEvent(event));
    logEvent("main.agentEvent.raw", event, { detail: true });
    if (automationRequests.has(event.requestId)) {
      handleAutomationAgentEvent(event);
      return;
    }
    const sessionId = Number(event.requestId.split(":")[0]);
    if (cancelledRequestIds.has(event.requestId)) {
      if (event.type === "done" || event.type === "error") {
        cancelledRequestIds.delete(event.requestId);
        xhsConnector.pruneProcessRegistry();
        xhsConnector.releaseRequest(event.requestId);
        closeSupplementQueue(event.requestId, "cancelled event settled");
      }
      return;
    }
    if (Number.isFinite(sessionId)) updateRuntimeFromEvent(sessionId, event);
    if (event.type === "session" && Number.isFinite(sessionId)) {
      db.updateSdkSessionId(sessionId, event.sdkSessionId);
      persistSessionJsonlPath(sessionId, event.sdkSessionId);
      refreshRuntimeSession(sessionId);
    }
    if (event.type === "done" && Number.isFinite(sessionId)) {
      rejectPermissionRequestsForRequest(event.requestId, "任务已完成");
      xhsConnector.pruneProcessRegistry();
      xhsConnector.releaseRequest(event.requestId);
      closeSupplementQueue(event.requestId, "done");
      db.completeSession(sessionId, {
        sdkSessionId: event.sdkSessionId,
        jsonlPath: event.sdkSessionId ? getExistingSessionJsonlPath(sessionId, event.sdkSessionId) ?? undefined : undefined,
        status: "completed"
      });
      browserSessions.markIdle(sessionId);
      refreshRuntimeSession(sessionId);
    }
    if (event.type === "error" && Number.isFinite(sessionId)) {
      rejectPermissionRequestsForRequest(event.requestId, event.message || "任务已结束");
      xhsConnector.pruneProcessRegistry();
      xhsConnector.releaseRequest(event.requestId);
      closeSupplementQueue(event.requestId, "error");
      db.updateStatus(sessionId, "failed");
      browserSessions.markIdle(sessionId);
      refreshRuntimeSession(sessionId);
    }
    if (event.type !== "session") sendToMainWindow(ipcChannels.agentEvent, attachSessionId(event, sessionId));
  });
}

function rescheduleAutomationTimer(): void {
  if (automationTimer) {
    clearTimeout(automationTimer);
    automationTimer = null;
  }
  if (!db) return;
  const next = db.getNextAutomationCandidate();
  if (!next) return;
  const delay = Math.max(0, new Date(next.at).getTime() - Date.now());
  automationTimer = setTimeout(() => {
    automationTimer = null;
    void drainDueAutomationWork();
  }, delay);
  logEvent("main.automation.timer", { next });
}

function emitAutomationChanged(reason: string): void {
  if (!sendToMainWindow(ipcChannels.automationChanged)) return;
  logEvent("main.automation.changed", { reason });
}

function emitConnectorsChanged(reason: string): void {
  if (!sendToMainWindow(ipcChannels.connectorsChanged)) return;
  logEvent("main.connectors.changed", { reason });
}

async function drainDueAutomationWork(): Promise<void> {
  const nowIso = new Date().toISOString();
  const dueTasks = db.listDueAutomationTasks(nowIso);
  const dueRetries = db.listDueAutomationRetries(nowIso);
  logEvent("main.automation.drain", { taskCount: dueTasks.length, retryCount: dueRetries.length });

  for (const task of dueTasks) {
    dispatchAutomationTask(task);
  }

  for (const run of dueRetries) {
    dispatchAutomationRetry(run);
  }

  rescheduleAutomationTimer();
}

function dispatchAutomationTask(task: AutomationTask): void {
  const scheduledAt = task.nextRunAt ?? new Date().toISOString();
  const run = db.createAutomationRun({ task, scheduledAt });
  const plan = calculateAutomationDispatchPlan(task, scheduledAt);
  const dispatchedTask = db.recordAutomationTaskDispatch(task.id, plan.nextRunAt, plan.enabled);
  startAutomationAttempt(dispatchedTask, run, 1);
}

function dispatchAutomationRetry(run: AutomationRun): void {
  const task = db.getAutomationTask(run.taskId);
  if (!task) {
    db.completeAutomationRun(run.id, "failed", "自动化任务已删除，无法重试");
    emitAutomationChanged("run:retryTaskMissing");
    return;
  }
  startAutomationAttempt(task, run, run.attemptCount + 1);
}

function startAutomationAttempt(task: AutomationTask, run: AutomationRun, attemptCount: number): void {
  const session = db.createSession({
    prompt: task.description,
    workspacePath: task.workspacePath,
    origin: "automation",
    title: task.name
  });
  const requestId = `automation:${run.id}:${attemptCount}:${Date.now()}`;
  db.startAutomationRunAttempt(run.id, { sessionId: session.id, attemptCount });
  automationRequests.set(requestId, {
    runId: run.id,
    taskId: task.id,
    sessionId: session.id,
    attemptCount
  });

  const request: AgentRunRequest = {
    requestId,
    sessionId: session.id,
    sdkSessionId: null,
    prompt: task.description,
    permissionMode: "bypassPermissions",
    disallowedTools: ["AskUserQuestion"],
    attachments: task.attachments,
    selectedSkills: task.selectedSkills,
    workspacePath: task.workspacePath,
    agentName: session.agentName,
    config: readConfig(),
    automationRun: {
      taskId: task.id,
      runId: run.id,
      attemptCount
    }
  };
  void prepareAutomationRequest(task, request, session)
    .then((prepared) => {
      agentHost.run(prepared);
    })
    .catch((error: unknown) => {
      handleAutomationAgentEvent({
        type: "error",
        requestId,
        sessionId: session.id,
        message: error instanceof Error ? error.message : String(error)
      });
    });
  logEvent("main.automation.dispatch", { requestId, runId: run.id, taskId: task.id, sessionId: session.id, attemptCount });
  emitAutomationChanged("run:attemptStart");
}

async function prepareAutomationRequest(task: AutomationTask, request: AgentRunRequest, session: SessionRecord): Promise<AgentRunRequest> {
  validateAutomationTaskResources(task);
  const [_, browserAutomation, xhsContext] = await Promise.all([
    cacheUserPrompt(session, request.requestId, task.description),
    browserSessions.ensureSession(session.id),
    task.connectorBindings.xhs ? ensureXhsContext(task.connectorBindings.xhs.profileKey, request.requestId) : Promise.resolve(undefined)
  ]);
  return {
    ...request,
    browserAutomation,
    xhsConnector: xhsContext,
    wechatConnector: task.connectorBindings.wechat ? ensureWechatContext(task.connectorBindings.wechat.profileKey) : undefined
  };
}

function validateAutomationTaskResources(task: AutomationTask): void {
  let workspaceStat: fs.Stats;
  try {
    workspaceStat = fs.statSync(task.workspacePath);
  } catch {
    throw new Error(`自动化任务工作空间不存在: ${task.workspacePath}`);
  }
  if (!workspaceStat.isDirectory()) throw new Error(`自动化任务工作空间不是目录: ${task.workspacePath}`);

  validateAutomationAttachments(task.attachments);
  validateAutomationSelectedSkills(task.selectedSkills, listSkills(getSkillRuntimePaths()).skills);
}

function handleAutomationAgentEvent(event: AgentEvent): void {
  const state = automationRequests.get(event.requestId);
  if (!state) return;
  updateRuntimeFromEvent(state.sessionId, event);

  if (event.type === "session") {
    db.updateSdkSessionId(state.sessionId, event.sdkSessionId);
    persistSessionJsonlPath(state.sessionId, event.sdkSessionId);
    refreshRuntimeSession(state.sessionId);
    return;
  }

  if (event.type === "done") {
    xhsConnector.pruneProcessRegistry();
    xhsConnector.releaseRequest(event.requestId);
    automationRequests.delete(event.requestId);
    db.completeSession(state.sessionId, { sdkSessionId: event.sdkSessionId, jsonlPath: event.sdkSessionId ? getExistingSessionJsonlPath(state.sessionId, event.sdkSessionId) ?? undefined : undefined, status: "completed" });
    db.completeAutomationRun(state.runId, "succeeded");
    browserSessions.markIdle(state.sessionId);
    refreshRuntimeSession(state.sessionId);
    rescheduleAutomationTimer();
    emitAutomationChanged("run:succeeded");
    return;
  }

  if (event.type === "error") {
    xhsConnector.pruneProcessRegistry();
    xhsConnector.releaseRequest(event.requestId);
    automationRequests.delete(event.requestId);
    db.updateStatus(state.sessionId, "failed");
    browserSessions.markIdle(state.sessionId);
    refreshRuntimeSession(state.sessionId);
    const run = db.getAutomationRun(state.runId);
    if (run && state.attemptCount < run.maxAttempts) {
      const nextRetryAt = new Date(Date.now() + getRetryDelayMs(state.attemptCount)).toISOString();
      db.scheduleAutomationRunRetry(state.runId, { nextRetryAt, errorMessage: event.message });
      emitAutomationChanged("run:retrying");
    } else {
      db.completeAutomationRun(state.runId, "failed", event.message);
      emitAutomationChanged("run:failed");
    }
    rescheduleAutomationTimer();
  }
}

function refreshAutomationSchedulesOnStartup(): void {
  const now = new Date();
  const missedRetries = db.markOverdueAutomationRetriesFailed(now.toISOString());
  const tasks = db.listAutomationTasks();
  for (const task of tasks) {
    if (!task.enabled) continue;
    if (task.maxRuns !== null && task.runCount >= task.maxRuns) {
      db.setAutomationTaskEnabled(task.id, false, null);
      continue;
    }
    const nextRunAt = calculateNextRunAt(task, now);
    db.updateAutomationTaskNextRunAt(task.id, nextRunAt);
  }
  logEvent("main.automation.startup", { taskCount: tasks.length, missedRetries });
  rescheduleAutomationTimer();
}

function didAutomationIntervalPlanChange(existing: AutomationTask, input: AutomationTaskInput): boolean {
  if (existing.scheduleType !== "interval" || input.scheduleType !== "interval") return existing.scheduleType !== input.scheduleType;
  return existing.scheduleConfig.intervalValue !== input.scheduleConfig.intervalValue
    || existing.scheduleConfig.intervalUnit !== input.scheduleConfig.intervalUnit
    || existing.maxRuns !== (input.maxRuns ?? null);
}

async function handleAutomationToolRequest(request: AutomationToolRequest, context: AgentRunRequest): Promise<unknown> {
  if (request.operation === "list") return db.listAutomationTasks();
  if (request.operation === "get") {
    const id = automationToolTaskId(request.input);
    const task = db.getAutomationTask(id);
    if (!task) throw new Error("自动化任务不存在");
    return task;
  }
  if (request.operation === "delete") {
    const id = automationToolTaskId(request.input);
    if (!db.getAutomationTask(id)) throw new Error("自动化任务不存在");
    unlinkAccountReviewTask(id, "tool:task:delete");
    db.deleteAutomationTask(id);
    rescheduleAutomationTimer();
    emitAutomationChanged("tool:task:delete");
    return { ok: true, id };
  }
  if (request.operation === "pause" || request.operation === "resume") {
    const id = automationToolTaskId(request.input);
    return setAutomationTaskEnabled(id, request.operation === "resume", `tool:task:${request.operation}`);
  }

  const input = normalizeAutomationTaskInput(automationTaskInputFromTool(request.input, context));
  const nextRunAt = calculateNextRunAt(input);
  if (!nextRunAt) throw new Error("计划时间必须晚于当前时间");
  const task = db.createAutomationTask(input, nextRunAt);
  rescheduleAutomationTimer();
  emitAutomationChanged("tool:task:create");
  return task;
}

async function handleConnectorToolRequest(request: ConnectorToolRequest, context: AgentRunRequest): Promise<unknown> {
  if (request.operation !== "xhs_account_mark_needs_refresh") {
    throw new Error(`不支持的连接器工具操作：${request.operation}`);
  }
  const result = await markRunXhsAccountNeedsRefresh(
    context,
    {
      reason: request.input.reason,
      actualAccountId: request.input.actualAccountId
    },
    {
      getAccount: (profileKey) => db.getConnectorAccountByProfileKey("xhs", profileKey),
      deleteProfile: (profileKey) => xhsConnector.deleteProfile(profileKey),
      markNeedsRefresh: markXhsAccountNeedsRefresh
    }
  );
  emitConnectorsChanged(`tool:${request.operation}:${request.input.reason}`);
  return result;
}

async function handleAgentPermissionRequest(request: AgentPermissionRequest, context: AgentRunRequest): Promise<AgentPermissionResponse> {
  const sessionId = context.sessionId ?? Number(request.requestId.split(":")[0]);
  const visibleRequest: AgentPermissionRequest = {
    ...request,
    sessionId: Number.isFinite(sessionId) ? sessionId : undefined
  };

  if (automationRequests.has(request.requestId)) {
    return { rpcId: request.rpcId, ok: true, action: "deny", message: "自动化任务无法等待用户交互确认" };
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { rpcId: request.rpcId, ok: true, action: "deny", message: "用户界面不可用，无法确认该操作" };
  }

  logEvent("main.agentPermission:request", {
    requestId: request.requestId,
    rpcId: request.rpcId,
    sessionId: visibleRequest.sessionId ?? null,
    toolUseId: request.toolUseId,
    toolName: request.toolName
  });

  return new Promise((resolve) => {
    permissionRequests.set(request.rpcId, { request: visibleRequest, resolve });
    if (!sendToMainWindow(ipcChannels.agentPermissionRequest, visibleRequest)) {
      permissionRequests.delete(request.rpcId);
      resolve({ rpcId: request.rpcId, ok: true, action: "deny", message: "用户界面不可用，无法确认该操作" });
    }
  });
}

function rejectPermissionRequestsForRequest(requestId: string, message: string): void {
  for (const [rpcId, pending] of [...permissionRequests.entries()]) {
    if (pending.request.requestId !== requestId) continue;
    permissionRequests.delete(rpcId);
    pending.resolve({ rpcId, ok: true, action: "deny", message });
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeAgentPermissionResponseMode(response: AgentPermissionResponse): AgentPermissionResponse["mode"] {
  if (response.mode === "allow" || response.mode === "allow_remember" || response.mode === "deny" || response.mode === "suggest_alternative") return response.mode;
  return response.action === "allow" ? "allow" : "deny";
}

function automationToolTaskId(input: unknown): number {
  const id = Number(input && typeof input === "object" ? (input as { id?: unknown }).id : Number.NaN);
  if (!Number.isInteger(id) || id < 1) throw new Error("请输入有效的自动化任务 ID");
  return id;
}

function automationTaskInputFromTool(value: unknown, context: AgentRunRequest): AutomationTaskInput {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const scheduleType = input.scheduleType as AutomationScheduleType;
  const scheduleConfig: AutomationScheduleConfig = {
    runAt: typeof input.runAt === "string" ? input.runAt : undefined,
    intervalValue: typeof input.intervalValue === "number" ? input.intervalValue : undefined,
    intervalUnit: input.intervalUnit === "hour" || input.intervalUnit === "day" ? input.intervalUnit : "minute",
    minute: typeof input.minute === "number" ? input.minute : undefined,
    hour: typeof input.hour === "number" ? input.hour : undefined,
    weekdays: Array.isArray(input.weekdays) ? input.weekdays as number[] : undefined,
    monthDays: Array.isArray(input.monthDays) ? input.monthDays as number[] : undefined
  };
  return {
    name: typeof input.name === "string" ? input.name : "",
    description: typeof input.description === "string" ? input.description : "",
    workspacePath: context.workspacePath,
    scheduleType,
    scheduleConfig,
    maxRetries: typeof input.maxRetries === "number" ? input.maxRetries : 0,
    maxRuns: typeof input.maxRuns === "number" ? input.maxRuns : null,
    connectorBindings: {
      ...(context.xhsConnector ? { xhs: connectorBindingSnapshot(context.xhsConnector) } : {}),
      ...(context.wechatConnector ? { wechat: connectorBindingSnapshot(context.wechatConnector) } : {})
    },
    selectedSkills: resolveAutomationToolSkills(input.selectedSkills, listSkills(getSkillRuntimePaths()).skills),
    attachments: resolveAutomationToolAttachments(input.attachmentPaths),
    enabled: true
  };
}

function setAutomationTaskEnabled(id: number, enabled: boolean, reason: string): AutomationTask {
  const task = db.getAutomationTask(id);
  if (!task) throw new Error("自动化任务不存在");
  if (task.enabled === enabled) return task;
  if (enabled && task.maxRuns !== null && task.runCount >= task.maxRuns) {
    throw new Error("该任务已达到最多运行次数，请编辑固定间隔或最多运行次数后重新启用");
  }
  const nextRunAt = enabled ? calculateNextRunAt(task) : null;
  if (enabled && !nextRunAt) throw new Error("计划时间必须晚于当前时间");
  const updated = db.setAutomationTaskEnabled(id, enabled, nextRunAt);
  rescheduleAutomationTimer();
  emitAutomationChanged(reason);
  return updated;
}

function syncAccountReviewTask(account: ConnectorAccount, enabled: boolean, reason: string): ConnectorAccount {
  if (!enabled) return disableAccountReviewTask(account, reason);
  if (account.status !== "authorized") throw new Error("账号未授权，不能开启自动复盘");
  if (!account.accountId) throw new Error("账号缺少稳定 accountId，不能开启自动复盘");

  const input = buildAccountReviewTaskInput(account, true);
  const nextRunAt = calculateNextRunAt(input);
  if (!nextRunAt) throw new Error("自动复盘计划时间必须晚于当前时间");
  const existingTask = account.opsState.reviewTaskId ? db.getAutomationTask(account.opsState.reviewTaskId) : null;
  const task = existingTask
    ? db.updateAutomationTask(existingTask.id, input, nextRunAt, false)
    : db.createAutomationTask(input, nextRunAt);
  const updated = db.updateConnectorAccountOpsState(account.platform, account.profileKey, {
    reviewTaskId: task.id
  });
  rescheduleAutomationTimer();
  emitAutomationChanged(reason);
  logEvent("main.accountReviewTask:sync", { platform: account.platform, profileKey: account.profileKey, accountId: account.accountId, taskId: task.id, enabled: true, reason });
  return updated;
}

function disableAccountReviewTask(account: ConnectorAccount, reason: string): ConnectorAccount {
  const taskId = account.opsState.reviewTaskId;
  const task = taskId ? db.getAutomationTask(taskId) : null;
  if (task) {
    db.setAutomationTaskEnabled(task.id, false, null);
  }
  const updated = db.updateConnectorAccountOpsState(account.platform, account.profileKey, {
    reviewTaskId: task ? taskId : null
  });
  rescheduleAutomationTimer();
  emitAutomationChanged(reason);
  logEvent("main.accountReviewTask:disable", { platform: account.platform, profileKey: account.profileKey, accountId: account.accountId, taskId, reason });
  return updated;
}

function unlinkAccountReviewTask(taskId: number, reason: string): void {
  for (const account of db.listConnectorAccounts()) {
    if (account.opsState.reviewTaskId !== taskId) continue;
    db.updateConnectorAccountOpsState(account.platform, account.profileKey, { reviewTaskId: null });
    logEvent("main.accountReviewTask:unlink", { platform: account.platform, profileKey: account.profileKey, taskId, reason });
  }
}

function buildAccountReviewTaskInput(account: ConnectorAccount, enabled: boolean): AutomationTaskInput {
  const accountId = account.accountId?.trim();
  if (!accountId) throw new Error("账号缺少稳定 accountId，不能创建自动复盘任务");
  const accountLabel = getConnectorAccountLabel(account);
  return {
    name: `自动复盘 · ${accountLabel}`,
    description: [
      "请执行账号级自动复盘聚合任务。",
      `平台: ${account.platform}`,
      `accountId: ${accountId}`,
      `账号昵称: ${accountLabel}`,
      "使用 content-review-ops，并用上述 AccountRef 调用 content_ops_data：读取 publication=completed 且 review=pending 或指标已更新的 Run。",
      "读取 metrics、engagement/comments、publish、draft、final 等证据，区分事实、解释和建议。",
      "只使用工具实际返回的数据；缺失指标如实记录，不编造指标或因果。",
      "将有充分证据的规律按纪律更新 playbook/history；单篇数据不得直接转正为生效规律。"
    ].join("\n"),
    workspacePath: currentWorkspace,
    scheduleType: "daily",
    scheduleConfig: { hour: 9, minute: 0 },
    maxRetries: 0,
    maxRuns: null,
    connectorBindings: {
      [account.platform]: {
        profileKey: account.profileKey,
        accountId,
        displayName: account.displayName
      }
    },
    selectedSkills: [{ name: "content-review-ops", agent: defaultAgentName, description: "内容复盘聚合" }],
    attachments: [],
    enabled
  };
}

function normalizeReviewPlatform(value: unknown): "xhs" | "wechat" {
  if (value === "xhs" || value === "wechat") return value;
  throw new Error("平台无效");
}

function connectorBindingSnapshot(context: { profileKey: string; accountId?: string | null; displayName?: string | null }) {
  return {
    profileKey: context.profileKey,
    accountId: context.accountId ?? null,
    displayName: context.displayName ?? null
  };
}

function attachSessionId(event: AgentEvent, sessionId: number): AgentEvent {
  return Number.isFinite(sessionId) ? { ...event, sessionId } : event;
}

async function cacheUserPrompt(session: SessionRecord, requestId: string, prompt: string): Promise<void> {
  const runtime = sessionRuntimeCache.get(session.id);
  const message: StoredTextMessage = {
    kind: "text",
    id: `user:${requestId}`,
    role: "user",
    text: prompt
  };
  if (runtime) {
    runtime.session = session;
    runtime.requestId = requestId;
    runtime.messages = appendRuntimeMessage(runtime.messages, message);
    return;
  }
  const messages = session.sdkSessionId ? await loadSessionMessages(session) : [];
  sessionRuntimeCache.set(session.id, {
    session,
    requestId,
    messages: appendRuntimeMessage(messages, message)
  });
}

function updateRuntimeFromEvent(sessionId: number, event: AgentEvent): void {
  const runtime = sessionRuntimeCache.get(sessionId);
  if (!runtime) return;
  if (event.type !== "supplementCleared") runtime.requestId = event.requestId;
  if (event.type === "supplementQueued") {
    runtime.messages = appendRuntimeSupplement(runtime.messages, event.item);
  }
  if (event.type === "supplementRevoked") {
    runtime.messages = removeRuntimeSupplement(runtime.messages, [event.itemId]);
  }
  if (event.type === "supplementConsumed") {
    runtime.messages = consumeRuntimeSupplement(runtime.messages, event.item);
  }
  if (event.type === "supplementCleared") {
    runtime.messages = removeRuntimeSupplement(runtime.messages, event.itemIds);
  }
  if (event.type === "message" && event.text) {
    runtime.messages = appendRuntimeMessage(runtime.messages, {
      kind: "text",
      id: `${event.type}:${event.requestId}:${runtime.messages.length}`,
      role: event.role,
      text: event.text
    });
  }
  if (event.type === "partial" && event.text) {
    runtime.messages = appendRuntimePartial(runtime.messages, event.text);
  }
  if (event.type === "thinking" && event.text) {
    runtime.messages = appendRuntimeThinking(runtime.messages, event.text);
  }
  if (event.type === "tool") {
    runtime.messages = appendRuntimeTool(runtime.messages, event);
  }
  if (event.type === "done" || event.type === "error") {
    runtime.requestId = undefined;
  }
}

function appendRuntimeSupplement(messages: StoredChatMessage[], item: AgentSupplementQueueItem): StoredChatMessage[] {
  const message: StoredSupplementMessage = {
    kind: "supplement",
    id: item.id,
    requestId: item.requestId,
    role: "user",
    text: item.text,
    status: "pending",
    createdAt: item.createdAt
  };
  return [...messages.filter((candidate) => candidate.kind !== "supplement" || candidate.id !== item.id), message];
}

function removeRuntimeSupplement(messages: StoredChatMessage[], itemIds: string[]): StoredChatMessage[] {
  const ids = new Set(itemIds);
  return messages.filter((message) => message.kind !== "supplement" || !ids.has(message.id));
}

function consumeRuntimeSupplement(messages: StoredChatMessage[], item: AgentSupplementQueueItem): StoredChatMessage[] {
  const replacement: StoredTextMessage = {
    kind: "text",
    id: `supplement:${item.id}`,
    role: "user",
    text: item.text
  };
  return appendRuntimeMessage(removeRuntimeSupplement(messages, [item.id]), replacement);
}

function appendRuntimeMessage(messages: StoredChatMessage[], message: StoredTextMessage): StoredChatMessage[] {
  if (message.role === "assistant") {
    return appendRuntimeAssistantText(messages, { kind: "text", id: message.id, text: message.text }, true);
  }
  return [...messages, message];
}

function appendRuntimePartial(messages: StoredChatMessage[], text: string): StoredChatMessage[] {
  return appendRuntimeAssistantText(messages, { kind: "text", id: `partial-${Date.now()}`, text }, false);
}

function appendRuntimeThinking(messages: StoredChatMessage[], text: string): StoredChatMessage[] {
  const { body, supplements } = detachTrailingRuntimeSupplements(messages);
  const { next, turn } = ensureRuntimeAssistantTurn(body);
  const thinkingIndex = findLastBlockIndex(turn.blocks, (block) => block.kind === "thinking");
  if (thinkingIndex >= 0) {
    const block = turn.blocks[thinkingIndex];
    if (block?.kind === "thinking") {
      return [...replaceRuntimeAssistantTurn(next, { ...turn, blocks: replaceBlockAt(turn.blocks, thinkingIndex, { ...block, text: block.text + text }) }), ...supplements];
    }
  }
  const textIndex = turn.blocks.findIndex((block) => block.kind === "text");
  const block = { kind: "thinking" as const, id: `thinking-${Date.now()}`, text };
  const blocks = textIndex >= 0 ? [...turn.blocks.slice(0, textIndex), block, ...turn.blocks.slice(textIndex)] : [...turn.blocks, block];
  return [...replaceRuntimeAssistantTurn(next, { ...turn, blocks }), ...supplements];
}

function appendRuntimeAssistantText(messages: StoredChatMessage[], block: { kind: "text"; id: string; text: string }, finalMessage: boolean): StoredChatMessage[] {
  const { body, supplements } = detachTrailingRuntimeSupplements(messages);
  const { next, turn } = ensureRuntimeAssistantTurn(body);
  const partialIndex = findLastBlockIndex(turn.blocks, (item) => item.kind === "text" && item.id.startsWith("partial-"));
  const partialBlock = partialIndex >= 0 ? turn.blocks[partialIndex] : undefined;
  if (partialBlock?.kind === "text") {
    const text = finalMessage
      ? block.text.includes(partialBlock.text) || partialBlock.text.includes(block.text)
        ? block.text.length >= partialBlock.text.length ? block.text : partialBlock.text
        : block.text
      : partialBlock.text + block.text;
    const id = finalMessage ? block.id : partialBlock.id;
    return [...replaceRuntimeAssistantTurn(next, { ...turn, blocks: replaceBlockAt(turn.blocks, partialIndex, { ...partialBlock, id, text }) }), ...supplements];
  }
  return [...replaceRuntimeAssistantTurn(next, { ...turn, blocks: [...turn.blocks, block] }), ...supplements];
}

function detachTrailingRuntimeSupplements(messages: StoredChatMessage[]): { body: StoredChatMessage[]; supplements: StoredSupplementMessage[] } {
  let index = messages.length;
  while (index > 0 && messages[index - 1]?.kind === "supplement") index -= 1;
  return {
    body: messages.slice(0, index),
    supplements: messages.slice(index) as StoredSupplementMessage[]
  };
}

function findLastBlockIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function replaceBlockAt<T>(items: T[], index: number, item: T): T[] {
  return [...items.slice(0, index), item, ...items.slice(index + 1)];
}

function appendRuntimeTool(messages: StoredChatMessage[], event: Extract<AgentEvent, { type: "tool" }>): StoredChatMessage[] {
  const existing = findRuntimeTool(messages, event.toolUseId);
  if (existing) {
    return messages.map((message) => {
      if (message.kind === "assistantTurn") {
        return {
          ...message,
          blocks: message.blocks.map((block) => {
            if (block.kind !== "toolGroup") return block;
            return {
              ...block,
              tools: block.tools.map((tool) => (tool.toolUseId === event.toolUseId ? mergeRuntimeTool(tool, event) : tool))
            };
          })
        };
      }
      if (message.kind !== "toolGroup") return message;
      return {
        ...message,
        tools: message.tools.map((tool) => (tool.toolUseId === event.toolUseId ? mergeRuntimeTool(tool, event) : tool))
      };
    });
  }

  const tool: StoredToolCall = {
    id: `${event.toolUseId}:${Date.now()}`,
    toolUseId: event.toolUseId,
    name: event.name,
    input: event.input,
    result: event.result,
    status: event.status,
    startedAt: event.startedAt,
    completedAt: event.completedAt,
    durationMs: event.durationMs
  };
  const timedTool = withToolDuration(tool);
  const { body, supplements } = detachTrailingRuntimeSupplements(messages);
  const { next, turn } = ensureRuntimeAssistantTurn(body);
  const lastBlock = turn.blocks.at(-1);
  if (lastBlock?.kind === "toolGroup") {
    return [...replaceRuntimeAssistantTurn(next, { ...turn, blocks: [...turn.blocks.slice(0, -1), { ...lastBlock, tools: [...lastBlock.tools, timedTool] }] }), ...supplements];
  }
  return [...replaceRuntimeAssistantTurn(next, { ...turn, blocks: [...turn.blocks, { kind: "toolGroup", id: `tools-${Date.now()}`, tools: [timedTool] }] }), ...supplements];
}

function ensureRuntimeAssistantTurn(messages: StoredChatMessage[]): { next: StoredChatMessage[]; turn: Extract<StoredChatMessage, { kind: "assistantTurn" }> } {
  const last = messages.at(-1);
  if (last?.kind === "assistantTurn") return { next: messages, turn: last };
  if (last?.kind === "text" && last.role === "assistant") {
    const turn: Extract<StoredChatMessage, { kind: "assistantTurn" }> = {
      kind: "assistantTurn",
      id: `assistant-${last.id}`,
      blocks: [{ kind: "text", id: last.id, text: last.text }]
    };
    return { next: [...messages.slice(0, -1), turn], turn };
  }
  if (last?.kind === "toolGroup") {
    const turn: Extract<StoredChatMessage, { kind: "assistantTurn" }> = {
      kind: "assistantTurn",
      id: `assistant-${last.id}`,
      blocks: [{ kind: "toolGroup", id: last.id, tools: last.tools }]
    };
    return { next: [...messages.slice(0, -1), turn], turn };
  }
  const turn: Extract<StoredChatMessage, { kind: "assistantTurn" }> = {
    kind: "assistantTurn",
    id: `assistant-${Date.now()}`,
    blocks: []
  };
  return { next: [...messages, turn], turn };
}

function replaceRuntimeAssistantTurn(messages: StoredChatMessage[], turn: Extract<StoredChatMessage, { kind: "assistantTurn" }>): StoredChatMessage[] {
  return [...messages.slice(0, -1), turn];
}

function findRuntimeTool(messages: StoredChatMessage[], toolUseId: string): StoredToolCall | undefined {
  for (const message of messages) {
    if (message.kind === "assistantTurn") {
      for (const block of message.blocks) {
        if (block.kind !== "toolGroup") continue;
        const tool = block.tools.find((item) => item.toolUseId === toolUseId);
        if (tool) return tool;
      }
      continue;
    }
    if (message.kind === "toolGroup") {
      const tool = message.tools.find((item) => item.toolUseId === toolUseId);
      if (tool) return tool;
    }
  }
  return undefined;
}

function mergeRuntimeTool(tool: StoredToolCall, event: Extract<AgentEvent, { type: "tool" }>): StoredToolCall {
  return withToolDuration({
    ...tool,
    name: tool.name === "工具调用" ? event.name : tool.name,
    input: tool.input ?? event.input,
    result: event.result ?? tool.result,
    status: event.status === "pending" && tool.result !== undefined ? tool.status : event.status,
    startedAt: tool.startedAt ?? event.startedAt,
    completedAt: tool.completedAt ?? event.completedAt,
    durationMs: event.durationMs ?? tool.durationMs
  });
}

function withToolDuration(tool: StoredToolCall): StoredToolCall {
  const durationMs = tool.durationMs ?? calculateToolDurationMs(tool.startedAt, tool.completedAt);
  return durationMs === undefined ? tool : { ...tool, durationMs };
}

function calculateToolDurationMs(startedAt: string | undefined, completedAt: string | undefined): number | undefined {
  if (!startedAt || !completedAt) return undefined;
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return undefined;
  return completed - started;
}

function normalizeToolTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString();
}

function refreshRuntimeSession(sessionId: number): void {
  const runtime = sessionRuntimeCache.get(sessionId);
  if (!runtime) return;
  const session = db.getSession(sessionId);
  if (session) runtime.session = session;
}

function getWorkspaceState(): WorkspaceState {
  return {
    currentPath: currentWorkspace,
    defaultPath: paths.workspace,
    recentDirectories: readSettings(paths.settings).workspace.recentDirectories
  };
}

function resolveWorkspaceDirectory(workspacePath: string): string | null {
  if (typeof workspacePath !== "string" || workspacePath.trim().length === 0) return null;
  const resolved = path.resolve(expandHome(workspacePath.trim()));
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

void bootstrapMain();

async function bootstrapMain(): Promise<void> {
  cdpPort = await findAvailableCdpPort();
  configureRemoteDebugging(cdpPort);
  await app.whenReady();
  logEvent("main.app", { event: "whenReady" });
  configureDockIcon();
  paths = ensureRuntimeLayout();
  browserSessions = new BrowserSessionManager(paths, cdpPort);
  xhsConnector = new XhsConnectorRuntimeManager(paths, cdpPort);
  applyThemeMode(readSettings(paths.settings).ui.themeMode);
  process.env.CLAUDE_CONFIG_DIR = paths.defaultAgent;
  const skillSync = syncRuntimeSkills({
    bundledSkills: resolveBundledSkillsDirectory(),
    userResourceSkills: paths.userResourceSkills,
    runtimeSkills: paths.skills,
    settings: paths.settings,
    marketSkills: resolveBundledMarketSkillsFile()
  });
  currentWorkspace = expandHome(readConfig().workspace.defaultDir || paths.workspace);
  fs.mkdirSync(currentWorkspace, { recursive: true });
  logEvent("main.app", {
    event: "runtimeReady",
    paths,
    currentWorkspace,
    cdpPort,
    skills: {
      discovered: skillSync.skills.length,
      linked: skillSync.linked.length,
      disabled: skillSync.disabled.length,
      errors: skillSync.errors,
      conflicts: skillSync.conflicts,
      removedStale: skillSync.removedStale
    }
  });
  db = await AppDatabase.open(paths.database);
  const interruptedSessions = db.markRunningSessionsFailed();
  if (interruptedSessions > 0) {
    logEvent("main.app.sessions:interrupted", { count: interruptedSessions });
  }
  agentHost = new AgentProcessHost(resolveAgentEntry());
  agentHost.onSupplementClaimRequest((request) => Promise.resolve(claimSupplement(request)));
  agentHost.onAutomationToolRequest(handleAutomationToolRequest);
  agentHost.onConnectorToolRequest(handleConnectorToolRequest);
  agentHost.onPermissionRequest(handleAgentPermissionRequest);
  registerIpc();
  wireAgentEvents();
  refreshAutomationSchedulesOnStartup();
  scheduleXhsAuthChecks();
  createWindow();

  nativeTheme.on("updated", broadcastThemeState);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on("window-all-closed", () => {
  logEvent("main.app", { event: "windowAllClosed" });
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  logEvent("main.app", { event: "beforeQuit" });
  if (automationTimer) clearTimeout(automationTimer);
  clearXhsAuthCheckTimers();
  agentHost?.dispose();
  browserSessions?.dispose();
  xhsConnector?.dispose();
  void flushLogEvents();
});

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
