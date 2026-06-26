import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSdkMcpServer, tool } from "../../runtime";
import TurndownService from "turndown";
import { WebSocket } from "undici";
import { z } from "zod/v4";

type JsonRecord = Record<string, unknown>;

type BrowserEnv = {
  cdpWebSocketUrl: string;
  cdpPort?: string;
};

type ToolServerContext = {
  browserAutomation?: {
    cdpPort: number;
    cdpWebSocketUrl: string;
  };
};

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 10;
const FETCH_TEXT_LIMIT = 20_000;
const FETCH_HTML_LIMIT = 4_000;
const FETCH_HTTP_TIMEOUT_MS = 15_000;
const FETCH_MIN_TEXT_LENGTH = 200;
const DEFAULT_FETCH_OUTPUT_DIR = path.join(os.homedir(), ".agentstudio", "workspace", "web-fetch");
const DEFAULT_SCREENSHOT_OUTPUT_DIR = path.join(os.homedir(), ".agentstudio", "workspace", "browser-screenshots");
const DEFAULT_WORKSPACE_DIR = path.join(os.homedir(), ".agentstudio", "workspace");
const DEFAULT_BROWSER_TIMEOUT_MS = 10_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 20_000;
const MAX_BROWSER_TIMEOUT_MS = 60_000;
const DEFAULT_SNAPSHOT_LIMIT = 80;
const MAX_SNAPSHOT_LIMIT = 200;
const DIRECT_BROWSER_URLS = [
  { protocol: "https:", hostname: "mp.weixin.qq.com" }
];

const browserTargetSchema = z.object({
  ref: z.string().min(1).optional().describe("browser_snapshot 返回的临时元素引用，例如 @e3。"),
  selector: z.string().min(1).optional().describe("CSS selector。"),
  role: z.string().min(1).optional().describe("ARIA role 或常见隐式 role，例如 button、link、textbox。"),
  name: z.string().min(1).optional().describe("可访问名称，常与 role 配合使用。"),
  text: z.string().min(1).optional().describe("按可见文本定位元素。"),
  label: z.string().min(1).optional().describe("按 label 文本定位表单控件。"),
  placeholder: z.string().min(1).optional().describe("按 placeholder 定位输入控件。"),
  alt: z.string().min(1).optional().describe("按 alt 文本定位图片或图片按钮。"),
  title: z.string().min(1).optional().describe("按 title attribute 定位元素。"),
  testId: z.string().min(1).optional().describe("按 data-testid 定位元素。"),
  exact: z.boolean().optional().describe("文本类定位是否要求精确匹配，默认 false。"),
  index: z.number().int().min(0).optional().describe("匹配多个元素时选择第几个，默认 0。")
});

type BrowserTarget = z.infer<typeof browserTargetSchema>;

type SnapshotRef = {
  ref: string;
  selector: string;
  url: string;
  text: string;
};

const snapshotRefs = new Map<string, SnapshotRef>();

function jsonResult(value: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ],
    isError
  };
}

export function createServer(context?: ToolServerContext) {
  const browserEnv = resolveBrowserEnv(context);
  return createSdkMcpServer({
    name: "browser",
    tools: [
      tool(
        "web_search",
        "使用 GrowthForce 通用浏览器搜索网页。优先 Bing 中文搜索，结果异常时自动切换到百度。同一 Agent Session 共用一个浏览器页面，多个 web_search 必须顺序调用，不支持并行搜索。",
        {
          query: z.string().min(1).describe("搜索关键词。"),
          maxResults: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional().describe("返回结果数量，默认 8，最多 10。")
        },
        async (args) => {
          try {
            return jsonResult(await webSearch(args.query, args.maxResults, browserEnv));
          } catch (error) {
            return jsonResult({ ok: false, status: "error", error: error instanceof Error ? error.message : String(error) }, true);
          }
        },
        {
          searchHint: "网页搜索 实时搜索 web search Bing 百度",
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true
          }
        }
      ),
      tool(
        "web_fetch",
        "抓取 URL 内容并生成 Markdown 文件。默认先 HTTP GET，失败或指定域名时使用 GrowthForce 通用浏览器渲染抓取。",
        {
          url: z.string().url().describe("要抓取的网页 URL。"),
          outputPath: z.string().min(1).optional().describe("可选 Markdown 输出路径。相对路径基于 ~/.agentstudio/workspace，绝对路径和 ~/ 路径按用户指定位置写入。"),
          preferBrowser: z.boolean().optional().describe("是否强制使用浏览器渲染抓取。默认 false。")
        },
        async (args) => {
          try {
            return jsonResult(await webFetch(args.url, { outputPath: args.outputPath, preferBrowser: args.preferBrowser }, browserEnv));
          } catch (error) {
            return jsonResult({ ok: false, status: "error", error: error instanceof Error ? error.message : String(error) }, true);
          }
        },
        {
          searchHint: "网页抓取 网页读取 web fetch URL 正文",
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true
          }
        }
      ),
      tool(
        "browser_navigate",
        "在当前 GrowthForce 浏览器页内导航到 http/https URL，不创建新 tab。",
        {
          url: z.string().url().describe("要打开的 http/https URL。"),
          waitUntil: z.enum(["domcontentloaded", "load", "networkidle"]).optional().describe("等待页面状态，默认 domcontentloaded。"),
          timeoutMs: z.number().int().min(500).max(MAX_BROWSER_TIMEOUT_MS).optional().describe("超时时间，默认 20000ms。"),
          settleMs: z.number().int().min(0).max(10_000).optional().describe("页面 ready 后额外等待时间，默认 300ms。")
        },
        async (args) => safeBrowserTool(() => browserNavigate(args.url, {
          waitUntil: args.waitUntil,
          timeoutMs: args.timeoutMs,
          settleMs: args.settleMs
        }, browserEnv)),
        {
          searchHint: "浏览器 导航 打开 URL browser navigate",
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
        }
      ),
      tool(
        "browser_snapshot",
        "获取当前浏览器页的紧凑元素快照，并为可交互元素生成 @eN 临时引用。",
        {
          selector: z.string().min(1).optional().describe("可选 CSS selector，只扫描该区域内元素。"),
          maxElements: z.number().int().min(1).max(MAX_SNAPSHOT_LIMIT).optional().describe("最多返回元素数，默认 80，最多 200。"),
          includeHidden: z.boolean().optional().describe("是否包含不可见元素，默认 false。")
        },
        async (args) => safeBrowserTool(() => browserSnapshot({
          selector: args.selector,
          maxElements: args.maxElements,
          includeHidden: args.includeHidden
        }, browserEnv)),
        {
          searchHint: "浏览器 快照 元素 refs accessibility snapshot",
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        }
      ),
      tool(
        "browser_click",
        "点击当前浏览器页内的元素，支持 CSS、@eN ref 和语义定位。",
        {
          target: browserTargetSchema.describe("要点击的元素定位。"),
          button: z.enum(["left", "middle", "right"]).optional().describe("鼠标按钮，默认 left。"),
          clickCount: z.number().int().min(1).max(3).optional().describe("点击次数，默认 1。"),
          timeoutMs: z.number().int().min(500).max(MAX_BROWSER_TIMEOUT_MS).optional().describe("超时时间，默认 10000ms。")
        },
        async (args) => safeBrowserTool(() => browserClick(args.target, {
          button: args.button,
          clickCount: args.clickCount,
          timeoutMs: args.timeoutMs
        }, browserEnv)),
        {
          searchHint: "浏览器 点击 click button link",
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        }
      ),
      tool(
        "browser_fill",
        "清空并填充当前浏览器页内的输入控件或 contenteditable 元素。",
        {
          target: browserTargetSchema.describe("要填充的元素定位。"),
          text: z.string().describe("要填入的文本。"),
          clear: z.boolean().optional().describe("填充前是否清空，默认 true。"),
          timeoutMs: z.number().int().min(500).max(MAX_BROWSER_TIMEOUT_MS).optional().describe("超时时间，默认 10000ms。")
        },
        async (args) => safeBrowserTool(() => browserFill(args.target, args.text, {
          clear: args.clear,
          timeoutMs: args.timeoutMs
        }, browserEnv)),
        {
          searchHint: "浏览器 填写 输入 fill form input textarea",
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        }
      ),
      tool(
        "browser_type",
        "向当前焦点或指定元素插入文本。",
        {
          target: browserTargetSchema.optional().describe("可选元素定位；省略时向当前焦点输入。"),
          text: z.string().describe("要输入的文本。"),
          delayMs: z.number().int().min(0).max(2_000).optional().describe("逐字符输入间隔，默认 0。")
        },
        async (args) => safeBrowserTool(() => browserType(args.target, args.text, { delayMs: args.delayMs }, browserEnv)),
        {
          searchHint: "浏览器 输入 type keyboard text",
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        }
      ),
      tool(
        "browser_press",
        "在当前浏览器页按下键盘按键，例如 Enter、Tab、Escape、Backspace、ArrowDown。",
        {
          key: z.string().min(1).describe("按键名称或单个字符。")
        },
        async (args) => safeBrowserTool(() => browserPress(args.key, browserEnv)),
        {
          searchHint: "浏览器 键盘 press key Enter Tab",
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        }
      ),
      tool(
        "browser_scroll",
        "滚动页面或指定可滚动元素。",
        {
          target: browserTargetSchema.optional().describe("可选滚动容器定位；省略时滚动窗口。"),
          direction: z.enum(["up", "down", "left", "right"]).optional().describe("滚动方向，默认 down。"),
          amount: z.number().int().min(1).max(10_000).optional().describe("滚动像素，默认 600。"),
          x: z.number().int().optional().describe("显式横向滚动像素，设置后优先于 direction。"),
          y: z.number().int().optional().describe("显式纵向滚动像素，设置后优先于 direction。")
        },
        async (args) => safeBrowserTool(() => browserScroll({
          target: args.target,
          direction: args.direction,
          amount: args.amount,
          x: args.x,
          y: args.y
        }, browserEnv)),
        {
          searchHint: "浏览器 滚动 scroll",
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        }
      ),
      tool(
        "browser_wait",
        "等待当前浏览器页满足 selector、text、url 或 load state 条件。",
        {
          selector: z.string().min(1).optional().describe("等待 CSS selector。"),
          text: z.string().min(1).optional().describe("等待页面出现文本。"),
          urlIncludes: z.string().min(1).optional().describe("等待 URL 包含指定文本。"),
          state: z.enum(["visible", "hidden", "attached", "detached", "domcontentloaded", "load", "networkidle"]).optional().describe("等待状态。selector 默认 visible；无 selector 时可等待页面 load state。"),
          timeoutMs: z.number().int().min(500).max(MAX_BROWSER_TIMEOUT_MS).optional().describe("超时时间，默认 10000ms。")
        },
        async (args) => safeBrowserTool(() => browserWait(args, browserEnv)),
        {
          searchHint: "浏览器 等待 wait selector text url load",
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        }
      ),
      tool(
        "browser_get",
        "读取当前浏览器页或元素的信息。",
        {
          target: browserTargetSchema.optional().describe("元素定位；读取 title/url 时可省略。"),
          kind: z.enum(["text", "html", "value", "attr", "title", "url", "count", "box", "state"]).describe("读取类型。"),
          name: z.string().min(1).optional().describe("kind=attr 时读取的 attribute 名称。")
        },
        async (args) => safeBrowserTool(() => browserGet(args.kind, {
          target: args.target,
          name: args.name
        }, browserEnv)),
        {
          searchHint: "浏览器 读取 get text html value title url count state",
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        }
      ),
      tool(
        "browser_screenshot",
        "截取当前浏览器页并写入本地 PNG 文件。",
        {
          outputPath: z.string().min(1).optional().describe("可选输出路径。相对路径基于 ~/.agentstudio/workspace，绝对路径和 ~/ 路径按用户指定位置写入。"),
          fullPage: z.boolean().optional().describe("是否截取完整页面，默认 false。")
        },
        async (args) => safeBrowserTool(() => browserScreenshot({
          outputPath: args.outputPath,
          fullPage: args.fullPage
        }, browserEnv)),
        {
          searchHint: "浏览器 截图 screenshot PNG",
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        }
      )
    ]
  });
}

export async function webSearch(query: string, maxResults = DEFAULT_SEARCH_LIMIT, env?: BrowserEnv | null): Promise<JsonRecord> {
  if (!env) return browserRuntimeMissing();
  const limit = Math.min(Math.max(Math.trunc(maxResults || DEFAULT_SEARCH_LIMIT), 1), MAX_SEARCH_LIMIT);
  let navigationError: string | undefined;
  const bingUrl = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN&mkt=zh-CN`;
  navigationError = await navigateBrowserBestEffort(env, bingUrl, { timeoutMs: 30_000, settleMs: 3_000 });
  let extracted = await evalJson<SearchExtraction>(env, SEARCH_EXTRACTION_SCRIPT, { timeoutMs: 15_000 });
  let provider = "bing";
  if (shouldFallbackSearch(extracted)) {
    const baiduUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;
    navigationError = await navigateBrowserBestEffort(env, baiduUrl, { timeoutMs: 30_000, settleMs: 3_000 });
    extracted = await evalJson<SearchExtraction>(env, SEARCH_EXTRACTION_SCRIPT, { timeoutMs: 15_000 });
    provider = "baidu";
  }

  return {
    ok: extracted.results.length > 0,
    status: extracted.results.length > 0 ? "ok" : "no_results",
    provider,
    query,
    url: extracted.url,
    title: extracted.title,
    blocked: extracted.blocked,
    navigationError,
    results: extracted.results.slice(0, limit)
  };
}

type WebFetchOptions = {
  outputPath?: string;
  preferBrowser?: boolean;
};

export async function webFetch(url: string, options: WebFetchOptions = {}, env?: BrowserEnv | null): Promise<JsonRecord> {
  const normalizedUrl = normalizeFetchUrl(url);
  const directBrowser = options.preferBrowser === true || shouldUseBrowserDirectly(normalizedUrl);
  let fallbackReason = directBrowser ? "direct_browser_url" : "";
  let httpResult: FetchContent | null = null;

  if (!directBrowser) {
    try {
      const fetched = await fetchHttpContent(normalizedUrl);
      const validation = validateFetchContent(fetched);
      if (!validation) httpResult = fetched;
      else fallbackReason = validation;
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : String(error);
    }
  }

  if (httpResult) return writeFetchMarkdownResult(httpResult, options.outputPath);

  if (!env) {
    return {
      ...browserRuntimeMissing(),
      fallbackReason
    };
  }

  const browserResult = await fetchBrowserContent(env, normalizedUrl);
  const blockedReason = resolveFetchBlockedReason(browserResult.extracted, browserResult.navigationError);
  if (blockedReason) {
    return {
      ok: false,
      status: "blocked",
      reason: blockedReason,
      method: "browser",
      title: browserResult.extracted.title,
      url: browserResult.extracted.url,
      textPreview: browserResult.extracted.text.slice(0, 1_000),
      fallbackReason,
      navigationError: browserResult.navigationError
    };
  }
  return writeFetchMarkdownResult({
    method: "browser",
    title: browserResult.extracted.title,
    url: browserResult.extracted.url,
    html: browserResult.extracted.contentHtml || browserResult.extracted.htmlExcerpt,
    text: browserResult.extracted.text,
    metadata: browserResult.extracted.metadata,
    navigationError: browserResult.navigationError,
    fallbackReason
  }, options.outputPath);
}

async function safeBrowserTool(callback: () => Promise<JsonRecord>) {
  try {
    return jsonResult(await callback());
  } catch (error) {
    return jsonResult({ ok: false, status: "error", error: error instanceof Error ? error.message : String(error) }, true);
  }
}

type BrowserNavigateOptions = {
  waitUntil?: "domcontentloaded" | "load" | "networkidle";
  timeoutMs?: number;
  settleMs?: number;
};

export async function browserNavigate(url: string, options: BrowserNavigateOptions = {}, env?: BrowserEnv | null): Promise<JsonRecord> {
  if (!env) return browserRuntimeMissing();
  const normalizedUrl = normalizeBrowserUrl(url);
  const timeoutMs = clampTimeout(options.timeoutMs, DEFAULT_NAVIGATION_TIMEOUT_MS);
  const result = await withCdpConnection(env, timeoutMs, async (cdp) => {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const navigation = await cdp.send("Page.navigate", { url: normalizedUrl });
    const errorText = readCdpString(navigation, "errorText");
    if (errorText) throw new Error(errorText);
    clearSnapshotRefs();
    let navigationWarning: string | undefined;
    try {
      await waitForBrowserLoadState(cdp, options.waitUntil ?? "domcontentloaded", timeoutMs);
    } catch (error) {
      const summary = await getPageSummaryFromCdp(cdp);
      const currentUrl = normalizeString(summary.url);
      if (!currentUrl) throw error;
      navigationWarning = error instanceof Error ? error.message : String(error);
    }
    await delay(options.settleMs ?? 300);
    return {
      ...(await getPageSummaryFromCdp(cdp)),
      navigationWarning
    };
  });
  return {
    ok: true,
    status: "ok",
    ...result
  };
}

type BrowserSnapshotOptions = {
  selector?: string;
  maxElements?: number;
  includeHidden?: boolean;
};

type BrowserSnapshotElement = {
  ref: string;
  selector: string;
  role: string;
  name: string;
  text: string;
  tag: string;
  visible: boolean;
  enabled: boolean;
  checked?: boolean;
  value?: string;
  box?: BrowserBox;
};

type SnapshotExtraction = {
  title: string;
  url: string;
  viewport: { width: number; height: number };
  elements: Array<Omit<BrowserSnapshotElement, "ref">>;
};

export async function browserSnapshot(options: BrowserSnapshotOptions = {}, env?: BrowserEnv | null): Promise<JsonRecord> {
  if (!env) return browserRuntimeMissing();
  const maxElements = Math.min(Math.max(Math.trunc(options.maxElements || DEFAULT_SNAPSHOT_LIMIT), 1), MAX_SNAPSHOT_LIMIT);
  const extracted = await evalJson<SnapshotExtraction>(env, scriptCall(SNAPSHOT_SCRIPT, {
    selector: options.selector ?? "",
    maxElements,
    includeHidden: options.includeHidden === true
  }), { timeoutMs: DEFAULT_BROWSER_TIMEOUT_MS });
  clearSnapshotRefs();
  const elements = extracted.elements.map((element, index) => {
    const ref = `@e${index + 1}`;
    snapshotRefs.set(ref, {
      ref,
      selector: element.selector,
      url: extracted.url,
      text: element.text || element.name || element.role || element.tag
    });
    return { ref, ...element };
  });
  return {
    ok: true,
    status: "ok",
    title: extracted.title,
    url: extracted.url,
    viewport: extracted.viewport,
    elements
  };
}

type BrowserClickOptions = {
  button?: "left" | "middle" | "right";
  clickCount?: number;
  timeoutMs?: number;
};

export async function browserClick(target: BrowserTarget, options: BrowserClickOptions = {}, env?: BrowserEnv | null): Promise<JsonRecord> {
  if (!env) return browserRuntimeMissing();
  const timeoutMs = clampTimeout(options.timeoutMs);
  return withCdpConnection(env, timeoutMs, async (cdp) => {
    const resolved = await resolveBrowserTarget(cdp, target, { scrollIntoView: true, timeoutMs });
    if (!resolved.ok) return resolved;
    if (!resolved.visible) return { ok: false, status: "target_not_visible", target: resolved.target };
    if (!resolved.enabled) return { ok: false, status: "target_disabled", target: resolved.target };
    const button = options.button ?? "left";
    const clickCount = Math.min(Math.max(Math.trunc(options.clickCount || 1), 1), 3);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: resolved.center.x,
      y: resolved.center.y,
      button,
      clickCount
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: resolved.center.x,
      y: resolved.center.y,
      button,
      clickCount
    });
    return {
      ok: true,
      status: "ok",
      action: "click",
      target: resolved.target,
      url: await readPageUrl(cdp)
    };
  });
}

type BrowserFillOptions = {
  clear?: boolean;
  timeoutMs?: number;
};

export async function browserFill(target: BrowserTarget, text: string, options: BrowserFillOptions = {}, env?: BrowserEnv | null): Promise<JsonRecord> {
  if (!env) return browserRuntimeMissing();
  const timeoutMs = clampTimeout(options.timeoutMs);
  return withCdpConnection(env, timeoutMs, async (cdp) => {
    const resolved = await resolveBrowserTarget(cdp, target, { scrollIntoView: true, timeoutMs });
    if (!resolved.ok) return resolved;
    const result = await evalCdpJson<JsonRecord>(cdp, scriptCall(FILL_SCRIPT, {
      selector: resolved.target.selector,
      text,
      clear: options.clear !== false
    }));
    return {
      ...result,
      target: resolved.target
    };
  });
}

type BrowserTypeOptions = {
  delayMs?: number;
};

export async function browserType(target: BrowserTarget | undefined, text: string, options: BrowserTypeOptions = {}, env?: BrowserEnv | null): Promise<JsonRecord> {
  if (!env) return browserRuntimeMissing();
  const delayMs = Math.min(Math.max(Math.trunc(options.delayMs || 0), 0), 2_000);
  return withCdpConnection(env, DEFAULT_BROWSER_TIMEOUT_MS, async (cdp) => {
    let resolvedTarget: BrowserResolvedTarget | undefined;
    if (target) {
      const resolved = await resolveBrowserTarget(cdp, target, { scrollIntoView: true, timeoutMs: DEFAULT_BROWSER_TIMEOUT_MS });
      if (!resolved.ok) return resolved;
      resolvedTarget = resolved.target;
      await evalCdpJson<JsonRecord>(cdp, scriptCall(FOCUS_SCRIPT, { selector: resolved.target.selector }));
    }
    if (delayMs > 0) {
      for (const char of [...text]) {
        await cdp.send("Input.insertText", { text: char });
        await delay(delayMs);
      }
    } else {
      await cdp.send("Input.insertText", { text });
    }
    return { ok: true, status: "ok", action: "type", target: resolvedTarget, length: text.length };
  });
}

export async function browserPress(key: string, env?: BrowserEnv | null): Promise<JsonRecord> {
  if (!env) return browserRuntimeMissing();
  const normalized = normalizeKey(key);
  return withCdpConnection(env, DEFAULT_BROWSER_TIMEOUT_MS, async (cdp) => {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: normalized.key,
      code: normalized.code,
      windowsVirtualKeyCode: normalized.keyCode,
      nativeVirtualKeyCode: normalized.keyCode,
      text: normalized.text
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: normalized.key,
      code: normalized.code,
      windowsVirtualKeyCode: normalized.keyCode,
      nativeVirtualKeyCode: normalized.keyCode
    });
    return { ok: true, status: "ok", action: "press", key: normalized.key };
  });
}

type BrowserScrollOptions = {
  target?: BrowserTarget;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  x?: number;
  y?: number;
};

export async function browserScroll(options: BrowserScrollOptions = {}, env?: BrowserEnv | null): Promise<JsonRecord> {
  if (!env) return browserRuntimeMissing();
  const amount = Math.min(Math.max(Math.trunc(options.amount || 600), 1), 10_000);
  const delta = resolveScrollDelta(options.direction ?? "down", amount, options.x, options.y);
  return withCdpConnection(env, DEFAULT_BROWSER_TIMEOUT_MS, async (cdp) => {
    let selector = "";
    let resolvedTarget: BrowserResolvedTarget | undefined;
    if (options.target) {
      const resolved = await resolveBrowserTarget(cdp, options.target, { scrollIntoView: false, timeoutMs: DEFAULT_BROWSER_TIMEOUT_MS });
      if (!resolved.ok) return resolved;
      selector = resolved.target.selector;
      resolvedTarget = resolved.target;
    }
    const result = await evalCdpJson<JsonRecord>(cdp, scriptCall(SCROLL_SCRIPT, {
      selector,
      x: delta.x,
      y: delta.y
    }));
    return {
      ...result,
      target: resolvedTarget
    };
  });
}

type BrowserWaitOptions = {
  selector?: string;
  text?: string;
  urlIncludes?: string;
  state?: "visible" | "hidden" | "attached" | "detached" | "domcontentloaded" | "load" | "networkidle";
  timeoutMs?: number;
};

export async function browserWait(options: BrowserWaitOptions, env?: BrowserEnv | null): Promise<JsonRecord> {
  if (!env) return browserRuntimeMissing();
  const timeoutMs = clampTimeout(options.timeoutMs);
  return withCdpConnection(env, timeoutMs, async (cdp) => {
    if (!options.selector && !options.text && !options.urlIncludes && isLoadState(options.state)) {
      await waitForBrowserLoadState(cdp, options.state, timeoutMs);
      return { ok: true, status: "ok", state: options.state, ...(await getPageSummaryFromCdp(cdp)) };
    }
    const deadline = Date.now() + timeoutMs;
    let last: JsonRecord = {};
    while (Date.now() < deadline) {
      last = await evalCdpJson<JsonRecord>(cdp, scriptCall(WAIT_CHECK_SCRIPT, {
        selector: options.selector ?? "",
        text: options.text ?? "",
        urlIncludes: options.urlIncludes ?? "",
        state: options.state ?? (options.selector ? "visible" : "")
      }));
      if (last.ok === true) return { ...last, status: "ok" };
      await delay(150);
    }
    return { ok: false, status: "timeout", timeoutMs, last };
  });
}

type BrowserGetOptions = {
  target?: BrowserTarget;
  name?: string;
};

export async function browserGet(kind: "text" | "html" | "value" | "attr" | "title" | "url" | "count" | "box" | "state", options: BrowserGetOptions = {}, env?: BrowserEnv | null): Promise<JsonRecord> {
  if (!env) return browserRuntimeMissing();
  if (kind === "attr" && !options.name) return { ok: false, status: "invalid_input", reason: "attr_name_required" };
  return withCdpConnection(env, DEFAULT_BROWSER_TIMEOUT_MS, async (cdp) => {
    if (kind === "title" || kind === "url") {
      return { ok: true, status: "ok", kind, value: kind === "title" ? (await readPageTitle(cdp)) : (await readPageUrl(cdp)) };
    }
    if (!options.target) return { ok: false, status: "invalid_input", reason: "target_required" };
    if (kind === "count") {
      if (options.target.ref) {
        const resolved = await resolveBrowserTarget(cdp, options.target, { scrollIntoView: false, timeoutMs: DEFAULT_BROWSER_TIMEOUT_MS });
        if (!resolved.ok) return resolved;
        return { ok: true, status: "ok", kind: "count", value: 1, target: resolved.target };
      }
      return evalCdpJson<JsonRecord>(cdp, scriptCall(COUNT_SCRIPT, { target: normalizeTargetForScript(options.target) }));
    }
    const resolved = await resolveBrowserTarget(cdp, options.target, { scrollIntoView: false, timeoutMs: DEFAULT_BROWSER_TIMEOUT_MS });
    if (!resolved.ok) return resolved;
    const result = await evalCdpJson<JsonRecord>(cdp, scriptCall(GET_SCRIPT, {
      selector: resolved.target.selector,
      kind,
      attr: options.name ?? ""
    }));
    return {
      ...result,
      target: resolved.target
    };
  });
}

type BrowserScreenshotOptions = {
  outputPath?: string;
  fullPage?: boolean;
};

export async function browserScreenshot(options: BrowserScreenshotOptions = {}, env?: BrowserEnv | null): Promise<JsonRecord> {
  if (!env) return browserRuntimeMissing();
  const screenshotPath = resolveScreenshotOutputPath(options.outputPath);
  const base64 = await withCdpConnection(env, DEFAULT_BROWSER_TIMEOUT_MS, async (cdp) => {
    await cdp.send("Page.enable");
    if (options.fullPage === true) {
      const metrics = await cdp.send("Page.getLayoutMetrics");
      const contentSize = getRecord(metrics, "contentSize");
      const width = typeof contentSize?.width === "number" ? Math.ceil(contentSize.width) : undefined;
      const height = typeof contentSize?.height === "number" ? Math.ceil(contentSize.height) : undefined;
      const result = await cdp.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        clip: width && height ? { x: 0, y: 0, width, height, scale: 1 } : undefined
      });
      return readCdpString(result, "data");
    }
    const result = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    return readCdpString(result, "data");
  });
  if (!base64) throw new Error("screenshot_empty");
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, Buffer.from(base64, "base64"));
  return {
    ok: true,
    status: "ok",
    path: screenshotPath,
    fullPage: options.fullPage === true,
    bytes: fs.statSync(screenshotPath).size
  };
}

async function fetchBrowserContent(env: BrowserEnv, url: string): Promise<{ extracted: FetchExtraction; navigationError?: string }> {
  const navigationError = await navigateBrowserBestEffort(env, url, { timeoutMs: 30_000, settleMs: 5_000 });
  const extracted = await evalJson<FetchExtraction>(env, FETCH_EXTRACTION_SCRIPT, { timeoutMs: 15_000 });
  return {
    extracted,
    navigationError
  };
}

async function fetchHttpContent(url: string): Promise<FetchContent> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
      }
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) throw new Error(`http_status_${response.status}`);
    if (!contentType.toLowerCase().includes("text/html") && !contentType.toLowerCase().includes("application/xhtml+xml")) {
      throw new Error(`non_html_content_type:${contentType || "unknown"}`);
    }
    const html = await response.text();
    const text = htmlToText(html);
    return {
      method: "http",
      title: extractHtmlTitle(html),
      url: response.url || url,
      html,
      text
    };
  } finally {
    clearTimeout(timeout);
  }
}

function validateFetchContent(content: FetchContent): string {
  if (!content.html.trim()) return "empty_html";
  if (isVerificationText(content.text)) return "verification";
  if (content.text.trim().length < FETCH_MIN_TEXT_LENGTH) return "text_too_short";
  return "";
}

function writeFetchMarkdownResult(content: FetchContent, outputPath?: string): JsonRecord {
  const markdownPath = resolveMarkdownOutputPath(outputPath, content.url);
  const markdown = htmlToMarkdown(content.html, content);
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, markdown, "utf8");
  return {
    ok: true,
    status: "ok",
    method: content.method,
    title: content.title,
    url: content.url,
    markdownPath,
    textPreview: content.text.slice(0, 1_000),
    fallbackReason: content.fallbackReason,
    navigationError: content.navigationError
  };
}

type BrowserBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type BrowserResolvedTarget = {
  selector: string;
  role: string;
  name: string;
  text: string;
  tag: string;
  visible: boolean;
  enabled: boolean;
  box: BrowserBox;
};

type BrowserToolError = {
  ok: false;
  status: string;
  [key: string]: unknown;
};

type BrowserTargetResolution =
  | {
      ok: true;
      status: "ok";
      target: BrowserResolvedTarget;
      visible: boolean;
      enabled: boolean;
      center: { x: number; y: number };
    }
  | BrowserToolError;

function normalizeBrowserUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("browser_navigate 只支持 http/https URL");
  }
  return parsed.href;
}

function clampTimeout(timeoutMs: number | undefined, defaultTimeoutMs = DEFAULT_BROWSER_TIMEOUT_MS): number {
  return Math.min(Math.max(Math.trunc(timeoutMs || defaultTimeoutMs), 500), MAX_BROWSER_TIMEOUT_MS);
}

function clearSnapshotRefs(): void {
  snapshotRefs.clear();
}

function normalizeTargetForScript(target: BrowserTarget): JsonRecord {
  return {
    selector: target.selector ?? "",
    role: target.role ?? "",
    name: target.name ?? "",
    text: target.text ?? "",
    label: target.label ?? "",
    placeholder: target.placeholder ?? "",
    alt: target.alt ?? "",
    title: target.title ?? "",
    testId: target.testId ?? "",
    exact: target.exact === true,
    index: Math.max(Math.trunc(target.index ?? 0), 0)
  };
}

async function resolveBrowserTarget(cdp: CdpConnection, target: BrowserTarget, options: { scrollIntoView: boolean; timeoutMs: number }): Promise<BrowserTargetResolution> {
  const normalized = normalizeTargetForScript(target);
  if (target.ref) {
    const ref = snapshotRefs.get(target.ref);
    if (!ref) return { ok: false, status: "stale_ref", ref: target.ref };
    const currentUrl = await readPageUrl(cdp);
    if (currentUrl !== ref.url) return { ok: false, status: "stale_ref", ref: target.ref, refUrl: ref.url, url: currentUrl };
    normalized.selector = ref.selector;
  }

  const deadline = Date.now() + options.timeoutMs;
  let last: JsonRecord = {};
  while (Date.now() < deadline) {
    const result = await evalCdpJson<JsonRecord>(cdp, scriptCall(RESOLVE_TARGET_SCRIPT, {
      target: normalized,
      scrollIntoView: options.scrollIntoView
    }));
    last = result;
    if (result.ok === true) {
      const targetRecord = getPlainRecord(result, "target");
      const boxRecord = getPlainRecord(targetRecord, "box");
      const centerRecord = getPlainRecord(result, "center");
      if (!targetRecord || !boxRecord || !centerRecord) throw new Error("invalid_target_resolution");
      const resolvedTarget: BrowserResolvedTarget = {
        selector: readPlainString(targetRecord, "selector"),
        role: readPlainString(targetRecord, "role"),
        name: readPlainString(targetRecord, "name"),
        text: readPlainString(targetRecord, "text"),
        tag: readPlainString(targetRecord, "tag"),
        visible: targetRecord.visible === true,
        enabled: targetRecord.enabled !== false,
        box: {
          x: readPlainNumber(boxRecord, "x"),
          y: readPlainNumber(boxRecord, "y"),
          width: readPlainNumber(boxRecord, "width"),
          height: readPlainNumber(boxRecord, "height")
        }
      };
      return {
        ok: true,
        status: "ok",
        target: resolvedTarget,
        visible: resolvedTarget.visible,
        enabled: resolvedTarget.enabled,
        center: {
          x: readPlainNumber(centerRecord, "x"),
          y: readPlainNumber(centerRecord, "y")
        }
      };
    }
    if (result.status !== "target_not_found") {
      return {
        ok: false,
        status: typeof result.status === "string" ? result.status : "target_resolution_failed",
        ...result
      };
    }
    await delay(150);
  }
  return { ok: false, status: "timeout", timeoutMs: options.timeoutMs, last };
}

async function getPageSummaryFromCdp(cdp: CdpConnection): Promise<JsonRecord> {
  return {
    title: await readPageTitle(cdp),
    url: await readPageUrl(cdp)
  };
}

async function readPageTitle(cdp: CdpConnection): Promise<string> {
  const result = await cdp.send("Runtime.evaluate", {
    expression: "document.title || ''",
    returnByValue: true
  });
  return readRemoteObjectValue(result);
}

async function readPageUrl(cdp: CdpConnection): Promise<string> {
  const result = await cdp.send("Runtime.evaluate", {
    expression: "location.href",
    returnByValue: true
  });
  return readRemoteObjectValue(result);
}

function readRemoteObjectValue(result: unknown): string {
  const remoteObject = getRecord(result, "result");
  const value = remoteObject?.value;
  return typeof value === "string" ? value : "";
}

async function evalCdpJson<T>(cdp: CdpConnection, script: string): Promise<T> {
  const result = await cdp.send("Runtime.evaluate", {
    expression: script,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  const exceptionDetails = getRecord(result, "exceptionDetails");
  if (exceptionDetails) throw new Error(`浏览器脚本执行失败：${JSON.stringify(exceptionDetails).slice(0, 500)}`);
  const remoteObject = getRecord(result, "result");
  const value = remoteObject?.value;
  if (typeof value === "string") return parseJsonOutput<T>(value);
  return value as T;
}

function scriptCall(functionSource: string, args: JsonRecord): string {
  return `(${functionSource})(${JSON.stringify(args)})`;
}

async function waitForBrowserLoadState(cdp: CdpConnection, state: "domcontentloaded" | "load" | "networkidle", timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const result = await evalCdpJson<{ readyState: string; inflight: number }>(cdp, LOAD_STATE_SCRIPT);
    const readyState = result.readyState;
    const domReady = readyState === "interactive" || readyState === "complete";
    const loadReady = readyState === "complete";
    if (state === "domcontentloaded" && domReady) return;
    if (state === "load" && loadReady) return;
    if (state === "networkidle" && loadReady && result.inflight === 0) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= 500) return;
    } else {
      stableSince = 0;
    }
    await delay(150);
  }
  throw new Error("navigation_timeout");
}

function isLoadState(state: string | undefined): state is "domcontentloaded" | "load" | "networkidle" {
  return state === "domcontentloaded" || state === "load" || state === "networkidle";
}

function resolveScrollDelta(direction: "up" | "down" | "left" | "right", amount: number, x?: number, y?: number): { x: number; y: number } {
  if (typeof x === "number" || typeof y === "number") return { x: Math.trunc(x ?? 0), y: Math.trunc(y ?? 0) };
  if (direction === "up") return { x: 0, y: -amount };
  if (direction === "left") return { x: -amount, y: 0 };
  if (direction === "right") return { x: amount, y: 0 };
  return { x: 0, y: amount };
}

function normalizeKey(key: string): { key: string; code: string; keyCode: number; text?: string } {
  const normalized = key.trim();
  const named: Record<string, { key: string; code: string; keyCode: number }> = {
    Enter: { key: "Enter", code: "Enter", keyCode: 13 },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Esc: { key: "Escape", code: "Escape", keyCode: 27 },
    Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    Delete: { key: "Delete", code: "Delete", keyCode: 46 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 }
  };
  const found = named[normalized];
  if (found) return found;
  if ([...normalized].length === 1) {
    const keyCode = normalized.toUpperCase().charCodeAt(0);
    return { key: normalized, code: `Key${normalized.toUpperCase()}`, keyCode, text: normalized };
  }
  return { key: normalized, code: normalized, keyCode: 0 };
}

function resolveScreenshotOutputPath(outputPath: string | undefined): string {
  const trimmed = outputPath?.trim() ?? "";
  const expanded = trimmed === "~" ? os.homedir() : trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
  return expanded
    ? path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(DEFAULT_WORKSPACE_DIR, expanded)
    : path.join(DEFAULT_SCREENSHOT_OUTPUT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
}

function getPlainRecord(value: unknown, key: string): JsonRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const child = (value as JsonRecord)[key];
  return child && typeof child === "object" && !Array.isArray(child) ? child as JsonRecord : undefined;
}

function readPlainString(value: JsonRecord, key: string): string {
  const child = value[key];
  return typeof child === "string" ? child : "";
}

function readPlainNumber(value: JsonRecord, key: string): number {
  const child = value[key];
  return typeof child === "number" && Number.isFinite(child) ? child : 0;
}

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type SearchExtraction = {
  title: string;
  url: string;
  blocked: boolean;
  results: SearchResult[];
};

type FetchExtraction = {
  title: string;
  url: string;
  blocked: boolean;
  blockReason: string;
  text: string;
  contentHtml: string;
  htmlExcerpt: string;
  metadata?: FetchMetadata;
};

type FetchMetadata = {
  author?: string;
  publishTime?: string;
  accountName?: string;
};

type FetchContent = {
  method: "http" | "browser";
  title: string;
  url: string;
  html: string;
  text: string;
  metadata?: FetchMetadata;
  fallbackReason?: string;
  navigationError?: string;
};

export function resolveBrowserEnv(context?: ToolServerContext): BrowserEnv | null {
  const cdpWebSocketUrl = normalizeString(context?.browserAutomation?.cdpWebSocketUrl);
  const cdpPort = context?.browserAutomation?.cdpPort;
  if (!cdpWebSocketUrl) return null;
  return { cdpWebSocketUrl, cdpPort: cdpPort ? String(cdpPort) : undefined };
}

function browserRuntimeMissing(): JsonRecord {
  return {
    ok: false,
    status: "unavailable",
    reason: "browser_runtime_missing",
    message: "通用浏览器 runtime 不可用，请重新提交或打开浏览器能力后再试。"
  };
}

function shouldFallbackSearch(extracted: SearchExtraction): boolean {
  if (extracted.results.length === 0) return true;
  if (extracted.blocked) return true;
  const title = extracted.title.toLowerCase();
  return title.includes("验证码") || title.includes("安全验证");
}

function normalizeFetchUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("web_fetch 只支持 http/https URL");
  }
  return parsed.href;
}

function shouldUseBrowserDirectly(url: string): boolean {
  const parsed = new URL(url);
  return DIRECT_BROWSER_URLS.some((rule) => parsed.protocol === rule.protocol && parsed.hostname === rule.hostname);
}

function resolveFetchBlockedReason(extracted: FetchExtraction, navigationError?: string): string {
  if (extracted.blocked) return extracted.blockReason || "verification";
  const text = extracted.text.trim();
  const isWechat = (() => {
    try {
      return new URL(extracted.url).hostname === "mp.weixin.qq.com";
    } catch {
      return false;
    }
  })();
  if (isWechat && navigationError && text.length < 200) return "navigation_timeout";
  if (isWechat && text.length === 0) return "empty_content";
  return "";
}

function resolveMarkdownOutputPath(outputPath: string | undefined, url: string): string {
  const trimmed = outputPath?.trim() ?? "";
  const expanded = trimmed === "~" ? os.homedir() : trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
  return expanded
    ? path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(DEFAULT_WORKSPACE_DIR, expanded)
    : path.join(DEFAULT_FETCH_OUTPUT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${urlToFileSlug(url)}.md`);
}

function urlToFileSlug(url: string): string {
  const parsed = new URL(url);
  const raw = `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, "") || parsed.hostname;
  const slug = raw.replace(/[^A-Za-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return slug || "page";
}

function htmlToMarkdown(html: string, content: FetchContent): string {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-"
  });
  const images: Array<{ alt: string; url: string }> = [];
  service.addRule("webFetchImagePlaceholders", {
    filter: "img",
    replacement: (_innerContent, node) => {
      const image = resolveMarkdownImage(node, content.url);
      if (!image) return "";
      images.push(image);
      return `[图片 ${images.length}${image.alt ? `: ${image.alt}` : ""}]`;
    }
  });
  const body = cleanMarkdownNoise(service.turndown(sanitizeHtmlForMarkdown(html)).trim());
  const imagesMarkdown = images.length > 0
    ? [
      "",
      "## Images",
      "",
      ...images.map((image, index) => `${index + 1}. ${image.alt ? `${image.alt} - ` : ""}${image.url}`)
    ].join("\n")
    : "";
  return [
    "---",
    `title: ${yamlScalar(content.title || "Untitled")}`,
    `url: ${yamlScalar(content.url)}`,
    ...metadataFrontmatter(content.metadata),
    `fetchedAt: ${yamlScalar(new Date().toISOString())}`,
    `method: ${content.method}`,
    "---",
    "",
    `${body || content.text.trim()}${imagesMarkdown}`
  ].join("\n");
}

function metadataFrontmatter(metadata: FetchMetadata | undefined): string[] {
  if (!metadata) return [];
  const fields: string[] = [];
  if (metadata.author) fields.push(`author: ${yamlScalar(metadata.author)}`);
  if (metadata.accountName && metadata.accountName !== metadata.author) fields.push(`accountName: ${yamlScalar(metadata.accountName)}`);
  if (metadata.publishTime) fields.push(`publishTime: ${yamlScalar(metadata.publishTime)}`);
  return fields;
}

function sanitizeHtmlForMarkdown(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template\b[\s\S]*?<\/template>/gi, " ")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, (match) => shouldDropSvgForMarkdown(match) ? " " : match);
}

function shouldDropSvgForMarkdown(svg: string): boolean {
  return /<symbol\b/i.test(svg)
    || /aria-hidden\s*=\s*["']?true/i.test(svg)
    || /(?:^|[;"'\s])display\s*:\s*none/i.test(svg)
    || /(?:^|[;"'\s])position\s*:\s*absolute/i.test(svg)
    || /(?:^|[;"'\s])width\s*:\s*0(?:px)?/i.test(svg)
    || /(?:^|[;"'\s])height\s*:\s*0(?:px)?/i.test(svg)
    || /\b(?:iconfont|svgfont)\b/i.test(svg);
}

function cleanMarkdownNoise(markdown: string): string {
  return markdown
    .split(/\n/)
    .filter((line) => !isMarkdownNoiseLine(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isMarkdownNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^\(?\s*adsbygoogle\b[\s\S]*\.push\(\s*\{\s*\}\s*\)\s*;?\s*\)?$/i.test(trimmed)) return true;
  if (/^JM_SLOT_SHOW\(/.test(trimmed)) return true;
  if (/^window\.[A-Za-z0-9_$]+\s*=/.test(trimmed) && trimmed.length > 200) return true;
  if (/^function\s*\(|^\(?function\s*\(/.test(trimmed) && trimmed.length > 200) return true;
  if (looksLikeCssRuleLine(trimmed)) return true;
  return false;
}

function looksLikeCssRuleLine(value: string): boolean {
  if (value.length > 1_000) return true;
  if (!/[{};]/.test(value)) return false;
  if (!/[.#][A-Za-z0-9_-]+\s*\{/.test(value)) return false;
  return /(?:width|height|margin|padding|display|position|color|font-size|line-height)\s*:/.test(value);
}

function resolveMarkdownImage(node: HTMLElement, pageUrl: string): { alt: string; url: string } | null {
  const candidates = [
    normalizeImageSource(node.getAttribute("data-src")),
    normalizeImageSource(node.getAttribute("data-original")),
    normalizeImageSource(node.getAttribute("data-lazy-src")),
    normalizeImageSource(node.getAttribute("data-actualsrc")),
    normalizeImageSource(node.getAttribute("data-backsrc")),
    normalizeImageSource(readFirstSrcsetUrl(node.getAttribute("data-srcset"))),
    normalizeImageSource(node.getAttribute("src")),
    normalizeImageSource(readFirstSrcsetUrl(node.getAttribute("srcset"))),
  ];
  for (const rawSrc of candidates) {
    if (!rawSrc || isDiscardableImage(rawSrc, node)) continue;
    const url = absolutizeImageUrl(rawSrc, pageUrl);
    if (!url || isDiscardableImage(url, node)) continue;
    return {
      alt: cleanImageAlt(node.getAttribute("alt") || node.getAttribute("title") || ""),
      url
    };
  }
  return null;
}

function isWechatUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "mp.weixin.qq.com";
  } catch {
    return false;
  }
}

function normalizeImageSource(value: string | null): string {
  return (value ?? "").trim();
}

function readFirstSrcsetUrl(value: string | null): string {
  const first = (value ?? "").split(",").map((item) => item.trim()).find(Boolean) ?? "";
  return first.split(/\s+/)[0] ?? "";
}

function isDiscardableImage(src: string, node: HTMLElement): boolean {
  const normalized = src.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.startsWith("data:image/svg+xml")) return true;
  if (normalized.startsWith("data:")) return true;
  if (/(?:^|[/_.-])(?:placeholder|shims?|spacer|tracking|tracker|pixel|1x1|16x9)(?:[/_.-]|$)/i.test(normalized)) {
    return true;
  }
  if (/(?:^|\/)(?:theme|themes)(?:\/|$)/i.test(normalized)) return true;
  if (readPixelSize(node.getAttribute("width")) <= 1 && readPixelSize(node.getAttribute("height")) <= 1) return true;
  const style = node.getAttribute("style") ?? "";
  if (/width\s*:\s*1px/i.test(style) && /height\s*:\s*1px/i.test(style)) return true;
  const semanticHint = [
    node.getAttribute("alt"),
    node.getAttribute("title"),
    node.getAttribute("class"),
    node.getAttribute("id")
  ].filter(Boolean).join(" ").toLowerCase();
  if (/(?:^|[\s_-])(?:site[-_ ]?logo|nav[-_ ]?icon|toolbar[-_ ]?icon|avatar)(?:$|[\s_-])/i.test(semanticHint)) {
    return true;
  }
  return false;
}

function readPixelSize(value: string | null): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(value ?? "");
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function absolutizeImageUrl(src: string, pageUrl: string): string {
  try {
    return new URL(src, pageUrl).href;
  } catch {
    return "";
  }
}

function cleanImageAlt(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[[\]]/g, "").trim().slice(0, 120);
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function extractHtmlTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return decodeHtmlEntities(stripTags(match?.[1] ?? "")).trim();
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(stripTags(html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")))
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function isVerificationText(text: string): boolean {
  return /环境异常|当前环境异常|去验证|验证码|安全验证|完成验证后即可继续访问|captcha|verify/i.test(text);
}

async function navigateBrowserBestEffort(env: BrowserEnv, url: string, options: { timeoutMs: number; settleMs: number }): Promise<string | undefined> {
  try {
    await navigateBrowser(env, url, options);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function navigateBrowser(env: BrowserEnv, url: string, options: { timeoutMs: number; settleMs: number }): Promise<void> {
  await withCdpConnection(env, options.timeoutMs, async (cdp) => {
    await cdp.send("Page.enable");
    const result = await cdp.send("Page.navigate", { url });
    const errorText = readCdpString(result, "errorText");
    if (errorText) throw new Error(errorText);
    await waitForPageReady(cdp, options.timeoutMs);
    if (options.settleMs > 0) await delay(options.settleMs);
  });
}

async function evaluateBrowserScript(env: BrowserEnv, script: string, options: { timeoutMs: number }): Promise<string> {
  return withCdpConnection(env, options.timeoutMs, async (cdp) => {
    const result = await cdp.send("Runtime.evaluate", {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false
    });
    const exceptionDetails = getRecord(result, "exceptionDetails");
    if (exceptionDetails) throw new Error(`浏览器脚本执行失败：${JSON.stringify(exceptionDetails).slice(0, 500)}`);
    const remoteObject = getRecord(result, "result");
    const value = remoteObject?.value;
    if (typeof value === "string") return value;
    return JSON.stringify(value ?? null);
  });
}

async function waitForPageReady(cdp: CdpConnection, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await cdp.send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true
    });
    const remoteObject = getRecord(result, "result");
    const readyState = remoteObject?.value;
    if (readyState === "interactive" || readyState === "complete") return;
    await delay(250);
  }
  throw new Error("navigation_timeout");
}

async function withCdpConnection<T>(env: BrowserEnv, timeoutMs: number, callback: (cdp: CdpConnection) => Promise<T>): Promise<T> {
  const cdp = new CdpConnection(env.cdpWebSocketUrl, timeoutMs);
  try {
    await cdp.open();
    return await callback(cdp);
  } finally {
    cdp.close();
  }
}

type CdpMessage = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: {
    message?: string;
    data?: string;
  };
};

class CdpConnection {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number
  ) {}

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      const timer = setTimeout(() => {
        reject(new Error("cdp_connect_timeout"));
        socket.close();
      }, this.timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("message", (event) => this.handleMessage(event.data));
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("cdp_connection_error"));
      });
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        this.rejectPending(new Error("cdp_connection_closed"));
      });
    });
  }

  send(method: string, params?: JsonRecord): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("cdp_not_connected"));
    const id = this.nextId;
    this.nextId += 1;
    const payload = params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp_command_timeout:${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify(payload));
    });
  }

  close(): void {
    this.rejectPending(new Error("cdp_connection_closed"));
    this.socket?.close();
    this.socket = null;
  }

  private handleMessage(data: unknown): void {
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    let message: CdpMessage;
    try {
      message = JSON.parse(text) as CdpMessage;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(`${message.error.message ?? "cdp_error"}${message.error.data ? `: ${message.error.data}` : ""}`));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

function getRecord(value: unknown, key: string): JsonRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const child = (value as JsonRecord)[key];
  return child && typeof child === "object" && !Array.isArray(child) ? child as JsonRecord : undefined;
}

function readCdpString(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const child = (value as JsonRecord)[key];
  return typeof child === "string" ? child : "";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evalJson<T>(env: BrowserEnv, script: string, options: { timeoutMs: number }): Promise<T> {
  const stdout = await evaluateBrowserScript(env, script, options);
  return parseJsonOutput<T>(stdout);
}

function parseJsonOutput<T>(stdout: string): T {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") return JSON.parse(parsed) as T;
    return parsed as T;
  } catch {
    const match = /({[\s\S]*})\s*$/.exec(trimmed);
    if (match) return JSON.parse(match[1]) as T;
    throw new Error(`无法解析浏览器输出：${trimmed.slice(0, 500)}`);
  }
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const SEARCH_EXTRACTION_SCRIPT = `
(() => {
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const absolutize = (href) => {
    try { return new URL(href, location.href).href; } catch { return ""; }
  };
  const pageText = clean(document.body?.innerText || "");
  const blocked = /验证码|安全验证|环境异常|去验证|verify|captcha/i.test(pageText);
  const selectors = [
    ".result, .c-container, #content_left > div",
    "li.b_algo, .b_algo",
    "article, .g, .result-item"
  ];
  const nodes = Array.from(document.querySelectorAll(selectors.join(",")));
  const seen = new Set();
  const results = [];
  for (const node of nodes) {
    const anchor = node.querySelector("h3 a, a[href]");
    const title = clean(anchor?.innerText || anchor?.textContent || "");
    const url = absolutize(anchor?.getAttribute("href") || "");
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    const text = clean(node.innerText || "");
    const snippet = text.replace(title, "").trim().slice(0, 500);
    results.push({ title, url, snippet });
    if (results.length >= 12) break;
  }
  return JSON.stringify({ title: document.title || "", url: location.href, blocked, results });
})()
`;

const LOAD_STATE_SCRIPT = `
(() => {
  const entries = performance.getEntriesByType ? performance.getEntriesByType("resource") : [];
  const now = performance.now ? performance.now() : Date.now();
  const recent = Array.from(entries).filter((entry) => {
    const responseEnd = Number(entry.responseEnd || 0);
    return responseEnd > 0 && now - responseEnd < 500;
  }).length;
  return { readyState: document.readyState, inflight: recent };
})()
`;

const DOM_HELPERS_SCRIPT = `
const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
const matchesText = (value, query, exact) => {
  const source = clean(value);
  const needle = clean(query);
  if (!needle) return true;
  return exact ? source === needle : source.toLowerCase().includes(needle.toLowerCase());
};
const isVisible = (element) => {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};
const isEnabled = (element) => {
  if (!element) return false;
  return !element.disabled && element.getAttribute("aria-disabled") !== "true";
};
const roleOf = (element) => {
  const explicit = clean(element.getAttribute("role"));
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  const type = String(element.getAttribute("type") || "").toLowerCase();
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "input") {
    if (["button", "submit", "reset"].includes(type)) return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    return "textbox";
  }
  if (tag === "img") return "img";
  if (tag === "summary") return "button";
  return "";
};
const labelsFor = (element) => {
  const values = [];
  if (element.labels) {
    for (const label of Array.from(element.labels)) values.push(clean(label.innerText || label.textContent));
  }
  const id = element.id;
  if (id) {
    for (const label of Array.from(document.querySelectorAll("label[for]"))) {
      if (label.getAttribute("for") === id) values.push(clean(label.innerText || label.textContent));
    }
  }
  const parentLabel = element.closest("label");
  if (parentLabel) values.push(clean(parentLabel.innerText || parentLabel.textContent));
  return values.filter(Boolean);
};
const accessibleName = (element) => {
  const aria = clean(element.getAttribute("aria-label"));
  if (aria) return aria;
  const labelledBy = clean(element.getAttribute("aria-labelledby"));
  if (labelledBy) {
    const text = labelledBy.split(/\\s+/).map((id) => clean(document.getElementById(id)?.innerText || document.getElementById(id)?.textContent)).filter(Boolean).join(" ");
    if (text) return text;
  }
  const label = labelsFor(element)[0];
  if (label) return label;
  const alt = clean(element.getAttribute("alt"));
  if (alt) return alt;
  const title = clean(element.getAttribute("title"));
  if (title) return title;
  const placeholder = clean(element.getAttribute("placeholder"));
  if (placeholder) return placeholder;
  const value = clean(element.value);
  if (["button", "submit", "reset"].includes(String(element.getAttribute("type") || "").toLowerCase()) && value) return value;
  return clean(element.innerText || element.textContent);
};
const cssEscape = (value) => {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => "\\\\" + char);
};
const cssPath = (element) => {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return "";
  if (element.id) return "#" + cssEscape(element.id);
  const parts = [];
  let node = element;
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
    const tag = node.tagName.toLowerCase();
    let part = tag;
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
      if (sameTag.length > 1) part += ":nth-of-type(" + (sameTag.indexOf(node) + 1) + ")";
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(" > ");
};
const allElements = () => Array.from(document.querySelectorAll("*"));
const targetCandidates = (target) => {
  if (target.selector) return Array.from(document.querySelectorAll(target.selector));
  if (target.testId) return Array.from(document.querySelectorAll("[data-testid='" + cssEscape(target.testId) + "']"));
  if (target.placeholder) return Array.from(document.querySelectorAll("input[placeholder], textarea[placeholder]")).filter((element) => matchesText(element.getAttribute("placeholder"), target.placeholder, target.exact));
  if (target.alt) return Array.from(document.querySelectorAll("[alt]")).filter((element) => matchesText(element.getAttribute("alt"), target.alt, target.exact));
  if (target.title) return Array.from(document.querySelectorAll("[title]")).filter((element) => matchesText(element.getAttribute("title"), target.title, target.exact));
  if (target.label) {
    const controls = allElements().filter((element) => labelsFor(element).some((label) => matchesText(label, target.label, target.exact)));
    if (controls.length > 0) return controls;
    return Array.from(document.querySelectorAll("label")).filter((element) => matchesText(element.innerText || element.textContent, target.label, target.exact));
  }
  if (target.role) {
    return allElements().filter((element) => roleOf(element) === target.role && (!target.name || matchesText(accessibleName(element), target.name, target.exact)));
  }
  if (target.text) return allElements().filter((element) => matchesText(element.innerText || element.textContent, target.text, target.exact));
  if (target.name) return allElements().filter((element) => matchesText(accessibleName(element), target.name, target.exact));
  return [];
};
const describeElement = (element) => {
  const rect = element.getBoundingClientRect();
  const visible = isVisible(element);
  const enabled = isEnabled(element);
  const role = roleOf(element);
  const name = accessibleName(element);
  const text = clean(element.innerText || element.textContent).slice(0, 300);
  const tag = element.tagName.toLowerCase();
  const box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  const result = {
    selector: cssPath(element),
    role,
    name,
    text,
    tag,
    visible,
    enabled,
    box
  };
  if ("checked" in element) result.checked = Boolean(element.checked);
  if ("value" in element) result.value = String(element.value || "").slice(0, 300);
  return result;
};
`;

const SNAPSHOT_SCRIPT = `
({ selector, maxElements, includeHidden }) => {
  ${DOM_HELPERS_SCRIPT}
  const root = selector ? document.querySelector(selector) : document;
  if (!root) return JSON.stringify({ title: document.title || "", url: location.href, viewport: { width: innerWidth, height: innerHeight }, elements: [] });
  const query = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "summary",
    "[role]",
    "[tabindex]",
    "[contenteditable='true']",
    "[data-testid]"
  ].join(",");
  const seen = new Set();
  const elements = [];
  for (const element of Array.from(root.querySelectorAll(query))) {
    const description = describeElement(element);
    if (!includeHidden && !description.visible) continue;
    if (!description.selector || seen.has(description.selector)) continue;
    seen.add(description.selector);
    elements.push(description);
    if (elements.length >= maxElements) break;
  }
  return JSON.stringify({
    title: document.title || "",
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight },
    elements
  });
}
`;

const RESOLVE_TARGET_SCRIPT = `
({ target, scrollIntoView }) => {
  ${DOM_HELPERS_SCRIPT}
  let candidates = [];
  try {
    candidates = targetCandidates(target);
  } catch (error) {
    return JSON.stringify({ ok: false, status: "invalid_selector", error: String(error && error.message || error) });
  }
  const index = Math.max(Number(target.index || 0), 0);
  const element = candidates[index];
  if (!element) return JSON.stringify({ ok: false, status: "target_not_found" });
  if (scrollIntoView && element.scrollIntoView) element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const description = describeElement(element);
  const rect = element.getBoundingClientRect();
  const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  return JSON.stringify({ ok: true, status: "ok", target: description, center });
}
`;

const FOCUS_SCRIPT = `
({ selector }) => {
  const element = document.querySelector(selector);
  if (!element) return JSON.stringify({ ok: false, status: "target_not_found" });
  element.focus();
  return JSON.stringify({ ok: true, status: "ok" });
}
`;

const FILL_SCRIPT = `
({ selector, text, clear }) => {
  const element = document.querySelector(selector);
  if (!element) return JSON.stringify({ ok: false, status: "target_not_found" });
  element.focus();
  const value = String(text || "");
  if (element.isContentEditable) {
    if (clear) element.textContent = "";
    element.textContent = clear ? value : String(element.textContent || "") + value;
  } else if ("value" in element) {
    const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    const nextValue = clear ? value : String(element.value || "") + value;
    if (descriptor && descriptor.set) descriptor.set.call(element, nextValue);
    else element.value = nextValue;
  } else {
    return JSON.stringify({ ok: false, status: "not_editable" });
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return JSON.stringify({ ok: true, status: "ok", value: "value" in element ? String(element.value || "") : String(element.textContent || "") });
}
`;

const SCROLL_SCRIPT = `
({ selector, x, y }) => {
  const target = selector ? document.querySelector(selector) : window;
  if (!target) return JSON.stringify({ ok: false, status: "target_not_found" });
  if (target === window) window.scrollBy(Number(x || 0), Number(y || 0));
  else target.scrollBy(Number(x || 0), Number(y || 0));
  return JSON.stringify({
    ok: true,
    status: "ok",
    x: target === window ? window.scrollX : target.scrollLeft,
    y: target === window ? window.scrollY : target.scrollTop
  });
}
`;

const WAIT_CHECK_SCRIPT = `
({ selector, text, urlIncludes, state }) => {
  ${DOM_HELPERS_SCRIPT}
  if (urlIncludes && !location.href.includes(urlIncludes)) return JSON.stringify({ ok: false, reason: "url_not_matched", url: location.href });
  if (text && !clean(document.body?.innerText || document.documentElement?.textContent || "").includes(text)) return JSON.stringify({ ok: false, reason: "text_not_found" });
  if (selector) {
    let element = null;
    try {
      element = document.querySelector(selector);
    } catch (error) {
      return JSON.stringify({ ok: false, status: "invalid_selector", error: String(error && error.message || error) });
    }
    const visible = Boolean(element && isVisible(element));
    if (state === "attached" && !element) return JSON.stringify({ ok: false, reason: "not_attached" });
    if (state === "detached" && element) return JSON.stringify({ ok: false, reason: "still_attached" });
    if (state === "hidden" && visible) return JSON.stringify({ ok: false, reason: "still_visible" });
    if ((!state || state === "visible") && !visible) return JSON.stringify({ ok: false, reason: "not_visible", attached: Boolean(element) });
  }
  return JSON.stringify({ ok: true, url: location.href, title: document.title || "" });
}
`;

const GET_SCRIPT = `
({ selector, kind, attr }) => {
  ${DOM_HELPERS_SCRIPT}
  const element = document.querySelector(selector);
  if (!element) return JSON.stringify({ ok: false, status: "target_not_found" });
  const description = describeElement(element);
  let value = null;
  if (kind === "text") value = clean(element.innerText || element.textContent);
  else if (kind === "html") value = String(element.innerHTML || "");
  else if (kind === "value") value = "value" in element ? String(element.value || "") : "";
  else if (kind === "attr") value = element.getAttribute(attr);
  else if (kind === "box") value = description.box;
  else if (kind === "state") value = { visible: description.visible, enabled: description.enabled, checked: description.checked, role: description.role, name: description.name };
  else return JSON.stringify({ ok: false, status: "invalid_kind" });
  return JSON.stringify({ ok: true, status: "ok", kind, value });
}
`;

const COUNT_SCRIPT = `
({ target }) => {
  ${DOM_HELPERS_SCRIPT}
  let count = 0;
  try {
    count = targetCandidates(target).length;
  } catch (error) {
    return JSON.stringify({ ok: false, status: "invalid_selector", error: String(error && error.message || error) });
  }
  return JSON.stringify({ ok: true, status: "ok", kind: "count", value: count });
}
`;

const FETCH_EXTRACTION_SCRIPT = `
(() => {
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const isWechat = location.hostname === "mp.weixin.qq.com";
  const readText = (node) => clean(node?.innerText || node?.textContent || "");
  const readWechatText = (node) => clean(node?.textContent || node?.innerText || "");
  const firstText = (selectors) => {
    for (const selector of selectors) {
      const value = clean(document.querySelector(selector)?.textContent || "");
      if (value) return value;
    }
    return "";
  };
  const cloneContentHtml = (node) => {
    if (!node) return "";
    const clone = node.cloneNode(true);
    const style = String(clone.getAttribute("style") || "");
    const cleanedStyle = style
      .replace(/(?:^|;)\\s*visibility\\s*:\\s*hidden\\s*;?/ig, ";")
      .replace(/(?:^|;)\\s*display\\s*:\\s*none\\s*;?/ig, ";")
      .replace(/;{2,}/g, ";")
      .replace(/^;|;$/g, "")
      .trim();
    if (cleanedStyle) clone.setAttribute("style", cleanedStyle);
    else clone.removeAttribute("style");
    return String(clone.outerHTML || "");
  };
  const wechatTitle = isWechat ? firstText(["h1.rich_media_title", "h1#activity-name", "#activity-name"]) : "";
  const title = wechatTitle || document.title || "";
  const metadata = isWechat ? {
    author: firstText(["a#js_name", "span.rich_media_meta_nickname", "#js_name"]),
    accountName: firstText(["a#js_name", "span.rich_media_meta_nickname", "#js_name"]),
    publishTime: firstText(["em#publish_time", "#publish_time"])
  } : {};
  const body = document.body;
  const text = clean(body?.innerText || "");
  const htmlExcerpt = String(document.documentElement?.outerHTML || "").slice(0, ${FETCH_HTML_LIMIT});
  const verification = /环境异常|当前环境异常|去验证|验证码|安全验证|完成验证后即可继续访问|captcha|verify/i.test(text);
  const wechatBlocked = isWechat && verification;
  const blocked = verification || wechatBlocked;
  const blockReason = blocked ? "verification" : "";
  const wechatContent = isWechat ? document.querySelector("#js_content") || document.querySelector(".rich_media_content") : null;
  const candidates = Array.from(document.querySelectorAll("article, main, #js_content, .rich_media_content, .article, .content"));
  const scored = candidates
    .map((node) => ({ text: readText(node), html: String(node.outerHTML || "") }))
    .sort((a, b) => b.text.length - a.text.length)[0];
  const best = wechatContent ? readWechatText(wechatContent) : scored?.text || "";
  const contentHtml = wechatContent ? cloneContentHtml(wechatContent) : scored?.html || String(document.body?.outerHTML || document.documentElement?.outerHTML || "");
  return JSON.stringify({
    title,
    url: location.href,
    blocked,
    blockReason,
    text: wechatContent ? best : best && best.length > 200 ? best : text,
    contentHtml,
    htmlExcerpt,
    metadata
  });
})()
`;

export const __test__ = {
  htmlToMarkdown,
  metadataFrontmatter,
  isWechatUrl
};
