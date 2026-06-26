import { clipboard, contextBridge, ipcRenderer } from "electron";
import { ipcChannels } from "../shared/ipc";
import type { AgentEvent, AgentPermissionRequest, AgentPermissionResponse, AutomationTaskInput, ChatPermissionMode, LocalAttachment, ModelProviderConfig, PromptSkillReference, SaveImageProviderSettingsInput, SaveModelProviderSettingsInput, SkillInstallInput, ThemeMode, ThemeState } from "../shared/types";

const api = {
  bootstrap: () => ipcRenderer.invoke(ipcChannels.appBootstrap),
  saveProviderConfig: (provider: ModelProviderConfig) => ipcRenderer.invoke(ipcChannels.configSaveProvider, provider),
  getModelProviderSettings: () => ipcRenderer.invoke(ipcChannels.configGetModelProviders),
  saveModelProviderSettings: (input: SaveModelProviderSettingsInput) => ipcRenderer.invoke(ipcChannels.configSaveModelProviders, input),
  setActiveModel: (model: string) => ipcRenderer.invoke(ipcChannels.configSetActiveModel, model),
  getImageProviderSettings: () => ipcRenderer.invoke(ipcChannels.configGetImageProviders),
  saveImageProviderSettings: (input: SaveImageProviderSettingsInput) => ipcRenderer.invoke(ipcChannels.configSaveImageProviders, input),
  listSessions: () => ipcRenderer.invoke(ipcChannels.sessionsList),
  getSession: (id: number) => ipcRenderer.invoke(ipcChannels.sessionsGet, id),
  getWorkspace: () => ipcRenderer.invoke(ipcChannels.workspaceGet),
  setWorkspace: (workspacePath: string) => ipcRenderer.invoke(ipcChannels.workspaceSet, workspacePath),
  chooseWorkspace: () => ipcRenderer.invoke(ipcChannels.workspaceChoose),
  chooseFiles: () => ipcRenderer.invoke(ipcChannels.filesChoose),
  readArtifactFile: (input: { sessionId: number; filePath: string }) => ipcRenderer.invoke(ipcChannels.filesArtifactRead, input),
  writeClipboardText: (text: string) => {
    clipboard.writeText(text);
    return true;
  },
  updatePermissionMode: (permissionMode: ChatPermissionMode) => ipcRenderer.invoke(ipcChannels.settingsUpdatePermissionMode, permissionMode),
  updateThemeMode: (themeMode: ThemeMode) => ipcRenderer.invoke(ipcChannels.settingsUpdateThemeMode, themeMode),
  onThemeChanged: (callback: (theme: ThemeState) => void) => {
    const listener = (_: Electron.IpcRendererEvent, theme: ThemeState) => callback(theme);
    ipcRenderer.on(ipcChannels.themeChanged, listener);
    return () => {
      ipcRenderer.off(ipcChannels.themeChanged, listener);
    };
  },
  listAgents: () => ipcRenderer.invoke(ipcChannels.agentsList),
  listSkills: () => ipcRenderer.invoke(ipcChannels.skillsList),
  enableSkill: (name: string) => ipcRenderer.invoke(ipcChannels.skillsEnable, name),
  disableSkill: (name: string) => ipcRenderer.invoke(ipcChannels.skillsDisable, name),
  listMarketSkills: () => ipcRenderer.invoke(ipcChannels.skillsMarketList),
  getSkillContent: (input: { source: "installed" | "market"; name: string; agent?: string }) => ipcRenderer.invoke(ipcChannels.skillsContentGet, input),
  installGithubSkill: (input: SkillInstallInput) => ipcRenderer.invoke(ipcChannels.skillsInstallGithub, input),
  listAutomationTasks: () => ipcRenderer.invoke(ipcChannels.automationTasksList),
  getAutomationTask: (id: number) => ipcRenderer.invoke(ipcChannels.automationTaskGet, id),
  createAutomationTask: (input: AutomationTaskInput) => ipcRenderer.invoke(ipcChannels.automationTaskCreate, input),
  updateAutomationTask: (id: number, input: AutomationTaskInput) => ipcRenderer.invoke(ipcChannels.automationTaskUpdate, { id, input }),
  setAutomationTaskEnabled: (id: number, enabled: boolean) => ipcRenderer.invoke(ipcChannels.automationTaskSetEnabled, { id, enabled }),
  deleteAutomationTask: (id: number) => ipcRenderer.invoke(ipcChannels.automationTaskDelete, id),
  listAutomationRuns: () => ipcRenderer.invoke(ipcChannels.automationRunsList),
  getAutomationRunSession: (runId: number) => ipcRenderer.invoke(ipcChannels.automationRunSessionGet, runId),
  chooseAutomationWorkspace: (currentPath?: string) => ipcRenderer.invoke(ipcChannels.automationWorkspaceChoose, currentPath),
  getXhsStatus: () => ipcRenderer.invoke(ipcChannels.xhsStatus),
  getConnectorState: () => ipcRenderer.invoke(ipcChannels.connectorsStateGet),
  createXhsAccount: () => ipcRenderer.invoke(ipcChannels.connectorsXhsAccountCreate),
  selectXhsAccount: (profileKey: string) => ipcRenderer.invoke(ipcChannels.connectorsXhsAccountSelect, profileKey),
  clearXhsAccountSelection: () => ipcRenderer.invoke(ipcChannels.connectorsXhsAccountClearSelection),
  deleteXhsAccount: (profileKey: string) => ipcRenderer.invoke(ipcChannels.connectorsXhsAccountDelete, profileKey),
  setConnectorAccountAutoReview: (input: { platform: "xhs" | "wechat"; profileKey: string; enabled: boolean }) => ipcRenderer.invoke(ipcChannels.connectorsAccountAutoReviewSet, input),
  createWechatAccount: (input: { displayName: string; appId: string; secret: string }) => ipcRenderer.invoke(ipcChannels.connectorsWechatAccountCreate, input),
  selectWechatAccount: (profileKey: string) => ipcRenderer.invoke(ipcChannels.connectorsWechatAccountSelect, profileKey),
  clearWechatAccountSelection: () => ipcRenderer.invoke(ipcChannels.connectorsWechatAccountClearSelection),
  getWechatCredential: (profileKey: string) => ipcRenderer.invoke(ipcChannels.connectorsWechatCredentialGet, profileKey),
  deleteWechatAccount: (profileKey: string) => ipcRenderer.invoke(ipcChannels.connectorsWechatAccountDelete, profileKey),
  startXhsLogin: (profileKey?: string) => ipcRenderer.invoke(ipcChannels.xhsLoginStart, profileKey),
  waitXhsLogin: (input?: number | { profileKey?: string; timeout?: number }) => ipcRenderer.invoke(ipcChannels.xhsLoginWait, input),
  logoutXhs: () => ipcRenderer.invoke(ipcChannels.xhsLogout),
  updateBrowserSurface: (input: { sessionId?: number; visible: boolean; bounds?: { x: number; y: number; width: number; height: number } }) => ipcRenderer.invoke(ipcChannels.browserSurfaceUpdate, input),
  onAutomationChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(ipcChannels.automationChanged, listener);
    return () => {
      ipcRenderer.off(ipcChannels.automationChanged, listener);
    };
  },
  onConnectorsChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(ipcChannels.connectorsChanged, listener);
    return () => {
      ipcRenderer.off(ipcChannels.connectorsChanged, listener);
    };
  },
  startTurn: (input: { prompt: string; sessionId?: number; permissionMode?: ChatPermissionMode; attachments?: LocalAttachment[]; selectedSkills?: PromptSkillReference[]; useBrowserAutomation?: boolean; xhsProfileKey?: string; wechatProfileKey?: string }) => ipcRenderer.invoke(ipcChannels.agentStartTurn, input),
  cancelTurn: (requestId: string) => ipcRenderer.invoke(ipcChannels.agentCancelTurn, requestId),
  enqueueSupplement: (input: { requestId: string; sessionId: number; text: string }) => ipcRenderer.invoke(ipcChannels.agentEnqueueSupplement, input),
  revokeSupplement: (input: { requestId: string; sessionId: number; itemId: string }) => ipcRenderer.invoke(ipcChannels.agentRevokeSupplement, input),
  getSupplementQueue: (input: { requestId: string; sessionId: number }) => ipcRenderer.invoke(ipcChannels.agentQueueSnapshot, input),
  respondAgentPermission: (response: AgentPermissionResponse) => ipcRenderer.invoke(ipcChannels.agentPermissionRespond, response),
  onAgentPermissionRequest: (callback: (request: AgentPermissionRequest) => void) => {
    const listener = (_: Electron.IpcRendererEvent, request: AgentPermissionRequest) => callback(request);
    ipcRenderer.on(ipcChannels.agentPermissionRequest, listener);
    return () => {
      ipcRenderer.off(ipcChannels.agentPermissionRequest, listener);
    };
  },
  onAgentEvent: (callback: (event: AgentEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, event: AgentEvent) => callback(event);
    ipcRenderer.on(ipcChannels.agentEvent, listener);
    return () => {
      ipcRenderer.off(ipcChannels.agentEvent, listener);
    };
  }
};

contextBridge.exposeInMainWorld("agentStudio", api);

export type AgentStudioApi = typeof api;
