import { createSdkMcpServer, tool } from "../../runtime";
import { WebSocket } from "undici";
import { z } from "zod/v4";

type JsonRecord = Record<string, unknown>;

type BrowserEnv = {
  cdpWebSocketUrl: string;
  cdpPort: string;
};

type ToolServerContext = {
  browserAutomation?: {
    cdpPort: number;
    cdpWebSocketUrl: string;
  };
};

type ResearchStatus = "ok" | "no_results" | "blocked" | "auth_required" | "upstream_error" | "unavailable";
type Transport = "http" | "browser";

type ResearchItem = {
  id: string;
  source: string;
  tier: "global" | "keyword" | "competitor";
  title: string;
  url: string;
  rank: number;
  hotValue?: number | null;
  hotText?: string;
  summary?: string;
  sourceAccount?: string;
  publishedAtText?: string;
  raw?: unknown;
};

type ResearchResult = {
  ok: boolean;
  status: ResearchStatus;
  source: string;
  transport: Transport;
  fetchedAt: string;
  items: ResearchItem[];
  warnings?: string[];
  error?: string;
};

const GLOBAL_SOURCES = [
  "weibo_hot",
  "toutiao_hot",
  "baidu_hot",
  "36kr_news",
  "36kr_hot"
] as const;

const KEYWORD_SOURCES = [
  "36kr_search",
  "wechat_sogou_search"
] as const;

const COMPETITOR_SOURCES = [
  "wechat_account",
  "36kr_author_or_keyword"
] as const;

type GlobalSource = typeof GLOBAL_SOURCES[number];
type KeywordSource = typeof KEYWORD_SOURCES[number];
type CompetitorSource = typeof COMPETITOR_SOURCES[number];

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const HTTP_TIMEOUT_MS = 15_000;
const BROWSER_NAVIGATION_TIMEOUT_MS = 30_000;
const BROWSER_EVALUATION_TIMEOUT_MS = 15_000;

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

let browserQueue: Promise<unknown> = Promise.resolve();

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
    name: "content_research",
    tools: [
      tool(
        "fetch_global_hotspots",
        "抓取单个平台的公开泛热点。每次只访问一个 source，不要求登录态。",
        {
          source: z.enum(GLOBAL_SOURCES).describe("热点源。"),
          limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("返回条数，默认 20，最多 50。")
        },
        async (args) => {
          try {
            return jsonResult(await fetchGlobalHotspots(args.source, args.limit, browserEnv));
          } catch (error) {
            return jsonResult(errorResult(args.source, "http", error), true);
          }
        },
        {
          searchHint: "热点 热搜 泛热点 微博 头条 百度 知乎 36kr",
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true
          }
        }
      ),
      tool(
        "search_keyword_hotspots",
        "围绕关键词搜索公开内容热点。每次只访问一个 source，不要求登录态。",
        {
          source: z.enum(KEYWORD_SOURCES).describe("关键词热点源。"),
          keyword: z.string().min(1).describe("搜索关键词。"),
          limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("返回条数，默认 20，最多 50。")
        },
        async (args) => {
          try {
            return jsonResult(await searchKeywordHotspots(args.source, args.keyword, args.limit, browserEnv));
          } catch (error) {
            return jsonResult(errorResult(args.source, needsBrowser(args.source) ? "browser" : "http", error), true);
          }
        },
        {
          searchHint: "关键词热点 垂类热点 搜索热点 公众号 搜狗微信 微博 36kr 知乎",
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true
          }
        }
      ),
      tool(
        "fetch_competitor_content",
        "抓取竞品账号、品牌或作者的公开内容候选。不要求登录态，不读取后台数据。",
        {
          source: z.enum(COMPETITOR_SOURCES).describe("竞品内容源。"),
          identifier: z.string().min(1).describe("竞品账号名、品牌名、作者名或关键词。"),
          limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("返回条数，默认 20，最多 50。")
        },
        async (args) => {
          try {
            return jsonResult(await fetchCompetitorContent(args.source, args.identifier, args.limit, browserEnv));
          } catch (error) {
            return jsonResult(errorResult(args.source, args.source === "wechat_account" ? "http" : "browser", error), true);
          }
        },
        {
          searchHint: "竞品调研 竞品账号 公众号竞品 品牌内容 作者文章",
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true
          }
        }
      )
    ]
  });
}

export async function fetchGlobalHotspots(source: GlobalSource, rawLimit = DEFAULT_LIMIT, browserEnv?: BrowserEnv | null): Promise<ResearchResult> {
  const limit = normalizeLimit(rawLimit);
  switch (source) {
    case "weibo_hot":
      return fetchWeiboHot(limit);
    case "toutiao_hot":
      return fetchToutiaoHot(limit);
    case "baidu_hot":
      return fetchBaiduHot(limit);
    case "36kr_news":
      return fetch36krNews(limit);
    case "36kr_hot":
      return withBrowserQueue(() => fetch36krHot(limit, browserEnv));
  }
}

export async function searchKeywordHotspots(source: KeywordSource, keyword: string, rawLimit = DEFAULT_LIMIT, browserEnv?: BrowserEnv | null): Promise<ResearchResult> {
  const limit = normalizeLimit(rawLimit);
  const query = requireText(keyword, "keyword");
  switch (source) {
    case "36kr_search":
      return withBrowserQueue(() => search36kr(query, limit, "keyword", browserEnv));
    case "wechat_sogou_search":
      return searchWechatSogou(query, limit, "keyword", browserEnv);
  }
}

export async function fetchCompetitorContent(source: CompetitorSource, identifier: string, rawLimit = DEFAULT_LIMIT, browserEnv?: BrowserEnv | null): Promise<ResearchResult> {
  const limit = normalizeLimit(rawLimit);
  const query = requireText(identifier, "identifier");
  switch (source) {
    case "wechat_account":
      return searchWechatSogou(query, limit, "competitor", browserEnv);
    case "36kr_author_or_keyword":
      return withBrowserQueue(() => search36kr(query, limit, "competitor", browserEnv));
  }
}

async function fetchWeiboHot(limit: number): Promise<ResearchResult> {
  const source = "weibo_hot";
  const payload = await fetchJson("https://weibo.com/ajax/statuses/hot_band", {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json",
      "Referer": "https://weibo.com/"
    }
  });
  const data = asRecord(payload.data);
  const list = asArray(data.band_list);
  const items = list
    .map((item, index) => {
      const record = asRecord(item);
      const title = cleanText(record.word);
      if (!title) return null;
      return normalizeItem({
        source,
        tier: "global",
        rank: Number(record.realpos) || index + 1,
        title,
        url: `https://s.weibo.com/weibo?q=${encodeURIComponent(`#${title}#`)}`,
        hotValue: toNumber(record.num),
        hotText: cleanText(record.label_name || record.category),
        raw: record
      });
    })
    .filter(isResearchItem)
    .slice(0, limit);
  return resultFromItems(source, "http", items);
}

async function fetchToutiaoHot(limit: number): Promise<ResearchResult> {
  const source = "toutiao_hot";
  const payload = await fetchJson("https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc", {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json",
      "Referer": "https://www.toutiao.com/"
    }
  });
  const list = Array.isArray(payload.data) ? payload.data : [];
  const items = list
    .map((item, index) => {
      const title = cleanText(item?.Title);
      if (!title) return null;
      return normalizeItem({
        source,
        tier: "global",
        rank: index + 1,
        title,
        url: cleanText(item?.Url),
        hotValue: toNumber(item?.HotValue),
        hotText: cleanText(item?.Label),
        summary: cleanText(item?.QueryWord),
        raw: item
      });
    })
    .filter(isResearchItem)
    .slice(0, limit);
  return resultFromItems(source, "http", items);
}

async function fetchBaiduHot(limit: number): Promise<ResearchResult> {
  const source = "baidu_hot";
  const payload = await fetchJson("https://top.baidu.com/api/board?platform=wise&tab=realtime", {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json, text/plain, */*",
      "Referer": "https://top.baidu.com/"
    }
  });
  const data = asRecord(payload.data);
  const cards = asArray(data.cards);
  const rows: unknown[] = [];
  for (const card of cards) {
    const content = Array.isArray((card as JsonRecord).content) ? (card as JsonRecord).content as unknown[] : [];
    for (const block of content) {
      const entries = block && typeof block === "object" && Array.isArray((block as JsonRecord).content)
        ? (block as JsonRecord).content as unknown[]
        : [];
      rows.push(...entries);
    }
  }
  const items = rows
    .map((item, index) => {
      const record = item as JsonRecord;
      const title = cleanText(record.word);
      if (!title) return null;
      return normalizeItem({
        source,
        tier: "global",
        rank: index + 1,
        title,
        url: cleanText(record.url) || `https://www.baidu.com/s?wd=${encodeURIComponent(title)}`,
        hotValue: toNumber(record.hotScore),
        summary: cleanText(record.desc),
        raw: record
      });
    })
    .filter(isResearchItem)
    .slice(0, limit);
  return resultFromItems(source, "http", items);
}

async function fetch36krNews(limit: number): Promise<ResearchResult> {
  const source = "36kr_news";
  const text = await fetchText("https://www.36kr.com/feed", {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/rss+xml, application/xml, text/xml, */*"
    }
  });
  const items: ResearchItem[] = [];
  for (const block of matchAll(text, /<item>([\s\S]*?)<\/item>/g).map((match) => match[1])) {
    if (items.length >= limit) break;
    const title = decodeHtmlEntities(readXmlTag(block, "title"));
    if (!title) continue;
    const link = decodeHtmlEntities(readXmlTag(block, "link"));
    const summary = htmlToPlainText(readXmlTag(block, "description")).slice(0, 240);
    const date = cleanText(readXmlTag(block, "pubDate"));
    items.push(normalizeItem({
      source,
      tier: "global",
      rank: items.length + 1,
      title,
      url: link,
      summary,
      publishedAtText: date
    }));
  }
  return resultFromItems(source, "http", items);
}

async function fetch36krHot(limit: number, env?: BrowserEnv | null): Promise<ResearchResult> {
  const source = "36kr_hot";
  if (!env) return browserRuntimeMissing(source);
  const navigationError = await navigateBrowserBestEffort(env, "https://www.36kr.com/hot-list/catalog", {
    timeoutMs: BROWSER_NAVIGATION_TIMEOUT_MS,
    settleMs: 3_000
  });
  const extracted = await evalJson<BrowserListExtraction>(env, THIRTY_SIX_KR_HOT_SCRIPT(limit), { timeoutMs: BROWSER_EVALUATION_TIMEOUT_MS });
  if (extracted.blocked) return blockedResult(source, "browser", extracted.blockReason || "blocked", navigationError);
  const items = extracted.items
    .map((item, index) => normalizeItem({
      source,
      tier: "global",
      rank: item.rank || index + 1,
      title: item.title,
      url: item.url,
      summary: item.summary,
      publishedAtText: item.publishedAtText
    }))
    .filter(isResearchItem)
    .slice(0, limit);
  return resultFromItems(source, "browser", items, navigationError ? [navigationError] : undefined);
}

async function search36kr(keyword: string, limit: number, tier: "keyword" | "competitor", env?: BrowserEnv | null): Promise<ResearchResult> {
  const source = tier === "keyword" ? "36kr_search" : "36kr_author_or_keyword";
  if (!env) return browserRuntimeMissing(source);
  const url = `https://www.36kr.com/search/articles/${encodeURIComponent(keyword)}`;
  const navigationError = await navigateBrowserBestEffort(env, url, { timeoutMs: BROWSER_NAVIGATION_TIMEOUT_MS, settleMs: 3_000 });
  const extracted = await evalJson<BrowserListExtraction>(env, THIRTY_SIX_KR_SEARCH_SCRIPT(limit), { timeoutMs: BROWSER_EVALUATION_TIMEOUT_MS });
  if (extracted.blocked) return blockedResult(source, "browser", extracted.blockReason || "blocked", navigationError);
  const items = extracted.items
    .map((item, index) => normalizeItem({
      source,
      tier,
      rank: item.rank || index + 1,
      title: item.title,
      url: item.url,
      summary: item.summary,
      publishedAtText: item.publishedAtText
    }))
    .filter(isResearchItem)
    .slice(0, limit);
  return resultFromItems(source, "browser", items, navigationError ? [navigationError] : undefined);
}

async function searchWechatSogou(keyword: string, limit: number, tier: "keyword" | "competitor", env?: BrowserEnv | null): Promise<ResearchResult> {
  const source = tier === "keyword" ? "wechat_sogou_search" : "wechat_account";
  const url = `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(keyword)}&ie=utf8`;
  let httpResult: ResearchResult | null = null;
  try {
    const html = await fetchText(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://weixin.sogou.com/"
      }
    });
    const parsed = parseSogouWechatHtml(html, source, tier, limit);
    httpResult = parsed;
    if (parsed.status === "blocked") return parsed;
    if (parsed.items.length > 0) return parsed;
  } catch {
    // Fall through to browser fallback below.
  }

  if (!env) return httpResult ?? browserRuntimeMissing(source);
  const navigationError = await navigateBrowserBestEffort(env, url, { timeoutMs: BROWSER_NAVIGATION_TIMEOUT_MS, settleMs: 3_000 });
  const extracted = await evalJson<BrowserListExtraction>(env, SOGOU_WECHAT_SCRIPT(limit), { timeoutMs: BROWSER_EVALUATION_TIMEOUT_MS });
  if (extracted.blocked) return blockedResult(source, "browser", extracted.blockReason || "blocked", navigationError);
  const items = extracted.items
    .map((item, index) => normalizeItem({
      source,
      tier,
      rank: item.rank || index + 1,
      title: item.title,
      url: item.url,
      summary: item.summary,
      sourceAccount: item.sourceAccount,
      publishedAtText: item.publishedAtText
    }))
    .filter(isResearchItem)
    .slice(0, limit);
  return resultFromItems(source, "browser", items, navigationError ? [navigationError] : undefined);
}

function parseSogouWechatHtml(html: string, source: string, tier: "keyword" | "competitor", limit: number): ResearchResult {
  const text = htmlToPlainText(html);
  if (looksBlocked(text) || /antispider|请输入验证码|验证码/i.test(html)) {
    return {
      ok: false,
      status: "blocked",
      source,
      transport: "http",
      fetchedAt: new Date().toISOString(),
      items: [],
      warnings: ["sogou_wechat_blocked_or_verification"]
    };
  }

  const blocks = matchAll(html, /<li\b[^>]*>([\s\S]*?)<\/li>/gi)
    .map((match) => match[1])
    .filter((block) => /txt-box|news-box|account|sogou_vr_11002601/i.test(block));
  const items: ResearchItem[] = [];
  for (const block of blocks) {
    if (items.length >= limit) break;
    const anchorMatch = /<h[34]\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h[34]>/i.exec(block)
      ?? /<a\b[^>]*id=["'][^"']*title[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block)
      ?? /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!anchorMatch) continue;
    const title = htmlToPlainText(anchorMatch[2]);
    if (!title) continue;
    const rawUrl = decodeHtmlEntities(anchorMatch[1]);
    const summary = htmlToPlainText(/<p\b[^>]*class=["'][^"']*txt-info[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? "");
    const sourceAccount = htmlToPlainText(/<a\b[^>]*class=["'][^"']*account[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ?? /<span\b[^>]*class=["'][^"']*all-time-y2[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1] ?? "");
    const publishedAtText = htmlToPlainText(/(?:time|date)["'][^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1] ?? "");
    items.push(normalizeItem({
      source,
      tier,
      rank: items.length + 1,
      title,
      url: absolutize(rawUrl, "https://weixin.sogou.com/"),
      summary,
      sourceAccount,
      publishedAtText
    }));
  }
  return resultFromItems(source, "http", dedupeItems(items).slice(0, limit));
}

async function fetchJson(url: string, init?: RequestInit): Promise<JsonRecord> {
  const text = await fetchText(url, init);
  try {
    return JSON.parse(text) as JsonRecord;
  } catch (error) {
    throw new Error(`malformed_json:${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`http_status_${response.status}:${text.slice(0, 200)}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function resultFromItems(source: string, transport: Transport, items: ResearchItem[], warnings?: string[]): ResearchResult {
  const deduped = dedupeItems(items);
  return {
    ok: deduped.length > 0,
    status: deduped.length > 0 ? "ok" : "no_results",
    source,
    transport,
    fetchedAt: new Date().toISOString(),
    items: deduped,
    ...(warnings?.length ? { warnings } : {})
  };
}

function blockedResult(source: string, transport: Transport, reason: string, navigationError?: string): ResearchResult {
  const authRequired = /login|登录|auth|401|403/i.test(reason);
  return {
    ok: false,
    status: authRequired ? "auth_required" : "blocked",
    source,
    transport,
    fetchedAt: new Date().toISOString(),
    items: [],
    warnings: [reason, ...(navigationError ? [navigationError] : [])]
  };
}

function errorResult(source: string, transport: Transport, error: unknown): ResearchResult {
  return {
    ok: false,
    status: "upstream_error",
    source,
    transport,
    fetchedAt: new Date().toISOString(),
    items: [],
    error: error instanceof Error ? error.message : String(error)
  };
}

function browserRuntimeMissing(source: string): ResearchResult {
  return {
    ok: false,
    status: "unavailable",
    source,
    transport: "browser",
    fetchedAt: new Date().toISOString(),
    items: [],
    warnings: ["browser_runtime_missing"]
  };
}

function normalizeItem(input: Omit<ResearchItem, "id">): ResearchItem {
  const title = cleanText(input.title);
  const url = cleanText(input.url);
  return {
    ...input,
    id: stableId(`${input.source}:${title}:${url}`),
    title,
    url,
    rank: Number.isFinite(input.rank) && input.rank > 0 ? Math.trunc(input.rank) : 1,
    summary: cleanText(input.summary),
    sourceAccount: cleanText(input.sourceAccount),
    publishedAtText: cleanText(input.publishedAtText),
    hotText: cleanText(input.hotText),
    hotValue: input.hotValue === undefined ? undefined : input.hotValue
  };
}

function isResearchItem(value: ResearchItem | null): value is ResearchItem {
  return Boolean(value?.title);
}

function dedupeItems(items: ResearchItem[]): ResearchItem[] {
  const seen = new Set<string>();
  const output: ResearchItem[] = [];
  for (const item of items) {
    const key = `${item.title.toLowerCase()}::${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function normalizeLimit(value: unknown): number {
  const parsed = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(parsed), MAX_LIMIT));
}

function requireText(value: string, field: string): string {
  const trimmed = cleanText(value);
  if (!trimmed) throw new Error(`${field}_required`);
  return trimmed;
}

function cleanText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function toNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function htmlToPlainText(value: string): string {
  return decodeHtmlEntities(value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)));
}

function readXmlTag(block: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(block);
  return cleanText(match?.[1] ?? "");
}

function matchAll(value: string, regex: RegExp): RegExpMatchArray[] {
  return Array.from(value.matchAll(regex));
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function absolutize(url: string, baseUrl: string): string {
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return "";
  }
}

function stableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function needsBrowser(source: string): boolean {
  return source !== "wechat_sogou_search";
}

function looksBlocked(text: string): boolean {
  return /验证码|安全验证|环境异常|去验证|身份未经过验证|登录后|请登录|captcha|verify|authentication/i.test(text);
}

export function resolveBrowserEnv(context?: ToolServerContext): BrowserEnv | null {
  const cdpWebSocketUrl = cleanText(context?.browserAutomation?.cdpWebSocketUrl);
  const cdpPort = context?.browserAutomation?.cdpPort;
  if (!cdpWebSocketUrl || !cdpPort) return null;
  return { cdpWebSocketUrl, cdpPort: String(cdpPort) };
}

function withBrowserQueue<T>(callback: () => Promise<T>): Promise<T> {
  const next = browserQueue.then(callback, callback);
  browserQueue = next.catch(() => undefined);
  return next;
}

type BrowserListItem = {
  rank?: number;
  title: string;
  url: string;
  hotValue?: number;
  hotText?: string;
  summary?: string;
  sourceAccount?: string;
  publishedAtText?: string;
};

type BrowserListExtraction = {
  blocked: boolean;
  blockReason: string;
  items: BrowserListItem[];
};

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

async function evalJson<T>(env: BrowserEnv, script: string, options: { timeoutMs: number }): Promise<T> {
  const stdout = await evaluateBrowserScript(env, script, options);
  return parseJsonOutput<T>(stdout);
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

function genericBrowserListScript(options: {
  limit: number;
  itemSelectors: string[];
  titleSelectors: string[];
  urlSelectors?: string[];
  summarySelectors?: string[];
  accountSelectors?: string[];
  timeSelectors?: string[];
}) {
  return `
(() => {
  const limit = ${JSON.stringify(options.limit)};
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const absolutize = (href) => {
    try { return new URL(href, location.href).href; } catch { return ""; }
  };
  const pageText = clean(document.body?.innerText || "");
  const blocked = /验证码|安全验证|环境异常|去验证|身份未经过验证|登录后|请登录|captcha|verify|authentication/i.test(pageText);
  const blockReason = blocked ? pageText.slice(0, 160) : "";
  const first = (node, selectors) => {
    for (const selector of selectors) {
      const found = node.querySelector(selector);
      const text = clean(found?.innerText || found?.textContent || "");
      if (text) return text;
    }
    return "";
  };
  const firstHref = (node, selectors) => {
    for (const selector of selectors) {
      const found = node.querySelector(selector);
      const href = found?.getAttribute?.("href") || "";
      if (href) return absolutize(href);
    }
    return "";
  };
  const nodes = Array.from(document.querySelectorAll(${JSON.stringify(options.itemSelectors.join(","))}));
  const seen = new Set();
  const items = [];
  for (const node of nodes) {
    const title = first(node, ${JSON.stringify(options.titleSelectors)});
    const url = firstHref(node, ${JSON.stringify(options.urlSelectors || ["a[href]"])});
    if (!title || seen.has(title + url)) continue;
    seen.add(title + url);
    items.push({
      rank: items.length + 1,
      title,
      url,
      summary: first(node, ${JSON.stringify(options.summarySelectors || [])}),
      sourceAccount: first(node, ${JSON.stringify(options.accountSelectors || [])}),
      publishedAtText: first(node, ${JSON.stringify(options.timeSelectors || [])})
    });
    if (items.length >= limit) break;
  }
  return JSON.stringify({ blocked, blockReason, items });
})()
`;
}

const THIRTY_SIX_KR_HOT_SCRIPT = (limit: number) => thirtySixKrArticleLinksScript(limit);

const THIRTY_SIX_KR_SEARCH_SCRIPT = (limit: number) => thirtySixKrArticleLinksScript(limit);

const SOGOU_WECHAT_SCRIPT = (limit: number) => genericBrowserListScript({
  limit,
  itemSelectors: ["li", ".news-list li", ".txt-box"],
  titleSelectors: ["h3 a", "h4 a", "a"],
  urlSelectors: ["h3 a[href]", "h4 a[href]", "a[href]"],
  summarySelectors: [".txt-info", "p"],
  accountSelectors: [".account", "[class*='account']"],
  timeSelectors: ["[class*='time']", "[class*='date']", "span"]
});

function thirtySixKrArticleLinksScript(limit: number): string {
  return `
(() => {
  const limit = ${JSON.stringify(limit)};
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const pageText = clean(document.body?.innerText || "");
  const blocked = /验证码|安全验证|环境异常|去验证|captcha|verify/i.test(pageText);
  if (blocked) return JSON.stringify({ blocked: true, blockReason: pageText.slice(0, 160), items: [] });
  const links = Array.from(document.querySelectorAll("a[href*='/p/']"));
  const byUrl = new Map();
  for (const link of links) {
    const href = link.getAttribute("href") || "";
    let url = "";
    try { url = new URL(href, location.href).href; } catch {}
    if (!/\\/p\\/\\d+/.test(url)) continue;
    const text = clean(link.innerText || link.textContent || "");
    if (!text || text.length < 8) continue;
    if (/核心服务|查看完整榜单|寻求报道|我要入驻|城市合作/.test(text)) continue;
    const existing = byUrl.get(url);
    if (!existing || text.length > existing.title.length) {
      byUrl.set(url, { title: text, url });
    }
  }
  const items = Array.from(byUrl.values()).slice(0, limit).map((item, index) => ({
    rank: index + 1,
    title: item.title,
    url: item.url
  }));
  return JSON.stringify({ blocked: false, blockReason: "", items });
})()
`;
}
