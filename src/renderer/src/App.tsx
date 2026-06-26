import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  BarChart3,
  Bell,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  Code2,
  Eye,
  EyeOff,
  FileText,
  Folder,
  FolderOpen,
  Home,
  Maximize2,
  Minimize2,
  MonitorCog,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  PackageOpen,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  ShieldAlert,
  Shield,
  Lightbulb,
  Sparkles,
  Square,
  Sun,
  Hand,
  Trash2,
  X,
  Wrench
} from "lucide-react";
import logoUrl from "./assets/logo.png";
import avatarUrl from "./assets/avatar.png";
import douyinLogoUrl from "./assets/connectors/dy.png";
import gzhLogoUrl from "./assets/connectors/gzh.png";
import xhsLogoUrl from "./assets/connectors/xhs.png";
import { formatAutomationSchedule, formatAutomationStatus } from "@shared/automation";
import type { AgentEvent, AgentPermissionRequest, AgentPermissionResponse, AgentStudioConfig, AgentStudioSettings, AgentSupplementQueueItem, ArtifactFileKind, ArtifactFilePreview, AutomationRun, AutomationScheduleConfig, AutomationScheduleType, AutomationTask, AutomationTaskInput, ChatPermissionMode, ImageProviderDefinition, ImageProviderSettings, ImageProviderType, LocalAttachment, MarketSkillItem, ModelProviderConfig, ModelProviderDefinition, ModelProviderSettings, PromptSkillReference, RuntimePaths, SessionDetail, SessionRecord, SkillContent, SkillListItem, StoredChatMessage, StoredSupplementMessage, StoredTextMessage, StoredToolCall, ThemeMode, ThemeState, WorkbenchPrompts, WorkspaceState } from "@shared/types";
import type { ConnectorAccount, ConnectorState } from "@shared/types";

type ChatMessage = StoredChatMessage;
type AppView = "workbench" | "skills" | "automation";
type RightPanelMode = "browser" | "artifact";
type SkillTab = "market" | "installed";
type AutomationTab = "tasks" | "runs";
type ProviderSettingsTab = "model" | "image";
type SettingsSection = "providers" | "connectors";
type ConnectorSettingsTab = "xhs" | "wechat" | "douyin";
type ComposerPopover = "add" | "connector" | "workspace" | "permission" | "model";
type PreviewMode = "rendered" | "source";
type WechatAccountDraft = { displayName: string; appId: string; secret: string };
type PermissionDraft = { answers: Record<string, string | string[]>; freeform: Record<string, string>; response: string; mode: AgentPermissionResponse["mode"]; message: string };

interface ArtifactFileCard {
  path: string;
  name: string;
  kind: ArtifactFileKind;
}

interface BootstrapState {
  paths: RuntimePaths;
  config: AgentStudioConfig;
  modelProviderSettings: ModelProviderSettings;
  modelProviderSettingsError?: string;
  imageProviderSettings: ImageProviderSettings;
  imageProviderSettingsError?: string;
  needsOnboarding: boolean;
  settings: AgentStudioSettings;
  theme?: ThemeState;
  workbenchPrompts: WorkbenchPrompts;
  platform?: NodeJS.Platform;
  connectorState?: ConnectorState;
  workspace: WorkspaceState;
  sessions: SessionRecord[];
  skills?: {
    installed: { skills: SkillListItem[]; errors: string[]; conflicts: string[] };
    market: { skills: MarketSkillItem[]; errors: string[] };
  };
}

const fallbackWorkbenchPrompts: WorkbenchPrompts = {
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

const emptyConnectorState: ConnectorState = {
  accounts: [],
  selected: { xhs: "", wechat: "" },
  locked: { xhs: {} }
};

const bottomThresholdPx = 120;
const automationChangedDebounceMs = 200;
const defaultRightPanelWidth = 420;
const minRightPanelWidth = 320;
const maxRightPanelViewportRatio = 0.5;
const minWorkspaceWidth = 560;
const mockThinkingDelayMs = 1000;
const mockThinkingRotateMs = 10000;
const mockThinkingPrompts = [
  "嗯，让我先想一下",
  "先来看看上下文",
  "我来理一下思路",
  "我的大脑正在飞速运转",
  "我先把你的目标和要求捋一下",
  "我先确认一下关键点",
  "稍等一下，我马上分析好了"
];
const permissionLabels: Record<ChatPermissionMode, string> = {
  default: "默认权限",
  bypassPermissions: "完全访问",
  auto: "自动决策",
  acceptEdits: "仅编辑权限"
};
const themeModeLabels: Record<ThemeMode, string> = {
  system: "跟随系统",
  light: "亮色",
  dark: "暗色"
};

const permissionOptions: ChatPermissionMode[] = ["default", "auto", "bypassPermissions"];
const visibleSkillAgent = "orchestrator";
const emptyProviderDraft: ModelProviderConfig = { id: "", baseUrl: "", apiKey: "", model: "" };
const emptyModelProviderSettings: ModelProviderSettings = { providers: [] };
const emptyImageProviderSettings: ImageProviderSettings = { imageProviders: [] };
const imageProviderDefaults: Record<ImageProviderType, { label: string; name: string; baseUrl: string; model: string }> = {
  doubao: {
    label: "豆包 Seedream",
    name: "豆包 Seedream",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seedream-5-0-260128"
  },
  openai: {
    label: "OpenAI",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-image-1"
  },
  gemini: {
    label: "Gemini",
    name: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1",
    model: "gemini-2.5-flash-image"
  },
  dashscope: {
    label: "阿里云 DashScope",
    name: "阿里云 DashScope",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
    model: "qwen-image-2.0-pro"
  },
  minimax: {
    label: "MiniMax",
    name: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    model: "image-01"
  },
  "openai-compatible": {
    label: "OpenAI Compatible",
    name: "OpenAI Compatible",
    baseUrl: "",
    model: ""
  }
};
const defaultImageProviderType: ImageProviderType = "openai";
const defaultThemeState: ThemeState = { themeMode: "system", resolvedTheme: getSystemResolvedTheme() };

function isImeCompositionKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.nativeEvent.isComposing || event.key === "Process" || event.keyCode === 229;
}

function getSystemResolvedTheme(): ThemeState["resolvedTheme"] {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function normalizeThemeMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function resolveLocalTheme(themeMode: ThemeMode): ThemeState {
  return {
    themeMode,
    resolvedTheme: themeMode === "system" ? getSystemResolvedTheme() : themeMode
  };
}

function getNextThemeMode(themeMode: ThemeMode): ThemeMode {
  if (themeMode === "system") return "light";
  if (themeMode === "light") return "dark";
  return "system";
}

function applyRendererTheme(theme: ThemeState): void {
  document.documentElement.dataset.theme = theme.resolvedTheme;
  document.documentElement.classList.toggle("dark", theme.resolvedTheme === "dark");
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  const [onboardingVisible, setOnboardingVisible] = useState(false);
  const [providerDraft, setProviderDraft] = useState<ModelProviderConfig>(emptyProviderDraft);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerError, setProviderError] = useState("");
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [modelProviderSettings, setModelProviderSettings] = useState<ModelProviderSettings>(emptyModelProviderSettings);
  const [imageProviderSettings, setImageProviderSettings] = useState<ImageProviderSettings>(emptyImageProviderSettings);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedImageProviderId, setSelectedImageProviderId] = useState("");
  const [modelSettingsSaving, setModelSettingsSaving] = useState(false);
  const [imageSettingsSaving, setImageSettingsSaving] = useState(false);
  const [modelSettingsError, setModelSettingsError] = useState("");
  const [imageSettingsError, setImageSettingsError] = useState("");
  const [themeState, setThemeState] = useState<ThemeState>(defaultThemeState);
  const [collapsed, setCollapsed] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [rightMaximized, setRightMaximized] = useState(false);
  const [rightPanelMode, setRightPanelMode] = useState<RightPanelMode>("browser");
  const [activeView, setActiveView] = useState<AppView>("workbench");
  const [skillTab, setSkillTab] = useState<SkillTab>("market");
  const [skillSearch, setSkillSearch] = useState("");
  const [installedSkills, setInstalledSkills] = useState<SkillListItem[]>([]);
  const [marketSkills, setMarketSkills] = useState<MarketSkillItem[]>([]);
  const [skillError, setSkillError] = useState("");
  const [automationTab, setAutomationTab] = useState<AutomationTab>("tasks");
  const [automationSearch, setAutomationSearch] = useState("");
  const [automationTasks, setAutomationTasks] = useState<AutomationTask[]>([]);
  const [automationRuns, setAutomationRuns] = useState<AutomationRun[]>([]);
  const [automationError, setAutomationError] = useState("");
  const [automationDialogOpen, setAutomationDialogOpen] = useState(false);
  const [automationBusy, setAutomationBusy] = useState(false);
  const [automationDraft, setAutomationDraft] = useState<AutomationTaskInput>(() => createAutomationDraft());
  const [automationDeleteTask, setAutomationDeleteTask] = useState<AutomationTask | null>(null);
  const [selectedAutomationTask, setSelectedAutomationTask] = useState<AutomationTask | null>(null);
  const [selectedAutomationRun, setSelectedAutomationRun] = useState<AutomationRun | null>(null);
  const [automationTaskDraft, setAutomationTaskDraft] = useState<AutomationTaskInput | null>(null);
  const [automationRunMessages, setAutomationRunMessages] = useState<ChatMessage[]>([]);
  const [automationRunLoading, setAutomationRunLoading] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<{ source: "installed" | "market"; name: string; agent: string } | null>(null);
  const [skillContent, setSkillContent] = useState<SkillContent | null>(null);
  const [skillContentLoading, setSkillContentLoading] = useState(false);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [installUrl, setInstallUrl] = useState("");
  const [installBusy, setInstallBusy] = useState(false);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [mockThinking, setMockThinking] = useState<{ requestId: string; text: string } | null>(null);
  const [pendingPermission, setPendingPermission] = useState<AgentPermissionRequest | null>(null);
  const [permissionDraft, setPermissionDraft] = useState<PermissionDraft>(() => createPermissionDraft());
  const [permissionSubmitting, setPermissionSubmitting] = useState(false);
  const [input, setInput] = useState("");
  const [permissionMode, setPermissionMode] = useState<ChatPermissionMode>("auto");
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [selectedPromptSkills, setSelectedPromptSkills] = useState<PromptSkillReference[]>([]);
  const [connectorState, setConnectorState] = useState<ConnectorState | null>(null);
  const [connectorBusy, setConnectorBusy] = useState(false);
  const [xhsAuthorizingProfileKey, setXhsAuthorizingProfileKey] = useState("");
  const [connectorError, setConnectorError] = useState("");
  const [wechatDialogOpen, setWechatDialogOpen] = useState(false);
  const [wechatDraft, setWechatDraft] = useState<WechatAccountDraft>({ displayName: "", appId: "", secret: "" });
  const xhsAuthorizationRunRef = useRef(0);
  const [activeComposerPopover, setActiveComposerPopover] = useState<ComposerPopover | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<number | undefined>();
  const [activeSession, setActiveSession] = useState<SessionRecord | null>(null);
  const [runningRequests, setRunningRequests] = useState<Record<number, string>>({});
  const [error, setError] = useState("");
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [rightPanelWidth, setRightPanelWidth] = useState(defaultRightPanelWidth);
  const [artifactPreview, setArtifactPreview] = useState<ArtifactFilePreview | null>(null);
  const [artifactPreviewMode, setArtifactPreviewMode] = useState<PreviewMode>("rendered");
  const [artifactPreviewLoading, setArtifactPreviewLoading] = useState(false);
  const [artifactPreviewLoadingPath, setArtifactPreviewLoadingPath] = useState<string | null>(null);
  const [artifactPreviewError, setArtifactPreviewError] = useState("");
  const [emptyQuickPrompts, setEmptyQuickPrompts] = useState<string[]>(fallbackWorkbenchPrompts.quickPrompts.slice(0, 6));
  const [typedPrompt, setTypedPrompt] = useState("");
  const [typingIndex, setTypingIndex] = useState(0);
  const [typingDeleting, setTypingDeleting] = useState(false);
  const chatAreaRef = useRef<HTMLDivElement | null>(null);
  const browserSurfaceRef = useRef<HTMLDivElement | null>(null);
  const composerMenuRef = useRef<HTMLDivElement | null>(null);
  const connectorMenuRef = useRef<HTMLDivElement | null>(null);
  const permissionMenuRef = useRef<HTMLDivElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const scrollingToBottomRef = useRef(false);
  const activeSessionIdRef = useRef<number | undefined>(undefined);
  const automationChangedRefreshTimerRef = useRef<number | undefined>(undefined);
  const mockThinkingDelayTimerRef = useRef<number | undefined>(undefined);
  const mockThinkingRotateTimerRef = useRef<number | undefined>(undefined);

  const activeRequestId = activeSessionId ? runningRequests[activeSessionId] : undefined;
  const activeSessionIsRunning = activeSession?.status === "running";
  const isXhsPanelDisabled = Boolean(activeRequestId);
  const visibleConnectorState = connectorState ?? bootstrap?.connectorState ?? emptyConnectorState;
  const xhsAccountLocks = visibleConnectorState.locked?.xhs ?? {};
  const selectedXhsAccount = visibleConnectorState.accounts.find((account) => account.platform === "xhs" && account.profileKey === visibleConnectorState.selected.xhs) ?? null;
  const selectedWechatAccount = visibleConnectorState.accounts.find((account) => account.platform === "wechat" && account.profileKey === visibleConnectorState.selected.wechat) ?? null;
  const selectedConnectorCount = Number(Boolean(selectedXhsAccount)) + Number(Boolean(selectedWechatAccount));
  const visibleMessages = useMemo(() => messages.filter((message) => message.kind !== "supplement"), [messages]);
  const pendingSupplements = useMemo(() => messages.filter((message): message is Extract<ChatMessage, { kind: "supplement" }> => message.kind === "supplement"), [messages]);
  const displayMessages = useMemo(() => appendMockThinking(visibleMessages, activeRequestId, mockThinking), [activeRequestId, visibleMessages, mockThinking]);
  const artifactGroups = useMemo(() => buildArtifactGroups(displayMessages), [displayMessages]);
  const workbenchPrompts = bootstrap?.workbenchPrompts ?? fallbackWorkbenchPrompts;
  const activeModelProvider = useMemo(() => resolveActiveModelProvider(modelProviderSettings, bootstrap?.config), [bootstrap?.config, modelProviderSettings]);
  const activeProviderModels = useMemo(() => splitModelTags(activeModelProvider?.model ?? ""), [activeModelProvider]);
  const activeModelName = bootstrap?.config.provider.model || providerDraft.model || "";
  const hasModelChoices = activeProviderModels.length > 0;
  const isEmptyWorkbench = activeView === "workbench" && displayMessages.length === 0;
  const hasFloatingLayer = Boolean(activeComposerPopover) || installDialogOpen || automationDialogOpen || settingsDialogOpen || wechatDialogOpen || Boolean(automationDeleteTask);
  const visibleSkills = skillTab === "market" ? marketSkills : installedSkills;
  const filteredSkills = useMemo(() => {
    const query = skillSearch.trim().toLowerCase();
    return visibleSkills.filter((skill) => {
      const matchesAgent = skill.agent === visibleSkillAgent;
      const matchesSearch = !query || skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query);
      return matchesAgent && matchesSearch;
    });
  }, [skillSearch, visibleSkills]);
  const filteredAutomationTasks = useMemo(() => {
    const query = automationSearch.trim().toLowerCase();
    if (!query) return automationTasks;
    return automationTasks.filter((task) => task.name.toLowerCase().includes(query) || task.description.toLowerCase().includes(query) || formatAutomationSchedule(task.scheduleType, task.scheduleConfig).toLowerCase().includes(query));
  }, [automationSearch, automationTasks]);
  const filteredAutomationRuns = useMemo(() => {
    const query = automationSearch.trim().toLowerCase();
    if (!query) return automationRuns;
    return automationRuns.filter((run) => run.taskName.toLowerCase().includes(query) || formatAutomationStatus(run.status).includes(query) || (run.errorMessage ?? "").toLowerCase().includes(query));
  }, [automationRuns, automationSearch]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    applyRendererTheme(themeState);
  }, [themeState]);

  useEffect(() => {
    if (!window.agentStudio || typeof window.agentStudio.onThemeChanged !== "function") return undefined;
    return window.agentStudio.onThemeChanged((theme: ThemeState) => {
      setThemeState(theme);
    });
  }, []);

  useEffect(() => {
    if (themeState.themeMode !== "system" || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (window.agentStudio && typeof window.agentStudio.onThemeChanged === "function") return;
      setThemeState(resolveLocalTheme("system"));
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [themeState.themeMode]);

  useEffect(() => {
    if (!window.agentStudio) return;
    void refreshConnectorState();
  }, []);

  useEffect(() => {
    clearMockThinkingTimers();
    setMockThinking(null);
    if (!activeRequestId) return undefined;

    mockThinkingDelayTimerRef.current = window.setTimeout(() => {
      setMockThinking({ requestId: activeRequestId, text: pickMockThinkingPrompt() });
      mockThinkingRotateTimerRef.current = window.setInterval(() => {
        setMockThinking((current) => {
          if (!current || current.requestId !== activeRequestId) return current;
          return { ...current, text: pickMockThinkingPrompt(current.text) };
        });
      }, mockThinkingRotateMs);
    }, mockThinkingDelayMs);

    return () => {
      clearMockThinkingTimers();
    };
  }, [activeRequestId]);

  useEffect(() => {
    if (!window.agentStudio) {
      setError("当前页面未运行在 Electron 环境，无法连接桌面端能力。");
      return;
    }
    void window.agentStudio.bootstrap().then((data: BootstrapState) => {
      setBootstrap(data);
      setSessions(data.sessions);
      setPermissionMode(data.settings?.chat?.permissionMode ?? "auto");
      setThemeState(data.theme ?? resolveLocalTheme(normalizeThemeMode(data.settings?.ui?.themeMode)));
      setProviderDraft(data.config?.provider ?? emptyProviderDraft);
      setModelProviderSettings(data.modelProviderSettings ?? emptyModelProviderSettings);
      setImageProviderSettings(data.imageProviderSettings ?? emptyImageProviderSettings);
      setModelSettingsError(data.modelProviderSettingsError ?? "");
      setImageSettingsError(data.imageProviderSettingsError ?? "");
      setSelectedProviderId(resolveSelectedProviderId(data.modelProviderSettings ?? emptyModelProviderSettings, data.config));
      setSelectedImageProviderId(resolveSelectedImageProviderId(data.imageProviderSettings ?? emptyImageProviderSettings, data.config));
      if (data.connectorState) setConnectorState(data.connectorState);
      if (data.skills) {
        setInstalledSkills(data.skills.installed.skills);
        setMarketSkills(data.skills.market.skills);
        setSkillError(formatSkillErrors(data.skills.installed, data.skills.market));
      }
      void refreshConnectorState();
      setOnboardingVisible(Boolean(data.needsOnboarding));
      setEmptyQuickPrompts(pickRandomPrompts(data.workbenchPrompts?.quickPrompts ?? fallbackWorkbenchPrompts.quickPrompts, 6));
    });
  }, []);

  useEffect(() => {
    if (!isEmptyWorkbench) return;
    const prompts = workbenchPrompts.typingPrompts.length > 0 ? workbenchPrompts.typingPrompts : fallbackWorkbenchPrompts.typingPrompts;
    const current = prompts[typingIndex % prompts.length] ?? fallbackWorkbenchPrompts.typingPrompts[0];
    const complete = typedPrompt === current;
    const empty = typedPrompt.length === 0;
    const delay = typingDeleting ? 28 : complete ? 1200 : 58;

    const timer = window.setTimeout(() => {
      if (typingDeleting) {
        if (empty) {
          setTypingDeleting(false);
          setTypingIndex((index) => (index + 1) % prompts.length);
        } else {
          setTypedPrompt((value) => value.slice(0, -1));
        }
        return;
      }
      if (complete) {
        setTypingDeleting(true);
        return;
      }
      setTypedPrompt(current.slice(0, typedPrompt.length + 1));
    }, delay);

    return () => window.clearTimeout(timer);
  }, [isEmptyWorkbench, typedPrompt, typingDeleting, typingIndex, workbenchPrompts.typingPrompts]);

  useEffect(() => {
    if (!window.agentStudio) return;
    return window.agentStudio.onAgentEvent((event: AgentEvent) => {
      const eventSessionId = getEventSessionId(event);
      const isCurrentSession = eventSessionId !== undefined && eventSessionId === activeSessionIdRef.current;

      if (event.type === "message" && event.text) {
        if (isCurrentSession) clearMockThinking();
        if (isCurrentSession) setMessages((prev) => appendMessage(prev, { id: crypto.randomUUID(), kind: "text", role: event.role, text: event.text }));
      }
      if (event.type === "partial" && event.text) {
        if (isCurrentSession) clearMockThinking();
        if (isCurrentSession) setMessages((prev) => appendPartial(prev, event.text));
      }
      if (event.type === "thinking" && event.text) {
        if (isCurrentSession) clearMockThinking();
        if (isCurrentSession) setMessages((prev) => appendThinking(prev, event.text));
      }
      if (event.type === "tool") {
        if (isCurrentSession) clearMockThinking();
        if (isCurrentSession) setMessages((prev) => appendToolEvent(prev, event));
      }
      if (event.type === "supplementQueued") {
        if (isCurrentSession) setMessages((prev) => appendSupplement(prev, event.item));
      }
      if (event.type === "supplementRevoked") {
        if (isCurrentSession) setMessages((prev) => removeSupplements(prev, [event.itemId]));
      }
      if (event.type === "supplementConsumed") {
        if (isCurrentSession) setMessages((prev) => consumeSupplement(prev, event.item));
      }
      if (event.type === "supplementCleared") {
        if (isCurrentSession) setMessages((prev) => removeSupplements(prev, event.itemIds));
      }
      if (event.type === "done") {
        if (isCurrentSession) clearMockThinking();
        setPendingPermission((current) => current?.requestId === event.requestId ? null : current);
        if (eventSessionId !== undefined) clearRunningRequest(eventSessionId, event.requestId);
        void refreshSessions();
      }
      if (event.type === "error") {
        if (isCurrentSession) clearMockThinking();
        setPendingPermission((current) => current?.requestId === event.requestId ? null : current);
        if (eventSessionId !== undefined) clearRunningRequest(eventSessionId, event.requestId);
        if (isCurrentSession) {
          setError(event.message);
          setMessages((prev) => appendMessage(prev, { id: crypto.randomUUID(), kind: "text", role: "system", text: event.message }));
        }
        void refreshSessions();
      }
    });
  }, []);

  useEffect(() => {
    if (!window.agentStudio || typeof window.agentStudio.onAgentPermissionRequest !== "function") return undefined;
    return window.agentStudio.onAgentPermissionRequest((request: AgentPermissionRequest) => {
      const sessionId = request.sessionId ?? getSessionIdFromRequestId(request.requestId);
      if (sessionId !== undefined && sessionId !== activeSessionIdRef.current) void openSession(sessionId);
      setActiveView("workbench");
      setPendingPermission(request);
      setPermissionDraft(createPermissionDraft(request));
      setPermissionSubmitting(false);
      clearMockThinking();
      window.setTimeout(() => scrollChatToBottom("smooth"), 0);
    });
  }, []);

  useEffect(() => {
    if (displayMessages.length === 0) {
      nearBottomRef.current = true;
      setShowScrollDown(false);
      return;
    }
    if (!nearBottomRef.current) return;
    const frame = requestAnimationFrame(() => scrollChatToBottom("smooth"));
    return () => cancelAnimationFrame(frame);
  }, [displayMessages]);

  useEffect(() => {
    if (activeView !== "skills") return;
    void refreshSkills();
  }, [activeView]);

  useEffect(() => {
    if (activeView !== "automation") return;
    void refreshAutomation();
  }, [activeView]);

  useEffect(() => {
    if (!window.agentStudio || typeof window.agentStudio.updateBrowserSurface !== "function") return undefined;
    let frame = 0;
    const updateSurface = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const element = browserSurfaceRef.current;
        const visible = Boolean(rightOpen && rightPanelMode === "browser" && activeView === "workbench" && activeSessionId && element);
        if (!visible) {
          void window.agentStudio.updateBrowserSurface({ sessionId: activeSessionId, visible: false });
          return;
        }
        const rect = element!.getBoundingClientRect();
        if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 1 || rect.height < 1) {
          void window.agentStudio.updateBrowserSurface({ sessionId: activeSessionId, visible: false });
          return;
        }
        void window.agentStudio.updateBrowserSurface({
          sessionId: activeSessionId,
          visible: true,
          bounds: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          }
        });
      });
    };

    updateSurface();
    const observer = new ResizeObserver(updateSurface);
    if (browserSurfaceRef.current) observer.observe(browserSurfaceRef.current);
    window.addEventListener("resize", updateSurface);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", updateSurface);
      void window.agentStudio.updateBrowserSurface({ sessionId: activeSessionId, visible: false });
    };
  }, [activeSessionId, activeView, collapsed, rightMaximized, rightOpen, rightPanelMode, rightPanelWidth]);

  useEffect(() => {
    if (!window.agentStudio) return;
    const unsubscribe = window.agentStudio.onAutomationChanged(() => {
      void refreshConnectorState();
      if (activeView !== "automation") return;
      if (automationChangedRefreshTimerRef.current !== undefined) {
        window.clearTimeout(automationChangedRefreshTimerRef.current);
      }
      automationChangedRefreshTimerRef.current = window.setTimeout(() => {
        automationChangedRefreshTimerRef.current = undefined;
        void refreshAutomation();
      }, automationChangedDebounceMs);
    });
    return () => {
      unsubscribe();
      if (automationChangedRefreshTimerRef.current !== undefined) {
        window.clearTimeout(automationChangedRefreshTimerRef.current);
        automationChangedRefreshTimerRef.current = undefined;
      }
    };
  }, [activeView, selectedAutomationTask, selectedAutomationRun]);

  useEffect(() => {
    if (!window.agentStudio || typeof window.agentStudio.onConnectorsChanged !== "function") return undefined;
    return window.agentStudio.onConnectorsChanged(() => {
      void refreshConnectorState();
    });
  }, []);

  useEffect(() => {
    if (activeView === "automation") return;
    if (automationChangedRefreshTimerRef.current === undefined) return;
    window.clearTimeout(automationChangedRefreshTimerRef.current);
    automationChangedRefreshTimerRef.current = undefined;
  }, [activeView]);

  useEffect(() => {
    if (!rightOpen) setRightMaximized(false);
  }, [rightOpen]);

  useEffect(() => {
    if (!activeComposerPopover) return;
    const currentPopover = activeComposerPopover;

    function closeFloatingMenus(event: MouseEvent | PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const activeRef = getComposerPopoverRef(currentPopover, {
        add: composerMenuRef.current,
        workspace: workspaceMenuRef.current,
        connector: connectorMenuRef.current,
        permission: permissionMenuRef.current,
        model: modelMenuRef.current
      });
      if (activeRef?.contains(target)) return;
      closeComposerPopover();
    }

    window.addEventListener("pointerdown", closeFloatingMenus);
    return () => window.removeEventListener("pointerdown", closeFloatingMenus);
  }, [activeComposerPopover]);

  useEffect(() => {
    function constrainPanelWidth() {
      setRightPanelWidth((width) => getConstrainedRightPanelWidth(width, collapsed));
    }

    constrainPanelWidth();
    window.addEventListener("resize", constrainPanelWidth);
    return () => window.removeEventListener("resize", constrainPanelWidth);
  }, [collapsed]);

  const currentWorkspacePath = activeSession?.workspacePath ?? bootstrap?.workspace.currentPath ?? "";

  async function refreshSessions() {
    if (!window.agentStudio) return;
    const next = (await window.agentStudio.listSessions()) as SessionRecord[];
    setSessions(next);
    const currentId = activeSessionIdRef.current;
    if (currentId !== undefined) {
      const current = next.find((session) => session.id === currentId);
      if (current) setActiveSession(current);
    }
  }

  async function refreshSkills() {
    if (!window.agentStudio) return;
    try {
      const [installedResult, marketResult] = await Promise.all([
        window.agentStudio.listSkills() as Promise<{ skills: SkillListItem[]; errors: string[]; conflicts: string[] }>,
        window.agentStudio.listMarketSkills() as Promise<{ skills: MarketSkillItem[]; errors: string[] }>
      ]);
      setInstalledSkills(installedResult.skills);
      setMarketSkills(marketResult.skills);
      setSkillError(formatSkillErrors(installedResult, marketResult));
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : String(err));
    }
  }

  async function chooseWorkspace() {
    if (activeSession) return;
    if (!window.agentStudio) return;
    closeComposerPopover();
    try {
      const workspace = (await window.agentStudio.chooseWorkspace()) as WorkspaceState;
      setBootstrap((prev) => (prev ? { ...prev, workspace } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function selectRecentWorkspace(workspacePath: string) {
    if (activeSession) return;
    if (!window.agentStudio) return;
    closeComposerPopover();
    try {
      const workspace = (await window.agentStudio.setWorkspace(workspacePath)) as WorkspaceState;
      setBootstrap((prev) => (prev ? { ...prev, workspace } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function updateComposerPermissionMode(nextMode: ChatPermissionMode) {
    closeComposerPopover();
    setPermissionMode(nextMode);
    if (!window.agentStudio) return;
    try {
      const settings = (await window.agentStudio.updatePermissionMode(nextMode)) as AgentStudioSettings;
      setPermissionMode(settings.chat.permissionMode);
      setBootstrap((prev) => (prev ? { ...prev, settings } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function updateActiveModel(model: string) {
    closeComposerPopover();
    if (!window.agentStudio || typeof window.agentStudio.setActiveModel !== "function") return;
    try {
      const result = (await window.agentStudio.setActiveModel(model)) as { settings: ModelProviderSettings; config: AgentStudioConfig; needsOnboarding: boolean };
      setModelProviderSettings(result.settings);
      setProviderDraft(result.config.provider);
      setSelectedProviderId(resolveSelectedProviderId(result.settings, result.config));
      setBootstrap((current) => current ? { ...current, config: result.config, needsOnboarding: result.needsOnboarding, modelProviderSettings: result.settings } : current);
      setOnboardingVisible(result.needsOnboarding);
      setModelSettingsError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function updateUiThemeMode(nextMode: ThemeMode) {
    if (window.agentStudio && typeof window.agentStudio.updateThemeMode === "function") {
      try {
        const result = (await window.agentStudio.updateThemeMode(nextMode)) as { settings: AgentStudioSettings; theme: ThemeState };
        setThemeState(result.theme);
        setBootstrap((prev) => (prev ? { ...prev, settings: result.settings, theme: result.theme } : prev));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    setThemeState(resolveLocalTheme(nextMode));
  }

  async function addFiles() {
    if (!window.agentStudio) return;
    const files = (await window.agentStudio.chooseFiles()) as LocalAttachment[];
    if (files.length === 0) return;
    setAttachments((prev) => mergeAttachments(prev, files));
    closeComposerPopover();
  }

  async function ensureComposerSkillsLoaded() {
    if (installedSkills.length > 0) return;
    await refreshSkills();
  }

  function addPromptSkill(skill: SkillListItem) {
    if (!skill.enabled) return;
    setSelectedPromptSkills((prev) => {
      if (prev.some((item) => item.name === skill.name)) return prev;
      return [...prev, { name: skill.name, agent: skill.agent, description: skill.description }];
    });
    closeComposerPopover();
  }

  async function refreshConnectorState() {
    if (!window.agentStudio || typeof window.agentStudio.getConnectorState !== "function") return;
    try {
      const state = (await window.agentStudio.getConnectorState()) as ConnectorState;
      setConnectorState(state);
      setConnectorError("");
    } catch (err) {
      setConnectorError(err instanceof Error ? err.message : String(err));
    }
  }

  async function addXhsAccount() {
    if (!window.agentStudio || isXhsPanelDisabled || connectorBusy) return;
    const runId = xhsAuthorizationRunRef.current + 1;
    xhsAuthorizationRunRef.current = runId;
    setConnectorBusy(true);
    setConnectorError("");
    try {
      const created = (await window.agentStudio.createXhsAccount()) as { account: ConnectorAccount; state: ConnectorState };
      setConnectorState(created.state);
      await authorizeXhsAccount(created.account.profileKey);
    } catch (err) {
      setConnectorError(err instanceof Error ? err.message : String(err));
      await refreshConnectorState();
    } finally {
      if (xhsAuthorizationRunRef.current === runId) {
        setConnectorBusy(false);
        setXhsAuthorizingProfileKey("");
      }
    }
  }

  async function reauthorizeXhsAccount(profileKey: string) {
    if (!window.agentStudio || isXhsPanelDisabled || isXhsAccountLocked(profileKey)) return;
    if (connectorBusy) {
      if (xhsAuthorizingProfileKey !== profileKey) return;
      setConnectorError("");
      try {
        await window.agentStudio.startXhsLogin(profileKey);
      } catch (err) {
        setConnectorError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    const runId = xhsAuthorizationRunRef.current + 1;
    xhsAuthorizationRunRef.current = runId;
    setConnectorBusy(true);
    setConnectorError("");
    try {
      await authorizeXhsAccount(profileKey);
    } catch (err) {
      setConnectorError(err instanceof Error ? err.message : String(err));
      await refreshConnectorState();
    } finally {
      if (xhsAuthorizationRunRef.current === runId) {
        setConnectorBusy(false);
        setXhsAuthorizingProfileKey("");
      }
    }
  }

  async function authorizeXhsAccount(profileKey: string) {
    if (!window.agentStudio) return;
    setXhsAuthorizingProfileKey(profileKey);
    await window.agentStudio.startXhsLogin(profileKey);
    const login = (await window.agentStudio.waitXhsLogin({ profileKey, timeout: 120 })) as { state?: ConnectorState; cancelled?: boolean; duplicate?: boolean; message?: string };
    if (login.state) setConnectorState(login.state);
    if (login.cancelled) return;
    if (login.message) setConnectorError(login.message);
  }

  async function selectXhsAccount(profileKey: string) {
    if (!window.agentStudio || isXhsPanelDisabled || connectorBusy || isXhsAccountLocked(profileKey)) return;
    setConnectorBusy(true);
    setConnectorError("");
    try {
      const result = (await window.agentStudio.selectXhsAccount(profileKey)) as { state: ConnectorState; valid?: boolean; message?: string };
      setConnectorState(result.state);
      if (result.valid === false && result.message) setConnectorError(result.message);
    } catch (err) {
      setConnectorError(err instanceof Error ? err.message : String(err));
      await refreshConnectorState();
    } finally {
      setConnectorBusy(false);
    }
  }

  async function clearXhsAccountSelection() {
    if (!window.agentStudio || connectorBusy) return;
    setConnectorBusy(true);
    setConnectorError("");
    try {
      const state = (await window.agentStudio.clearXhsAccountSelection()) as ConnectorState;
      setConnectorState(state);
    } catch (err) {
      setConnectorError(err instanceof Error ? err.message : String(err));
      await refreshConnectorState();
    } finally {
      setConnectorBusy(false);
    }
  }

  async function toggleXhsAccountSelection(account: ConnectorAccount) {
    if (account.status !== "authorized") {
      await reauthorizeXhsAccount(account.profileKey);
      return;
    }
    if (account.profileKey === visibleConnectorState.selected.xhs) {
      await clearXhsAccountSelection();
      return;
    }
    await selectXhsAccount(account.profileKey);
  }

  async function deleteXhsAccount(profileKey: string): Promise<boolean> {
    if (!window.agentStudio || isXhsPanelDisabled || connectorBusy || isXhsAccountLocked(profileKey)) return false;
    setConnectorBusy(true);
    setConnectorError("");
    try {
      const state = (await window.agentStudio.deleteXhsAccount(profileKey)) as ConnectorState;
      setConnectorState(state);
      return true;
    } catch (err) {
      setConnectorError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setConnectorBusy(false);
    }
  }

  async function toggleConnectorAutoReview(account: ConnectorAccount) {
    if (!window.agentStudio || connectorBusy || account.status !== "authorized") return;
    setConnectorBusy(true);
    setConnectorError("");
    try {
      const state = (await window.agentStudio.setConnectorAccountAutoReview({
        platform: account.platform === "wechat" ? "wechat" : "xhs",
        profileKey: account.profileKey,
        enabled: !getConnectorOpsState(account).autoReviewEnabled
      })) as ConnectorState;
      setConnectorState(state);
      await refreshAutomation();
    } catch (err) {
      setConnectorError(err instanceof Error ? err.message : String(err));
      await refreshConnectorState();
    } finally {
      setConnectorBusy(false);
    }
  }

  function openWechatAccountDialog() {
    if (activeRequestId || connectorBusy) return;
    setWechatDraft({ displayName: "", appId: "", secret: "" });
    setConnectorError("");
    setWechatDialogOpen(true);
    closeComposerPopover();
  }

  async function createWechatAccount() {
    if (!window.agentStudio || connectorBusy) return;
    setConnectorBusy(true);
    setConnectorError("");
    try {
      const result = (await window.agentStudio.createWechatAccount(wechatDraft)) as { account: ConnectorAccount; state: ConnectorState };
      setConnectorState(result.state);
      setWechatDialogOpen(false);
      setWechatDraft({ displayName: "", appId: "", secret: "" });
    } catch (err) {
      setConnectorError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnectorBusy(false);
    }
  }

  async function toggleWechatAccountSelection(account: ConnectorAccount) {
    if (!window.agentStudio || activeRequestId || connectorBusy) return;
    setConnectorBusy(true);
    setConnectorError("");
    try {
      const state = account.profileKey === visibleConnectorState.selected.wechat
        ? await window.agentStudio.clearWechatAccountSelection()
        : ((await window.agentStudio.selectWechatAccount(account.profileKey)) as { state: ConnectorState }).state;
      setConnectorState(state as ConnectorState);
    } catch (err) {
      setConnectorError(err instanceof Error ? err.message : String(err));
      await refreshConnectorState();
    } finally {
      setConnectorBusy(false);
    }
  }

  async function deleteWechatAccount(profileKey: string): Promise<boolean> {
    if (!window.agentStudio || activeRequestId || connectorBusy) return false;
    setConnectorBusy(true);
    setConnectorError("");
    try {
      setConnectorState((await window.agentStudio.deleteWechatAccount(profileKey)) as ConnectorState);
      return true;
    } catch (err) {
      setConnectorError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setConnectorBusy(false);
    }
  }

  function isXhsAccountLocked(profileKey: string): boolean {
    return Boolean(xhsAccountLocks[profileKey]);
  }

  function getXhsAccountTitle(account: ConnectorAccount): string {
    if (isXhsAccountLocked(account.profileKey)) return "其他任务正在运行";
    return account.accountHandle ? `${account.accountHandle}${account.accountId ? ` · ${account.accountId}` : ""}` : account.accountId ?? getConnectorAccountProfileLabel(account);
  }

  function toggleComposerPopover(popover: ComposerPopover) {
    setActiveComposerPopover((current) => (current === popover ? null : popover));
  }

  function closeComposerPopover() {
    setActiveComposerPopover(null);
  }

  function startNewSession() {
    setActiveView("workbench");
    setRightOpen(false);
    setRightPanelMode("browser");
    resetArtifactPreview();
    nearBottomRef.current = true;
    setShowScrollDown(false);
    activeSessionIdRef.current = undefined;
    setActiveSessionId(undefined);
    setActiveSession(null);
    setMessages([]);
    setInput("");
    clearMockThinking();
    setAttachments([]);
    setSelectedPromptSkills([]);
    setEmptyQuickPrompts(pickRandomPrompts(workbenchPrompts.quickPrompts, 6));
    setError("");
  }

  function openWorkbench() {
    startNewSession();
  }

  function openSkillsCenter() {
    setActiveView("skills");
    setRightOpen(false);
    void refreshSkills();
  }

  function openAutomation() {
    setActiveView("automation");
    setRightOpen(false);
    void refreshAutomation();
  }

  async function refreshAutomation() {
    if (!window.agentStudio) return;
    try {
      const [tasks, runs] = await Promise.all([
        window.agentStudio.listAutomationTasks() as Promise<AutomationTask[]>,
        window.agentStudio.listAutomationRuns() as Promise<AutomationRun[]>
      ]);
      setAutomationTasks(tasks);
      setAutomationRuns(runs);
      setAutomationError("");
      if (selectedAutomationTask) {
        const next = tasks.find((task) => task.id === selectedAutomationTask.id) ?? null;
        setSelectedAutomationTask(next);
        if (next) setAutomationTaskDraft(taskToInput(next));
      }
      if (selectedAutomationRun) {
        setSelectedAutomationRun(runs.find((run) => run.id === selectedAutomationRun.id) ?? null);
      }
    } catch (err) {
      setAutomationError(err instanceof Error ? err.message : String(err));
    }
  }

  function openAutomationCreate(preset?: { name: string; description: string }) {
    setAutomationDraft({
      ...createAutomationDraft(bootstrap?.workspace.currentPath, preset),
      connectorBindings: {
        ...(selectedXhsAccount ? { xhs: automationConnectorBinding(selectedXhsAccount) } : {})
      },
      selectedSkills: selectedPromptSkills,
      attachments
    });
    setAutomationDialogOpen(true);
    setAutomationError("");
  }

  async function saveNewAutomationTask() {
    if (!window.agentStudio || automationBusy) return;
    setAutomationBusy(true);
    setAutomationError("");
    try {
      await window.agentStudio.createAutomationTask(automationDraft);
      setAutomationDialogOpen(false);
      await refreshAutomation();
    } catch (err) {
      setAutomationError(err instanceof Error ? err.message : String(err));
    } finally {
      setAutomationBusy(false);
    }
  }

  async function saveAutomationTaskDetail() {
    if (!window.agentStudio || !selectedAutomationTask || !automationTaskDraft || automationBusy) return;
    setAutomationBusy(true);
    setAutomationError("");
    try {
      const task = (await window.agentStudio.updateAutomationTask(selectedAutomationTask.id, automationTaskDraft)) as AutomationTask;
      setSelectedAutomationTask(task);
      setAutomationTaskDraft(taskToInput(task));
      await refreshAutomation();
    } catch (err) {
      setAutomationError(err instanceof Error ? err.message : String(err));
    } finally {
      setAutomationBusy(false);
    }
  }

  async function toggleAutomationTask(task: AutomationTask) {
    if (!window.agentStudio) return;
    try {
      await window.agentStudio.setAutomationTaskEnabled(task.id, !task.enabled);
      await refreshAutomation();
    } catch (err) {
      setAutomationError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteAutomationTask() {
    if (!window.agentStudio || !automationDeleteTask) return;
    const id = automationDeleteTask.id;
    await window.agentStudio.deleteAutomationTask(id);
    setAutomationDeleteTask(null);
    if (selectedAutomationTask?.id === id) {
      setSelectedAutomationTask(null);
      setAutomationTaskDraft(null);
      setRightOpen(false);
    }
    await refreshAutomation();
  }

  async function chooseAutomationWorkspace(target: "create" | "edit") {
    if (!window.agentStudio) return;
    const current = target === "edit" ? automationTaskDraft?.workspacePath : automationDraft.workspacePath;
    const selected = (await window.agentStudio.chooseAutomationWorkspace(current)) as string | null;
    if (!selected) return;
    if (target === "edit") setAutomationTaskDraft((draft) => (draft ? { ...draft, workspacePath: selected } : draft));
    else setAutomationDraft((draft) => ({ ...draft, workspacePath: selected }));
  }

  async function chooseAutomationFiles(target: "create" | "edit") {
    if (!window.agentStudio) return;
    const selected = await window.agentStudio.chooseFiles() as LocalAttachment[];
    if (selected.length === 0) return;
    const append = (draft: AutomationTaskInput) => ({ ...draft, attachments: mergeAttachments(draft.attachments ?? [], selected) });
    if (target === "edit") setAutomationTaskDraft((draft) => draft ? append(draft) : draft);
    else setAutomationDraft(append);
  }

  function selectAutomationTask(task: AutomationTask) {
    setSelectedAutomationRun(null);
    setAutomationRunMessages([]);
    setSelectedAutomationTask(task);
    setAutomationTaskDraft(taskToInput(task));
    setRightOpen(true);
  }

  async function selectAutomationRun(run: AutomationRun) {
    setSelectedAutomationTask(null);
    setAutomationTaskDraft(null);
    setSelectedAutomationRun(run);
    setAutomationRunMessages([]);
    setAutomationRunLoading(true);
    setRightOpen(true);
    if (!window.agentStudio) return;
    try {
      const detail = (await window.agentStudio.getAutomationRunSession(run.id)) as SessionDetail | null;
      setAutomationRunMessages(detail?.messages ?? []);
    } catch (err) {
      setAutomationError(err instanceof Error ? err.message : String(err));
    } finally {
      setAutomationRunLoading(false);
    }
  }

  async function selectSkill(source: "installed" | "market", name: string, agent: string) {
    if (!window.agentStudio) return;
    setSelectedSkill({ source, name, agent });
    setRightOpen(true);
    setSkillContent(null);
    setSkillContentLoading(true);
    setSkillError("");
    try {
      const content = (await window.agentStudio.getSkillContent({ source, name, agent })) as SkillContent;
      setSkillContent(content);
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : String(err));
    } finally {
      setSkillContentLoading(false);
    }
  }

  async function toggleSkill(skill: SkillListItem) {
    if (!window.agentStudio) return;
    setSkillError("");
    try {
      if (skill.enabled) {
        await window.agentStudio.disableSkill(skill.name);
      } else {
        await window.agentStudio.enableSkill(skill.name);
      }
      await refreshSkills();
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : String(err));
    }
  }

  async function installMarketSkill(skill: MarketSkillItem) {
    if (!window.agentStudio || skill.installed) return;
    setSkillError("");
    try {
      await window.agentStudio.installGithubSkill({ url: skill.skillMdUrl, agent: visibleSkillAgent });
      await refreshSkills();
      setSkillTab("installed");
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : String(err));
    }
  }

  async function installGithubSkill() {
    if (!window.agentStudio || installBusy) return;
    const url = installUrl.trim();
    if (!url) {
      setSkillError("请输入 GitHub skill 链接");
      return;
    }
    setInstallBusy(true);
    setSkillError("");
    try {
      await window.agentStudio.installGithubSkill({ url, agent: visibleSkillAgent });
      setInstallDialogOpen(false);
      setInstallUrl("");
      setSkillTab("installed");
      await refreshSkills();
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstallBusy(false);
    }
  }

  async function openSession(sessionId: number) {
    if (!window.agentStudio) return;
    const detail = (await window.agentStudio.getSession(sessionId)) as SessionDetail | null;
    if (!detail) return;
    setActiveView("workbench");
    setRightOpen(false);
    setRightPanelMode("browser");
    resetArtifactPreview();
    nearBottomRef.current = true;
    setShowScrollDown(false);
    activeSessionIdRef.current = detail.session.id;
    setActiveSessionId(detail.session.id);
    setActiveSession(detail.session);
    setMessages(detail.messages);
    setRunningRequests((prev) => {
      const next = { ...prev };
      if (detail.runningRequestId) next[detail.session.id] = detail.runningRequestId;
      else delete next[detail.session.id];
      return next;
    });
    clearMockThinking();
    setAttachments([]);
    setSelectedPromptSkills([]);
    setError("");
  }

  async function sendPrompt(promptText = input) {
    const prompt = promptText.trim();
    if (!prompt) return;
    if (!window.agentStudio) {
      setError("当前页面未运行在 Electron 环境，无法发送消息。");
      return;
    }
    if (activeRequestId) {
      await enqueueSupplement(prompt);
      return;
    }
    if (activeSessionIsRunning) {
      setError("正在恢复任务状态，请稍后重试");
      return;
    }
    if (activeSessionId && runningRequests[activeSessionId]) return;
    setError("");
    clearMockThinking();
    const optimisticMessageId = crypto.randomUUID();
    setMessages((prev) => appendMessage(prev, { id: optimisticMessageId, kind: "text", role: "user", text: prompt }));
    setInput("");
    const turnAttachments = attachments;
    const turnSkills = selectedPromptSkills;
    setAttachments([]);
    setSelectedPromptSkills([]);

    try {
      const result = (await window.agentStudio.startTurn({ prompt, sessionId: activeSessionId, permissionMode, attachments: turnAttachments, selectedSkills: turnSkills, useBrowserAutomation: true, xhsProfileKey: visibleConnectorState.selected.xhs || undefined, wechatProfileKey: visibleConnectorState.selected.wechat || undefined })) as {
        requestId: string;
        session: SessionRecord;
      };
      activeSessionIdRef.current = result.session.id;
      setActiveSessionId(result.session.id);
      setActiveSession(result.session);
      setRunningRequests((prev) => ({ ...prev, [result.session.id]: result.requestId }));
      await refreshSessions();
    } catch (err) {
      setAttachments(turnAttachments);
      setSelectedPromptSkills(turnSkills);
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      clearMockThinking();
      setMessages((prev) => appendMessage(prev.filter((item) => item.id !== optimisticMessageId), { id: crypto.randomUUID(), kind: "text", role: "system", text: message }));
      await refreshSessions();
    }
  }

  async function enqueueSupplement(text: string) {
    if (!activeRequestId || !activeSessionId || !window.agentStudio) return;
    setError("");
    try {
      await window.agentStudio.enqueueSupplement({ requestId: activeRequestId, sessionId: activeSessionId, text });
      setInput("");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    }
  }

  async function revokeSupplement(message: Extract<ChatMessage, { kind: "supplement" }>) {
    if (!window.agentStudio) return;
    try {
      await window.agentStudio.revokeSupplement({ requestId: message.requestId, sessionId: activeSessionId ?? getSessionIdFromRequestId(message.requestId) ?? 0, itemId: message.id });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
    }
  }

  async function cancelTurn() {
    if (!activeRequestId || !window.agentStudio) return;
    await window.agentStudio.cancelTurn(activeRequestId);
    if (activeSessionId) clearRunningRequest(activeSessionId, activeRequestId);
  }

  async function respondPermission(mode: NonNullable<AgentPermissionResponse["mode"]>) {
    if (!pendingPermission || !window.agentStudio || permissionSubmitting) return;
    const response = buildPermissionResponse(pendingPermission, permissionDraft, mode);
    if (!response) return;
    setPermissionSubmitting(true);
    try {
      await window.agentStudio.respondAgentPermission(response);
      setPendingPermission(null);
      setPermissionDraft(createPermissionDraft());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPermissionSubmitting(false);
    }
  }

  async function openArtifactPreview(file: ArtifactFileCard) {
    if (!window.agentStudio || !activeSessionId) return;
    setRightPanelMode("artifact");
    setRightOpen(true);
    setArtifactPreviewLoading(true);
    setArtifactPreviewLoadingPath(file.path);
    setArtifactPreviewError("");
    try {
      const preview = (await window.agentStudio.readArtifactFile({ sessionId: activeSessionId, filePath: file.path })) as ArtifactFilePreview;
      setArtifactPreview(preview);
      setArtifactPreviewMode("rendered");
    } catch (err) {
      setArtifactPreview({
        path: file.path,
        name: file.name,
        kind: file.kind,
        content: ""
      });
      setArtifactPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setArtifactPreviewLoading(false);
      setArtifactPreviewLoadingPath(null);
    }
  }

  function resetArtifactPreview() {
    setArtifactPreview(null);
    setArtifactPreviewMode("rendered");
    setArtifactPreviewLoading(false);
    setArtifactPreviewLoadingPath(null);
    setArtifactPreviewError("");
  }

  function openBrowserPanel() {
    setActiveView("workbench");
    setRightPanelMode("browser");
    resetArtifactPreview();
    setRightOpen(true);
  }

  function closeRightPanel() {
    resetArtifactPreview();
    setRightOpen(false);
    setRightPanelMode("browser");
  }

  async function saveProviderFromOnboarding() {
    if (!window.agentStudio || providerSaving) return;
    const provider = {
      id: providerDraft.id.trim(),
      baseUrl: providerDraft.baseUrl.trim(),
      apiKey: providerDraft.apiKey.trim(),
      model: providerDraft.model.trim()
    };
    if (!provider.baseUrl || !provider.apiKey || !provider.model) {
      setProviderError("请完整填写 Base URL、API Key 和 Model。");
      return;
    }

    setProviderSaving(true);
    setProviderError("");
    try {
      const result = (await window.agentStudio.saveProviderConfig(provider)) as { config: AgentStudioConfig; modelProviderSettings: ModelProviderSettings; needsOnboarding: boolean };
      setModelProviderSettings(result.modelProviderSettings);
      setSelectedProviderId(result.config.provider.id);
      setBootstrap((current) => current ? { ...current, config: result.config, modelProviderSettings: result.modelProviderSettings, modelProviderSettingsError: "", needsOnboarding: result.needsOnboarding } : current);
      setProviderDraft(result.config.provider);
      setOnboardingVisible(result.needsOnboarding);
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : String(err));
    } finally {
      setProviderSaving(false);
    }
  }

  function skipOnboarding() {
    setProviderError("");
    setOnboardingVisible(false);
  }

  async function refreshProviderSettings() {
    if (!window.agentStudio) return;
    let nextConfig = bootstrap?.config;
    try {
      const modelResult = await window.agentStudio.getModelProviderSettings() as { settings: ModelProviderSettings; config: AgentStudioConfig };
      nextConfig = modelResult.config;
      setModelProviderSettings(modelResult.settings);
      setSelectedProviderId(resolveSelectedProviderId(modelResult.settings, modelResult.config));
      setModelSettingsError("");
      setBootstrap((current) => current ? { ...current, config: modelResult.config, modelProviderSettings: modelResult.settings } : current);
    } catch (err) {
      setModelSettingsError(err instanceof Error ? err.message : String(err));
    }
    try {
      const imageResult = await window.agentStudio.getImageProviderSettings() as { settings: ImageProviderSettings; config: AgentStudioConfig };
      nextConfig = imageResult.config;
      setImageProviderSettings(imageResult.settings);
      setSelectedImageProviderId(resolveSelectedImageProviderId(imageResult.settings, imageResult.config));
      setImageSettingsError("");
      setBootstrap((current) => current ? { ...current, config: imageResult.config, imageProviderSettings: imageResult.settings } : current);
    } catch (err) {
      setImageSettingsError(err instanceof Error ? err.message : String(err));
    }
    if (nextConfig) {
      setProviderDraft(nextConfig.provider);
    }
  }

  async function openSettingsDialog() {
    setSettingsDialogOpen(true);
    try {
      await refreshProviderSettings();
    } catch (err) {
      setModelSettingsError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveModelProviderSettings() {
    if (!window.agentStudio || modelSettingsSaving) return;
    setModelSettingsSaving(true);
    setModelSettingsError("");
    try {
      const result = await window.agentStudio.saveModelProviderSettings({
        settings: modelProviderSettings,
        selectedProviderId
      }) as { settings: ModelProviderSettings; config: AgentStudioConfig; needsOnboarding: boolean };
      setModelProviderSettings(result.settings);
      setProviderDraft(result.config.provider);
      setBootstrap((current) => current ? { ...current, config: result.config, needsOnboarding: result.needsOnboarding, modelProviderSettings: result.settings } : current);
      setOnboardingVisible(result.needsOnboarding);
      setSettingsDialogOpen(false);
    } catch (err) {
      setModelSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setModelSettingsSaving(false);
    }
  }

  async function saveImageProviderSettings() {
    if (!window.agentStudio || imageSettingsSaving) return;
    setImageSettingsSaving(true);
    setImageSettingsError("");
    try {
      const result = await window.agentStudio.saveImageProviderSettings({
        settings: imageProviderSettings,
        selectedImageProviderId
      }) as { settings: ImageProviderSettings; config: AgentStudioConfig; needsOnboarding: boolean };
      setImageProviderSettings(result.settings);
      setBootstrap((current) => current ? { ...current, config: result.config, needsOnboarding: result.needsOnboarding, imageProviderSettings: result.settings } : current);
      setOnboardingVisible(result.needsOnboarding);
      setSettingsDialogOpen(false);
    } catch (err) {
      setImageSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setImageSettingsSaving(false);
    }
  }

  function updateProviderDefinition(id: string, patch: Partial<ModelProviderDefinition>) {
    setModelProviderSettings((current) => ({
      ...current,
      providers: current.providers.map((provider) => provider.id === id ? { ...provider, ...patch } : provider)
    }));
  }

  function updateImageProviderDefinition(id: string, patch: Partial<ImageProviderDefinition>) {
    setImageProviderSettings((current) => ({
      ...current,
      imageProviders: current.imageProviders.map((provider) => provider.id === id ? { ...provider, ...patch } : provider)
    }));
  }

  function addProviderDefinition() {
    const provider: ModelProviderDefinition = {
      id: `provider-${crypto.randomUUID().slice(0, 8)}`,
      name: "新的模型供应商",
      baseUrl: "",
      apiKey: "",
      model: ""
    };
    setModelProviderSettings((current) => ({ ...current, providers: [...current.providers, provider] }));
    setSelectedProviderId(provider.id);
  }

  function addImageProviderDefinition() {
    const defaults = imageProviderDefaults[defaultImageProviderType];
    const provider: ImageProviderDefinition = {
      id: `image-provider-${crypto.randomUUID().slice(0, 8)}`,
      name: defaults.name,
      providerType: defaultImageProviderType,
      baseUrl: defaults.baseUrl,
      apiKey: "",
      model: defaults.model
    };
    setImageProviderSettings((current) => ({ ...current, imageProviders: [...current.imageProviders, provider] }));
    setSelectedImageProviderId(provider.id);
  }

  function deleteProviderDefinition(id: string) {
    setModelProviderSettings((current) => {
      const providers = current.providers.filter((provider) => provider.id !== id);
      if (selectedProviderId === id) setSelectedProviderId(providers[0]?.id ?? "");
      return { ...current, providers };
    });
  }

  function deleteImageProviderDefinition(id: string) {
    setImageProviderSettings((current) => {
      const imageProviders = current.imageProviders.filter((provider) => provider.id !== id);
      if (selectedImageProviderId === id) setSelectedImageProviderId(imageProviders[0]?.id ?? "");
      return { ...current, imageProviders };
    });
  }

  function clearRunningRequest(sessionId: number, requestId: string) {
    setRunningRequests((prev) => {
      if (prev[sessionId] !== requestId) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }

  function clearMockThinkingTimers() {
    if (mockThinkingDelayTimerRef.current !== undefined) {
      window.clearTimeout(mockThinkingDelayTimerRef.current);
      mockThinkingDelayTimerRef.current = undefined;
    }
    if (mockThinkingRotateTimerRef.current !== undefined) {
      window.clearInterval(mockThinkingRotateTimerRef.current);
      mockThinkingRotateTimerRef.current = undefined;
    }
  }

  function clearMockThinking() {
    clearMockThinkingTimers();
    setMockThinking(null);
  }

  function getIsNearBottom(element: HTMLDivElement): boolean {
    return element.scrollHeight - element.scrollTop - element.clientHeight <= bottomThresholdPx;
  }

  function handleChatScroll() {
    const element = chatAreaRef.current;
    if (!element) return;
    const isNearBottom = getIsNearBottom(element);
    nearBottomRef.current = isNearBottom;
    if (scrollingToBottomRef.current && !isNearBottom) return;
    if (isNearBottom) scrollingToBottomRef.current = false;
    setShowScrollDown(messages.length > 0 && !isNearBottom);
  }

  function scrollChatToBottom(behavior: ScrollBehavior = "smooth") {
    const element = chatAreaRef.current;
    if (!element) return;
    scrollingToBottomRef.current = true;
    nearBottomRef.current = true;
    setShowScrollDown(false);
    element.scrollTo({ top: element.scrollHeight, behavior });
    window.setTimeout(() => {
      scrollingToBottomRef.current = false;
      handleChatScroll();
    }, behavior === "smooth" ? 450 : 0);
  }

  function startRightPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!rightOpen) setRightOpen(true);
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rightPanelWidth;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    function handlePointerMove(moveEvent: PointerEvent) {
      const nextWidth = startWidth + startX - moveEvent.clientX;
      setRightPanelWidth(getConstrainedRightPanelWidth(nextWidth, collapsed));
    }

    function handlePointerUp() {
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  function handleWorkspacePointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (!rightOpen || hasFloatingLayer || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (isInteractiveWorkspaceTarget(target)) return;
    setRightOpen(false);
  }

  function renderComposer(variant: "empty" | "dock") {
    const isEmpty = variant === "empty";
    return (
      <>
        {error && <div className="errorBanner">{error}</div>}
        <div className={`composer ${isEmpty ? "emptyComposer" : activeSession ? "sessionComposer" : "workbenchComposer"}`}>
          {(attachments.length > 0 || selectedPromptSkills.length > 0) && (
            <div className="composerChips">
              {attachments.map((file) => (
                <button key={file.path} className="composerChip" onClick={() => setAttachments((prev) => prev.filter((item) => item.path !== file.path))} title={file.path}>
                  <Paperclip size={14} />
                  <span>{file.name}</span>
                  <X size={13} />
                </button>
              ))}
              {selectedPromptSkills.map((skill) => (
                <button key={skill.name} className="composerChip skillChip" onClick={() => setSelectedPromptSkills((prev) => prev.filter((item) => item.name !== skill.name))} title={skill.description}>
                  <Wrench size={14} />
                  <span>{skill.name}</span>
                  <X size={13} />
                </button>
              ))}
            </div>
          )}
          {pendingSupplements.length > 0 && (
            <div className="supplementQueue" aria-label="待投递补充消息">
              {pendingSupplements.map((message) => (
                <div key={message.id} className="supplementQueueItem">
                  <span>{message.text}</span>
                  <button type="button" onClick={() => void revokeSupplement(message)} title="撤销补充消息">
                    <X size={13} />
                    <span>撤销</span>
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            value={input}
            rows={isEmpty ? 3 : activeSession ? 1 : 3}
            placeholder={isEmpty ? "尽管问" : activeSession ? "继续提问..." : "尽管问"}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (isImeCompositionKeyDown(event)) return;
              if (event.key === "Enter" && (event.ctrlKey || event.altKey)) return;
              if (event.key === "Enter") {
                event.preventDefault();
                void sendPrompt();
              }
            }}
          />
            <div className="composerControls">
            <div className="composerMenuWrap" ref={composerMenuRef}>
              <button className="plainIcon addButton" title="添加" onClick={() => toggleComposerPopover("add")}>
                <Plus size={20} />
              </button>
              {activeComposerPopover === "add" && (
                <div className="composerMenu">
                  <button onClick={() => void addFiles()}>
                    <Paperclip size={18} />
                    <span>添加文件</span>
                  </button>
                  <div className="composerMenuItem hasSubmenu" onMouseEnter={() => void ensureComposerSkillsLoaded()}>
                    <span>
                      <Wrench size={18} />
                      <span>使用技能</span>
                    </span>
                    <ChevronRight size={17} />
                    <div className="composerSubmenu">
                      {installedSkills.filter((skill) => skill.enabled && skill.agent === visibleSkillAgent).map((skill) => (
                        <button key={skill.name} onClick={() => addPromptSkill(skill)} title={skill.description}>
                          <span>{skill.name}</span>
                        </button>
                      ))}
                      {installedSkills.filter((skill) => skill.enabled && skill.agent === visibleSkillAgent).length === 0 && <div className="submenuEmpty">暂无已启用技能</div>}
                    </div>
                  </div>
                  <div className="composerMenuItem disabled">
                    <span>
                      <PackageOpen size={18} />
                      <span>使用插件</span>
                    </span>
                  </div>
                </div>
              )}
            </div>
            <div className="workspacePickerWrap" ref={workspaceMenuRef}>
              <button
                className="workspacePicker"
                onClick={() => toggleComposerPopover("workspace")}
                disabled={Boolean(activeSession)}
                title={currentWorkspacePath ? currentWorkspacePath : activeSession ? "会话路径已绑定" : "选择项目目录"}
                aria-label={currentWorkspacePath ? `项目目录：${currentWorkspacePath}` : activeSession ? "会话路径已绑定" : "选择项目目录"}
              >
                <Folder size={15} />
                <span className="workspaceCurrentLabel">{currentWorkspacePath ? getPathBasename(currentWorkspacePath) : "工作目录"}</span>
              </button>
              {activeComposerPopover === "workspace" && !activeSession && (
                <div className="workspaceMenu">
                  <div className="workspaceMenuTitle">最近使用的目录</div>
                  {(bootstrap?.workspace.recentDirectories ?? []).length > 0 ? (
                    bootstrap!.workspace.recentDirectories.map((directory) => (
                      <button key={directory} className="workspaceRecentItem" onClick={() => void selectRecentWorkspace(directory)} title={directory}>
                        <Folder size={18} />
                        <span>{getPathBasename(directory)}</span>
                      </button>
                    ))
                  ) : (
                    <div className="workspaceMenuEmpty">暂无最近目录</div>
                  )}
                  <div className="workspaceMenuDivider" />
                  <button className="workspaceMenuChoose" onClick={() => void chooseWorkspace()}>
                    <FolderOpen size={18} />
                    <span>选择目录</span>
                  </button>
                </div>
              )}
            </div>
            <div className="connectorPickerWrap" ref={connectorMenuRef}>
              <button
                className={`connectorPicker ${selectedConnectorCount > 0 ? "selected" : ""} ${selectedConnectorCount > 1 ? "multi" : ""}`}
                onClick={() => {
                  void refreshConnectorState();
                  toggleComposerPopover("connector");
                }}
                title={getSelectedConnectorTitle(selectedXhsAccount, selectedWechatAccount)}
                aria-label={getSelectedConnectorTitle(selectedXhsAccount, selectedWechatAccount)}
              >
                {selectedConnectorCount > 0 ? (
                  <span className="connectorPickerLogos" aria-hidden="true">
                    {selectedXhsAccount && <img className="connectorPickerLogo" src={xhsLogoUrl} alt="" />}
                    {selectedWechatAccount && <img className="connectorPickerLogo" src={gzhLogoUrl} alt="" />}
                  </span>
                ) : (
                  <Plug size={15} />
                )}
              </button>
              {activeComposerPopover === "connector" && (
                <div className="connectorMenu">
                  <div className="connectorMenuItem hasSubmenu">
                    <span>
                      <img className="connectorPlatformLogo" src={xhsLogoUrl} alt="" />
                      <span>小红书</span>
                    </span>
                    <ChevronRight size={17} />
                    <div className={`connectorSubmenu ${isXhsPanelDisabled ? "disabled" : ""}`} aria-disabled={isXhsPanelDisabled}>
                      <button className="connectorAccountAction" onClick={() => void addXhsAccount()} disabled={isXhsPanelDisabled || connectorBusy}>
                        <Plus size={16} />
                        <span>{connectorBusy ? "授权中" : "添加账号"}</span>
                      </button>
                      <div className="connectorMenuDivider" />
                      <div className="connectorAccountList">
                      {visibleConnectorState.accounts.some((account) => account.platform === "xhs") ? (
                        sortConnectorAccountsByCreatedAt(visibleConnectorState.accounts.filter((account) => account.platform === "xhs")).map((account) => {
                          const locked = isXhsAccountLocked(account.profileKey);
                          const isCurrentAuthorizing = connectorBusy && xhsAuthorizingProfileKey === account.profileKey;
                          const isSelected = account.profileKey === visibleConnectorState.selected.xhs;
                          const primaryDisabled = isXhsPanelDisabled || (locked && !isSelected) || (connectorBusy && !isCurrentAuthorizing);
                          const title = getXhsAccountTitle(account);
                          return (
                            <div key={account.profileKey} className={`connectorAccountRow connectorAccountTone-${getConnectorAccountStatusTone(account)} ${locked ? "locked" : ""}`} title={title}>
                              <button
                                className={isSelected ? "selected" : ""}
                                onClick={() => void toggleXhsAccountSelection(account)}
                                disabled={primaryDisabled}
                                title={title}
                              >
                                <span className="connectorAccountText">
                                  <span>{getConnectorAccountLabel(account)}</span>
                                  <small>{getConnectorAccountStatusLabel(account)}</small>
                                </span>
                                {account.status === "authorized" && isSelected && <Check size={15} />}
                              </button>
                            </div>
                          );
                        })
                      ) : (
                        <div className="submenuEmpty">暂无账号</div>
                      )}
                      </div>
                      {connectorError && <div className="connectorError">{connectorError}</div>}
                    </div>
                  </div>
                  <div className="connectorMenuItem disabled">
                    <span>
                      <img className="connectorPlatformLogo" src={gzhLogoUrl} alt="" />
                      <span>公众号</span>
                    </span>
                  </div>
                  <div className="connectorMenuItem disabled">
                    <span>
                      <img className="connectorPlatformLogo" src={douyinLogoUrl} alt="" />
                      <span>抖音</span>
                    </span>
                  </div>
                </div>
              )}
            </div>
            <div className="permissionWrap" ref={permissionMenuRef}>
              <button
                className={`permissionPicker permission-${permissionMode}`}
                onClick={() => toggleComposerPopover("permission")}
                disabled={Boolean(activeRequestId)}
                title={permissionLabels[permissionMode]}
                aria-label={`权限：${permissionLabels[permissionMode]}`}
              >
                <PermissionIcon mode={permissionMode} size={15} />
              </button>
              {activeComposerPopover === "permission" && (
                <div className="permissionMenu">
                  {permissionOptions.map((mode) => (
                    <button key={mode} className={mode === permissionMode ? "selected" : ""} onClick={() => void updateComposerPermissionMode(mode)} title={permissionLabels[mode]}>
                      <PermissionIcon mode={mode} size={18} />
                      <span>{permissionLabels[mode]}</span>
                      {mode === permissionMode && <Check size={18} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="modelPickerWrap" ref={modelMenuRef}>
              <button
                className={`modelPicker ${activeModelName ? "selected" : ""}`}
                onClick={() => toggleComposerPopover("model")}
                title={activeModelName ? `模型：${activeModelName}` : "选择模型"}
                aria-label={activeModelName ? `模型：${activeModelName}` : "选择模型"}
              >
                <span className="modelCurrentLabel" title={activeModelName || "未选择模型"}>{activeModelName || "未选择模型"}</span>
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              {activeComposerPopover === "model" && (
                <div className="modelMenu">
                  <div className="modelMenuProvider" title={activeModelProvider?.name ?? "当前供应商"}>
                    {activeModelProvider?.name ?? "当前供应商"}
                  </div>
                  {hasModelChoices ? activeProviderModels.map((model) => (
                    <button key={model} className={model === activeModelName ? "selected" : ""} onClick={() => void updateActiveModel(model)} title={model}>
                      <span>{model}</span>
                      {model === activeModelName && <Check size={16} />}
                    </button>
                  )) : (
                    <div className="modelMenuEmpty">当前供应商暂无可选模型</div>
                  )}
                </div>
              )}
            </div>
            {activeRequestId ? (
              <button className="sendButton stop" onClick={() => void cancelTurn()} title="停止">
                <Square size={16} />
              </button>
            ) : (
              <button className="sendButton" onClick={() => void sendPrompt()} title="发送">
                <Send size={16} />
              </button>
            )}
          </div>
        </div>
      </>
    );
  }

  if (window.agentStudio && !bootstrap) {
    return (
      <main className="onboardingPage onboardingLoading" aria-label="正在读取模型配置">
        <div className="onboardingBrand">
          <img className="onboardingLogo" src={logoUrl} alt="小G" />
          <span>小G</span>
        </div>
        <div className="onboardingMark">
          <RefreshCw className="spinIcon" size={30} />
        </div>
        <p>正在读取模型配置</p>
      </main>
    );
  }

  if (onboardingVisible) {
    return (
      <OnboardingPage
        error={providerError}
        platform={bootstrap?.platform ?? "browser"}
        provider={providerDraft}
        saving={providerSaving}
        onProviderChange={setProviderDraft}
        onSave={() => void saveProviderFromOnboarding()}
        onSkip={skipOnboarding}
      />
    );
  }

  return (
    <main className={`shell ${collapsed ? "sidebarCollapsed" : ""} ${rightMaximized ? "rightMaximized" : ""} ${hasFloatingLayer ? "floatingLayerOpen" : ""} ${installDialogOpen ? "modalOpen" : ""} platform-${bootstrap?.platform ?? "browser"}`}>
      <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
        <header className="panelChrome sidebarChrome">
          {!collapsed && (
            <button className="chromeButton" onClick={() => setCollapsed(true)} title="折叠左侧栏" aria-label="折叠左侧栏">
              <PanelLeftClose size={18} />
            </button>
          )}
        </header>
        <nav className="nav">
          <button className={`navItem ${activeView === "workbench" ? "active" : ""}`} onClick={openWorkbench}>
            <Home size={21} />
            {!collapsed && <span>工作台</span>}
          </button>
          <button className={`navItem ${activeView === "skills" ? "active" : ""}`} onClick={openSkillsCenter}>
            <Wrench size={21} />
            {!collapsed && <span>插件和技能</span>}
          </button>
          <button className={`navItem ${activeView === "automation" ? "active" : ""}`} onClick={openAutomation}>
            <Clock3 size={21} />
            {!collapsed && <span>自动化运营</span>}
          </button>
        </nav>

        {!collapsed && (
          <section className="sessionPanel">
            <div className="sectionTitle">
              <span>创作记录</span>
              <button
                className="miniButton"
                onClick={startNewSession}
                title="新会话"
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="sessionList">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  className={`sessionItem ${session.id === activeSessionId ? "selected" : ""}`}
                  onClick={() => void openSession(session.id)}
                >
                  <span>{session.title}</span>
                  <small>{formatTime(session.updatedAt)}</small>
                </button>
              ))}
              {sessions.length === 0 && <p className="emptyHint">暂无会话</p>}
            </div>
          </section>
        )}

        {!collapsed && (
          <footer className="profile">
            <button className="profileButton" onClick={() => void openSettingsDialog()} aria-label="账号设置">
              <img className="avatar" src={avatarUrl} alt="" />
              <strong>账号设置</strong>
            </button>
          </footer>
        )}
      </aside>

      <section className="workspace" onPointerDownCapture={handleWorkspacePointerDown}>
        <header className={`topbar ${activeView !== "workbench" ? "topbarBlank" : ""}`}>
          <div className="topbarLeft">
            {collapsed && (
              <button className="chromeButton active" onClick={() => setCollapsed(false)} title="展开左侧栏" aria-label="展开左侧栏">
                <PanelLeftOpen size={18} />
              </button>
            )}
            {activeView === "workbench" && (
              <div className="agentName">
                <strong title={activeSession?.title ?? "小G · GrowthForce"}>{activeSession?.title ?? "小G · GrowthForce"}</strong>
              </div>
            )}
          </div>
          <div className="topActions">
            <button
              className="themeToggleButton"
              onClick={() => void updateUiThemeMode(getNextThemeMode(themeState.themeMode))}
              title={`主题：${themeModeLabels[themeState.themeMode]}，点击切换到${themeModeLabels[getNextThemeMode(themeState.themeMode)]}`}
              aria-label={`主题：${themeModeLabels[themeState.themeMode]}，点击切换到${themeModeLabels[getNextThemeMode(themeState.themeMode)]}`}
            >
              <ThemeModeIcon mode={themeState.themeMode} size={17} />
            </button>
            {!rightOpen && (
              <button className="iconButton" onClick={openBrowserPanel} title="打开右侧面板" aria-label="打开右侧面板">
                <PanelRightOpen size={19} />
              </button>
            )}
          </div>
        </header>

        {activeView === "skills" ? (
          <SkillCenter
            error={skillError}
            installDialogOpen={installDialogOpen}
            installBusy={installBusy}
            installUrl={installUrl}
            search={skillSearch}
            skills={filteredSkills}
            tab={skillTab}
            onInstallDialogChange={setInstallDialogOpen}
            onInstallGithub={() => void installGithubSkill()}
            onInstallMarket={(skill) => void installMarketSkill(skill)}
            onInstallUrlChange={setInstallUrl}
            onSearchChange={setSkillSearch}
            onSelectSkill={(source, name, agent) => void selectSkill(source, name, agent)}
            onTabChange={setSkillTab}
            onToggleSkill={(skill) => void toggleSkill(skill)}
            onReload={() => void refreshSkills()}
          />
        ) : activeView === "automation" ? (
          <AutomationCenter
            error={automationError}
            search={automationSearch}
            tab={automationTab}
            tasks={filteredAutomationTasks}
            runs={filteredAutomationRuns}
            onCreate={() => openAutomationCreate()}
            onPresetCreate={openAutomationCreate}
            onDeleteTask={setAutomationDeleteTask}
            onReload={() => void refreshAutomation()}
            onSearchChange={setAutomationSearch}
            onSelectRun={(run) => void selectAutomationRun(run)}
            onSelectTask={selectAutomationTask}
            onTabChange={setAutomationTab}
            onToggleTask={(task) => void toggleAutomationTask(task)}
          />
        ) : (
          <>
            <div className="chatStage">
              {displayMessages.length === 0 && !pendingPermission ? (
                <div className="emptyWorkbench">
                  <h1 className="typingPrompt">{typedPrompt}</h1>
                  <div className="emptyComposerWrap">{renderComposer("empty")}</div>
                  <div className="quickGrid">
                    {emptyQuickPrompts.map((prompt) => (
                      <button key={prompt} onClick={() => void sendPrompt(prompt)}>
                        <Sparkles size={17} />
                        <span>{prompt}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  <div className="chatArea" ref={chatAreaRef} onScroll={handleChatScroll}>
                    <div className="messageList">
                      {displayMessages.map((message) => (
                        <MessageView
                          key={message.id}
                          message={message}
                          artifactGroups={artifactGroups}
                          activeArtifactPath={rightPanelMode === "artifact" ? artifactPreview?.path : undefined}
                          loadingArtifactPath={artifactPreviewLoadingPath ?? undefined}
                          onOpenArtifact={(file) => void openArtifactPreview(file)}
                          onRevokeSupplement={(message) => void revokeSupplement(message)}
                        />
                      ))}
                      {pendingPermission && (
                        <PermissionRequestCard
                          request={pendingPermission}
                          draft={permissionDraft}
                          submitting={permissionSubmitting}
                          onDraftChange={setPermissionDraft}
                          onRespond={(mode) => void respondPermission(mode)}
                        />
                      )}
                    </div>
                  </div>
                  {showScrollDown && (
                    <button className="scrollDownButton" onClick={() => scrollChatToBottom()} title="回到底部">
                      <ArrowDown size={18} />
                    </button>
                  )}
                </>
              )}
            </div>

            {(displayMessages.length > 0 || pendingPermission) && (
              <footer className="composerDock">
                {renderComposer("dock")}
                <p className="notice">内容由 AI 生成，请注意甄别信息准确性</p>
              </footer>
            )}
          </>
        )}
      </section>

      <aside className={`rightPanel ${rightOpen ? "open" : ""} ${rightMaximized ? "maximized" : ""}`} style={{ "--right-panel-width": `${rightPanelWidth}px` } as CSSProperties}>
        {rightOpen && (
          <>
            <header className="panelChrome rightPanelChrome">
              <div className="chromeSpacer" />
              <button className={`chromeButton ${rightMaximized ? "active" : ""}`} onClick={() => setRightMaximized((value) => !value)} title={rightMaximized ? "还原右侧面板" : "最大化右侧面板"} aria-label={rightMaximized ? "还原右侧面板" : "最大化右侧面板"}>
                {rightMaximized ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
              </button>
              <button className="chromeButton active" onClick={closeRightPanel} title="隐藏右侧面板" aria-label="隐藏右侧面板">
                <PanelRightClose size={18} />
              </button>
            </header>
            <div className="rightPanelResizeHandle" onPointerDown={startRightPanelResize} role="separator" aria-orientation="vertical" aria-label="调整右侧面板宽度" title="拖拽调整宽度" />
            {activeView === "skills" ? (
              <SkillDetailPanel selectedSkill={selectedSkill} content={skillContent} loading={skillContentLoading} />
            ) : activeView === "automation" ? (
              <AutomationRightPanel
                accounts={visibleConnectorState.accounts}
                availableSkills={installedSkills.filter((skill) => skill.enabled)}
                busy={automationBusy}
                draft={automationTaskDraft}
                run={selectedAutomationRun}
                runLoading={automationRunLoading}
                runMessages={automationRunMessages}
                task={selectedAutomationTask}
                onChooseWorkspace={() => void chooseAutomationWorkspace("edit")}
                onChooseFiles={() => void chooseAutomationFiles("edit")}
                onDraftChange={setAutomationTaskDraft}
                onSave={() => void saveAutomationTaskDetail()}
              />
            ) : (
              rightPanelMode === "artifact" && artifactPreview ? (
                <ArtifactPreviewPanel
                  preview={artifactPreview}
                  mode={artifactPreviewMode}
                  error={artifactPreviewError}
                  loading={artifactPreviewLoading}
                  onModeChange={setArtifactPreviewMode}
                />
              ) : rightPanelMode === "artifact" ? (
                <div className="rightEmpty">{artifactPreviewLoading ? "正在加载文件..." : "选择文件后显示预览"}</div>
              ) : (
                <div className="browserSurface" ref={browserSurfaceRef}>
                  {!activeSessionId && <div className="rightEmpty">选择或创建会话后显示浏览器</div>}
                </div>
              )
            )}
          </>
        )}
      </aside>
      {automationDialogOpen && (
        <AutomationTaskModal
          accounts={visibleConnectorState.accounts}
          availableSkills={installedSkills.filter((skill) => skill.enabled)}
          busy={automationBusy}
          draft={automationDraft}
          error={automationError}
          title="创建自动化"
          onCancel={() => setAutomationDialogOpen(false)}
          onChooseWorkspace={() => void chooseAutomationWorkspace("create")}
          onChooseFiles={() => void chooseAutomationFiles("create")}
          onDraftChange={setAutomationDraft}
          onSave={() => void saveNewAutomationTask()}
        />
      )}
      {automationDeleteTask && (
        <div className="modalBackdrop" role="presentation">
          <section className="installModal confirmModal" role="dialog" aria-modal="true" aria-label="删除自动化任务">
            <header>
              <strong>删除自动化任务</strong>
              <button className="iconButton" onClick={() => setAutomationDeleteTask(null)} title="关闭">
                <X size={18} />
              </button>
            </header>
            <p>确定删除「{automationDeleteTask.name}」吗？已产生的运行记录会保留。</p>
            <footer>
              <button className="secondaryButton" onClick={() => setAutomationDeleteTask(null)}>取消</button>
              <button className="dangerButton" onClick={() => void deleteAutomationTask()}>
                <Trash2 size={16} />
                <span>删除</span>
              </button>
            </footer>
          </section>
        </div>
      )}
      {wechatDialogOpen && (
        <div
          className="modalBackdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !connectorBusy) setWechatDialogOpen(false);
          }}
        >
          <form
            className="installModal wechatAccountModal"
            role="dialog"
            aria-modal="true"
            aria-label="添加公众号账号"
            onSubmit={(event) => {
              event.preventDefault();
              void createWechatAccount();
            }}
          >
            <header>
              <strong>添加公众号账号</strong>
              <button className="iconButton" type="button" onClick={() => setWechatDialogOpen(false)} disabled={connectorBusy} title="关闭">
                <X size={18} />
              </button>
            </header>
            <p>保存后账号将直接标记为已授权，公众号昵称同时作为默认文章作者。</p>
            <label>
              <span>公众号昵称</span>
              <input value={wechatDraft.displayName} onChange={(event) => setWechatDraft((current) => ({ ...current, displayName: event.target.value }))} autoFocus required />
            </label>
            <label>
              <span>WECHAT_APPID</span>
              <input value={wechatDraft.appId} onChange={(event) => setWechatDraft((current) => ({ ...current, appId: event.target.value }))} required />
            </label>
            <label>
              <span>WECHAT_SECRET</span>
              <input type="password" value={wechatDraft.secret} onChange={(event) => setWechatDraft((current) => ({ ...current, secret: event.target.value }))} required />
            </label>
            {connectorError && <div className="connectorError" role="alert">{connectorError}</div>}
            <footer>
              <button className="secondaryButton" type="button" onClick={() => setWechatDialogOpen(false)} disabled={connectorBusy}>取消</button>
              <button className="primaryButton" type="submit" disabled={connectorBusy || !wechatDraft.displayName.trim() || !wechatDraft.appId.trim() || !wechatDraft.secret.trim()}>
                {connectorBusy ? <RefreshCw className="spinIcon" size={16} /> : <Save size={16} />}
                <span>{connectorBusy ? "保存中" : "保存"}</span>
              </button>
            </footer>
          </form>
        </div>
      )}
      {settingsDialogOpen && (
        <SettingsDialog
          accounts={visibleConnectorState.accounts}
          activeRequest={Boolean(activeRequestId)}
          connectorBusy={connectorBusy}
          connectorError={connectorError}
          lockedXhsAccounts={xhsAccountLocks}
          modelError={modelSettingsError}
          imageError={imageSettingsError}
          modelSaving={modelSettingsSaving}
          imageSaving={imageSettingsSaving}
          modelSettings={modelProviderSettings}
          imageSettings={imageProviderSettings}
          selectedProviderId={selectedProviderId}
          selectedImageProviderId={selectedImageProviderId}
          onAddImageProvider={addImageProviderDefinition}
          onAddProvider={addProviderDefinition}
          onClose={() => {
            if (!modelSettingsSaving && !imageSettingsSaving) {
              setSettingsDialogOpen(false);
              setModelSettingsError("");
              setImageSettingsError("");
              void refreshProviderSettings().catch(() => undefined);
            }
          }}
          onDeleteImageProvider={deleteImageProviderDefinition}
          onDeleteProvider={deleteProviderDefinition}
          onDeleteConnectorAccount={(account) => account.platform === "wechat"
            ? deleteWechatAccount(account.profileKey)
            : deleteXhsAccount(account.profileKey)}
          onSaveImage={() => void saveImageProviderSettings()}
          onSaveModel={() => void saveModelProviderSettings()}
          onSelectImageProvider={setSelectedImageProviderId}
          onSelectProvider={setSelectedProviderId}
          onUpdateImageProvider={updateImageProviderDefinition}
          onUpdateProvider={updateProviderDefinition}
          onToggleAutoReview={(account) => toggleConnectorAutoReview(account)}
        />
      )}
    </main>
  );
}

function SettingsDialog({
  accounts,
  activeRequest,
  connectorBusy,
  connectorError,
  lockedXhsAccounts,
  modelError,
  imageError,
  modelSaving,
  imageSaving,
  modelSettings,
  imageSettings,
  selectedProviderId,
  selectedImageProviderId,
  onAddProvider,
  onAddImageProvider,
  onClose,
  onDeleteProvider,
  onDeleteImageProvider,
  onDeleteConnectorAccount,
  onSaveModel,
  onSaveImage,
  onSelectProvider,
  onSelectImageProvider,
  onUpdateProvider,
  onUpdateImageProvider,
  onToggleAutoReview
}: {
  accounts: ConnectorAccount[];
  activeRequest: boolean;
  connectorBusy: boolean;
  connectorError: string;
  lockedXhsAccounts: Record<string, boolean>;
  modelError: string;
  imageError: string;
  modelSaving: boolean;
  imageSaving: boolean;
  modelSettings: ModelProviderSettings;
  imageSettings: ImageProviderSettings;
  selectedProviderId: string;
  selectedImageProviderId: string;
  onAddProvider: () => void;
  onAddImageProvider: () => void;
  onClose: () => void;
  onDeleteProvider: (id: string) => void;
  onDeleteImageProvider: (id: string) => void;
  onDeleteConnectorAccount: (account: ConnectorAccount) => Promise<boolean>;
  onSaveModel: () => void;
  onSaveImage: () => void;
  onSelectProvider: (id: string) => void;
  onSelectImageProvider: (id: string) => void;
  onUpdateProvider: (id: string, patch: Partial<ModelProviderDefinition>) => void;
  onUpdateImageProvider: (id: string, patch: Partial<ImageProviderDefinition>) => void;
  onToggleAutoReview: (account: ConnectorAccount) => Promise<void>;
}) {
  const selectedProvider = modelSettings.providers.find((provider) => provider.id === selectedProviderId) ?? modelSettings.providers[0] ?? null;
  const selectedImageProvider = imageSettings.imageProviders.find((provider) => provider.id === selectedImageProviderId) ?? imageSettings.imageProviders[0] ?? null;
  const saving = modelSaving || imageSaving;
  const [activeSection, setActiveSection] = useState<SettingsSection>("providers");
  const [activeProviderTab, setActiveProviderTab] = useState<ProviderSettingsTab>("model");
  const [activeConnectorTab, setActiveConnectorTab] = useState<ConnectorSettingsTab>("xhs");
  const [deleteTarget, setDeleteTarget] = useState<ConnectorAccount | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [revealedWechatSecrets, setRevealedWechatSecrets] = useState<Record<string, string>>({});
  const [credentialError, setCredentialError] = useState("");
  const [copiedCredential, setCopiedCredential] = useState("");
  const copyFeedbackTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (copyFeedbackTimerRef.current !== undefined) window.clearTimeout(copyFeedbackTimerRef.current);
  }, []);

  function switchSection(section: SettingsSection) {
    setActiveSection(section);
    setDeleteTarget(null);
    setCredentialError("");
    setCopiedCredential("");
    setRevealedWechatSecrets({});
  }

  function switchConnectorTab(tab: ConnectorSettingsTab) {
    setActiveConnectorTab(tab);
    setCredentialError("");
    setCopiedCredential("");
    setRevealedWechatSecrets({});
  }

  function showCopiedFeedback(key: string) {
    if (copyFeedbackTimerRef.current !== undefined) window.clearTimeout(copyFeedbackTimerRef.current);
    setCopiedCredential(key);
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      setCopiedCredential("");
      copyFeedbackTimerRef.current = undefined;
    }, 1600);
  }

  async function copyCredential(account: ConnectorAccount, field: "appid" | "secret") {
    setCredentialError("");
    try {
      let value = account.accountId ?? "";
      if (field === "secret") {
        value = revealedWechatSecrets[account.profileKey]
          ?? ((await window.agentStudio.getWechatCredential(account.profileKey)) as { secret: string }).secret;
      }
      if (!value) throw new Error(field === "appid" ? "公众号 APPID 不存在" : "公众号 APPSECRET 不存在");
      await window.agentStudio.writeClipboardText(value);
      showCopiedFeedback(`${account.profileKey}:${field}`);
    } catch (err) {
      setCredentialError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleWechatSecret(account: ConnectorAccount) {
    if (revealedWechatSecrets[account.profileKey]) {
      setRevealedWechatSecrets((current) => {
        const next = { ...current };
        delete next[account.profileKey];
        return next;
      });
      return;
    }
    setCredentialError("");
    try {
      const result = await window.agentStudio.getWechatCredential(account.profileKey) as { secret: string };
      setRevealedWechatSecrets({ [account.profileKey]: result.secret });
    } catch (err) {
      setCredentialError(err instanceof Error ? err.message : String(err));
    }
  }

  async function confirmDeleteConnectorAccount() {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    const deleted = await onDeleteConnectorAccount(deleteTarget);
    setDeleteBusy(false);
    if (deleted) {
      setDeleteTarget(null);
      setRevealedWechatSecrets({});
    }
  }

  return (
    <div
      className="modalBackdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section className="settingsModal" role="dialog" aria-modal="true" aria-label="账号设置">
        <aside className="settingsNav" aria-label="设置导航">
          <header>
            <img src={avatarUrl} alt="" />
            <strong>账号设置</strong>
          </header>
          <button className={activeSection === "providers" ? "active" : ""} type="button" onClick={() => switchSection("providers")}>
            <PackageOpen size={18} />
            <span>模型供应商</span>
          </button>
          <button className={activeSection === "connectors" ? "active" : ""} type="button" onClick={() => switchSection("connectors")}>
            <MonitorCog size={18} />
            <span>连接器设置</span>
          </button>
        </aside>

        <form className="settingsContent" onSubmit={(event) => event.preventDefault()}>
          <header className="settingsHeader">
            <h2>{activeSection === "providers" ? "模型供应商" : "连接器设置"}</h2>
            <button className="iconButton" type="button" onClick={onClose} disabled={saving || deleteBusy} title="关闭">
              <X size={18} />
            </button>
          </header>

          {activeSection === "providers" ? (
            <div className="settingsTabs" role="tablist" aria-label="模型供应商类型">
              <button
                className={activeProviderTab === "model" ? "active" : ""}
                type="button"
                role="tab"
                aria-selected={activeProviderTab === "model"}
                onClick={() => setActiveProviderTab("model")}
              >
                大模型
              </button>
              <button
                className={activeProviderTab === "image" ? "active" : ""}
                type="button"
                role="tab"
                aria-selected={activeProviderTab === "image"}
                onClick={() => setActiveProviderTab("image")}
              >
                图片模型
              </button>
            </div>
          ) : (
            <div className="settingsTabs connectorSettingsTabs" role="tablist" aria-label="连接器平台">
              <button className={activeConnectorTab === "xhs" ? "active" : ""} type="button" role="tab" aria-selected={activeConnectorTab === "xhs"} onClick={() => switchConnectorTab("xhs")}>
                <img src={xhsLogoUrl} alt="" />
                <span>小红书</span>
              </button>
              <button className={activeConnectorTab === "wechat" ? "active" : ""} type="button" role="tab" aria-selected={activeConnectorTab === "wechat"} onClick={() => switchConnectorTab("wechat")}>
                <img src={gzhLogoUrl} alt="" />
                <span>公众号</span>
              </button>
              <button className={activeConnectorTab === "douyin" ? "active" : ""} type="button" role="tab" aria-selected={activeConnectorTab === "douyin"} onClick={() => switchConnectorTab("douyin")}>
                <img src={douyinLogoUrl} alt="" />
                <span>抖音</span>
              </button>
            </div>
          )}

          <div className="settingsScroll">
            {activeSection === "connectors" ? (
              <ConnectorSettingsPanel
                accounts={sortConnectorAccountsByCreatedAt(accounts.filter((account) => account.platform === activeConnectorTab))}
                activeRequest={activeRequest}
                connectorBusy={connectorBusy || deleteBusy}
                connectorError={connectorError || credentialError}
                lockedXhsAccounts={lockedXhsAccounts}
                platform={activeConnectorTab}
                copiedCredential={copiedCredential}
                revealedWechatSecrets={revealedWechatSecrets}
                onCopyCredential={(account, field) => void copyCredential(account, field)}
                onDelete={setDeleteTarget}
                onToggleAutoReview={(account) => void onToggleAutoReview(account)}
                onToggleWechatSecret={(account) => void toggleWechatSecret(account)}
              />
            ) : activeProviderTab === "model" ? (
            <section className="settingsPanel" role="tabpanel" aria-label="大模型供应商">
              <div className="providerToolbar">
                <p>仅支持 Claude Messages API 兼容协议。编辑配置后保存会测试当前供应商的第一个模型；仅切换供应商不重新测试。</p>
                <button className="secondaryButton providerAddButton" type="button" onClick={onAddProvider} disabled={modelSaving}>
                  <Plus size={16} />
                  <span>新增</span>
                </button>
              </div>
              <ModelProviderList
                providers={modelSettings.providers}
                selectedId={selectedProvider?.id ?? ""}
                saving={modelSaving}
                onDelete={onDeleteProvider}
                onSelect={onSelectProvider}
                onUpdate={onUpdateProvider}
              />
              {!selectedProvider && (
                <p className="settingsEmpty">暂无大模型供应商。</p>
              )}
              {modelError && (
                <p className="settingsError" role="alert">
                  <AlertCircle size={16} />
                  <span>{modelError}</span>
                </p>
              )}
            </section>
            ) : (
            <section className="settingsPanel" role="tabpanel" aria-label="图片模型供应商">
              <div className="providerToolbar">
                <p>仅保存当前选中的图片供应商配置，后续图片生成工具会使用该供应商；保存时不测试连通性。</p>
                <button className="secondaryButton providerAddButton" type="button" onClick={onAddImageProvider} disabled={imageSaving}>
                  <Plus size={16} />
                  <span>新增</span>
                </button>
              </div>
              <ImageProviderList
                providers={imageSettings.imageProviders}
                selectedId={selectedImageProvider?.id ?? ""}
                saving={imageSaving}
                onDelete={onDeleteImageProvider}
                onSelect={onSelectImageProvider}
                onUpdate={onUpdateImageProvider}
              />
              {!selectedImageProvider && (
                <p className="settingsEmpty">暂无图片模型供应商。</p>
              )}
              {imageError && (
                <p className="settingsError" role="alert">
                  <AlertCircle size={16} />
                  <span>{imageError}</span>
                </p>
              )}
            </section>
            )}
          </div>
          <footer className="settingsActions">
            {activeSection === "providers" ? (
              <>
                <button className="secondaryButton" type="button" onClick={onClose} disabled={saving}>取消</button>
                <button
                  className="primaryButton"
                  type="button"
                  onClick={activeProviderTab === "model" ? onSaveModel : onSaveImage}
                  disabled={saving}
                >
                  {saving ? <RefreshCw className="spinIcon" size={16} /> : <Save size={16} />}
                  <span>保存</span>
                </button>
              </>
            ) : (
              <button className="secondaryButton" type="button" onClick={onClose} disabled={connectorBusy || deleteBusy}>关闭</button>
            )}
          </footer>
        </form>
      </section>
      {deleteTarget && (
        <div className="modalBackdrop nestedModalBackdrop" role="presentation">
          <section className="installModal confirmModal" role="dialog" aria-modal="true" aria-label="删除连接器账号">
            <header>
              <div>
                <strong>删除连接器账号</strong>
                <span>此操作无法撤销</span>
              </div>
              <button className="iconButton" type="button" onClick={() => setDeleteTarget(null)} disabled={deleteBusy} title="关闭">
                <X size={18} />
              </button>
            </header>
            <p>
              确定删除{getConnectorPlatformLabel(deleteTarget.platform)}账号「{getConnectorAccountLabel(deleteTarget)}」吗？
              登录信息和自动复盘任务将一并清除。
            </p>
            {connectorError && <div className="connectorError" role="alert">{connectorError}</div>}
            <footer>
              <button className="secondaryButton" type="button" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>取消</button>
              <button className="dangerButton" type="button" onClick={() => void confirmDeleteConnectorAccount()} disabled={deleteBusy}>
                {deleteBusy ? <RefreshCw className="spinIcon" size={16} /> : <Trash2 size={16} />}
                <span>{deleteBusy ? "删除中" : "确认删除"}</span>
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

function ConnectorSettingsPanel({
  accounts,
  activeRequest,
  connectorBusy,
  connectorError,
  copiedCredential,
  lockedXhsAccounts,
  platform,
  revealedWechatSecrets,
  onDelete,
  onCopyCredential,
  onToggleAutoReview,
  onToggleWechatSecret
}: {
  accounts: ConnectorAccount[];
  activeRequest: boolean;
  connectorBusy: boolean;
  connectorError: string;
  copiedCredential: string;
  lockedXhsAccounts: Record<string, boolean>;
  platform: ConnectorSettingsTab;
  revealedWechatSecrets: Record<string, string>;
  onDelete: (account: ConnectorAccount) => void;
  onCopyCredential: (account: ConnectorAccount, field: "appid" | "secret") => void;
  onToggleAutoReview: (account: ConnectorAccount) => void;
  onToggleWechatSecret: (account: ConnectorAccount) => void;
}) {
  return (
    <section className="settingsPanel connectorSettingsPanel" role="tabpanel" aria-label={`${getConnectorPlatformLabel(platform)}账号`}>
      <div className="settingsSectionHeader">
        <div>
          <strong>{getConnectorPlatformLabel(platform)}账号</strong>
          <p>{platform === "douyin" ? "抖音连接器暂未开放添加账号。" : "账号添加和选择请在对话框左下角的连接器入口完成。"}</p>
        </div>
      </div>
      <div className="connectorSettingsList">
        {accounts.map((account) => {
          const locked = platform === "xhs" && Boolean(lockedXhsAccounts[account.profileKey]);
          const disabled = connectorBusy || activeRequest || locked;
          const reviewDisabled = disabled || account.status !== "authorized";
          const secret = revealedWechatSecrets[account.profileKey];
          const appIdCopied = copiedCredential === `${account.profileKey}:appid`;
          const secretCopied = copiedCredential === `${account.profileKey}:secret`;
          return (
            <article key={account.profileKey} className={`connectorSettingsRow connectorAccountTone-${getConnectorAccountStatusTone(account)}`}>
              <div className="connectorSettingsIdentity">
                <img src={platform === "wechat" ? gzhLogoUrl : platform === "douyin" ? douyinLogoUrl : xhsLogoUrl} alt="" />
                <div>
                  <strong>{getConnectorAccountLabel(account)}</strong>
                  <span>{platform === "wechat" ? "公众号账号" : platform === "douyin" ? "抖音账号" : account.accountHandle || "未读取到小红书号"}</span>
                </div>
              </div>
              <div className="connectorSettingsDetails">
                <div>
                  <span>{platform === "wechat" ? "APPID" : "登录状态"}</span>
                  {platform === "wechat" ? (
                    <div className="connectorCredentialField">
                      <code>{account.accountId || "未配置"}</code>
                      <button type="button" onClick={() => onCopyCredential(account, "appid")} disabled={connectorBusy || !account.accountId} aria-label={`复制 ${getConnectorAccountLabel(account)} APPID`} title={appIdCopied ? "已复制" : "复制 APPID"}>
                        {appIdCopied ? <Check size={16} /> : <Copy size={16} />}
                      </button>
                    </div>
                  ) : (
                    <strong>{getConnectorAccountLoginStatusLabel(account)}</strong>
                  )}
                </div>
                {platform === "wechat" && (
                  <div>
                    <span>APPSECRET</span>
                    <div className="connectorCredentialField">
                      <code>{secret || "••••••••••••"}</code>
                      <button type="button" onClick={() => onToggleWechatSecret(account)} disabled={connectorBusy} aria-label={`${secret ? "隐藏" : "显示"} ${getConnectorAccountLabel(account)} APPSECRET`} title={secret ? "隐藏 APPSECRET" : "显示 APPSECRET"}>
                        {secret ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                      <button type="button" onClick={() => onCopyCredential(account, "secret")} disabled={connectorBusy} aria-label={`复制 ${getConnectorAccountLabel(account)} APPSECRET`} title={secretCopied ? "已复制" : "复制 APPSECRET"}>
                        {secretCopied ? <Check size={16} /> : <Copy size={16} />}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="connectorSettingsActions">
                <label>
                  <span>自动复盘</span>
                  <button
                    className={`connectorReviewSwitch ${getConnectorOpsState(account).autoReviewEnabled ? "enabled" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={getConnectorOpsState(account).autoReviewEnabled}
                    aria-label={`${getConnectorOpsState(account).autoReviewEnabled ? "关闭" : "开启"}自动复盘 ${getConnectorAccountLabel(account)}`}
                    onClick={() => onToggleAutoReview(account)}
                    disabled={reviewDisabled}
                    title={locked ? "其他任务正在运行" : account.status === "authorized" ? "自动复盘" : "授权后可开启自动复盘"}
                  >
                    <span />
                  </button>
                </label>
                <button className="connectorSettingsDelete" type="button" onClick={() => onDelete(account)} disabled={disabled} aria-label={`删除账号 ${getConnectorAccountLabel(account)}`} title={locked ? "其他任务正在运行" : "删除账号"}>
                  <Trash2 size={16} />
                </button>
              </div>
            </article>
          );
        })}
        {accounts.length === 0 && <p className="settingsEmpty">{platform === "douyin" ? "暂不支持添加抖音账号。" : "暂无账号，请从对话框连接器入口添加。"}</p>}
      </div>
      {connectorError && <p className="settingsError" role="alert"><AlertCircle size={16} /><span>{connectorError}</span></p>}
    </section>
  );
}

function ModelProviderList({
  providers,
  selectedId,
  saving,
  onDelete,
  onSelect,
  onUpdate
}: {
  providers: ModelProviderDefinition[];
  selectedId: string;
  saving: boolean;
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
  onUpdate: (id: string, patch: Partial<ModelProviderDefinition>) => void;
}) {
  return (
    <div className="providerList" aria-label="大模型供应商列表">
      <div className="providerListHeader" aria-hidden="true">
        <span>当前</span>
        <span>供应商</span>
        <span>模型</span>
        <span>Base URL</span>
        <span>操作</span>
      </div>
      {providers.map((provider) => (
        <div key={provider.id} className={`providerRow ${provider.id === selectedId ? "selected" : ""}`}>
          <div className="providerRowMain">
            <input type="radio" checked={provider.id === selectedId} onChange={() => onSelect(provider.id)} aria-label={`选择供应商 ${provider.name || provider.id}`} disabled={saving} />
            <button className="providerRowBody" type="button" onClick={() => onSelect(provider.id)} aria-label={provider.name || provider.id} disabled={saving}>
              <span className="providerCell providerNameCell">{provider.name || provider.id}</span>
              <span className="providerCell" title={provider.model}>{provider.model || "未配置模型"}</span>
              <span className="providerCell" title={provider.baseUrl}>{provider.baseUrl || "未配置 Base URL"}</span>
            </button>
            {providers.length > 1 && (
              <button className="providerRowDelete" type="button" onClick={() => onDelete(provider.id)} aria-label={`删除供应商 ${provider.name || provider.id}`} title="删除供应商" disabled={saving}>
                <X size={14} />
              </button>
            )}
          </div>
          {provider.id === selectedId && (
            <div className="providerRowDetails">
              <div className="settingsGrid">
                <label>
                  <span>供应商名称</span>
                  <input value={provider.name} onChange={(event) => onUpdate(provider.id, { name: event.target.value })} disabled={saving} />
                </label>
                <label>
                  <span>Base URL</span>
                  <input value={provider.baseUrl} onChange={(event) => onUpdate(provider.id, { baseUrl: event.target.value })} placeholder="https://api.anthropic.com" disabled={saving} />
                </label>
                <label>
                  <span>API Key</span>
                  <ApiKeyField
                    value={provider.apiKey}
                    onChange={(apiKey) => onUpdate(provider.id, { apiKey })}
                    placeholder="sk-..."
                    disabled={saving}
                  />
                </label>
                <ModelTagsField
                  disabled={saving}
                  model={provider.model}
                  onChange={(model) => onUpdate(provider.id, { model })}
                />
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ImageProviderList({
  providers,
  selectedId,
  saving,
  onDelete,
  onSelect,
  onUpdate
}: {
  providers: ImageProviderDefinition[];
  selectedId: string;
  saving: boolean;
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
  onUpdate: (id: string, patch: Partial<ImageProviderDefinition>) => void;
}) {
  return (
    <div className="providerList" aria-label="图片模型供应商列表">
      <div className="providerListHeader" aria-hidden="true">
        <span>当前</span>
        <span>供应商</span>
        <span>模型</span>
        <span>Base URL</span>
        <span>操作</span>
      </div>
      {providers.map((provider) => (
        <div key={provider.id} className={`providerRow ${provider.id === selectedId ? "selected" : ""}`}>
          <div className="providerRowMain">
            <input type="radio" checked={provider.id === selectedId} onChange={() => onSelect(provider.id)} aria-label={`选择图片供应商 ${provider.name || provider.id}`} disabled={saving} />
            <button className="providerRowBody" type="button" onClick={() => onSelect(provider.id)} aria-label={provider.name || provider.id} disabled={saving}>
              <span className="providerCell providerNameCell">{provider.name || provider.id}</span>
              <span className="providerCell" title={provider.model}>{provider.model || "未配置模型"}</span>
              <span className="providerCell" title={provider.baseUrl}>{provider.baseUrl || "未配置 Base URL"}</span>
            </button>
            {providers.length > 1 && (
              <button className="providerRowDelete" type="button" onClick={() => onDelete(provider.id)} aria-label={`删除图片供应商 ${provider.name || provider.id}`} title="删除图片供应商" disabled={saving}>
                <X size={14} />
              </button>
            )}
          </div>
          {provider.id === selectedId && (
            <div className="providerRowDetails">
              <div className="settingsGrid">
                <label>
                  <span>供应商类型</span>
                  <div className="settingsSelectField">
                    <select
                      value={provider.providerType}
                      onChange={(event) => {
                        const providerType = event.target.value as ImageProviderType;
                        const defaults = imageProviderDefaults[providerType];
                        onUpdate(provider.id, {
                          providerType,
                          name: defaults.name,
                          baseUrl: defaults.baseUrl,
                          model: defaults.model
                        });
                      }}
                      disabled={saving}
                    >
                      {Object.entries(imageProviderDefaults).map(([providerType, defaults]) => (
                        <option key={providerType} value={providerType}>{defaults.label}</option>
                      ))}
                    </select>
                    <ChevronDown size={17} aria-hidden="true" />
                  </div>
                </label>
                <label>
                  <span>供应商名称</span>
                  <input value={provider.name} onChange={(event) => onUpdate(provider.id, { name: event.target.value })} disabled={saving} />
                </label>
                <label>
                  <span>Base URL</span>
                  <input value={provider.baseUrl} onChange={(event) => onUpdate(provider.id, { baseUrl: event.target.value })} placeholder={provider.providerType === "openai-compatible" ? "https://api.example.com/v1" : imageProviderDefaults[provider.providerType]?.baseUrl} disabled={saving} />
                </label>
                <label>
                  <span>API Key</span>
                  <ApiKeyField
                    value={provider.apiKey}
                    onChange={(apiKey) => onUpdate(provider.id, { apiKey })}
                    placeholder="sk-..."
                    disabled={saving}
                  />
                </label>
                <label>
                  <span>模型</span>
                  <input value={provider.model} onChange={(event) => onUpdate(provider.id, { model: event.target.value })} placeholder="gpt-image-1" disabled={saving} />
                </label>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ApiKeyField({
  value,
  disabled,
  placeholder,
  onChange
}: {
  value: string;
  disabled: boolean;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="apiKeyField">
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        type={visible ? "text" : "password"}
        placeholder={placeholder}
        disabled={disabled}
      />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? "隐藏 API Key" : "显示 API Key"}
        title={visible ? "隐藏 API Key" : "显示 API Key"}
        disabled={disabled}
      >
        {visible ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
    </div>
  );
}

function ModelTagsField({ disabled, model, onChange }: { disabled: boolean; model: string; onChange: (model: string) => void }) {
  const models = splitModelTags(model);
  return (
    <div className="modelTagsField">
      <label>
        <span>模型</span>
        <input value={model} onChange={(event) => onChange(event.target.value)} placeholder="claude-sonnet-4-5,claude-opus-4-5" disabled={disabled} />
      </label>
      {models.length > 0 && (
        <div className="modelTagList" aria-label="模型标签预览">
          {models.map((item) => <span key={item}>{item}</span>)}
        </div>
      )}
    </div>
  );
}

function OnboardingPage({
  error,
  platform,
  provider,
  saving,
  onProviderChange,
  onSave,
  onSkip
}: {
  error: string;
  platform: NodeJS.Platform | "browser";
  provider: ModelProviderConfig;
  saving: boolean;
  onProviderChange: (provider: ModelProviderConfig) => void;
  onSave: () => void;
  onSkip: () => void;
}) {
  const updateProvider = (field: keyof ModelProviderConfig, value: string) => {
    onProviderChange({ ...provider, [field]: value });
  };

  return (
    <main className={`onboardingPage platform-${platform}`}>
      <section className="onboardingHero" aria-label="模型配置引导">
        <div className="onboardingBrand">
          <img className="onboardingLogo" src={logoUrl} alt="小G" />
          <span>小G</span>
        </div>
        <div className="onboardingCopy">
          <div className="onboardingMark">
            <Bot size={34} />
          </div>
          <h1>连接你的模型服务</h1>
          <p>配置 Anthropic Messages API 兼容服务后，小G就可以在本机工作空间里处理项目任务。</p>
        </div>
        <div className="onboardingChecklist" aria-label="配置项">
          <span><Check size={15} />Base URL</span>
          <span><Check size={15} />API Key</span>
          <span><Check size={15} />Model</span>
        </div>
      </section>

      <form className="onboardingForm" onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}>
        <header>
          <div>
            <Settings size={22} />
            <strong>模型配置</strong>
          </div>
        </header>
        <label>
          <span>Base URL</span>
          <input value={provider.baseUrl} onChange={(event) => updateProvider("baseUrl", event.target.value)} placeholder="https://api.anthropic.com" disabled={saving} />
        </label>
        <label>
          <span>API Key</span>
          <input value={provider.apiKey} onChange={(event) => updateProvider("apiKey", event.target.value)} type="password" placeholder="sk-ant-..." disabled={saving} />
        </label>
        <label>
          <span>Model</span>
          <input value={provider.model} onChange={(event) => updateProvider("model", event.target.value)} placeholder="claude-sonnet-4-5" disabled={saving} />
        </label>
        {error && (
          <p className="onboardingError" role="alert">
            <AlertCircle size={16} />
            <span>{error}</span>
          </p>
        )}
        <footer className={`onboardingActions ${saving ? "saving" : ""}`}>
          {!saving && <button type="button" className="onboardingSkip" onClick={onSkip}>跳过</button>}
          <button type="submit" className="onboardingSave" disabled={saving}>
            {saving ? <RefreshCw className="spinIcon" size={17} /> : <Save size={17} />}
            <span>{saving ? "正在测试连接" : "保存"}</span>
          </button>
        </footer>
      </form>
    </main>
  );
}

function PermissionIcon({ mode, size }: { mode: ChatPermissionMode; size: number }) {
  if (mode === "default") return <Hand size={size} />;
  if (mode === "auto") return <Shield size={size} />;
  if (mode === "bypassPermissions") return <ShieldAlert size={size} />;
  return <Shield size={size} />;
}

function ThemeModeIcon({ mode, size }: { mode: ThemeMode; size: number }) {
  if (mode === "system") return <MonitorCog size={size} />;
  if (mode === "dark") return <Moon size={size} />;
  return <Sun size={size} />;
}

function AutomationCenter({
  error,
  search,
  tab,
  tasks,
  runs,
  onCreate,
  onPresetCreate,
  onDeleteTask,
  onReload,
  onSearchChange,
  onSelectRun,
  onSelectTask,
  onTabChange,
  onToggleTask
}: {
  error: string;
  search: string;
  tab: AutomationTab;
  tasks: AutomationTask[];
  runs: AutomationRun[];
  onCreate: () => void;
  onPresetCreate: (preset: { name: string; description: string }) => void;
  onDeleteTask: (task: AutomationTask) => void;
  onReload: () => void;
  onSearchChange: (value: string) => void;
  onSelectRun: (run: AutomationRun) => void;
  onSelectTask: (task: AutomationTask) => void;
  onTabChange: (value: AutomationTab) => void;
  onToggleTask: (task: AutomationTask) => void;
}) {
  const hasTasks = tasks.length > 0 || runs.length > 0 || search.trim().length > 0;
  if (!hasTasks) {
    return (
      <section className="automationCenter">
        <div className="automationEmpty">
          <div className="animatedClock" aria-hidden="true">
            <span className="clockHand hourHand" />
            <span className="clockHand minuteHand" />
            <span className="clockDot" />
          </div>
          <button className="emptyCreateText" onClick={onCreate}>创建首个自动化</button>
          <div className="automationQuickActions">
            {automationPresets.map((preset) => (
              <button key={preset.name} onClick={() => onPresetCreate(preset)}>
                <preset.icon size={20} />
                <span>{preset.name}</span>
              </button>
            ))}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="automationCenter">
      <div className="skillToolbar">
        <label className="skillSearch">
          <Search size={17} />
          <input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="搜索自动化任务或运行记录" />
        </label>
        <button className="primaryButton" onClick={onCreate}>
          <Plus size={17} />
          <span>创建</span>
        </button>
      </div>
      <div className="skillTabs">
        <button className={tab === "tasks" ? "active" : ""} onClick={() => onTabChange("tasks")}>定时任务</button>
        <button className={tab === "runs" ? "active" : ""} onClick={() => onTabChange("runs")}>运行记录</button>
      </div>
      {error && (
        <div className="skillError">
          <AlertCircle size={20} />
          <div>
            <strong>自动化加载失败</strong>
            <span>{error}</span>
          </div>
          <button className="secondaryButton" onClick={onReload}>
            <RefreshCw size={16} />
            <span>重新加载</span>
          </button>
        </div>
      )}
      {tab === "tasks" ? (
        <div className="skillTable automationTable">
          <div className="automationTaskRow automationHead">
            <span>任务名称</span>
            <span>描述</span>
            <span>调度周期</span>
            <span>下次执行时间</span>
            <span>操作</span>
          </div>
          {tasks.map((task) => (
            <button key={task.id} className="automationTaskRow" onClick={() => onSelectTask(task)}>
              <strong>{task.name}</strong>
              <span>{task.description}</span>
              <span>{formatAutomationSchedule(task.scheduleType, task.scheduleConfig)}{task.maxRuns !== null ? ` · ${task.runCount}/${task.maxRuns} 次` : ""}</span>
              <span>{task.nextRunAt ? formatDateTime(task.nextRunAt) : task.enabled ? "未计划" : "已停用"}</span>
              <span className="automationActions" onClick={(event) => event.stopPropagation()}>
                <button
                  className={`skillSwitch ${task.enabled ? "enabled" : ""}`}
                  onClick={() => onToggleTask(task)}
                  role="switch"
                  aria-checked={task.enabled}
                  aria-label={`${task.enabled ? "停用" : "启用"} ${task.name}`}
                  title={task.enabled ? "停用" : "启用"}
                >
                  <span className="switchTrack" aria-hidden="true">
                    <span className="switchThumb" />
                  </span>
                </button>
                <button className="iconDanger" onClick={() => onDeleteTask(task)} title="删除">
                  <Trash2 size={16} />
                </button>
              </span>
            </button>
          ))}
          {tasks.length === 0 && <AutomationInlineEmpty text="没有匹配的定时任务" />}
        </div>
      ) : (
        <div className="skillTable automationTable">
          <div className="automationRunRow automationHead">
            <span>定时任务名称</span>
            <span>运行时间</span>
            <span>运行状态</span>
            <span>尝试次数</span>
            <span>错误摘要</span>
          </div>
          {runs.map((run) => (
            <button key={run.id} className="automationRunRow" onClick={() => onSelectRun(run)}>
              <strong>{run.taskName}</strong>
              <span>{formatDateTime(run.startedAt ?? run.scheduledAt)}</span>
              <span className={`runStatus ${run.status}`}>{formatAutomationStatus(run.status)}</span>
              <span>{run.attemptCount}/{run.maxAttempts}</span>
              <span>{run.errorMessage ?? "-"}</span>
            </button>
          ))}
          {runs.length === 0 && <AutomationInlineEmpty text="暂无运行记录" />}
        </div>
      )}
    </section>
  );
}

function AutomationInlineEmpty({ text }: { text: string }) {
  return (
    <div className="skillEmpty automationInlineEmpty">
      <Clock3 size={42} />
      <strong>{text}</strong>
    </div>
  );
}

function AutomationTaskModal(props: {
  accounts: ConnectorAccount[];
  availableSkills: SkillListItem[];
  busy: boolean;
  draft: AutomationTaskInput;
  error: string;
  title: string;
  onCancel: () => void;
  onChooseWorkspace: () => void;
  onChooseFiles: () => void;
  onDraftChange: (draft: AutomationTaskInput) => void;
  onSave: () => void;
}) {
  return (
    <div className="modalBackdrop" role="presentation">
      <section className="installModal automationModal" role="dialog" aria-modal="true" aria-label={props.title}>
        <header>
          <strong>{props.title}</strong>
          <button className="iconButton" onClick={props.onCancel} title="关闭">
            <X size={18} />
          </button>
        </header>
        {props.error && <div className="errorBanner">{props.error}</div>}
        <AutomationTaskForm accounts={props.accounts} availableSkills={props.availableSkills} draft={props.draft} onChooseFiles={props.onChooseFiles} onChooseWorkspace={props.onChooseWorkspace} onDraftChange={props.onDraftChange} />
        <footer>
          <button className="secondaryButton" onClick={props.onCancel}>取消</button>
          <button className="primaryButton" onClick={props.onSave} disabled={props.busy}>
            <Save size={16} />
            <span>{props.busy ? "保存中" : "保存"}</span>
          </button>
        </footer>
      </section>
    </div>
  );
}

function AutomationRightPanel({
  accounts,
  availableSkills,
  busy,
  draft,
  run,
  runLoading,
  runMessages,
  task,
  onChooseWorkspace,
  onChooseFiles,
  onDraftChange,
  onSave
}: {
  accounts: ConnectorAccount[];
  availableSkills: SkillListItem[];
  busy: boolean;
  draft: AutomationTaskInput | null;
  run: AutomationRun | null;
  runLoading: boolean;
  runMessages: ChatMessage[];
  task: AutomationTask | null;
  onChooseWorkspace: () => void;
  onChooseFiles: () => void;
  onDraftChange: (draft: AutomationTaskInput | null) => void;
  onSave: () => void;
}) {
  if (task && draft) {
    return (
      <>
        <header>
          <strong>{task.name}</strong>
          <span>{task.enabled ? "已启用" : "已停用"}</span>
        </header>
        <div className="automationDetail">
          <AutomationTaskForm accounts={accounts} availableSkills={availableSkills} draft={draft} onChooseFiles={onChooseFiles} onChooseWorkspace={onChooseWorkspace} onDraftChange={(next) => onDraftChange(next)} />
          <button className="primaryButton" onClick={onSave} disabled={busy}>
            <Save size={16} />
            <span>{busy ? "保存中" : "保存修改"}</span>
          </button>
        </div>
      </>
    );
  }
  if (run) {
    return (
      <>
        <header>
          <strong>{run.taskName}</strong>
          <span>{formatAutomationStatus(run.status)}</span>
        </header>
        <div className="automationRunDetail">
          <div className="runMeta">
            <span>运行时间：{formatDateTime(run.startedAt ?? run.scheduledAt)}</span>
            <span>尝试次数：{run.attemptCount}/{run.maxAttempts}</span>
            {run.nextRetryAt && <span>下次重试：{formatDateTime(run.nextRetryAt)}</span>}
            {run.errorMessage && <span>错误：{run.errorMessage}</span>}
          </div>
          {runLoading && <div className="rightEmpty">正在读取对话记录...</div>}
          {!runLoading && runMessages.length === 0 && <div className="rightEmpty">暂无可展示的对话记录。</div>}
          {!runLoading && runMessages.length > 0 && (
            <div className="messageList automationMessageList">
              {runMessages.map((message) => (
                <MessageView key={message.id} message={message} />
              ))}
            </div>
          )}
        </div>
      </>
    );
  }
  return (
    <>
      <header>
        <strong>自动化详情</strong>
        <span>未选择</span>
      </header>
      <div className="rightEmpty">点击任务或运行记录查看详情。</div>
    </>
  );
}

function AutomationTaskForm({ accounts, availableSkills, draft, onChooseFiles, onChooseWorkspace, onDraftChange }: { accounts: ConnectorAccount[]; availableSkills: SkillListItem[]; draft: AutomationTaskInput; onChooseFiles: () => void; onChooseWorkspace: () => void; onDraftChange: (draft: AutomationTaskInput) => void }) {
  const update = (patch: Partial<AutomationTaskInput>) => onDraftChange({ ...draft, ...patch });
  const updateConfig = (patch: AutomationScheduleConfig) => update({ scheduleConfig: { ...draft.scheduleConfig, ...patch } });
  const bindings = draft.connectorBindings ?? {};
  const selectedSkills = draft.selectedSkills ?? [];
  const taskAttachments = draft.attachments ?? [];
  const updateBinding = (platform: "xhs", profileKey: string) => {
    const account = accounts.find((item) => item.platform === platform && item.profileKey === profileKey);
    const next = { ...bindings };
    if (account) next[platform] = automationConnectorBinding(account);
    else delete next[platform];
    update({ connectorBindings: next });
  };
  const toggleSkill = (skill: SkillListItem) => {
    const exists = selectedSkills.some((item) => item.name === skill.name);
    update({ selectedSkills: exists ? selectedSkills.filter((item) => item.name !== skill.name) : [...selectedSkills, { name: skill.name, agent: skill.agent, description: skill.description }] });
  };
  return (
    <div className="automationForm">
      <label>
        <span>任务名称</span>
        <input value={draft.name} onChange={(event) => update({ name: event.target.value })} placeholder="例如：内容日更" />
      </label>
      <label>
        <span>项目目录</span>
        <div className="pathInput">
          <input value={draft.workspacePath} onChange={(event) => update({ workspacePath: event.target.value })} placeholder="选择任务运行目录" />
          <button className="secondaryButton" onClick={onChooseWorkspace}>选择</button>
        </div>
      </label>
      <label>
        <span>任务描述</span>
        <textarea value={draft.description} onChange={(event) => update({ description: event.target.value })} rows={4} placeholder="描述 agent 到点后需要执行的任务" />
      </label>
      <ScheduleEditor type={draft.scheduleType} config={draft.scheduleConfig} onConfigChange={updateConfig} onTypeChange={(scheduleType) => update({ scheduleType, scheduleConfig: defaultScheduleConfig(scheduleType) })} />
      {draft.scheduleType === "interval" && (
        <label>
          <span>最多运行次数（留空表示无限）</span>
          <input type="number" min={1} value={draft.maxRuns ?? ""} onChange={(event) => update({ maxRuns: event.target.value ? Math.max(1, Math.floor(Number(event.target.value))) : null })} />
        </label>
      )}
      <label>
        <span>最大重试次数</span>
        <input type="number" min={0} max={20} value={draft.maxRetries} onChange={(event) => update({ maxRetries: Number(event.target.value) })} />
      </label>
      {(["xhs"] as const).map((platform) => (
        <label key={platform}>
          <span>小红书账号</span>
          <select value={bindings[platform]?.profileKey ?? ""} onChange={(event) => updateBinding(platform, event.target.value)}>
            <option value="">不绑定</option>
            {accounts.filter((account) => account.platform === platform).map((account) => <option key={account.profileKey} value={account.profileKey}>{getConnectorAccountLabel(account)}</option>)}
          </select>
        </label>
      ))}
      <div className="automationContextGroup">
        <span>使用 Skill</span>
        <div className="automationContextOptions">
          {availableSkills.map((skill) => <button type="button" key={skill.name} className={selectedSkills.some((item) => item.name === skill.name) ? "active" : ""} onClick={() => toggleSkill(skill)}>{skill.name}</button>)}
          {availableSkills.length === 0 && <em>暂无已启用 Skill</em>}
        </div>
      </div>
      <div className="automationContextGroup">
        <span>选择的文件</span>
        <div className="automationAttachmentList">
          {taskAttachments.map((file) => <div key={file.path}><span title={file.path}>{file.name}</span><button type="button" title="移除文件" onClick={() => update({ attachments: taskAttachments.filter((item) => item.path !== file.path) })}><X size={14} /></button></div>)}
          <button type="button" className="secondaryButton" onClick={onChooseFiles}><Paperclip size={15} />添加文件</button>
        </div>
      </div>
      <div className="automationPermissionNotice"><ShieldAlert size={16} />定时任务始终使用完全访问权限</div>
    </div>
  );
}

function ScheduleEditor({ type, config, onConfigChange, onTypeChange }: { type: AutomationScheduleType; config: AutomationScheduleConfig; onConfigChange: (patch: AutomationScheduleConfig) => void; onTypeChange: (type: AutomationScheduleType) => void }) {
  return (
    <div className="scheduleEditor">
      <label>
        <span>计划时间</span>
        <select value={type} onChange={(event) => onTypeChange(event.target.value as AutomationScheduleType)}>
          <option value="once">一次性</option>
          <option value="interval">固定间隔</option>
          <option value="hourly">每小时</option>
          <option value="daily">每天</option>
          <option value="weekday">工作日</option>
          <option value="weekly">每周</option>
          <option value="monthly">每月</option>
        </select>
      </label>
      {type === "once" && (
        <label>
          <span>执行时间</span>
          <input type="datetime-local" value={toDateTimeLocal(config.runAt)} onChange={(event) => onConfigChange({ runAt: fromDateTimeLocal(event.target.value) })} />
        </label>
      )}
      {type === "interval" && (
        <>
          <NumberInput label="间隔数值" value={config.intervalValue ?? config.intervalMinutes ?? 1} min={1} onChange={(value) => onConfigChange({ intervalValue: value })} />
          <label>
            <span>间隔单位</span>
            <select value={config.intervalUnit ?? "minute"} onChange={(event) => onConfigChange({ intervalUnit: event.target.value as "minute" | "hour" | "day" })}>
              <option value="minute">分钟</option>
              <option value="hour">小时</option>
              <option value="day">天</option>
            </select>
          </label>
        </>
      )}
      {type === "hourly" && <NumberSelect label="分钟" value={config.minute ?? 0} min={0} max={59} onChange={(value) => onConfigChange({ minute: value })} />}
      {(type === "daily" || type === "weekday" || type === "weekly" || type === "monthly") && (
        <>
          {type === "weekly" && <MultiNumberSelect label="星期" values={config.weekdays ?? [1]} min={1} max={7} formatter={(value) => `周${["一", "二", "三", "四", "五", "六", "日"][value - 1]}`} onChange={(values) => onConfigChange({ weekdays: values })} />}
          {type === "monthly" && <MultiNumberSelect label="日期" values={config.monthDays ?? [1]} min={1} max={31} formatter={(value) => `${value}日`} onChange={(values) => onConfigChange({ monthDays: values })} />}
          <NumberSelect label="小时" value={config.hour ?? 9} min={0} max={23} onChange={(value) => onConfigChange({ hour: value })} />
          <NumberSelect label="分钟" value={config.minute ?? 0} min={0} max={59} onChange={(value) => onConfigChange({ minute: value })} />
        </>
      )}
    </div>
  );
}

function NumberSelect({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {Array.from({ length: max - min + 1 }, (_, index) => min + index).map((item) => (
          <option key={item} value={item}>{String(item).padStart(2, "0")}</option>
        ))}
      </select>
    </label>
  );
}

function NumberInput({ label, value, min, onChange }: { label: string; value: number; min: number; onChange: (value: number) => void }) {
  return (
    <label>
      <span>{label}</span>
      <input type="number" min={min} value={value} onChange={(event) => onChange(Math.max(min, Math.floor(Number(event.target.value) || min)))} />
    </label>
  );
}

function MultiNumberSelect({ label, values, min, max, formatter, onChange }: { label: string; values: number[]; min: number; max: number; formatter: (value: number) => string; onChange: (values: number[]) => void }) {
  const current = new Set(values);
  function toggle(value: number) {
    const next = new Set(current);
    if (next.has(value) && next.size > 1) next.delete(value);
    else next.add(value);
    onChange(Array.from(next).sort((a, b) => a - b));
  }
  return (
    <div className="multiSelect">
      <span>{label}</span>
      <div>
        {Array.from({ length: max - min + 1 }, (_, index) => min + index).map((item) => (
          <button key={item} type="button" className={current.has(item) ? "active" : ""} onClick={() => toggle(item)}>
            {formatter(item)}
          </button>
        ))}
      </div>
    </div>
  );
}

function SkillCenter({
  error,
  installDialogOpen,
  installBusy,
  installUrl,
  search,
  skills,
  tab,
  onInstallDialogChange,
  onInstallGithub,
  onInstallMarket,
  onInstallUrlChange,
  onSearchChange,
  onSelectSkill,
  onTabChange,
  onToggleSkill,
  onReload
}: {
  error: string;
  installDialogOpen: boolean;
  installBusy: boolean;
  installUrl: string;
  search: string;
  skills: Array<MarketSkillItem | SkillListItem>;
  tab: SkillTab;
  onInstallDialogChange: (value: boolean) => void;
  onInstallGithub: () => void;
  onInstallMarket: (skill: MarketSkillItem) => void;
  onInstallUrlChange: (value: string) => void;
  onSearchChange: (value: string) => void;
  onSelectSkill: (source: "installed" | "market", name: string, agent: string) => void;
  onTabChange: (value: SkillTab) => void;
  onToggleSkill: (skill: SkillListItem) => void;
  onReload: () => void;
}) {
  const source = tab === "market" ? "market" : "installed";

  return (
    <section className="skillCenter">
      <div className="skillToolbar">
        <label className="skillSearch">
          <Search size={17} />
          <input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="搜索插件或技能" />
        </label>
        <button className="primaryButton" onClick={() => onInstallDialogChange(true)}>
          <Plus size={17} />
          <span>创建</span>
        </button>
      </div>

      <div className="skillTabs">
        <button className={tab === "market" ? "active" : ""} onClick={() => onTabChange("market")}>技能市场</button>
        <button className={tab === "installed" ? "active" : ""} onClick={() => onTabChange("installed")}>已安装</button>
      </div>

      {error && (
        <div className="skillError">
          <AlertCircle size={20} />
          <div>
            <strong>无法加载技能列表</strong>
            <span>{error}</span>
          </div>
          <button className="secondaryButton" onClick={onReload}>
            <RefreshCw size={16} />
            <span>重新加载</span>
          </button>
        </div>
      )}

      <div className="skillTable">
        <div className="skillRow skillHead">
          <span>名称</span>
          <span>描述</span>
          <span>操作</span>
        </div>
        {skills.map((skill) => (
          <button key={`${skill.agent}:${skill.name}`} className="skillRow" onClick={() => onSelectSkill(source, skill.name, skill.agent)}>
            <strong>{skill.name}</strong>
            <span>{skill.description}</span>
            <SkillActionCell skill={skill} tab={tab} onInstallMarket={onInstallMarket} onToggleSkill={onToggleSkill} />
          </button>
        ))}
        {skills.length === 0 && (
          <div className="skillEmpty">
            <PackageOpen size={42} />
            <strong>没有匹配的技能</strong>
            <span>尝试调整筛选条件或搜索关键词</span>
          </div>
        )}
      </div>

      {installDialogOpen && (
        <div className="modalBackdrop" role="presentation">
          <section className="installModal" role="dialog" aria-modal="true" aria-label="通过 GitHub 安装 Skill">
            <header>
              <strong>通过 GitHub 链接安装</strong>
              <button className="iconButton" onClick={() => onInstallDialogChange(false)} title="关闭">
                <X size={18} />
              </button>
            </header>
            <p>支持 GitHub SKILL.md 链接，例如 https://github.com/owner/repo/tree/main/example/SKILL.md。安装时会临时 clone 仓库并复制该 Skill 所在目录。</p>
            <label>
              <span>GitHub 链接</span>
              <input value={installUrl} onChange={(event) => onInstallUrlChange(event.target.value)} placeholder="https://github.com/owner/repo/tree/main/example/SKILL.md" />
            </label>
            <footer>
              <button className="secondaryButton" onClick={() => onInstallDialogChange(false)}>取消</button>
              <button className="primaryButton" onClick={onInstallGithub} disabled={installBusy}>
                <Download size={16} />
                <span>{installBusy ? "安装中" : "安装"}</span>
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}

function SkillActionCell({
  skill,
  tab,
  onInstallMarket,
  onToggleSkill
}: {
  skill: MarketSkillItem | SkillListItem;
  tab: SkillTab;
  onInstallMarket: (skill: MarketSkillItem) => void;
  onToggleSkill: (skill: SkillListItem) => void;
}) {
  if (tab === "market") {
    const marketSkill = skill as MarketSkillItem;
    return (
      <span className="skillAction" onClick={(event) => event.stopPropagation()}>
        {marketSkill.installed ? (
          <span className="installedBadge" title="已安装">
            <Check size={17} />
          </span>
        ) : (
          <button className="miniButton" onClick={() => onInstallMarket(marketSkill)} title="安装">
            <Plus size={16} />
          </button>
        )}
      </span>
    );
  }

  const installedSkill = skill as SkillListItem;
  return (
    <span className="skillAction" onClick={(event) => event.stopPropagation()}>
      <button
        className={`skillSwitch ${installedSkill.enabled ? "enabled" : ""}`}
        onClick={() => onToggleSkill(installedSkill)}
        role="switch"
        aria-checked={installedSkill.enabled}
        aria-label={`${installedSkill.enabled ? "禁用" : "启用"} ${installedSkill.name}`}
        title={installedSkill.enabled ? "禁用" : "启用"}
      >
        <span className="switchTrack" aria-hidden="true">
          <span className="switchThumb" />
        </span>
      </button>
    </span>
  );
}

function SkillDetailPanel({ selectedSkill, content, loading }: { selectedSkill: { source: "installed" | "market"; name: string; agent: string } | null; content: SkillContent | null; loading: boolean }) {
  if (!selectedSkill) {
    return (
      <>
        <header>
          <strong>Skill 详情</strong>
          <span>未选择</span>
        </header>
        <div className="rightEmpty">点击左侧任意 skill 查看 SKILL.md。</div>
      </>
    );
  }

  return (
    <>
      <header>
        <strong>{selectedSkill.name}</strong>
        <span>{selectedSkill.source === "installed" ? "已安装" : "技能市场"}</span>
      </header>
      {loading && <div className="rightEmpty">正在读取 SKILL.md...</div>}
      {!loading && content && (
        <div className="skillDetail">
          <section>
            <h3>元信息</h3>
            <MetadataTable metadata={omitMetadataFields(content.frontmatter, ["agent"])} />
          </section>
          <section>
            <h3>Markdown</h3>
            <pre>{content.markdown || "无正文内容"}</pre>
          </section>
        </div>
      )}
      {!loading && !content && <div className="rightEmpty">暂无可展示内容。</div>}
    </>
  );
}

function MetadataTable({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata);
  if (entries.length === 0) {
    return <div className="metadataEmpty">无元信息</div>;
  }

  return (
    <div className="metadataTable" role="table" aria-label="Skill 元信息">
      <div className="metadataRow metadataHead" role="row">
        <span role="columnheader">字段</span>
        <span role="columnheader">内容</span>
      </div>
      {entries.map(([key, value]) => (
        <div className="metadataRow" role="row" key={key}>
          <strong role="cell">{key}</strong>
          <span role="cell">{formatMetadataValue(value)}</span>
        </div>
      ))}
    </div>
  );
}

function omitMetadataFields(metadata: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const hidden = new Set(fields);
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !hidden.has(key)));
}

function ArtifactFileStrip({
  files,
  activePath,
  loadingPath,
  onOpen
}: {
  files: ArtifactFileCard[];
  activePath?: string;
  loadingPath?: string;
  onOpen: (file: ArtifactFileCard) => void;
}) {
  return (
    <section className="artifactStrip" aria-label="会话文件产物">
      <div className="artifactStripTitle">内容产物</div>
      <div className="artifactCards">
        {files.map((file) => (
          <button
            key={file.path}
            className={`artifactCard ${file.path === activePath ? "active" : ""}`}
            onClick={() => onOpen(file)}
            title={file.path}
          >
            {file.kind === "markdown" ? <FileText size={18} /> : <Code2 size={18} />}
            <span>{file.name}</span>
            <small>{loadingPath === file.path ? "读取中" : file.kind === "markdown" ? "Markdown" : "HTML"}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function ArtifactPreviewPanel({
  preview,
  mode,
  error,
  loading,
  onModeChange
}: {
  preview: ArtifactFilePreview;
  mode: PreviewMode;
  error: string;
  loading: boolean;
  onModeChange: (mode: PreviewMode) => void;
}) {
  const renderedMarkdown = useMemo(() => renderMarkdown(preview.content), [preview.content]);
  return (
    <section className="artifactPreviewPanel">
      <header>
        <div>
          <strong>{preview.name}</strong>
          <span>{preview.path}</span>
        </div>
        <div className="artifactPreviewActions">
          <button
            className="iconButton"
            onClick={() => onModeChange(mode === "rendered" ? "source" : "rendered")}
            title={mode === "rendered" ? "查看源码" : "查看预览"}
            aria-label={mode === "rendered" ? "查看源码" : "查看预览"}
          >
            {mode === "rendered" ? <Code2 size={18} /> : <Eye size={18} />}
          </button>
        </div>
      </header>
      {loading && <div className="rightEmpty">正在读取文件...</div>}
      {!loading && error && <div className="artifactError">{error}</div>}
      {!loading && !error && mode === "source" && <pre className="artifactSource">{preview.content}</pre>}
      {!loading && !error && mode === "rendered" && preview.kind === "markdown" && (
        <article className="markdownPreview" dangerouslySetInnerHTML={{ __html: renderedMarkdown }} />
      )}
      {!loading && !error && mode === "rendered" && preview.kind === "html" && (
        <iframe className="htmlPreview" title={preview.name} sandbox="" srcDoc={preview.content} />
      )}
    </section>
  );
}

function MessageView({
  message,
  artifactGroups,
  activeArtifactPath,
  loadingArtifactPath,
  onOpenArtifact,
  onRevokeSupplement
}: {
  message: ChatMessage;
  artifactGroups?: Map<string, ArtifactFileCard[]>;
  activeArtifactPath?: string;
  loadingArtifactPath?: string;
  onOpenArtifact?: (file: ArtifactFileCard) => void;
  onRevokeSupplement?: (message: Extract<ChatMessage, { kind: "supplement" }>) => void;
}) {
  if (message.kind === "text" && message.role === "system") {
    return null;
  }

  if (message.kind === "supplement") {
    return (
      <article className="message user supplementMessage">
        <div className="messageRole">你</div>
        <div className="messageBubble">
          <div>{message.text}</div>
          <div className="supplementMeta">
            <span>待发送</span>
            {onRevokeSupplement && (
              <button type="button" onClick={() => onRevokeSupplement(message)}>
                <X size={13} />
                <span>撤销</span>
              </button>
            )}
          </div>
        </div>
      </article>
    );
  }

  if (message.kind === "toolGroup") {
    return (
      <AssistantTurnView
        message={{ kind: "assistantTurn", id: `assistant-${message.id}`, blocks: [{ kind: "toolGroup", id: message.id, tools: message.tools }] }}
        artifactGroups={artifactGroups}
        activeArtifactPath={activeArtifactPath}
        loadingArtifactPath={loadingArtifactPath}
        onOpenArtifact={onOpenArtifact}
      />
    );
  }

  if (message.kind === "assistantTurn") {
    return (
      <AssistantTurnView
        message={message}
        artifactGroups={artifactGroups}
        activeArtifactPath={activeArtifactPath}
        loadingArtifactPath={loadingArtifactPath}
        onOpenArtifact={onOpenArtifact}
      />
    );
  }

  return (
    <>
      <article className={`message ${message.role}`}>
        <div className="messageRole">{message.role === "user" ? "你" : message.role === "system" ? "系统" : "小G"}</div>
        <div className="messageBubble">
          {message.role === "assistant" ? <AssistantMarkdown text={message.text} /> : message.text}
        </div>
      </article>
      <ArtifactGroupSlot
        files={artifactGroups?.get(message.id)}
        activePath={activeArtifactPath}
        loadingPath={loadingArtifactPath}
        onOpen={onOpenArtifact}
      />
    </>
  );
}

function AssistantTurnView({
  message,
  artifactGroups,
  activeArtifactPath,
  loadingArtifactPath,
  onOpenArtifact
}: {
  message: Extract<ChatMessage, { kind: "assistantTurn" }>;
  artifactGroups?: Map<string, ArtifactFileCard[]>;
  activeArtifactPath?: string;
  loadingArtifactPath?: string;
  onOpenArtifact?: (file: ArtifactFileCard) => void;
}) {
  return (
    <article className="message assistant assistantTurn">
      <div className="messageRole">小G</div>
      <div className="assistantBlocks">
        {message.blocks.map((block) => {
          const blockView = block.kind === "toolGroup"
            ? <ToolGroupView tools={block.tools} />
            : block.kind === "thinking"
              ? <ThinkingView text={block.text} mock={block.mock} />
              : (
                <div className="messageBubble">
                  <AssistantMarkdown text={block.text} />
                </div>
              );
          return (
            <div key={block.id} className="assistantBlock">
              {blockView}
              <ArtifactGroupSlot
                files={artifactGroups?.get(block.id)}
                activePath={activeArtifactPath}
                loadingPath={loadingArtifactPath}
                onOpen={onOpenArtifact}
              />
            </div>
          );
        })}
      </div>
    </article>
  );
}

function ArtifactGroupSlot({
  files,
  activePath,
  loadingPath,
  onOpen
}: {
  files?: ArtifactFileCard[];
  activePath?: string;
  loadingPath?: string;
  onOpen?: (file: ArtifactFileCard) => void;
}) {
  if (!files || files.length === 0 || !onOpen) return null;
  return (
    <ArtifactFileStrip
      files={files}
      activePath={activePath}
      loadingPath={loadingPath}
      onOpen={onOpen}
    />
  );
}

function PermissionRequestCard({
  request,
  draft,
  submitting,
  onDraftChange,
  onRespond
}: {
  request: AgentPermissionRequest;
  draft: PermissionDraft;
  submitting: boolean;
  onDraftChange: (draft: PermissionDraft) => void;
  onRespond: (mode: NonNullable<AgentPermissionResponse["mode"]>) => void;
}) {
  const isQuestion = request.toolName === "AskUserQuestion";
  const questions = isQuestion ? getAskUserQuestions(request.input) : [];
  const rememberSuggestions = getRememberPermissionSuggestions(request.suggestions);
  const canRemember = !isQuestion && rememberSuggestions.length > 0;
  const needsMessage = draft.mode === "deny" || draft.mode === "suggest_alternative";
  const messageLabel = draft.mode === "suggest_alternative" ? "替代方案" : "拒绝原因";
  const messagePlaceholder = draft.mode === "suggest_alternative" ? "说明你希望小G改用什么做法" : "说明为什么拒绝本次操作";
  const messageEmpty = needsMessage && draft.message.trim().length === 0;
  return (
    <article className="permissionCard">
      <header>
        <div className="permissionIcon">
          {isQuestion ? <HelpIcon /> : <ShieldAlert size={17} />}
        </div>
        <div>
          <strong>{isQuestion ? "需要你确认" : request.title || request.displayName || "工具权限请求"}</strong>
          <span>{isQuestion ? "小G需要更多信息才能继续" : request.description || request.decisionReason || request.toolName}</span>
        </div>
      </header>

      {isQuestion ? (
        <div className="questionList">
          {questions.map((question) => (
            <section key={question.question} className="questionBlock">
              <div className="questionHead">
                <span>{question.header}</span>
                <strong>{question.question}</strong>
              </div>
              <div className="questionOptions">
                {question.options.map((option) => {
                  const selected = isQuestionOptionSelected(draft.answers[question.question], option.label);
                  return (
                    <button
                      key={option.label}
                      className={selected ? "selected" : ""}
                      type="button"
                      onClick={() => onDraftChange(updateQuestionAnswer(draft, question, option.label))}
                    >
                      <Check size={15} />
                      <span>{option.label}</span>
                      <small>{option.description}</small>
                      {option.preview ? <MarkdownPreview text={option.preview} /> : null}
                    </button>
                  );
                })}
              </div>
              <input
                className="questionOtherInput"
                value={draft.freeform[question.question] ?? ""}
                onChange={(event) => onDraftChange({
                  ...draft,
                  freeform: { ...draft.freeform, [question.question]: event.target.value }
                })}
                placeholder="其他答案"
              />
            </section>
          ))}
          <textarea
            className="permissionResponseInput"
            value={draft.response}
            onChange={(event) => onDraftChange({ ...draft, response: event.target.value })}
            placeholder="或者直接输入一段回复"
            rows={2}
          />
        </div>
      ) : (
        <div className="approvalBody">
          <div className="approvalMeta">
            <span>工具</span>
            <strong>{request.displayName || request.toolName}</strong>
          </div>
          {request.blockedPath ? (
            <div className="approvalMeta">
              <span>路径</span>
              <strong>{request.blockedPath}</strong>
            </div>
          ) : null}
          <ToolField label="调用参数" value={request.input} empty="无参数" />
          {needsMessage ? (
            <label className="permissionMessageField">
              <span>{messageLabel}</span>
              <textarea
                className="permissionResponseInput"
                value={draft.message}
                onChange={(event) => onDraftChange({ ...draft, message: event.target.value })}
                placeholder={messagePlaceholder}
                rows={3}
                autoFocus
              />
            </label>
          ) : null}
        </div>
      )}

      <footer>
        {isQuestion ? (
          <>
            <button className="secondaryButton" type="button" onClick={() => onRespond("deny")} disabled={submitting}>
              取消
            </button>
            <button className="primaryButton" type="button" onClick={() => onRespond("allow")} disabled={submitting}>
              提交答案
            </button>
          </>
        ) : needsMessage ? (
          <>
            <button className="secondaryButton" type="button" onClick={() => onDraftChange({ ...draft, mode: undefined, message: "" })} disabled={submitting}>
              返回
            </button>
            <button className="primaryButton" type="button" onClick={() => onRespond(draft.mode === "suggest_alternative" ? "suggest_alternative" : "deny")} disabled={submitting || messageEmpty}>
              提交
            </button>
          </>
        ) : (
          <>
            <button className="secondaryButton" type="button" onClick={() => onDraftChange({ ...draft, mode: "deny", message: "" })} disabled={submitting}>
              拒绝
            </button>
            <button className="secondaryButton" type="button" onClick={() => onDraftChange({ ...draft, mode: "suggest_alternative", message: "" })} disabled={submitting}>
              <Lightbulb size={15} />
              建议替代方案
            </button>
            {canRemember ? (
              <button className="secondaryButton" type="button" onClick={() => onRespond("allow_remember")} disabled={submitting}>
                始终允许
              </button>
            ) : null}
            <button className="primaryButton" type="button" onClick={() => onRespond("allow")} disabled={submitting}>
              允许本次
            </button>
          </>
        )}
      </footer>
    </article>
  );
}

function MarkdownPreview({ text }: { text: string }) {
  const renderedMarkdown = useMemo(() => renderMarkdown(text), [text]);
  return <div className="questionOptionPreview" dangerouslySetInnerHTML={{ __html: renderedMarkdown }} />;
}

function HelpIcon() {
  return <Bot size={17} />;
}

function ToolGroupView({ tools }: { tools: StoredToolCall[] }) {
  const completed = tools.filter((tool) => tool.status !== "pending").length;
  return (
    <details className="toolGroup">
      <summary>
        <span>工具调用</span>
        <small>
          {completed}/{tools.length} 已完成
        </small>
        <ChevronRight size={15} />
      </summary>
      <div className="toolList">
        {tools.map((tool) => (
          <article key={tool.id} className="toolItem">
            <header>
              <strong>
                {tool.name}
                {tool.status !== "pending" && tool.durationMs !== undefined ? <span className="toolDuration"> · {formatToolDuration(tool.durationMs)}</span> : null}
              </strong>
              <span className={`toolStatus ${tool.status}`}>{formatToolStatus(tool.status)}</span>
            </header>
            <ToolField label="调用参数" value={tool.input} empty="无参数" />
            <ToolField label="调用结果" value={tool.result} empty={tool.status === "pending" ? "等待结果" : "无结果"} />
          </article>
        ))}
      </div>
    </details>
  );
}

function ThinkingView({ text, mock }: { text: string; mock?: boolean }) {
  if (mock) {
    return (
      <div className="mockThinkingLine">
        {text}
        <span className="thinkingDots" aria-hidden="true">
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      </div>
    );
  }

  return (
    <details className="thinkingGroup">
      <summary>
        <span>模型思考</span>
        <ChevronRight size={15} />
      </summary>
      <div className="thinkingText">{text}</div>
    </details>
  );
}

function AssistantMarkdown({ text }: { text: string }) {
  const renderedMarkdown = useMemo(() => renderMarkdown(text), [text]);
  return <div className="assistantMarkdown" dangerouslySetInnerHTML={{ __html: renderedMarkdown }} />;
}

function getEventSessionId(event: AgentEvent): number | undefined {
  if (event.sessionId !== undefined) return event.sessionId;
  return getSessionIdFromRequestId(event.requestId);
}

function getSessionIdFromRequestId(requestId: string): number | undefined {
  const parsed = Number(requestId.split(":")[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

type AskQuestion = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string; preview?: string }>;
};

function createPermissionDraft(request?: AgentPermissionRequest): PermissionDraft {
  const answers: PermissionDraft["answers"] = {};
  if (request?.toolName === "AskUserQuestion") {
    for (const question of getAskUserQuestions(request.input)) {
      answers[question.question] = question.multiSelect ? [] : question.options[0]?.label ?? "";
    }
  }
  return { answers, freeform: {}, response: "", mode: undefined, message: "" };
}

function getAskUserQuestions(input: Record<string, unknown>): AskQuestion[] {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  return rawQuestions.flatMap((item): AskQuestion[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const question = typeof raw.question === "string" ? raw.question : "";
    const header = typeof raw.header === "string" ? raw.header : "问题";
    const options = Array.isArray(raw.options) ? raw.options.flatMap((option): AskQuestion["options"] => {
      if (!option || typeof option !== "object") return [];
      const typed = option as Record<string, unknown>;
      const label = typeof typed.label === "string" ? typed.label : "";
      if (!label) return [];
      return [{
        label,
        description: typeof typed.description === "string" ? typed.description : "",
        preview: typeof typed.preview === "string" ? typed.preview : undefined
      }];
    }) : [];
    if (!question || options.length === 0) return [];
    return [{ question, header, options, multiSelect: raw.multiSelect === true }];
  });
}

function updateQuestionAnswer(draft: PermissionDraft, question: AskQuestion, label: string): PermissionDraft {
  const current = draft.answers[question.question];
  if (!question.multiSelect) {
    return { ...draft, answers: { ...draft.answers, [question.question]: label } };
  }
  const selected = Array.isArray(current) ? current : [];
  const next = selected.includes(label) ? selected.filter((item) => item !== label) : [...selected, label];
  return { ...draft, answers: { ...draft.answers, [question.question]: next } };
}

function isQuestionOptionSelected(value: string | string[] | undefined, label: string): boolean {
  return Array.isArray(value) ? value.includes(label) : value === label;
}

function getRememberPermissionSuggestions(suggestions: unknown): unknown[] {
  if (!Array.isArray(suggestions)) return [];
  return suggestions.filter((suggestion) => {
    if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) return false;
    return (suggestion as { destination?: unknown }).destination === "localSettings";
  });
}

function buildPermissionResponse(request: AgentPermissionRequest, draft: PermissionDraft, mode: NonNullable<AgentPermissionResponse["mode"]>): AgentPermissionResponse | null {
  if (mode === "deny" || mode === "suggest_alternative") {
    const message = request.toolName === "AskUserQuestion" ? "用户取消了回答" : draft.message.trim();
    if (!message) return null;
    return { rpcId: request.rpcId, ok: true, action: "deny", mode, message };
  }
  if (request.toolName !== "AskUserQuestion") {
    return {
      rpcId: request.rpcId,
      ok: true,
      action: "allow",
      mode,
      updatedInput: request.input,
      updatedPermissions: mode === "allow_remember" ? getRememberPermissionSuggestions(request.suggestions) : undefined
    };
  }

  const response = draft.response.trim();
  if (response) {
    return {
      rpcId: request.rpcId,
      ok: true,
      action: "allow",
      mode: "allow",
      updatedInput: {
        ...request.input,
        questions: request.input.questions,
        response
      }
    };
  }

  const answers: Record<string, string | string[]> = {};
  for (const question of getAskUserQuestions(request.input)) {
    const freeform = (draft.freeform[question.question] ?? "").trim();
    const selected = draft.answers[question.question];
    answers[question.question] = freeform || selected || "";
  }
  return {
    rpcId: request.rpcId,
    ok: true,
    action: "allow",
    mode: "allow",
    updatedInput: {
      ...request.input,
      questions: request.input.questions,
      answers
    }
  };
}

function ToolField({ label, value, empty }: { label: string; value: unknown; empty: string }) {
  return (
    <div className="toolField">
      <span>{label}</span>
      <pre>{value === undefined || value === null || value === "" ? empty : formatToolValue(value)}</pre>
    </div>
  );
}

function appendMockThinking(messages: ChatMessage[], activeRequestId: string | undefined, mockThinking: { requestId: string; text: string } | null): ChatMessage[] {
  if (!activeRequestId || !mockThinking || mockThinking.requestId !== activeRequestId) return messages;
  return [
    ...messages,
    {
      kind: "assistantTurn",
      id: `mock-thinking-${activeRequestId}`,
      blocks: [{ kind: "thinking", id: `mock-thinking-block-${activeRequestId}`, text: mockThinking.text, mock: true }]
    }
  ];
}

function pickMockThinkingPrompt(previous?: string): string {
  const choices = previous ? mockThinkingPrompts.filter((prompt) => prompt !== previous) : mockThinkingPrompts;
  return choices[Math.floor(Math.random() * choices.length)] ?? mockThinkingPrompts[0];
}

function appendMessage(messages: ChatMessage[], message: StoredTextMessage): ChatMessage[] {
  if (message.role === "assistant") {
    return appendAssistantText(messages, { kind: "text", id: message.id, text: message.text }, true);
  }
  return [...messages, message];
}

function appendSupplement(messages: ChatMessage[], item: AgentSupplementQueueItem): ChatMessage[] {
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

function removeSupplements(messages: ChatMessage[], itemIds: string[]): ChatMessage[] {
  const ids = new Set(itemIds);
  return messages.filter((message) => message.kind !== "supplement" || !ids.has(message.id));
}

function consumeSupplement(messages: ChatMessage[], item: AgentSupplementQueueItem): ChatMessage[] {
  const replacement: StoredTextMessage = {
    kind: "text",
    id: `supplement:${item.id}`,
    role: "user",
    text: item.text
  };
  return appendMessage(removeSupplements(messages, [item.id]), replacement);
}

function appendPartial(messages: ChatMessage[], text: string): ChatMessage[] {
  return appendAssistantText(messages, { id: `partial-${crypto.randomUUID()}`, kind: "text", text }, false);
}

function appendThinking(messages: ChatMessage[], text: string): ChatMessage[] {
  const { body, supplements } = detachTrailingSupplements(messages);
  const { next, turn } = ensureAssistantTurn(body);
  const thinkingIndex = findLastBlockIndex(turn.blocks, (block) => block.kind === "thinking");
  if (thinkingIndex >= 0) {
    const block = turn.blocks[thinkingIndex];
    if (block?.kind === "thinking") {
      return [...replaceAssistantTurn(next, { ...turn, blocks: replaceBlockAt(turn.blocks, thinkingIndex, { ...block, text: block.text + text }) }), ...supplements];
    }
  }
  const textIndex = turn.blocks.findIndex((block) => block.kind === "text");
  const block = { kind: "thinking" as const, id: `thinking-${crypto.randomUUID()}`, text };
  const blocks = textIndex >= 0 ? [...turn.blocks.slice(0, textIndex), block, ...turn.blocks.slice(textIndex)] : [...turn.blocks, block];
  return [...replaceAssistantTurn(next, { ...turn, blocks }), ...supplements];
}

function appendAssistantText(messages: ChatMessage[], block: { kind: "text"; id: string; text: string }, finalMessage: boolean): ChatMessage[] {
  const { body, supplements } = detachTrailingSupplements(messages);
  const { next, turn } = ensureAssistantTurn(body);
  const partialIndex = findLastBlockIndex(turn.blocks, (item) => item.kind === "text" && item.id.startsWith("partial-"));
  const partialBlock = partialIndex >= 0 ? turn.blocks[partialIndex] : undefined;
  if (partialBlock?.kind === "text") {
    const text = finalMessage
      ? block.text.includes(partialBlock.text) || partialBlock.text.includes(block.text)
        ? block.text.length >= partialBlock.text.length ? block.text : partialBlock.text
        : block.text
      : partialBlock.text + block.text;
    const id = finalMessage ? block.id : partialBlock.id;
    return [...replaceAssistantTurn(next, { ...turn, blocks: replaceBlockAt(turn.blocks, partialIndex, { ...partialBlock, id, text }) }), ...supplements];
  }
  return [...replaceAssistantTurn(next, { ...turn, blocks: [...turn.blocks, block] }), ...supplements];
}

function detachTrailingSupplements(messages: ChatMessage[]): { body: ChatMessage[]; supplements: Extract<ChatMessage, { kind: "supplement" }>[] } {
  let index = messages.length;
  while (index > 0 && messages[index - 1]?.kind === "supplement") index -= 1;
  return {
    body: messages.slice(0, index),
    supplements: messages.slice(index) as Extract<ChatMessage, { kind: "supplement" }>[]
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

function appendToolEvent(messages: ChatMessage[], event: Extract<AgentEvent, { type: "tool" }>): ChatMessage[] {
  const existing = findTool(messages, event.toolUseId);
  if (existing) {
    return messages.map((message) => {
      if (message.kind === "assistantTurn") {
        return {
          ...message,
          blocks: message.blocks.map((block) => {
            if (block.kind !== "toolGroup") return block;
            return {
              ...block,
              tools: block.tools.map((tool) => (tool.toolUseId === event.toolUseId ? mergeTool(tool, event) : tool))
            };
          })
        };
      }
      if (message.kind !== "toolGroup") return message;
      return {
        ...message,
        tools: message.tools.map((tool) => (tool.toolUseId === event.toolUseId ? mergeTool(tool, event) : tool))
      };
    });
  }

  const tool: StoredToolCall = {
    id: `${event.toolUseId}:${crypto.randomUUID()}`,
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
  const { body, supplements } = detachTrailingSupplements(messages);
  const { next, turn } = ensureAssistantTurn(body);
  const lastBlock = turn.blocks.at(-1);
  if (lastBlock?.kind === "toolGroup") {
    return [...replaceAssistantTurn(next, { ...turn, blocks: [...turn.blocks.slice(0, -1), { ...lastBlock, tools: [...lastBlock.tools, timedTool] }] }), ...supplements];
  }
  return [...replaceAssistantTurn(next, { ...turn, blocks: [...turn.blocks, { kind: "toolGroup", id: `tools-${crypto.randomUUID()}`, tools: [timedTool] }] }), ...supplements];
}

function ensureAssistantTurn(messages: ChatMessage[]): { next: ChatMessage[]; turn: Extract<ChatMessage, { kind: "assistantTurn" }> } {
  const last = messages.at(-1);
  if (last?.kind === "assistantTurn") return { next: messages, turn: last };
  if (last?.kind === "text" && last.role === "assistant") {
    const turn: Extract<ChatMessage, { kind: "assistantTurn" }> = {
      kind: "assistantTurn",
      id: `assistant-${last.id}`,
      blocks: [{ kind: "text", id: last.id, text: last.text }]
    };
    return { next: [...messages.slice(0, -1), turn], turn };
  }
  if (last?.kind === "toolGroup") {
    const turn: Extract<ChatMessage, { kind: "assistantTurn" }> = {
      kind: "assistantTurn",
      id: `assistant-${last.id}`,
      blocks: [{ kind: "toolGroup", id: last.id, tools: last.tools }]
    };
    return { next: [...messages.slice(0, -1), turn], turn };
  }
  const turn: Extract<ChatMessage, { kind: "assistantTurn" }> = {
    kind: "assistantTurn",
    id: `assistant-${crypto.randomUUID()}`,
    blocks: []
  };
  return { next: [...messages, turn], turn };
}

function replaceAssistantTurn(messages: ChatMessage[], turn: Extract<ChatMessage, { kind: "assistantTurn" }>): ChatMessage[] {
  return [...messages.slice(0, -1), turn];
}

function findTool(messages: ChatMessage[], toolUseId: string): StoredToolCall | undefined {
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

function mergeTool(tool: StoredToolCall, event: Extract<AgentEvent, { type: "tool" }>): StoredToolCall {
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

function formatToolDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60000) return `${(durationMs / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatToolStatus(status: StoredToolCall["status"]): string {
  if (status === "completed") return "完成";
  if (status === "failed") return "失败";
  return "运行中";
}

function buildArtifactGroups(messages: ChatMessage[]): Map<string, ArtifactFileCard[]> {
  const seen = new Set<string>();
  const groups = new Map<string, ArtifactFileCard[]>();
  for (const message of messages) {
    if (message.kind === "text" || message.kind === "supplement") continue;
    if (message.kind === "toolGroup") {
      addArtifactGroup(groups, seen, message.id, extractArtifactFileCardsFromToolGroup(message.tools));
      continue;
    }
    for (const block of message.blocks) {
      if (block.kind === "toolGroup") {
        addArtifactGroup(groups, seen, block.id, extractArtifactFileCardsFromToolGroup(block.tools));
      }
    }
  }
  return groups;
}

function addArtifactGroup(groups: Map<string, ArtifactFileCard[]>, seen: Set<string>, id: string, files: ArtifactFileCard[]): void {
  const unique = files.filter((file) => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
  if (unique.length > 0) groups.set(id, unique);
}

function extractArtifactFileCardsFromToolGroup(tools: StoredToolCall[]): ArtifactFileCard[] {
  const files = new Map<string, ArtifactFileCard>();
  for (const tool of tools) {
    const candidate = getFrontendWriteToolPath(tool);
    if (!candidate) continue;
    const kind = getArtifactKind(candidate);
    if (!kind) continue;
    if (!files.has(candidate)) files.set(candidate, { path: candidate, name: getPathBaseName(candidate), kind });
  }
  return Array.from(files.values());
}

function getFrontendWriteToolPath(tool: StoredToolCall): string | null {
  if (!isFrontendWriteTool(tool.name)) return null;
  if (!tool.input || typeof tool.input !== "object" || Array.isArray(tool.input)) return null;
  const input = tool.input as Record<string, unknown>;
  const filePath = input.file_path ?? input.filePath;
  return typeof filePath === "string" && filePath.trim() ? filePath.trim() : null;
}

function isFrontendWriteTool(name: string): boolean {
  return ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name);
}

function getArtifactKind(filePath: string): ArtifactFileKind | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  return null;
}

function getPathBaseName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath;
}

function renderMarkdown(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const html: string[] = [];
  let listOpen = false;
  let orderedListOpen = false;
  let codeFenceOpen = false;
  let codeFenceContent: string[] = [];
  const closeLists = () => {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
    if (orderedListOpen) {
      html.push("</ol>");
      orderedListOpen = false;
    }
  };
  const closeCodeFence = () => {
    html.push(`<pre><code>${escapeHtml(codeFenceContent.join("\n"))}</code></pre>`);
    codeFenceContent = [];
    codeFenceOpen = false;
  };
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (codeFenceOpen) {
        closeCodeFence();
      } else {
        closeLists();
        codeFenceContent = [];
        codeFenceOpen = true;
      }
      continue;
    }
    if (codeFenceOpen) {
      codeFenceContent.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      closeLists();
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeLists();
      html.push(`<h${heading[1].length}>${renderInlineMarkdown(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (orderedListOpen) {
        html.push("</ol>");
        orderedListOpen = false;
      }
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${renderInlineMarkdown(bullet[1])}</li>`);
      continue;
    }
    const numbered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (numbered) {
      if (listOpen) {
        html.push("</ul>");
        listOpen = false;
      }
      if (!orderedListOpen) {
        html.push("<ol>");
        orderedListOpen = true;
      }
      html.push(`<li>${renderInlineMarkdown(numbered[1])}</li>`);
      continue;
    }
    closeLists();
    html.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
  }
  if (codeFenceOpen) closeCodeFence();
  closeLists();
  return html.join("");
}

function renderInlineMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/\[([^\]]+)]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
      const safeHref = sanitizeMarkdownHref(href);
      return safeHref ? `<a href="${safeHref}" target="_blank" rel="noreferrer">${label}</a>` : label;
    })
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

function sanitizeMarkdownHref(href: string): string {
  const normalized = href.trim();
  if (/^(https?:|mailto:)/i.test(normalized) || normalized.startsWith("#")) return escapeHtml(normalized);
  return "";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatMetadataValue(value: unknown): string {
  if (value === null || value === undefined) return "空";
  if (typeof value === "string") return value.trim() || "空";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length > 0 ? value.map((item) => formatMetadataValue(item)).join("，") : "空";
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "空";
    return entries.map(([key, item]) => `${key}: ${formatMetadataValue(item)}`).join("\n");
  }
  return String(value);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const automationPresets = [
  {
    name: "内容日更",
    description: "请根据当前项目资料，生成今天适合发布的内容选题、正文草稿和下一步行动建议。",
    icon: Bell
  },
  {
    name: "竞品号监控",
    description: "请检查并总结竞品账号近期内容变化，提炼值得关注的主题、表达方式和可借鉴方向。",
    icon: CalendarClock
  },
  {
    name: "数据监控",
    description: "请分析项目目录中的最新数据或记录，输出关键变化、异常项和建议动作。",
    icon: BarChart3
  }
];

function createAutomationDraft(workspacePath = "~/.agentstudio/workspace", preset?: { name: string; description: string }): AutomationTaskInput {
  return {
    name: preset?.name ?? "",
    description: preset?.description ?? "",
    workspacePath,
    scheduleType: "daily",
    scheduleConfig: defaultScheduleConfig("daily"),
    maxRetries: 0,
    maxRuns: null,
    connectorBindings: {},
    selectedSkills: [],
    attachments: [],
    enabled: true
  };
}

function taskToInput(task: AutomationTask): AutomationTaskInput {
  return {
    name: task.name,
    description: task.description,
    workspacePath: task.workspacePath,
    scheduleType: task.scheduleType,
    scheduleConfig: task.scheduleConfig,
    maxRetries: task.maxRetries,
    maxRuns: task.maxRuns,
    connectorBindings: task.connectorBindings,
    selectedSkills: task.selectedSkills,
    attachments: task.attachments,
    enabled: task.enabled
  };
}

function defaultScheduleConfig(type: AutomationScheduleType): AutomationScheduleConfig {
  if (type === "once") return { runAt: new Date(Date.now() + 60 * 60_000).toISOString() };
  if (type === "interval") return { intervalValue: 1, intervalUnit: "minute" };
  if (type === "hourly") return { minute: 0 };
  if (type === "weekly") return { weekdays: [1], hour: 9, minute: 0 };
  if (type === "monthly") return { monthDays: [1], hour: 9, minute: 0 };
  return { hour: 9, minute: 0 };
}

function toDateTimeLocal(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function fromDateTimeLocal(value: string): string {
  return value ? new Date(value).toISOString() : "";
}

function mergeAttachments(current: LocalAttachment[], next: LocalAttachment[]): LocalAttachment[] {
  const byPath = new Map(current.map((file) => [file.path, file]));
  for (const file of next) byPath.set(file.path, file);
  return Array.from(byPath.values());
}

function getPathBasename(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? value;
}

function getConnectorAccountLabel(account: ConnectorAccount): string {
  return account.displayName || account.accountHandle || account.accountId || getConnectorAccountProfileLabel(account);
}

function getConnectorPlatformLabel(platform: ConnectorSettingsTab | ConnectorAccount["platform"]): string {
  if (platform === "wechat") return "公众号";
  if (platform === "douyin") return "抖音";
  return "小红书";
}

function getConnectorAccountProfileLabel(account: ConnectorAccount): string {
  if (account.platform !== "xhs" || !account.profileKey.startsWith("xhs_")) return account.profileKey;
  return `xhs_${account.profileKey.slice(4, 8)}`;
}

function sortConnectorAccountsByCreatedAt(accounts: ConnectorAccount[]): ConnectorAccount[] {
  return [...accounts].sort((left, right) => {
    const createdOrder = right.createdAt.localeCompare(left.createdAt);
    return createdOrder || right.id - left.id;
  });
}

function getConnectorOpsState(account: ConnectorAccount) {
  return {
    autoReviewEnabled: account.autoReviewEnabled === true,
    reviewTaskId: account.opsState?.reviewTaskId ?? null
  };
}

function getConnectorAccountStatusLabel(account: ConnectorAccount): string {
  if (account.status === "authorized") return account.accountHandle ? `已授权 · ${account.accountHandle}` : "已授权";
  if (account.status === "authorizing") return "授权中，点击继续";
  if (account.status === "needs_refresh") return "需要重新授权";
  if (account.status === "error") return "授权异常，点击重试";
  return "未授权，点击登录";
}

function getConnectorAccountLoginStatusLabel(account: ConnectorAccount): string {
  if (account.status === "authorized") return "已授权";
  if (account.status === "authorizing") return "授权中";
  if (account.status === "needs_refresh") return "需要重新授权";
  if (account.status === "error") return "授权异常";
  return "未授权";
}

function getConnectorAccountStatusTone(account: ConnectorAccount): string {
  if (account.status === "authorized") return "authorized";
  if (account.status === "authorizing") return "authorizing";
  if (account.status === "needs_refresh" || account.status === "error") return "invalid";
  return "unauthorized";
}

function getSelectedConnectorTitle(xhs: ConnectorAccount | null, wechat: ConnectorAccount | null): string {
  if (xhs && wechat) return `连接器：小红书 · ${getConnectorAccountLabel(xhs)}；公众号 · ${getConnectorAccountLabel(wechat)}`;
  if (xhs) return `连接器：${getConnectorAccountLabel(xhs)}`;
  if (wechat) return `连接器：${getConnectorAccountLabel(wechat)}`;
  return "连接器";
}

function automationConnectorBinding(account: ConnectorAccount) {
  return {
    profileKey: account.profileKey,
    accountId: account.accountId,
    displayName: account.displayName
  };
}

function getComposerPopoverRef(popover: ComposerPopover, refs: Record<ComposerPopover, HTMLElement | null>): HTMLElement | null {
  return refs[popover];
}

function pickRandomPrompts(prompts: string[], count: number): string[] {
  const unique = Array.from(new Set(prompts.filter((prompt) => prompt.trim().length > 0)));
  for (let index = unique.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [unique[index], unique[swapIndex]] = [unique[swapIndex], unique[index]];
  }
  return unique.slice(0, count);
}

function splitModelTags(value: string): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of value.split(",")) {
    const model = item.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}

function resolveSelectedProviderId(settings: ModelProviderSettings, config?: AgentStudioConfig): string {
  if (config?.provider.id && settings.providers.some((provider) => provider.id === config.provider.id)) return config.provider.id;
  const matchingConfig = settings.providers.find((provider) => (
    provider.baseUrl === config?.provider.baseUrl &&
    provider.apiKey === config?.provider.apiKey &&
    splitModelTags(provider.model).includes(config?.provider.model ?? "")
  ));
  return matchingConfig?.id ?? settings.providers[0]?.id ?? "";
}

function resolveActiveModelProvider(settings: ModelProviderSettings, config?: AgentStudioConfig): ModelProviderDefinition | null {
  if (!config) return settings.providers[0] ?? null;
  const byId = settings.providers.find((provider) => provider.id === config.provider.id);
  if (byId) return byId;
  return settings.providers.find((provider) => (
    provider.baseUrl === config.provider.baseUrl &&
    provider.apiKey === config.provider.apiKey &&
    splitModelTags(provider.model).includes(config.provider.model)
  )) ?? null;
}

function resolveSelectedImageProviderId(settings: ImageProviderSettings, config?: AgentStudioConfig): string {
  if (config?.imageProvider.id && settings.imageProviders.some((provider) => provider.id === config.imageProvider.id)) return config.imageProvider.id;
  const matchingConfig = settings.imageProviders.find((provider) => (
    provider.providerType === config?.imageProvider.providerType &&
    provider.baseUrl === config?.imageProvider.baseUrl &&
    provider.apiKey === config?.imageProvider.apiKey &&
    provider.model === config?.imageProvider.model
  ));
  return matchingConfig?.id ?? settings.imageProviders[0]?.id ?? "";
}

function formatSkillErrors(installed: { errors: string[]; conflicts: string[] }, market: { errors: string[] }): string {
  return [...installed.errors, ...installed.conflicts.map((name) => `Skill 冲突：${name}`), ...market.errors].join("\n");
}

function getConstrainedRightPanelWidth(width: number, collapsed: boolean): number {
  const sidebarWidth = collapsed ? 86 : 292;
  const shellGapsAndMargins = 28;
  const viewportMax = Math.floor(window.innerWidth * maxRightPanelViewportRatio);
  const workspaceMax = window.innerWidth - sidebarWidth - minWorkspaceWidth - shellGapsAndMargins;
  const maxWidth = Math.max(minRightPanelWidth, Math.min(viewportMax, workspaceMax));
  return Math.min(maxWidth, Math.max(minRightPanelWidth, Math.round(width)));
}

function isInteractiveWorkspaceTarget(target: Element): boolean {
  return Boolean(
    target.closest(
      [
        "a",
        "button",
        "input",
        "textarea",
        "select",
        "label",
        "summary",
        "[contenteditable='true']",
        "[role='button']",
        "[role='switch']",
        "[role='tab']",
        "[role='menuitem']",
        "[role='dialog']",
        ".composer",
        ".composerMenu",
        ".permissionMenu",
        ".workspaceMenu",
        ".modalBackdrop",
        ".installModal",
        ".automationModal",
        ".confirmDialog"
      ].join(", ")
    )
  );
}
