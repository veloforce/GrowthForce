import { createSdkMcpServer, tool } from "../../runtime";
import fs from "node:fs";
import path from "node:path";
import TurndownService from "turndown";
import { z } from "zod/v4";

type WechatCredentials = { appId: string; secret: string };
type WechatRuntime = WechatCredentials & { author: string };
type ToolServerContext = { wechatConnector?: WechatRuntime };
type JsonRecord = Record<string, unknown>;
type DraftPublishInput = {
  title: string;
  digest?: string;
  contentHtmlPath: string;
  coverPath: string;
  author?: string;
  openComment?: boolean;
  fansOnlyComment?: boolean;
};

const API_ROOT = "https://api.weixin.qq.com";
const API_TIMEOUT_MS = 30_000;
const MAX_METRICS_DAYS = 7;
const MAX_PUBLISHED_ARTICLES = 20;

function jsonResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    isError
  };
}

export function createServer(context?: ToolServerContext) {
  const runtime = resolveWechatRuntime(context);
  return createSdkMcpServer({
    name: "wechat_ops",
    tools: [
      tool(
        "wechat_metrics_fetch",
        "使用公众号数据分析 API 拉取最近若干天的原始文章指标；不匹配 Run、不写历史、不生成复盘。",
        {
          days: z.number().int().min(1).max(MAX_METRICS_DAYS).optional().describe("向前读取的完整自然日数量，默认 3，最多 7。")
        },
        async (args) => invoke(() => fetchWechatMetrics(args.days, runtime)),
        readOnlyAnnotations("公众号 微信 指标 数据分析 原始数据")
      ),
      tool(
        "wechat_published_articles_fetch",
        "读取公众号已成功发布的消息列表及文章正文；接口可能因账号认证、权限、凭据、IP 白名单或微信侧限制失败。",
        {
          offset: z.number().int().min(0).optional().describe("发布消息偏移量，默认 0。"),
          count: z.number().int().min(1).max(MAX_PUBLISHED_ARTICLES).optional().describe("返回发布消息数量，默认 10，最多 20。"),
          includeContent: z.boolean().optional().describe("是否返回并转换文章正文，默认 true。")
        },
        async (args) => invoke(() => fetchWechatPublishedArticles(args.offset, args.count, args.includeContent, runtime)),
        readOnlyAnnotations("公众号 微信 已发布文章 发布记录 正文 历史")
      ),
      tool(
        "wechat_draft_get",
        "按 mediaId 读取公众号草稿箱内容，返回原始字段、正文 HTML 和规范化 Markdown；不写文件。",
        {
          mediaId: z.string().min(1).describe("微信草稿箱 media_id。")
        },
        async (args) => invoke(() => fetchWechatDraft(args.mediaId, runtime)),
        readOnlyAnnotations("公众号 微信 草稿箱 草稿 读取 media_id")
      ),
      tool(
        "wechat_draft_publish",
        "将已排版校验的公众号 HTML 发布到草稿箱；上传正文中的本地图片和封面，不正式发布、不写生命周期数据。",
        {
          title: z.string().min(1).max(64).describe("公众号文章标题。"),
          digest: z.string().max(120).optional().describe("可选摘要。"),
          contentHtmlPath: z.string().min(1).describe("已排版公众号正文 HTML 文件的绝对路径。"),
          coverPath: z.string().min(1).describe("封面图片绝对路径。"),
          author: z.string().max(32).optional().describe("可选作者。"),
          openComment: z.boolean().optional().describe("是否开放评论，默认 false。"),
          fansOnlyComment: z.boolean().optional().describe("是否仅粉丝可评论，默认 false。")
        },
        async (args) => invoke(() => publishWechatDraft(args, runtime)),
        writeAnnotations("公众号 微信 草稿箱 推送 发布 HTML")
      )
    ]
  });
}

async function invoke(callback: () => unknown | Promise<unknown>) {
  try {
    return jsonResult(await callback());
  } catch (error) {
    return jsonResult({ ok: false, error: error instanceof Error ? error.message : String(error) }, true);
  }
}

function readOnlyAnnotations(searchHint: string) {
  return {
    searchHint,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  };
}

function writeAnnotations(searchHint: string) {
  return {
    searchHint,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  };
}

export function resolveWechatRuntime(context?: ToolServerContext): WechatRuntime | null {
  const appId = context?.wechatConnector?.appId?.trim() ?? "";
  const secret = context?.wechatConnector?.secret?.trim() ?? "";
  const author = context?.wechatConnector?.author?.trim() ?? "";
  if (!appId || !secret) return null;
  return { appId, secret, author };
}

export function readWechatCredentials(runtime?: WechatRuntime | null): WechatCredentials {
  const appId = runtime?.appId?.trim() ?? "";
  const secret = runtime?.secret?.trim() ?? "";
  if (!appId || !secret) {
    throw new Error("缺少公众号凭据：需要 turn scoped WECHAT_APPID 和 WECHAT_SECRET");
  }
  return { appId, secret };
}

export function validateDraftPublishInput(input: DraftPublishInput, runtime?: WechatRuntime | null): Required<Omit<DraftPublishInput, "author">> & { author: string; contentHtml: string } {
  const title = input.title?.trim() ?? "";
  const digest = input.digest?.trim() ?? "";
  const contentHtmlPath = input.contentHtmlPath?.trim() ?? "";
  const coverPath = input.coverPath?.trim() ?? "";
  const author = input.author?.trim() || runtime?.author?.trim() || "";
  if (!title) throw new Error("title 不能为空");
  if (title.length > 64) throw new Error("title 不能超过 64 个字符");
  if (digest.length > 120) throw new Error("digest 不能超过 120 个字符");
  requireAbsoluteFile(contentHtmlPath, "contentHtmlPath");
  const contentHtml = fs.readFileSync(contentHtmlPath, "utf8").trim();
  if (!contentHtml) throw new Error("contentHtmlPath 指向的文件内容不能为空");
  if (input.fansOnlyComment && !input.openComment) {
    throw new Error("fansOnlyComment=true 时必须同时设置 openComment=true");
  }
  requireAbsoluteFile(coverPath, "coverPath");
  for (const imagePath of extractLocalImagePaths(contentHtml)) {
    requireAbsoluteFile(imagePath, "contentHtml 本地图片");
  }
  return {
    title,
    digest,
    contentHtmlPath,
    contentHtml,
    coverPath,
    author,
    openComment: Boolean(input.openComment),
    fansOnlyComment: Boolean(input.fansOnlyComment)
  };
}

export function extractLocalImagePaths(contentHtml: string): string[] {
  const paths = new Set<string>();
  for (const match of contentHtml.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const source = match[1].trim();
    if (!source || /^(?:https?:|data:|\/\/)/i.test(source)) continue;
    paths.add(source);
  }
  return [...paths];
}

export async function publishWechatDraft(input: DraftPublishInput, runtime?: WechatRuntime | null) {
  const publishPackage = validateDraftPublishInput(input, runtime);
  const token = await getAccessToken(readWechatCredentials(runtime));
  let contentHtml = publishPackage.contentHtml;
  const uploadedImages: Array<{ localPath: string; url: string }> = [];
  for (const imagePath of extractLocalImagePaths(contentHtml)) {
    const url = await uploadContentImage(token, imagePath);
    contentHtml = replaceImageSource(contentHtml, imagePath, url);
    uploadedImages.push({ localPath: imagePath, url });
  }
  const thumbMediaId = await uploadCover(token, publishPackage.coverPath);
  const payload = await postWechatApi("/cgi-bin/draft/add", token, {
    articles: [{
      title: publishPackage.title,
      author: publishPackage.author,
      digest: publishPackage.digest,
      content: contentHtml,
      thumb_media_id: thumbMediaId,
      show_cover_pic: 0,
      need_open_comment: publishPackage.openComment ? 1 : 0,
      only_fans_can_comment: publishPackage.fansOnlyComment ? 1 : 0
    }]
  });
  const mediaId = asString(payload.media_id);
  if (!mediaId) throwWechatError(payload, "创建公众号草稿失败");
  return {
    ok: true,
    source: "wechat_draft_publish",
    publishedAt: new Date().toISOString(),
    mediaId,
    title: publishPackage.title,
    digest: publishPackage.digest,
    coverPath: publishPackage.coverPath,
    contentHtmlPath: publishPackage.contentHtmlPath,
    thumbMediaId,
    uploadedImages,
    warnings: /<img\b[^>]*\bsrc\s*=\s*["']https?:/i.test(contentHtml)
      ? ["正文仍包含远程图片 URL，微信后台可能无法正常显示"]
      : []
  };
}

export async function fetchWechatMetrics(days = 3, runtime?: WechatRuntime | null) {
  const normalizedDays = normalizeDays(days);
  const token = await getAccessToken(readWechatCredentials(runtime));
  const snapshots = [];
  for (let offset = 1; offset <= normalizedDays; offset += 1) {
    const date = formatLocalDate(new Date(Date.now() - offset * 24 * 60 * 60 * 1000));
    const [summary, total] = await Promise.all([
      postWechatApi("/datacube/getarticlesummary", token, { begin_date: date, end_date: date }),
      postWechatApi("/datacube/getarticletotal", token, { begin_date: date, end_date: date })
    ]);
    snapshots.push({
      date,
      summary: asArray(summary.list),
      total: asArray(total.list)
    });
  }
  return {
    ok: true,
    source: "wechat_data_cube",
    capturedAt: new Date().toISOString(),
    days: normalizedDays,
    snapshots
  };
}

export async function fetchWechatPublishedArticles(
  offset = 0,
  count = 10,
  includeContent = true,
  runtime?: WechatRuntime | null
) {
  const request = validatePublishedArticlesRequest({ offset, count, includeContent });
  const token = await getAccessToken(readWechatCredentials(runtime));
  const payload = await postWechatApi("/cgi-bin/freepublish/batchget", token, {
    offset: request.offset,
    count: request.count,
    no_content: request.includeContent ? 0 : 1
  });
  return normalizePublishedArticles(payload, request);
}

export function validatePublishedArticlesRequest(input: {
  offset?: number;
  count?: number;
  includeContent?: boolean;
}) {
  const offset = input.offset ?? 0;
  const count = input.count ?? 10;
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset 必须是非负整数");
  if (!Number.isInteger(count) || count < 1 || count > MAX_PUBLISHED_ARTICLES) {
    throw new Error(`count 必须是 1-${MAX_PUBLISHED_ARTICLES} 的整数`);
  }
  return { offset, count, includeContent: input.includeContent ?? true };
}

export function normalizePublishedArticles(
  payload: JsonRecord,
  request: { offset: number; count: number; includeContent: boolean }
) {
  const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });
  const messages = asArray(payload.item).map((item) => {
    const articleId = asString(item.article_id);
    const updateTime = asNumber(item.update_time);
    const articles = asArray(asRecord(item.content).news_item).map((newsItem, articleIndex) => {
      const contentHtml = asString(newsItem.content);
      return {
        articleId,
        articleIndex,
        updateTime,
        title: asString(newsItem.title),
        author: asString(newsItem.author),
        digest: asString(newsItem.digest),
        contentHtml,
        contentMarkdown: contentHtml ? turndown.turndown(contentHtml).trim() : "",
        url: asString(newsItem.url),
        contentSourceUrl: asString(newsItem.content_source_url),
        thumbMediaId: asString(newsItem.thumb_media_id),
        thumbUrl: asString(newsItem.thumb_url),
        needOpenComment: asBoolean(newsItem.need_open_comment),
        onlyFansCanComment: asBoolean(newsItem.only_fans_can_comment),
        isDeleted: asBoolean(newsItem.is_deleted)
      };
    });
    return { articleId, updateTime, articles };
  });
  return {
    ok: true,
    source: "wechat_freepublish",
    fetchedAt: new Date().toISOString(),
    request,
    totalCount: asNumber(payload.total_count),
    itemCount: asNumber(payload.item_count),
    messages,
    articles: messages.flatMap((message) => message.articles)
  };
}

export async function fetchWechatDraft(mediaId: string, runtime?: WechatRuntime | null) {
  const normalizedMediaId = mediaId.trim();
  if (!normalizedMediaId) throw new Error("mediaId 不能为空");
  const token = await getAccessToken(readWechatCredentials(runtime));
  const payload = await postWechatApi("/cgi-bin/draft/get", token, { media_id: normalizedMediaId });
  const newsItem = asArray(payload.news_item);
  const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });
  const articles = newsItem.map((item) => {
    const record = asRecord(item);
    const contentHtml = asString(record.content);
    return {
      title: asString(record.title),
      author: asString(record.author),
      digest: asString(record.digest),
      contentHtml,
      contentMarkdown: contentHtml ? turndown.turndown(contentHtml).trim() : "",
      contentSourceUrl: asString(record.content_source_url),
      thumbMediaId: asString(record.thumb_media_id),
      needOpenComment: Boolean(record.need_open_comment),
      onlyFansCanComment: Boolean(record.only_fans_can_comment)
    };
  });
  return {
    ok: true,
    source: "wechat_draft",
    fetchedAt: new Date().toISOString(),
    mediaId: normalizedMediaId,
    updateTime: typeof payload.update_time === "number" ? payload.update_time : undefined,
    articles
  };
}

async function getAccessToken(credentials: WechatCredentials): Promise<string> {
  const url = new URL(`${API_ROOT}/cgi-bin/token`);
  url.searchParams.set("grant_type", "client_credential");
  url.searchParams.set("appid", credentials.appId);
  url.searchParams.set("secret", credentials.secret);
  const payload = await fetchJson(url, { method: "GET" });
  const token = asString(payload.access_token);
  if (!token) throwWechatError(payload, "获取公众号 access token 失败");
  return token;
}

async function postWechatApi(pathname: string, token: string, body: JsonRecord): Promise<JsonRecord> {
  const url = new URL(`${API_ROOT}${pathname}`);
  url.searchParams.set("access_token", token);
  const payload = await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (typeof payload.errcode === "number" && payload.errcode !== 0) {
    throwWechatError(payload, `公众号 API ${pathname} 调用失败`);
  }
  return payload;
}

async function uploadContentImage(token: string, imagePath: string): Promise<string> {
  const payload = await postWechatMultipart("/cgi-bin/media/uploadimg", token, imagePath);
  const url = asString(payload.url);
  if (!url) throwWechatError(payload, "上传公众号正文图片失败");
  return url;
}

async function uploadCover(token: string, coverPath: string): Promise<string> {
  const payload = await postWechatMultipart("/cgi-bin/material/add_material", token, coverPath, { type: "image" });
  const mediaId = asString(payload.media_id);
  if (!mediaId) throwWechatError(payload, "上传公众号封面失败");
  return mediaId;
}

async function postWechatMultipart(pathname: string, token: string, filePath: string, query: Record<string, string> = {}): Promise<JsonRecord> {
  const url = new URL(`${API_ROOT}${pathname}`);
  url.searchParams.set("access_token", token);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const form = new FormData();
  const bytes = new Uint8Array(fs.readFileSync(filePath));
  form.append("media", new Blob([bytes], { type: mimeType(filePath) }), path.basename(filePath));
  const payload = await fetchJson(url, { method: "POST", body: form });
  if (typeof payload.errcode === "number" && payload.errcode !== 0) {
    throwWechatError(payload, `公众号 API ${pathname} 调用失败`);
  }
  return payload;
}

async function fetchJson(url: URL, init: RequestInit): Promise<JsonRecord> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`公众号 API HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("公众号 API 返回非对象 JSON");
    return payload as JsonRecord;
  } finally {
    clearTimeout(timer);
  }
}

function requireAbsoluteFile(filePath: string, field: string): void {
  if (!filePath) throw new Error(`${field} 不能为空`);
  if (!path.isAbsolute(filePath)) throw new Error(`${field} 必须是绝对路径: ${filePath}`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`${field} 不存在: ${filePath}`);
  }
  if (!stat.isFile()) throw new Error(`${field} 不是文件: ${filePath}`);
  fs.accessSync(filePath, fs.constants.R_OK);
}

function replaceImageSource(contentHtml: string, original: string, replacement: string): string {
  const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return contentHtml.replace(new RegExp(`(<img\\b[^>]*\\bsrc\\s*=\\s*["'])${escaped}(["'])`, "gi"), `$1${replacement}$2`);
}

function mimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

function throwWechatError(payload: JsonRecord, prefix: string): never {
  const errcode = typeof payload.errcode === "number" ? payload.errcode : "unknown";
  const errmsg = asString(payload.errmsg) || "unknown";
  throw new Error(`${prefix}: ${errcode} ${errmsg}`);
}

function normalizeDays(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_METRICS_DAYS) {
    throw new Error(`days 必须是 1-${MAX_METRICS_DAYS} 的整数`);
  }
  return value;
}

function formatLocalDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function asArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}
