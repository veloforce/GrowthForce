import { BrowserWindow, WebContentsView, app, session as electronSession, type Rectangle, type Session, type WebContents } from "electron";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { logEvent } from "../shared/log";
import type { BrowserAutomationContext, RuntimePaths } from "../shared/types";
import {
  browserFingerprintPolicyVersion,
  configureBrowserSessionFingerprint,
  type BrowserFingerprintIdentity
} from "./browser-fingerprint";

const profileId = "default";
const bootstrapTitle = "GrowthForce Browser Session";
const idleTimeoutMs = 120 * 60 * 1000;
const hiddenViewportSize = { width: 1280, height: 900 };
const fallbackHiddenBounds: Rectangle = { x: 100_000, y: 100_000, width: hiddenViewportSize.width, height: hiddenViewportSize.height };

interface BrowserRuntime {
  sessionId: number;
  view: WebContentsView;
  targetTitle: string;
  cdpPort: number;
  targetId: string;
  cdpWebSocketUrl: string;
  idleTimer?: NodeJS.Timeout;
}

export interface BrowserSurfaceState {
  sessionId?: number;
  visible: boolean;
  bounds?: Rectangle;
}

interface CdpTarget {
  id?: string;
  title?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface BootstrapPage {
  title: string;
  token: string;
  url: string;
}

export async function findAvailableCdpPort(maxAttempts = 30): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const port = 40_000 + Math.floor(Math.random() * 20_000);
    try {
      await assertPortAvailable(port);
      return port;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Unable to find an available CDP port: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export class BrowserSessionManager {
  private readonly runtimes = new Map<number, BrowserRuntime>();
  private sharedSession: Session | null = null;
  private fingerprintIdentity: BrowserFingerprintIdentity | null = null;
  private surface: BrowserSurfaceState = { visible: false };
  private mainWindow: BrowserWindow | null = null;

  constructor(
    private readonly paths: RuntimePaths,
    private readonly cdpPort: number
  ) {}

  setMainWindow(window: BrowserWindow): void {
    if (this.mainWindow && this.mainWindow !== window) {
      for (const runtime of this.runtimes.values()) this.detachViewFromWindow(runtime, this.mainWindow);
    }
    this.mainWindow = window;
    window.on("close", () => {
      for (const runtime of this.runtimes.values()) this.detachViewFromWindow(runtime, window);
    });
    window.on("closed", () => {
      for (const runtime of this.runtimes.values()) this.detachViewFromWindow(runtime, window);
      this.mainWindow = null;
    });
    for (const runtime of this.runtimes.values()) this.applySurface(runtime);
  }

  async ensureSession(sessionId: number): Promise<BrowserAutomationContext> {
    const existing = this.runtimes.get(sessionId);
    if (existing && !existing.view.webContents.isDestroyed()) {
      this.clearIdleTimer(existing);
      this.applySurface(existing);
      return toAutomationContext(existing);
    }

    const view = new WebContentsView({
      webPreferences: {
        session: this.getSharedSession(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    view.setBounds(this.getHiddenBounds());
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    const existingTargetIds = await fetchCdpTargetIds(this.cdpPort).catch((error) => {
      logEvent("main.browser.cdp:existingTargetsFailed", {
        sessionId,
        cdpPort: this.cdpPort,
        error: error instanceof Error ? error.message : String(error)
      });
      return new Set<string>();
    });
    const bootstrap = createBootstrapPage(sessionId);
    await view.webContents.loadURL(bootstrap.url);
    const target = await resolveWebContentsTarget(view.webContents, bootstrap, { cdpPort: this.cdpPort, sessionId })
      ?? await this.waitForCdpTarget(bootstrap, existingTargetIds, sessionId);
    const runtime: BrowserRuntime = {
      sessionId,
      view,
      targetTitle: bootstrap.title,
      cdpPort: this.cdpPort,
      targetId: target.id,
      cdpWebSocketUrl: target.webSocketDebuggerUrl
    };
    this.runtimes.set(sessionId, runtime);
    this.applySurface(runtime);
    logEvent("main.browser.session:create", {
      sessionId,
      profileId,
      targetTitle: bootstrap.title,
      targetId: target.id,
      targetSource: target.source,
      fingerprintPolicyVersion: browserFingerprintPolicyVersion,
      chromiumMajor: this.fingerprintIdentity?.userAgentMetadata.brands.find((brand) => brand.brand === "Chromium")?.version
    });
    return toAutomationContext(runtime);
  }

  updateSurface(surface: BrowserSurfaceState): void {
    this.surface = {
      sessionId: surface.sessionId,
      visible: surface.visible,
      bounds: surface.bounds ? normalizeBounds(surface.bounds) : undefined
    };
    for (const runtime of this.runtimes.values()) this.applySurface(runtime);
  }

  markIdle(sessionId: number): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    this.clearIdleTimer(runtime);
    runtime.idleTimer = setTimeout(() => {
      this.disposeSession(sessionId);
    }, idleTimeoutMs);
  }

  disposeSession(sessionId: number): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    this.clearIdleTimer(runtime);
    this.detachView(runtime);
    if (!runtime.view.webContents.isDestroyed()) runtime.view.webContents.close();
    this.runtimes.delete(sessionId);
    logEvent("main.browser.session:dispose", { sessionId });
  }

  dispose(): void {
    for (const sessionId of [...this.runtimes.keys()]) this.disposeSession(sessionId);
  }

  private getSharedSession(): Session {
    if (this.sharedSession) return this.sharedSession;
    const profilePath = path.join(this.paths.userProfile, profileId);
    fs.mkdirSync(profilePath, { recursive: true });
    this.sharedSession = electronSession.fromPath(profilePath, { cache: false });
    this.fingerprintIdentity = configureBrowserSessionFingerprint(this.sharedSession);
    logEvent("main.browser.profile", {
      profileId,
      profilePath,
      diskCache: false,
      fingerprintPolicyVersion: browserFingerprintPolicyVersion,
      platform: this.fingerprintIdentity.userAgentMetadata.platform,
      chromiumMajor: this.fingerprintIdentity.userAgentMetadata.brands.find((brand) => brand.brand === "Chromium")?.version
    });
    return this.sharedSession;
  }

  private applySurface(runtime: BrowserRuntime): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed() || runtime.view.webContents.isDestroyed()) {
      this.detachView(runtime);
      return;
    }
    const visibleBounds = this.getVisibleSurfaceBounds(runtime);
    if (visibleBounds) {
      runtime.view.setBounds(visibleBounds);
      this.mainWindow.contentView.addChildView(runtime.view);
      runtime.view.setVisible(true);
      return;
    }
    this.detachView(runtime);
  }

  private getVisibleSurfaceBounds(runtime: BrowserRuntime): Rectangle | null {
    if (!this.mainWindow || !this.surface.visible || this.surface.sessionId !== runtime.sessionId || !this.surface.bounds) return null;
    const contentBounds = this.mainWindow.getContentBounds();
    if (!isValidSurfaceBounds(this.surface.bounds, { width: contentBounds.width, height: contentBounds.height })) return null;
    return normalizeBounds(this.surface.bounds);
  }

  private getHiddenBounds(): Rectangle {
    const contentBounds = this.mainWindow?.getContentBounds();
    if (!contentBounds) return fallbackHiddenBounds;
    const x = Math.max(0, contentBounds?.width ?? 0) + 100;
    const y = Math.max(0, contentBounds?.height ?? 0) + 100;
    return {
      x,
      y,
      width: hiddenViewportSize.width,
      height: hiddenViewportSize.height
    };
  }

  private detachView(runtime: BrowserRuntime): void {
    if (!this.mainWindow) return;
    this.detachViewFromWindow(runtime, this.mainWindow);
  }

  private detachViewFromWindow(runtime: BrowserRuntime, window: BrowserWindow): void {
    try {
      if (window.isDestroyed()) return;
      const parent = window.contentView;
      if (!parent.children.includes(runtime.view)) return;
      runtime.view.setVisible(false);
      parent.removeChildView(runtime.view);
    } catch (error) {
      logEvent("main.browser.session:detachFailed", {
        sessionId: runtime.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private clearIdleTimer(runtime: BrowserRuntime): void {
    if (!runtime.idleTimer) return;
    clearTimeout(runtime.idleTimer);
    runtime.idleTimer = undefined;
  }

  private async waitForCdpTarget(bootstrap: BootstrapPage, existingTargetIds: Set<string>, sessionId: number): Promise<{ id: string; webSocketDebuggerUrl: string; source: "jsonList" }> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const targets = await fetchCdpTargets(this.cdpPort);
      const target = targets.find((item) => {
        if (!item.id || existingTargetIds.has(item.id)) return false;
        if (item.type && item.type !== "page") return false;
        if (item.title !== bootstrap.title) return false;
        return !item.url || item.url.includes(bootstrap.token);
      });
      if (target?.id && target.webSocketDebuggerUrl) {
        logEvent("main.browser.cdp:targetResolved", {
          sessionId,
          targetId: target.id,
          source: "jsonList",
          targets: summarizeCdpTargets(targets)
        });
        return { id: target.id, webSocketDebuggerUrl: target.webSocketDebuggerUrl, source: "jsonList" };
      }
      await delay(100);
    }
    logEvent("main.browser.cdp:targetResolveFailed", {
      sessionId,
      source: "jsonList",
      reason: "notFound"
    });
    throw new Error("无法创建浏览器自动化目标，请确认 Electron CDP 调试端口可用");
  }
}

function toAutomationContext(runtime: BrowserRuntime): BrowserAutomationContext {
  return {
    cdpPort: runtime.cdpPort,
    cdpWebSocketUrl: runtime.cdpWebSocketUrl
  };
}

function normalizeBounds(bounds: Rectangle): Rectangle {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  };
}

function isValidSurfaceBounds(bounds: Rectangle, viewport: { width: number; height: number }): boolean {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height, viewport.width, viewport.height];
  if (!values.every(Number.isFinite)) return false;
  if (bounds.width < 1 || bounds.height < 1 || viewport.width < 1 || viewport.height < 1) return false;
  if (bounds.x < 0 || bounds.y < 0) return false;
  if (bounds.x >= viewport.width || bounds.y >= viewport.height) return false;
  if (bounds.x + bounds.width > viewport.width + 1) return false;
  if (bounds.y + bounds.height > viewport.height + 1) return false;
  return true;
}

function assertPortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
}

function fetchCdpTargets(port: number): Promise<CdpTarget[]> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/json/list", timeout: 1000 }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          resolve(Array.isArray(parsed) ? parsed as CdpTarget[] : []);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error("CDP target list request timed out"));
    });
  });
}

async function fetchCdpTargetIds(port: number): Promise<Set<string>> {
  const targets = await fetchCdpTargets(port);
  return new Set(targets.map((target) => target.id).filter((id): id is string => typeof id === "string" && id.length > 0));
}

async function resolveWebContentsTarget(
  webContents: WebContents,
  bootstrap: BootstrapPage,
  context: { cdpPort: number; sessionId: number }
): Promise<{ id: string; webSocketDebuggerUrl: string; source: "webContentsDebugger" } | null> {
  const targetId = await resolveWebContentsTargetId(webContents, bootstrap, context);
  if (!targetId) return null;
  const webSocketDebuggerUrl = await waitForCdpTargetWebSocketUrl(context.cdpPort, targetId, context.sessionId, "webContentsDebugger");
  if (!webSocketDebuggerUrl) return null;
  return { id: targetId, webSocketDebuggerUrl, source: "webContentsDebugger" };
}

async function resolveWebContentsTargetId(
  webContents: WebContents,
  bootstrap: BootstrapPage,
  context: { sessionId: number }
): Promise<string | null> {
  if (webContents.isDestroyed()) {
    logEvent("main.browser.cdp:targetResolveFailed", { sessionId: context.sessionId, source: "webContentsDebugger", reason: "webContentsDestroyed" });
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
      logEvent("main.browser.cdp:targetResolved", {
        sessionId: context.sessionId,
        targetId,
        source: "webContentsDebugger",
        titleMatched: true,
        urlMatched: true
      });
      return targetId;
    }
    logEvent("main.browser.cdp:targetResolveMiss", {
      sessionId: context.sessionId,
      source: "webContentsDebugger",
      targetId: targetId || null,
      titleMatched: title === bootstrap.title,
      urlMatched: !url || url.includes(bootstrap.token)
    });
  } catch (error) {
    logEvent("main.browser.cdp:targetResolveFailed", {
      sessionId: context.sessionId,
      source: "webContentsDebugger",
      reason: "debuggerError",
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    if (!wasAttached && debuggerApi.isAttached()) debuggerApi.detach();
  }
  return null;
}

async function waitForCdpTargetWebSocketUrl(port: number, targetId: string, sessionId: number, source: string): Promise<string | null> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const targets = await fetchCdpTargets(port);
    const target = targets.find((item) => item.id === targetId && item.webSocketDebuggerUrl);
    if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
    await delay(100);
  }
  logEvent("main.browser.cdp:targetWebSocketResolveFailed", { sessionId, targetId, source });
  return null;
}

function createBootstrapPage(sessionId: number): BootstrapPage {
  const token = `${sessionId}-${Date.now()}-${randomUUID()}`;
  const title = `${bootstrapTitle} ${token}`;
  const html = [
    "<!doctype html>",
    "<html>",
    "<head>",
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
    "<body>",
    `<script>window.__agentStudioBrowserBootstrapToken = ${JSON.stringify(token)};</script>`,
    `<main data-agentstudio-browser-bootstrap-token="${escapeHtml(token)}"></main>`,
    "</body>",
    "</html>"
  ].join("");
  return {
    title,
    token,
    url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
  };
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function configureRemoteDebugging(port: number): void {
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", String(port));
  app.commandLine.appendSwitch("disable-features", "CompressionDictionaryTransport,CompressionDictionaryTransportBackend");
}
