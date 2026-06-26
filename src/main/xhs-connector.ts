import { BrowserWindow, safeStorage, session as electronSession, type Cookie, type CookiesSetDetails, type Session, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync, type ChildProcess } from "node:child_process";
import http from "node:http";
import { logEvent } from "../shared/log";
import type { ConnectorAccount, RuntimePaths, XhsConnectorCommandResult, XhsConnectorContext, XhsConnectorStatus, XhsLoginResult } from "../shared/types";
import {
  browserFingerprintPolicyVersion,
  configureBrowserSessionFingerprint
} from "./browser-fingerprint";

const bootstrapTitle = "GrowthForce XHS Connector";
const idleTimeoutMs = 2 * 60 * 60 * 1000;
const idleDisposeGraceMs = 60 * 1000;
const idleDisposeThresholdMs = idleTimeoutMs - idleDisposeGraceMs;
const xhsProcessTimeoutGraceMs = 60_000;
const checkSessionBusinessTimeoutMs = 120_000;
const checkSessionProcessTimeoutMs = checkSessionBusinessTimeoutMs + xhsProcessTimeoutGraceMs;
const loginUrl = "https://www.xiaohongshu.com/explore";
const authCookieSnapshotFileName = "auth-cookies.enc";
const authCookieSnapshotVersion = 1;
const loginWaitCancelledCode = "XHS_LOGIN_WAIT_CANCELLED";

interface CdpTarget {
  id?: string;
  title?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpTargetResolveContext {
  port: number;
  profileKey: string;
}

interface XhsRuntime {
  profileKey: string;
  profilePath: string;
  session: Session;
  netLogPath: string;
  diagnosticsPath: string;
  window: BrowserWindow;
  targetId: string;
  closingForDispose?: boolean;
  lockedBy?: string;
  idleTimer?: NodeJS.Timeout;
  lastReleaseTime?: number;
}

interface XhsLoginWindowState {
  profileKey?: string;
  visible: boolean;
}

interface XhsAuthCookieSnapshot {
  version: number;
  savedAt: string;
  cookies: XhsStoredCookie[];
}

interface XhsAuthCookieSnapshotFile {
  version: number;
  encryption: "electron-safe-storage";
  payload: string;
}

interface PendingLoginWait {
  child: ChildProcess;
  reject: (error: Error) => void;
}

interface XhsStoredCookie {
  domain?: string;
  expirationDate?: number;
  hostOnly?: boolean;
  httpOnly?: boolean;
  name: string;
  path?: string;
  sameSite?: Cookie["sameSite"];
  secure?: boolean;
  session?: boolean;
  value: string;
}

export class XhsLoginWaitCancelledError extends Error {
  readonly code = loginWaitCancelledCode;

  constructor(reason: string) {
    super(`小红书登录等待已取消：${reason}`);
    this.name = "XhsLoginWaitCancelledError";
  }
}

export function isXhsLoginWaitCancelledError(error: unknown): error is XhsLoginWaitCancelledError {
  return error instanceof XhsLoginWaitCancelledError || (typeof error === "object" && error !== null && (error as { code?: unknown }).code === loginWaitCancelledCode);
}

export class XhsConnectorRuntimeManager {
  private readonly runtimes = new Map<string, XhsRuntime>();
  private readonly pendingLoginWaits = new Map<string, PendingLoginWait>();
  private readonly netLogInstallations = new Set<string>();
  private loginWindowState: XhsLoginWindowState = { visible: false };
  private mainWindow: BrowserWindow | null = null;

  constructor(
    private readonly paths: RuntimePaths,
    private readonly cdpPort: number
  ) {}

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
    window.on("closed", () => {
      this.mainWindow = null;
      this.dispose();
    });
    for (const runtime of this.runtimes.values()) {
      if (!runtime.window.isDestroyed()) runtime.window.setParentWindow(window);
    }
  }

  getProfilePath(profileKey: string): string {
    return path.join(this.paths.userProfile, "connectors", "xhs", profileKey);
  }

  async ensureContext(account: ConnectorAccount, requestId: string): Promise<XhsConnectorContext> {
    if (account.platform !== "xhs") throw new Error("连接器账号平台不是小红书");
    if (account.status !== "authorized") throw new Error("请选择已授权的小红书账号");
    const runtime = await this.ensureRuntime(account.profileKey);
    if (runtime.lockedBy && runtime.lockedBy !== requestId) {
      throw new Error(`小红书账号 ${account.displayName ?? account.accountId ?? account.profileKey} 正在执行其他任务，请稍后再试`);
    }
    this.clearIdleTimer(runtime);
    runtime.lastReleaseTime = undefined;
    runtime.lockedBy = requestId;
    return {
      cliCommand: resolveXhsCliCommand(),
      cdpPort: this.cdpPort,
      targetId: runtime.targetId,
      profileKey: account.profileKey,
      processRegistryDir: this.getProcessRegistryDir(),
      netLogPath: runtime.netLogPath,
      diagnosticsPath: runtime.diagnosticsPath,
      accountId: account.accountId,
      accountHandle: account.accountHandle,
      displayName: account.displayName
    };
  }

  getProcessRegistryDir(): string {
    return path.join(this.paths.runtime, "xhs-cli-processes");
  }

  releaseRequest(requestId: string): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.lockedBy !== requestId) continue;
      runtime.lockedBy = undefined;
      runtime.lastReleaseTime = Date.now();
      logEvent("main.xhs.runtime:idleStart", {
        profileKey: runtime.profileKey,
        lastReleaseTime: runtime.lastReleaseTime,
        idleDisposeThresholdMs
      });
      this.markIdle(runtime);
    }
  }

  isLocked(profileKey: string): boolean {
    return Boolean(this.runtimes.get(profileKey)?.lockedBy);
  }

  getLockSnapshot(profileKeys: string[]): Record<string, boolean> {
    return Object.fromEntries(profileKeys.map((profileKey) => [profileKey, this.isLocked(profileKey)]));
  }

  async status(account?: ConnectorAccount | null): Promise<XhsConnectorStatus> {
    if (!account) {
      return {
        connected: false,
        loggedIn: false,
        profilePath: "",
        account: null,
        error: "未选择小红书账号"
      };
    }
    try {
      const result = await this.runCommand(account.profileKey, ["check-session"], { timeoutMs: checkSessionProcessTimeoutMs });
      const payload = result.payload && typeof result.payload === "object" ? result.payload as Record<string, unknown> : {};
      const runtime = await this.ensureRuntime(account.profileKey);
      return {
        connected: true,
        loggedIn: payload.logged_in === true,
        profilePath: runtime.profilePath,
        targetId: runtime.targetId,
        account,
        raw: result.payload
      };
    } catch (error) {
      return {
        connected: false,
        loggedIn: false,
        profilePath: this.getProfilePath(account.profileKey),
        account,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async startLogin(profileKey: string): Promise<XhsLoginResult> {
    const runtime = await this.ensureRuntime(profileKey);
    this.showLoginWindow(runtime);
    logEvent("main.xhs.runtime:loginNavigateStart", { profileKey, targetId: runtime.targetId, url: loginUrl });
    void runtime.window.loadURL(loginUrl)
      .then(() => {
        logEvent("main.xhs.runtime:loginNavigateSucceeded", {
          profileKey,
          targetId: runtime.targetId,
          url: loginUrl,
          currentUrl: runtime.window.isDestroyed() ? "" : runtime.window.webContents.getURL()
        });
      })
      .catch((error) => {
        logEvent("main.xhs.runtime:loginNavigateFailed", {
          profileKey,
          targetId: runtime.targetId,
          url: loginUrl,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    return {
      success: true,
      raw: { profileKey }
    };
  }

  async waitLogin(profileKey: string, timeout = 120): Promise<XhsLoginResult> {
    const result = await this.runCommand(profileKey, ["wait-login", "--timeout", String(timeout)], {
      timeoutMs: timeout * 1000 + xhsProcessTimeoutGraceMs,
      loginWaitProfileKey: profileKey
    });
    return {
      success: result.exitCode === 0,
      raw: result.payload
    };
  }

  cancelLoginWait(profileKey: string, reason = "cancelled"): boolean {
    const pending = this.pendingLoginWaits.get(profileKey);
    if (!pending) return false;
    this.pendingLoginWaits.delete(profileKey);
    logEvent("main.xhs.runtime:loginWaitCancelled", { profileKey, reason });
    pending.reject(new XhsLoginWaitCancelledError(reason));
    if (!pending.child.killed) pending.child.kill();
    return true;
  }

  cancelRequest(requestId: string): void {
    const registryDir = this.getProcessRegistryDir();
    if (!fs.existsSync(registryDir)) return;
    const entries = listXhsProcessRegistryEntries(registryDir, requestId);
    for (const entry of entries) {
      try {
        terminateProcessTree(entry.pid);
        fs.rmSync(entry.path, { force: true });
        logEvent("main.xhs.cli:cancelled", {
          requestId,
          pid: entry.pid,
          profileKey: entry.profileKey,
          targetId: entry.targetId
        });
      } catch (error) {
        fs.rmSync(entry.path, { force: true });
        logEvent("main.xhs.cli:cancelFailed", {
          requestId,
          pid: entry.pid,
          profileKey: entry.profileKey,
          targetId: entry.targetId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  async checkLogin(profileKey: string): Promise<boolean> {
    const result = await this.runCommand(profileKey, ["check-session"], { timeoutMs: checkSessionProcessTimeoutMs });
    const payload = result.payload && typeof result.payload === "object" ? result.payload as Record<string, unknown> : {};
    return result.exitCode === 0 && payload.logged_in === true;
  }

  async checkSession(profileKey: string, timeoutMs = checkSessionProcessTimeoutMs): Promise<XhsConnectorCommandResult> {
    return this.runCommand(profileKey, ["check-session"], { timeoutMs });
  }

  async getAccountInfo(profileKey: string): Promise<XhsConnectorCommandResult> {
    return this.runCommand(profileKey, ["account-info"]);
  }

  async saveAuthCookies(profileKey: string): Promise<void> {
    const runtime = await this.ensureRuntime(profileKey);
    const cookies = (await runtime.session.cookies.get({}))
      .filter((cookie) => isXhsCookie(cookie))
      .map(toStoredCookie);
    if (cookies.length === 0) {
      throw new Error("未读取到小红书登录 Cookie，请重新登录后再试");
    }
    if (!safeStorage.isEncryptionAvailable()) {
      logEvent("main.xhs.cookies:snapshotUnavailable", { profileKey, reason: "safeStorageUnavailable" });
      throw new Error("当前系统不可用安全存储，无法保存小红书登录 Cookie");
    }

    const snapshot: XhsAuthCookieSnapshot = {
      version: authCookieSnapshotVersion,
      savedAt: new Date().toISOString(),
      cookies
    };
    const encrypted = safeStorage.encryptString(JSON.stringify(snapshot));
    const file: XhsAuthCookieSnapshotFile = {
      version: authCookieSnapshotVersion,
      encryption: "electron-safe-storage",
      payload: encrypted.toString("base64")
    };
    const snapshotPath = this.getAuthCookieSnapshotPath(profileKey);
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify(file, null, 2), { mode: 0o600 });
    await runtime.session.cookies.flushStore();
    runtime.session.flushStorageData();
    logEvent("main.xhs.cookies:snapshotSaved", { profileKey, cookieCount: cookies.length });
  }

  async logout(profileKey: string): Promise<XhsConnectorCommandResult> {
    await this.clearAuth(profileKey, { showLoginWindow: false });
    return { exitCode: 0, payload: { success: true } };
  }

  async clearAuth(profileKey: string, options: { showLoginWindow?: boolean } = {}): Promise<XhsConnectorCommandResult> {
    const runtime = await this.ensureRuntime(profileKey);
    this.deleteAuthCookieSnapshot(profileKey);
    await runtime.session.clearStorageData({
      origin: "https://www.xiaohongshu.com",
      storages: ["cookies", "localstorage", "cachestorage", "indexdb", "serviceworkers"]
    });
    await runtime.session.clearStorageData({
      origin: "https://creator.xiaohongshu.com",
      storages: ["cookies", "localstorage", "cachestorage", "indexdb", "serviceworkers"]
    });
    await runtime.window.loadURL("https://www.xiaohongshu.com/explore");
    if (options.showLoginWindow) this.showLoginWindow(runtime);
    else this.updateSurface({ visible: false });
    return { exitCode: 0, payload: { success: true } };
  }

  updateSurface(surface: XhsLoginWindowState): void {
    this.loginWindowState = {
      profileKey: surface.profileKey,
      visible: surface.visible
    };
    logEvent("main.xhs.runtime:surfaceUpdate", surface);
    for (const runtime of this.runtimes.values()) {
      if (surface.visible && surface.profileKey === runtime.profileKey) this.showLoginWindow(runtime);
      else if (!runtime.window.isDestroyed()) {
        runtime.window.hide();
        logEvent("main.xhs.runtime:windowHidden", { profileKey: runtime.profileKey, targetId: runtime.targetId, reason: "surfaceUpdate" });
      }
    }
  }

  disposeRuntime(profileKey: string): void {
    const runtime = this.runtimes.get(profileKey);
    if (!runtime) return;
    this.clearIdleTimer(runtime);
    if (!runtime.window.isDestroyed()) {
      logEvent("main.xhs.runtime:windowCloseRequested", { profileKey, targetId: runtime.targetId, reason: "disposeRuntime" });
      runtime.closingForDispose = true;
      runtime.window.close();
    }
    this.runtimes.delete(profileKey);
    logEvent("main.xhs.runtime:dispose", { profileKey, targetId: runtime.targetId, profilePath: runtime.profilePath });
  }

  dispose(): void {
    this.pruneProcessRegistry();
    for (const profileKey of [...this.runtimes.keys()]) this.disposeRuntime(profileKey);
  }

  pruneProcessRegistry(): void {
    const registryDir = this.getProcessRegistryDir();
    if (!fs.existsSync(registryDir)) return;
    for (const entry of listXhsProcessRegistryEntries(registryDir)) {
      if (!isProcessAlive(entry.pid)) fs.rmSync(entry.path, { force: true });
    }
  }

  deleteProfile(profileKey: string): void {
    this.cancelLoginWait(profileKey, "deleteProfile");
    this.disposeRuntime(profileKey);
    const profilePath = this.getProfilePath(profileKey);
    if (fs.existsSync(profilePath)) fs.rmSync(profilePath, { recursive: true, force: true });
  }

  private async runCommand(profileKey: string, args: string[], options: { timeoutMs?: number; loginWaitProfileKey?: string } = {}): Promise<XhsConnectorCommandResult> {
    const runtime = await this.ensureRuntime(profileKey);
    const command = resolveXhsCliCommandParts();
    const cliArgs = [...command.args, ...args];
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (options.loginWaitProfileKey) this.cancelLoginWait(options.loginWaitProfileKey, "superseded");
    logEvent("main.xhs.cli:run", { profileKey, targetId: runtime.targetId, command: command.file, args, timeoutMs });
    const env = {
      ...process.env,
      AGENTSTUDIO_XHS_CDP_PORT: String(this.cdpPort),
      AGENTSTUDIO_XHS_TARGET_ID: runtime.targetId,
      AGENTSTUDIO_XHS_PROFILE_KEY: profileKey,
      AGENTSTUDIO_XHS_PROCESS_REGISTRY_DIR: this.getProcessRegistryDir(),
      AGENTSTUDIO_XHS_NETLOG_PATH: runtime.netLogPath,
      AGENTSTUDIO_XHS_DIAGNOSTICS_PATH: runtime.diagnosticsPath
    };
    return new Promise((resolve, reject) => {
      let cancelled = false;
      const child = execFile(command.file, cliArgs, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, env }, (error, stdout, stderr) => {
        if (options.loginWaitProfileKey && this.pendingLoginWaits.get(options.loginWaitProfileKey)?.child === child) {
          this.pendingLoginWaits.delete(options.loginWaitProfileKey);
        }
        if (cancelled) return;
        const payload = parseJsonOutput(stdout);
        const exitCode = typeof (error as { code?: unknown } | null)?.code === "number" ? (error as { code: number }).code : 0;
        if (error) {
          const message = readCliFailureMessage(payload) ?? (stderr.trim() || error.message);
          const diagnostics = this.createCliFailureDiagnostics(runtime, payload, stderr);
          logEvent("main.xhs.cli:failed", {
            profileKey,
            targetId: runtime.targetId,
            command: command.file,
            args,
            exitCode,
            error: message,
            payload: summarizeCliPayload(payload),
            stderr: summarizeText(stderr),
            ...diagnostics
          });
          reject(new Error(message));
          return;
        }
        logEvent("main.xhs.cli:success", {
          profileKey,
          targetId: runtime.targetId,
          command: command.file,
          args,
          exitCode,
          payload: summarizeCliPayload(payload),
          stderr: summarizeText(stderr)
        });
        resolve({
          exitCode,
          payload,
          stdout,
          stderr
        });
      });
      if (options.loginWaitProfileKey) {
        this.pendingLoginWaits.set(options.loginWaitProfileKey, {
          child,
          reject: (error) => {
            cancelled = true;
            reject(error);
          }
        });
      }
    });
  }

  private async ensureRuntime(profileKey: string): Promise<XhsRuntime> {
    const existing = this.runtimes.get(profileKey);
    if (existing && !existing.window.isDestroyed()) {
      this.clearIdleTimer(existing);
      existing.lastReleaseTime = undefined;
      logEvent("main.xhs.runtime:reuse", { profileKey, targetId: existing.targetId, profilePath: existing.profilePath });
      return existing;
    }

    const profilePath = this.getProfilePath(profileKey);
    fs.mkdirSync(profilePath, { recursive: true });
    logEvent("main.xhs.runtime:createStart", { profileKey, profilePath, cdpPort: this.cdpPort });
    const existingTargetIds = await fetchCdpTargetIds(this.cdpPort, { profileKey, reason: "beforeRuntimeCreate" }).catch((error) => {
      logEvent("main.xhs.cdp:existingTargetsFailed", {
        profileKey,
        cdpPort: this.cdpPort,
        error: error instanceof Error ? error.message : String(error)
      });
      return new Set<string>();
    });
    const session = electronSession.fromPath(profilePath, { cache: false });
    const fingerprintIdentity = configureBrowserSessionFingerprint(session);
    const netLogPath = this.getNetLogPath(profileKey);
    const diagnosticsPath = this.getDiagnosticsPath(profileKey);
    this.installNetLog(profileKey, session, netLogPath);
    await this.restoreAuthCookies(profileKey, session);
    const window = new BrowserWindow({
      width: 420,
      height: 720,
      minWidth: 360,
      minHeight: 560,
      show: false,
      title: "小红书登录",
      parent: this.mainWindow ?? undefined,
      webPreferences: {
        session,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    const contentViewId = window.webContents.id;
    logEvent("main.xhs.runtime:windowCreated", { profileKey, profilePath, contentViewId });
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    let runtime: XhsRuntime | undefined;
    window.on("close", (event) => {
      if (runtime?.closingForDispose) return;
      event.preventDefault();
      window.hide();
      this.loginWindowState = { profileKey, visible: false };
      logEvent("main.xhs.runtime:windowCloseIntercepted", { profileKey, profilePath, contentViewId, reason: "userClose" });
    });
    window.on("closed", () => {
      this.runtimes.delete(profileKey);
      logEvent("main.xhs.runtime:windowClosed", { profileKey, profilePath, contentViewId });
    });
    window.webContents.on("destroyed", () => {
      logEvent("main.xhs.runtime:webContentsDestroyed", { profileKey, profilePath, contentViewId });
    });

    const bootstrap = createBootstrapPage(profileKey);
    logEvent("main.xhs.runtime:bootstrapNavigateStart", { profileKey, contentViewId });
    await window.loadURL(bootstrap.url);
    logEvent("main.xhs.runtime:bootstrapNavigateSucceeded", { profileKey, contentViewId });
    const target = await resolveWebContentsTargetId(window.webContents, bootstrap, { port: this.cdpPort, profileKey })
      .then((targetId) => targetId ? { id: targetId, source: "webContentsDebugger" } : waitForCdpTarget(this.cdpPort, bootstrap, existingTargetIds, { port: this.cdpPort, profileKey }));
    runtime = {
      profileKey,
      profilePath,
      session,
      netLogPath,
      diagnosticsPath,
      window,
      targetId: target.id
    };
    this.runtimes.set(profileKey, runtime);
    logEvent("main.xhs.runtime:create", {
      profileKey,
      targetId: target.id,
      targetSource: target.source,
      profilePath,
      contentViewId,
      fingerprintPolicyVersion: browserFingerprintPolicyVersion,
      platform: fingerprintIdentity.userAgentMetadata.platform,
      chromiumMajor: fingerprintIdentity.userAgentMetadata.brands.find((brand) => brand.brand === "Chromium")?.version
    });
    return runtime;
  }

  private createCliFailureDiagnostics(runtime: XhsRuntime, payload: unknown, stderr: string): Record<string, unknown> {
    const message = readCliFailureMessage(payload) ?? stderr;
    if (!message.includes("CDP target")) return {};
    void fetchCdpTargets(this.cdpPort, { profileKey: runtime.profileKey, reason: "cliFailureDiagnostics" })
      .then((targets) => {
        logEvent("main.xhs.cdp:targetPresenceAfterCliFailure", {
          profileKey: runtime.profileKey,
          targetId: runtime.targetId,
          targetPresent: targets.some((target) => target.id === runtime.targetId),
          targets: summarizeCdpTargets(targets)
        });
      })
      .catch((error) => {
        logEvent("main.xhs.cdp:targetPresenceAfterCliFailureFailed", {
          profileKey: runtime.profileKey,
          targetId: runtime.targetId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    return { cdpTargetId: runtime.targetId };
  }

  private async restoreAuthCookies(profileKey: string, session: Session): Promise<void> {
    const snapshotPath = this.getAuthCookieSnapshotPath(profileKey);
    if (!fs.existsSync(snapshotPath)) return;
    if (!safeStorage.isEncryptionAvailable()) {
      logEvent("main.xhs.cookies:restoreSkipped", { profileKey, reason: "safeStorageUnavailable" });
      return;
    }

    let snapshot: XhsAuthCookieSnapshot;
    try {
      const file = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as Partial<XhsAuthCookieSnapshotFile>;
      if (file.version !== authCookieSnapshotVersion || file.encryption !== "electron-safe-storage" || typeof file.payload !== "string") {
        throw new Error("invalid cookie snapshot metadata");
      }
      snapshot = JSON.parse(safeStorage.decryptString(Buffer.from(file.payload, "base64"))) as XhsAuthCookieSnapshot;
      if (snapshot.version !== authCookieSnapshotVersion || !Array.isArray(snapshot.cookies)) {
        throw new Error("invalid cookie snapshot payload");
      }
    } catch (error) {
      logEvent("main.xhs.cookies:restoreFailed", {
        profileKey,
        reason: "decryptOrParseFailed",
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    let restoredCount = 0;
    let failedCount = 0;
    for (const cookie of snapshot.cookies) {
      const details = toCookieSetDetails(cookie);
      if (!details) {
        failedCount += 1;
        continue;
      }
      try {
        await session.cookies.set(details);
        restoredCount += 1;
      } catch {
        failedCount += 1;
      }
    }
    if (restoredCount > 0) await session.cookies.flushStore();
    session.flushStorageData();
    logEvent("main.xhs.cookies:restored", {
      profileKey,
      cookieCount: snapshot.cookies.length,
      restoredCount,
      failedCount
    });
  }

  private deleteAuthCookieSnapshot(profileKey: string): void {
    const snapshotPath = this.getAuthCookieSnapshotPath(profileKey);
    if (fs.existsSync(snapshotPath)) fs.rmSync(snapshotPath, { force: true });
  }

  private getAuthCookieSnapshotPath(profileKey: string): string {
    return path.join(this.getProfilePath(profileKey), authCookieSnapshotFileName);
  }

  private getNetLogPath(profileKey: string): string {
    return path.join(this.paths.runtime, "xhs-netlog", `${safeFileName(profileKey)}.json`);
  }

  private getDiagnosticsPath(profileKey: string): string {
    return path.join(this.paths.runtime, "xhs-netlog", `${safeFileName(profileKey)}-diagnostics.json`);
  }

  private installNetLog(profileKey: string, session: Session, netLogPath: string): void {
    if (this.netLogInstallations.has(profileKey)) return;
    this.netLogInstallations.add(profileKey);
    installXhsNetLog(profileKey, session, netLogPath);
  }

  private showLoginWindow(runtime: XhsRuntime): void {
    if (runtime.window.isDestroyed()) {
      logEvent("main.xhs.runtime:windowShowSkipped", { profileKey: runtime.profileKey, targetId: runtime.targetId, reason: "destroyed" });
      return;
    }
    runtime.window.setTitle("小红书登录");
    if (this.mainWindow && !this.mainWindow.isDestroyed()) runtime.window.setParentWindow(this.mainWindow);
    this.loginWindowState = { profileKey: runtime.profileKey, visible: true };
    if (runtime.window.isMinimized()) runtime.window.restore();
    runtime.window.show();
    runtime.window.focus();
    runtime.window.moveTop();
    logEvent("main.xhs.runtime:windowShown", { profileKey: runtime.profileKey, targetId: runtime.targetId });
  }

  private markIdle(runtime: XhsRuntime): void {
    this.clearIdleTimer(runtime);
    if (!runtime.lastReleaseTime) return;
    const elapsedMs = Date.now() - runtime.lastReleaseTime;
    const remainingMs = Math.max(idleDisposeThresholdMs - elapsedMs, 1_000);
    runtime.idleTimer = setTimeout(() => {
      this.maybeDisposeIdleRuntime(runtime);
    }, remainingMs);
  }

  private maybeDisposeIdleRuntime(runtime: XhsRuntime): void {
    runtime.idleTimer = undefined;
    if (runtime.lockedBy) return;
    if (!runtime.lastReleaseTime) return;
    const elapsedMs = Date.now() - runtime.lastReleaseTime;
    if (elapsedMs >= idleDisposeThresholdMs) {
      this.disposeRuntime(runtime.profileKey);
      return;
    }
    const remainingMs = Math.max(idleDisposeThresholdMs - elapsedMs, 1_000);
    logEvent("main.xhs.runtime:idleReschedule", {
      profileKey: runtime.profileKey,
      elapsedMs,
      remainingMs
    });
    runtime.idleTimer = setTimeout(() => {
      this.maybeDisposeIdleRuntime(runtime);
    }, remainingMs);
  }

  private clearIdleTimer(runtime: XhsRuntime): void {
    if (!runtime.idleTimer) return;
    clearTimeout(runtime.idleTimer);
    runtime.idleTimer = undefined;
  }
}

export function resolveXhsCliCommand(): string {
  const command = resolveXhsCliCommandParts();
  if (command.args.length === 0) return command.file;
  return [command.file, ...command.args].map(quoteShellArg).join(" ");
}

const xhsNetLogMaxEntries = 500;
const xhsNetLogRequestBodyMaxBytes = 8 * 1024;
const xhsNetLogUrlFilter = {
  urls: [
    "https://*.xiaohongshu.com/*",
    "https://xiaohongshu.com/*",
    "https://t2.xiaohongshu.com/*",
    "https://apm-fe.xiaohongshu.com/*"
  ]
};
const xhsNetLogRequestHeaderAllowlist = new Set([
  "xs",
  "xt",
  "x-s-common",
  "x-t",
  "x-mns-platform",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
  "referer",
  "origin",
  "user-agent",
  "content-type",
  "accept",
  "accept-language",
  "cookie"
]);
const xhsNetLogResponseHeaderAllowlist = new Set([
  "location",
  "set-cookie",
  "cache-control",
  "x-request-id",
  "content-type",
  "server",
  "x-application-context"
]);
const xhsNetLogSkipResourceTypes = new Set(["image", "font", "stylesheet", "media"]);
const xhsDeviceCookieName = `a${1}`;
const xhsSessionCookieName = ["web", "session"].join("_");
const xhsWebIdCookieName = ["web", "Id"].join("");
const xhsSessionCookieFlag = `has_${xhsSessionCookieName}`;
const xhsDeviceCookieFlag = `has_${xhsDeviceCookieName}`;
const xhsWebIdCookieFlag = `has_${xhsWebIdCookieName}`;
const xhsSessionCookiePreview = `${xhsSessionCookieName}_preview`;
const xhsDeviceCookiePreview = `${xhsDeviceCookieName}_preview`;

interface XhsNetLogEntry {
  id: string;
  requestId: string;
  ts: number;
  tsLabel: string;
  method: string;
  url: string;
  host: string;
  path: string;
  resourceType: string;
  reqHeaders: Record<string, string>;
  reqBody: string | null;
  reqFingerprint: Record<string, unknown> | null;
  status: number;
  statusLine: string;
  respHeaders: Record<string, string>;
  setCookie: string[] | null;
  duration_ms: number;
  err: string | null;
  category: string;
  signals: string[];
  cookieDiff: { added: string[]; removed: string[] } | null;
  redirectTo: string | null;
  errorCode: string | null;
  _t0?: number;
}

function installXhsNetLog(profileKey: string, session: Session, netLogPath: string): void {
  const pending = new Map<string, XhsNetLogEntry>();
  const lastHostCookies = new Map<string, Set<string>>();

  const safeHandler = (event: string, fn: (...args: any[]) => void) => (...args: any[]) => {
    try {
      fn(...args);
    } catch (error) {
      logEvent("main.xhs.netlog:error", {
        profileKey,
        event,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  session.webRequest.onBeforeRequest(xhsNetLogUrlFilter, safeHandler("beforeRequest", (details: any, callback: (response: Record<string, never>) => void) => {
    try {
      if (!xhsNetLogSkipResourceTypes.has(String(details.resourceType ?? ""))) {
        const parsed = parseUrlParts(String(details.url ?? ""));
        if (parsed) {
          const now = Number(details.timestamp) || Date.now();
          pending.set(String(details.id), {
            id: `${now}_${details.id}`,
            requestId: String(details.id),
            ts: now,
            tsLabel: formatNetLogTimestamp(now),
            method: String(details.method ?? "GET"),
            url: parsed.url,
            host: parsed.host,
            path: parsed.path,
            resourceType: String(details.resourceType ?? ""),
            reqHeaders: {},
            reqBody: extractElectronUploadBody(details.uploadData),
            reqFingerprint: null,
            status: 0,
            statusLine: "",
            respHeaders: {},
            setCookie: null,
            duration_ms: 0,
            err: null,
            category: "other",
            signals: [],
            cookieDiff: null,
            redirectTo: null,
            errorCode: null,
            _t0: Date.now()
          });
        }
      }
    } finally {
      callback({});
    }
  }));

  session.webRequest.onBeforeSendHeaders(xhsNetLogUrlFilter, (details: any, callback: (response: { requestHeaders?: Record<string, string | string[]> }) => void) => {
    try {
      const entry = pending.get(String(details.id));
      if (entry) {
        const headers = normalizeHeaders(details.requestHeaders, xhsNetLogRequestHeaderAllowlist);
        entry.reqHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) => key !== "cookie"));
        const cookieMap = parseCookieHeader(headers.cookie ?? "");
        entry.reqFingerprint = {
          has_xs: Boolean(headers.xs),
          has_xt: Boolean(headers.xt),
          has_xsCommon: Boolean(headers["x-s-common"]),
          sec_fetch_site: headers["sec-fetch-site"] ?? null,
          sec_fetch_mode: headers["sec-fetch-mode"] ?? null,
          referer: headers.referer ?? null,
          origin: headers.origin ?? null,
          ua_prefix: (headers["user-agent"] ?? "").slice(0, 80),
          cookie: {
            [xhsDeviceCookieFlag]: Object.prototype.hasOwnProperty.call(cookieMap, xhsDeviceCookieName),
            [xhsSessionCookieFlag]: Object.prototype.hasOwnProperty.call(cookieMap, xhsSessionCookieName),
            [xhsWebIdCookieFlag]: Object.prototype.hasOwnProperty.call(cookieMap, xhsWebIdCookieName),
            has_gid: Object.prototype.hasOwnProperty.call(cookieMap, "gid"),
            [xhsDeviceCookiePreview]: previewSecret(cookieMap[xhsDeviceCookieName], 12),
            [xhsSessionCookiePreview]: previewSecret(cookieMap[xhsSessionCookieName], 10)
          }
        };
      }
    } catch (error) {
      logEvent("main.xhs.netlog:error", {
        profileKey,
        event: "beforeSendHeaders",
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      callback({ requestHeaders: details.requestHeaders });
    }
  });

  session.webRequest.onHeadersReceived(xhsNetLogUrlFilter, (details: any, callback: (response: { responseHeaders?: Record<string, string | string[]> }) => void) => {
    try {
      const entry = pending.get(String(details.id));
      if (entry) {
        entry.status = Number(details.statusCode) || 0;
        entry.statusLine = String(details.statusLine ?? "").replace(/^HTTP\/[\d.]+\s*/, "");
        entry.respHeaders = normalizeHeaders(details.responseHeaders, xhsNetLogResponseHeaderAllowlist);
        if (entry.respHeaders["set-cookie"]) {
          entry.setCookie = entry.respHeaders["set-cookie"]
            .split("\n")
            .map((value) => value.split("=", 1)[0]?.trim())
            .filter(Boolean);
        }
        if (entry.status === 301 || entry.status === 302) {
          entry.redirectTo = entry.respHeaders.location ?? null;
          entry.errorCode = parseRedirectErrorCode(entry.redirectTo, entry.url);
        }
      }
    } catch (error) {
      logEvent("main.xhs.netlog:error", {
        profileKey,
        event: "headersReceived",
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      callback({ responseHeaders: details.responseHeaders });
    }
  });

  session.webRequest.onCompleted(xhsNetLogUrlFilter, safeHandler("completed", (details: any) => {
    finalizeNetLogEntry(profileKey, netLogPath, pending, lastHostCookies, String(details.id), null);
  }));

  session.webRequest.onErrorOccurred(xhsNetLogUrlFilter, safeHandler("errorOccurred", (details: any) => {
    finalizeNetLogEntry(profileKey, netLogPath, pending, lastHostCookies, String(details.id), String(details.error ?? "network_error"));
  }));

  logEvent("main.xhs.netlog:installed", { profileKey, netLogPath });
}

function finalizeNetLogEntry(
  profileKey: string,
  netLogPath: string,
  pending: Map<string, XhsNetLogEntry>,
  lastHostCookies: Map<string, Set<string>>,
  requestId: string,
  error: string | null
): void {
  const entry = pending.get(requestId);
  pending.delete(requestId);
  if (!entry) return;
  entry.duration_ms = Date.now() - (entry._t0 ?? Date.now());
  delete entry._t0;
  entry.err = error;
  classifyNetLogEntry(entry, lastHostCookies);
  appendNetLogEntry(netLogPath, entry);
  if (entry.category === "risk_redirect" || entry.category === "signature_failure" || entry.category === "business_error") {
    logEvent("main.xhs.netlog:riskSignal", {
      profileKey,
      category: entry.category,
      status: entry.status,
      host: entry.host,
      path: entry.path,
      redirectTo: entry.redirectTo,
      signals: entry.signals
    });
  }
}

function classifyNetLogEntry(entry: XhsNetLogEntry, lastHostCookies: Map<string, Set<string>>): void {
  const body = entry.reqBody ?? "";
  if (/fp|sec|aegis|sentry|track/i.test(entry.host) || /webdriver|navigator|screen|timezone/i.test(body)) {
    entry.signals.push("fingerprint_upload");
  }
  if (entry.status === 301 || entry.status === 302) {
    const redirect = entry.redirectTo ?? "";
    if (/\/404(?:\?|$)|\/login(?:\?|$)/.test(redirect)) entry.signals.push("risk_redirect");
    if (entry.errorCode && /30003[123]/.test(entry.errorCode)) entry.signals.push("signature_failure");
  }
  if ([401, 403, 461, 999].includes(entry.status)) entry.signals.push("business_error");
  if (entry.setCookie?.length) {
    const previous = lastHostCookies.get(entry.host) ?? new Set<string>();
    const current = new Set([...previous, ...entry.setCookie]);
    const added = [...entry.setCookie].filter((name) => !previous.has(name));
    if (added.length > 0) {
      entry.signals.push("cookie_change");
      entry.cookieDiff = { added, removed: [] };
    }
    lastHostCookies.set(entry.host, current);
  }
  if (entry.path.includes("/api/") && entry.status >= 200 && entry.status < 300) entry.signals.push("business_api");
  entry.category =
    entry.signals.find((signal) => signal === "fingerprint_upload")
    ?? entry.signals.find((signal) => signal === "signature_failure")
    ?? entry.signals.find((signal) => signal === "risk_redirect")
    ?? entry.signals.find((signal) => signal === "business_error")
    ?? entry.signals.find((signal) => signal === "cookie_change")
    ?? entry.signals.find((signal) => signal === "business_api")
    ?? "other";
}

function appendNetLogEntry(netLogPath: string, entry: XhsNetLogEntry): void {
  try {
    fs.mkdirSync(path.dirname(netLogPath), { recursive: true });
    const existing = fs.existsSync(netLogPath)
      ? JSON.parse(fs.readFileSync(netLogPath, "utf8")) as unknown
      : [];
    const entries = Array.isArray(existing) ? existing : [];
    entries.push(entry);
    fs.writeFileSync(netLogPath, JSON.stringify(entries.slice(-xhsNetLogMaxEntries), null, 2), { mode: 0o600 });
  } catch {
    // NetLog is strictly best-effort; never break the XHS business path.
  }
}

function parseUrlParts(rawUrl: string): { url: string; host: string; path: string } | null {
  try {
    const url = new URL(rawUrl);
    return {
      url: rawUrl,
      host: url.host,
      path: `${url.pathname}${url.search}`
    };
  } catch {
    return null;
  }
}

function normalizeHeaders(raw: unknown, allowlist: Set<string>): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return headers;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalized = key.toLowerCase();
    if (!allowlist.has(normalized)) continue;
    const stringValue = Array.isArray(value) ? value.join("\n") : String(value ?? "");
    if (stringValue) headers[normalized] = stringValue;
  }
  return headers;
}

function parseCookieHeader(cookie: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

function extractElectronUploadBody(uploadData: unknown): string | null {
  if (!Array.isArray(uploadData) || uploadData.length === 0) return null;
  const chunks: Buffer[] = [];
  for (const item of uploadData as Array<{ bytes?: Buffer }>) {
    if (!item?.bytes) continue;
    chunks.push(Buffer.from(item.bytes));
  }
  if (chunks.length === 0) return null;
  return Buffer.concat(chunks).toString("utf8").slice(0, xhsNetLogRequestBodyMaxBytes);
}

function parseRedirectErrorCode(redirectTo: string | null, baseUrl: string): string | null {
  if (!redirectTo) return null;
  try {
    return new URL(redirectTo, baseUrl).searchParams.get("error_code");
  } catch {
    return null;
  }
}

function formatNetLogTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function previewSecret(value: string | undefined, length: number): string | null {
  return value ? `${value.slice(0, length)}...` : null;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || "default";
}

interface XhsProcessRegistryEntry {
  path: string;
  pid: number;
  requestId: string;
  profileKey: string;
  targetId: string;
}

function listXhsProcessRegistryEntries(registryDir: string, requestId?: string): XhsProcessRegistryEntry[] {
  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(registryDir).filter((fileName) => fileName.endsWith(".json"));
  } catch {
    return [];
  }

  const entries: XhsProcessRegistryEntry[] = [];
  for (const fileName of fileNames) {
    const filePath = path.join(registryDir, fileName);
    try {
      const payload = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
      const entryRequestId = typeof payload.requestId === "string" ? payload.requestId : "";
      const pid = typeof payload.pid === "number" && Number.isInteger(payload.pid) ? payload.pid : 0;
      if (!entryRequestId || pid <= 0) {
        fs.rmSync(filePath, { force: true });
        continue;
      }
      if (requestId && entryRequestId !== requestId) continue;
      entries.push({
        path: filePath,
        pid,
        requestId: entryRequestId,
        profileKey: typeof payload.profileKey === "string" ? payload.profileKey : "",
        targetId: typeof payload.targetId === "string" ? payload.targetId : ""
      });
    } catch {
      fs.rmSync(filePath, { force: true });
    }
  }
  return entries;
}

function terminateProcessTree(pid: number): void {
  if (!isProcessAlive(pid)) return;
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }

  const pids = Array.from(new Set([...collectDescendantPids(pid), pid])).filter(isProcessAlive);
  for (const targetPid of pids) {
    try {
      process.kill(targetPid, "SIGTERM");
    } catch (error) {
      if (!isProcessMissingError(error)) throw error;
    }
  }
  waitForProcessExit(pids, 800);
  for (const targetPid of pids) {
    if (!isProcessAlive(targetPid)) continue;
    try {
      process.kill(targetPid, "SIGKILL");
    } catch (error) {
      if (!isProcessMissingError(error)) throw error;
    }
  }
}

function collectDescendantPids(pid: number): number[] {
  const descendants: number[] = [];
  for (const childPid of listChildPids(pid)) {
    descendants.push(...collectDescendantPids(childPid), childPid);
  }
  return descendants;
}

function listChildPids(pid: number): number[] {
  try {
    const output = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.split(/\s+/).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isProcessMissingError(error);
  }
}

function waitForProcessExit(pids: number[], timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && pids.some(isProcessAlive)) sleepSync(50);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isProcessMissingError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ESRCH");
}

function resolveXhsCliCommandParts(): { file: string; args: string[] } {
  const binaryName = process.platform === "win32" ? "xhs-cli.exe" : "xhs-cli";
  const relativeExecutable = path.join("resources", "connectors", "xhs", "bin", process.platform, process.arch, "xhs-cli", binaryName);
  const binaryCandidates = [
    path.join(process.cwd(), relativeExecutable),
    path.join(__dirname, "..", "..", relativeExecutable)
  ];
  if (process.resourcesPath) {
    binaryCandidates.unshift(path.join(process.resourcesPath, relativeExecutable));
  }
  for (const candidate of binaryCandidates.map(toUnpackedAsarPath)) {
    if (fs.existsSync(candidate)) return { file: candidate, args: [] };
  }

  if (isPackagedRuntime()) {
    throw new Error("Packaged XHS CLI onedir executable not found in bundled resources");
  }
  if (process.env.AGENTSTUDIO_XHS_ALLOW_SOURCE_CLI !== "1") {
    throw new Error(`XHS sidecar not found. Run \`npm run build:xhs-sidecar\` before starting dev, or set AGENTSTUDIO_XHS_ALLOW_SOURCE_CLI=1 with AGENTSTUDIO_PYTHON=/path/to/python3.11 for Python source debugging.`);
  }

  const scriptCandidates = [
    path.join(process.cwd(), "resources", "connectors", "xhs", "engine", "scripts", "cli.py"),
    path.join(__dirname, "..", "..", "resources", "connectors", "xhs", "engine", "scripts", "cli.py")
  ];
  if (process.resourcesPath) {
    scriptCandidates.unshift(path.join(process.resourcesPath, "resources", "connectors", "xhs", "engine", "scripts", "cli.py"));
  }
  const python = resolvePythonExecutable();
  assertSourceCliPython(python);
  for (const candidate of scriptCandidates.map(toUnpackedAsarPath)) {
    if (fs.existsSync(candidate)) return { file: python, args: [candidate] };
  }

  throw new Error("XHS CLI not found in bundled resources");
}

function resolvePythonExecutable(): string {
  return process.env.AGENTSTUDIO_PYTHON || (process.platform === "win32" ? "python" : "python3");
}

function assertSourceCliPython(python: string): void {
  try {
    execFileSync(python, [
      "-c",
      "import sys, websockets; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)"
    ], { stdio: "pipe" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Python source XHS CLI requires Python >= 3.11 with websockets installed. Set AGENTSTUDIO_PYTHON=/path/to/python3.11 or run \`npm run build:xhs-sidecar\`. Current python: ${python}. ${message}`);
  }
}

function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function readCliFailureMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const error = readNonEmptyString(record.error);
  const message = readNonEmptyString(record.message);
  return error ?? message;
}

function summarizeCliPayload(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
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
    "status",
    "count"
  ]) {
    if (record[key] !== undefined) summary[key] = record[key];
  }
  return Object.keys(summary).length > 0 ? summary : { type: Object.prototype.toString.call(payload) };
}

function summarizeText(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 500)}...`;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isXhsCookie(cookie: Cookie): boolean {
  const domain = cookie.domain ?? "";
  if (!domain.includes("xiaohongshu.com")) return false;
  if (cookie.expirationDate && cookie.expirationDate <= Date.now() / 1000) return false;
  return Boolean(cookie.name);
}

function toStoredCookie(cookie: Cookie): XhsStoredCookie {
  return {
    domain: cookie.domain,
    expirationDate: cookie.expirationDate,
    hostOnly: cookie.hostOnly,
    httpOnly: cookie.httpOnly,
    name: cookie.name,
    path: cookie.path,
    sameSite: cookie.sameSite,
    secure: cookie.secure,
    session: cookie.session,
    value: cookie.value
  };
}

function toCookieSetDetails(cookie: XhsStoredCookie): CookiesSetDetails | null {
  if (!cookie.name) return null;
  if (!cookie.value) return null;
  if (cookie.expirationDate && cookie.expirationDate <= Date.now() / 1000) return null;
  const url = resolveCookieUrl(cookie);
  if (!url) return null;
  const details: CookiesSetDetails = {
    url,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite
  };
  if (cookie.domain && !cookie.hostOnly) details.domain = cookie.domain;
  if (!cookie.session && cookie.expirationDate) details.expirationDate = cookie.expirationDate;
  return details;
}

function resolveCookieUrl(cookie: XhsStoredCookie): string | null {
  const rawDomain = cookie.domain?.trim();
  if (!rawDomain) return "https://www.xiaohongshu.com";
  const host = rawDomain.startsWith(".") ? rawDomain.slice(1) : rawDomain;
  if (!host.endsWith("xiaohongshu.com")) return null;
  return `https://${host}${cookie.path || "/"}`;
}

interface BootstrapPage {
  title: string;
  token: string;
  url: string;
}

function createBootstrapPage(profileKey: string): BootstrapPage {
  const token = `${profileKey}-${Date.now()}-${randomUUID()}`;
  const title = `${bootstrapTitle} ${token}`;
  const html = [
    "<!doctype html>",
    "<html>",
    "<head>",
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
    "<body>",
    `<script>window.__agentStudioXhsBootstrapToken = ${JSON.stringify(token)};</script>`,
    `<main data-agentstudio-xhs-bootstrap-token="${escapeHtml(token)}"></main>`,
    "</body>",
    "</html>"
  ].join("");
  return {
    title,
    token,
    url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
  };
}

function waitForCdpTarget(port: number, bootstrap: BootstrapPage, existingTargetIds: Set<string>, context: CdpTargetResolveContext): Promise<{ id: string; source: "jsonList" }> {
  const deadline = Date.now() + 5000;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const targets = await fetchCdpTargets(port, { profileKey: context.profileKey, reason: "waitForTarget" });
        const target = targets.find((item) => {
          if (!item.id || existingTargetIds.has(item.id)) return false;
          if (item.type && item.type !== "page") return false;
          if (item.title !== bootstrap.title) return false;
          return !item.url || item.url.includes(bootstrap.token);
        });
        if (target?.id) {
          logEvent("main.xhs.cdp:targetResolved", {
            profileKey: context.profileKey,
            targetId: target.id,
            source: "jsonList",
            targets: summarizeCdpTargets(targets)
          });
          resolve({ id: target.id, source: "jsonList" });
          return;
        }
      } catch (error) {
        if (Date.now() >= deadline) {
          logEvent("main.xhs.cdp:targetResolveFailed", {
            profileKey: context.profileKey,
            source: "jsonList",
            reason: "fetchFailed",
            error: error instanceof Error ? error.message : String(error)
          });
          reject(error);
          return;
        }
      }
      if (Date.now() >= deadline) {
        logEvent("main.xhs.cdp:targetResolveFailed", {
          profileKey: context.profileKey,
          source: "jsonList",
          reason: "notFound"
        });
        reject(new Error("无法创建小红书连接器 CDP target"));
        return;
      }
      setTimeout(tick, 100);
    };
    void tick();
  });
}

async function resolveWebContentsTargetId(webContents: WebContents, bootstrap: BootstrapPage, context: CdpTargetResolveContext): Promise<string | null> {
  if (webContents.isDestroyed()) {
    logEvent("main.xhs.cdp:targetResolveFailed", { profileKey: context.profileKey, source: "webContentsDebugger", reason: "webContentsDestroyed" });
    return null;
  }
  const debuggerApi = webContents.debugger;
  const wasAttached = debuggerApi.isAttached();
  try {
    if (!wasAttached) debuggerApi.attach("1.3");
    const result = await debuggerApi.sendCommand("Target.getTargetInfo");
    const targetInfo = result?.targetInfo;
    const targetId = typeof targetInfo?.targetId === "string" ? targetInfo.targetId : "";
    const title = typeof targetInfo?.title === "string" ? targetInfo.title : "";
    const url = typeof targetInfo?.url === "string" ? targetInfo.url : "";
    if (targetId && title === bootstrap.title && (!url || url.includes(bootstrap.token))) {
      logEvent("main.xhs.cdp:targetResolved", {
        profileKey: context.profileKey,
        targetId,
        source: "webContentsDebugger",
        titleMatched: true,
        urlMatched: true
      });
      return targetId;
    }
    logEvent("main.xhs.cdp:targetResolveMiss", {
      profileKey: context.profileKey,
      source: "webContentsDebugger",
      targetId: targetId || null,
      titleMatched: title === bootstrap.title,
      urlMatched: !url || url.includes(bootstrap.token)
    });
  } catch (error) {
    logEvent("main.xhs.cdp:targetResolveFailed", {
      profileKey: context.profileKey,
      source: "webContentsDebugger",
      reason: "debuggerError",
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  } finally {
    if (!wasAttached && debuggerApi.isAttached()) debuggerApi.detach();
  }
  return null;
}

async function fetchCdpTargetIds(port: number, context: { profileKey?: string; reason: string }): Promise<Set<string>> {
  const targets = await fetchCdpTargets(port, context);
  return new Set(targets.map((target) => target.id).filter((id): id is string => typeof id === "string" && id.length > 0));
}

function fetchCdpTargets(port: number, context?: { profileKey?: string; reason?: string }): Promise<CdpTarget[]> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/json/list", timeout: 1000 }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          const targets = Array.isArray(parsed) ? parsed as CdpTarget[] : [];
          logEvent("main.xhs.cdp:targetsListed", {
            profileKey: context?.profileKey ?? null,
            reason: context?.reason ?? null,
            port,
            count: targets.length,
            targets: summarizeCdpTargets(targets)
          });
          resolve(targets);
        } catch (error) {
          logEvent("main.xhs.cdp:targetsListFailed", {
            profileKey: context?.profileKey ?? null,
            reason: context?.reason ?? null,
            port,
            error: error instanceof Error ? error.message : String(error)
          });
          reject(error);
        }
      });
    });
    request.on("error", (error) => {
      logEvent("main.xhs.cdp:targetsListFailed", {
        profileKey: context?.profileKey ?? null,
        reason: context?.reason ?? null,
        port,
        error: error.message
      });
      reject(error);
    });
    request.on("timeout", () => {
      request.destroy(new Error("CDP target list request timed out"));
    });
  });
}

function summarizeCdpTargets(targets: CdpTarget[]): Array<Record<string, unknown>> {
  return targets.slice(0, 20).map((target) => ({
    id: target.id,
    type: target.type,
    title: target.title,
    url: target.url ? summarizeUrl(target.url) : undefined
  }));
}

function summarizeUrl(url: string): string {
  if (url.startsWith("data:")) return "data:";
  return url.length <= 300 ? url : `${url.slice(0, 300)}...`;
}

function quoteShellArg(value: string): string {
  if (process.platform === "win32") return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function toUnpackedAsarPath(candidate: string): string {
  return candidate.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function isPackagedRuntime(): boolean {
  return __dirname.includes(`${path.sep}app.asar${path.sep}`) || Boolean(process.resourcesPath && !process.env.VITE_DEV_SERVER_URL);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
