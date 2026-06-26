import { createSdkMcpServer, tool } from "../../runtime";
import fs from "node:fs";
import path from "node:path";
import MarkdownIt from "markdown-it";
import TurndownService from "turndown";
import { load as loadHtml, type CheerioAPI } from "cheerio";
import hljs from "highlight.js";
import yaml from "js-yaml";
import { z } from "zod/v4";

type JsonRecord = Record<string, unknown>;
type Theme = {
  name: string;
  description: string;
  colors: Record<string, unknown>;
  darkmode: Record<string, unknown>;
  baseCss: string;
  aigcFooter: boolean;
  cssRandomize: boolean;
};

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const CATEGORIES = ["tech-opinion", "story-emotional", "list-practical", "hot-take", "general"] as const;
const NEGATIVE_MARKERS = ["但是", "不过", "可惜", "遗憾", "焦虑", "担心", "失败", "问题", "风险", "困难", "痛苦", "崩溃"];
const ADVERBS = ["非常", "特别", "其实", "真的", "显然", "当然", "可能", "大概", "基本上", "几乎"];
const BANNED_WORDS = ["综上所述", "值得注意的是", "不可否认", "毋庸置疑", "在当今社会", "随着时代的发展"];
const SELF_CORRECTION_PATTERNS = [/换句话说/g, /准确地说/g, /不对[，,]/g, /或者说/g, /我收回/g, /更准确一点/g];
const REAL_SOURCE_PATTERNS = [/\d+(?:\.\d+)?%/g, /\d{4}年/g, /据.{0,20}(?:报告|数据|统计|调查)/g, /《[^》]+》/g, /https?:\/\//g];

function jsonResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    isError
  };
}

export function createServer() {
  return createSdkMcpServer({
    name: "wechat_content",
    tools: [
      tool(
        "wechat_markdown_render",
        "读取 Markdown 和主题 YAML，生成公众号正文 HTML、浏览器预览和路径型发布包；不选择主题、不发布。",
        {
          markdownPath: absolutePathSchema("Markdown 文件绝对路径。"),
          themePath: absolutePathSchema("主题 YAML 文件绝对路径。"),
          outputDir: absolutePathSchema("输出目录绝对路径；不存在时创建。"),
          coverPath: absolutePathSchema("可选封面图片绝对路径。").optional(),
          title: z.string().max(64).optional().describe("可选标题覆盖。"),
          digest: z.string().max(120).optional().describe("可选摘要覆盖。")
        },
        async (args) => invoke(() => renderMarkdownPackage(args)),
        writeAnnotations("公众号 Markdown HTML 排版 预览 发布包 主题")
      ),
      tool(
        "wechat_html_to_markdown",
        "读取本地公众号 HTML，提取元数据和正文并写入 Markdown；不负责抓取网页。",
        {
          htmlPath: absolutePathSchema("本地 HTML 文件绝对路径。"),
          outputMarkdownPath: absolutePathSchema("输出 Markdown 文件绝对路径。"),
          sourceUrl: z.string().url().optional().describe("可选来源 URL，只写入 frontmatter。")
        },
        async (args) => invoke(() => htmlFileToMarkdown(args)),
        writeAnnotations("公众号 HTML Markdown 提取 转换 文件")
      ),
      tool(
        "wechat_theme_extract",
        "从本地公众号 HTML 分析排版样式，基于显式传入的基础主题生成主题 YAML；不下载文章、不注册主题。",
        {
          htmlPath: absolutePathSchema("本地公众号 HTML 文件绝对路径。"),
          baseThemePath: absolutePathSchema("基础主题 YAML 文件绝对路径。"),
          outputThemePath: absolutePathSchema("输出主题 YAML 文件绝对路径。"),
          name: z.string().regex(/^[A-Za-z0-9_-]+$/).describe("主题标识，只允许字母、数字、下划线和中划线。")
        },
        async (args) => invoke(() => extractTheme(args)),
        writeAnnotations("公众号 排版 主题 提取 YAML")
      ),
      tool(
        "wechat_article_quality_analyze",
        "读取 Markdown 并写入可解释的统计与模式质量报告；结果不是 AI 检测结论，也不自动改稿。",
        {
          markdownPath: absolutePathSchema("Markdown 文件绝对路径。"),
          outputReportPath: absolutePathSchema("输出 JSON 报告绝对路径。")
        },
        async (args) => invoke(() => analyzeArticleQualityFile(args)),
        writeAnnotations("公众号 文章 质量 分析 报告 证据")
      ),
      tool(
        "wechat_exemplar_extract",
        "读取 Markdown 并写入范文结构片段与风格统计；不维护范文索引、不写长期数据。",
        {
          markdownPath: absolutePathSchema("Markdown 文件绝对路径。"),
          outputExemplarPath: absolutePathSchema("输出 JSON 绝对路径。"),
          category: z.enum(CATEGORIES).optional().describe("可选范文分类；省略时自动判断。"),
          source: z.string().max(200).optional().describe("可选来源名称。")
        },
        async (args) => invoke(() => extractExemplarFile(args)),
        writeAnnotations("公众号 范文 风格 特征 片段 提取")
      )
    ]
  });
}

function absolutePathSchema(description: string) {
  return z.string().min(1).describe(description);
}

async function invoke(callback: () => unknown | Promise<unknown>) {
  try {
    return jsonResult(await callback());
  } catch (error) {
    return jsonResult({ ok: false, error: error instanceof Error ? error.message : String(error) }, true);
  }
}

function writeAnnotations(searchHint: string) {
  return {
    searchHint,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  };
}

export function renderMarkdownPackage(input: {
  markdownPath: string;
  themePath: string;
  outputDir: string;
  coverPath?: string;
  title?: string;
  digest?: string;
}) {
  const markdownPath = requireAbsoluteFile(input.markdownPath, "markdownPath");
  const themePath = requireAbsoluteFile(input.themePath, "themePath");
  const outputDir = requireAbsoluteDirectoryPath(input.outputDir, "outputDir");
  const coverPath = input.coverPath ? requireAbsoluteFile(input.coverPath, "coverPath") : "";
  const markdown = readTextFile(markdownPath);
  const theme = loadThemeFile(themePath);
  const converted = convertMarkdown(markdown, theme);
  const normalized = normalizeLocalImageSources(converted.html, path.dirname(markdownPath));
  const local = resolveLocalImages(normalized.images, path.dirname(markdownPath));
  const errors = [...local.errors];
  const title = (input.title ?? converted.title).trim();
  const digest = (input.digest ?? converted.digest).trim();
  if (!title) errors.push("title is required");
  if (!normalized.html.trim()) errors.push("contentHtml is required");
  if (!coverPath) errors.push("cover is required for a complete publish package");

  fs.mkdirSync(outputDir, { recursive: true });
  const stem = path.basename(markdownPath, path.extname(markdownPath));
  const contentHtmlPath = path.join(outputDir, `${stem}.wechat.html`);
  const previewPath = path.join(outputDir, `${stem}.preview.html`);
  fs.writeFileSync(contentHtmlPath, normalized.html, "utf8");
  fs.writeFileSync(previewPath, buildPreviewHtml(normalized.html, theme), "utf8");

  return {
    ok: true,
    title,
    digest,
    contentHtmlPath,
    previewPath,
    themePath,
    theme: theme.name,
    coverPath,
    localImages: local.localImages,
    warnings: local.warnings,
    errors,
    validationStatus: errors.length === 0 ? "valid" : "invalid"
  };
}

export function convertMarkdown(markdown: string, theme: Theme) {
  const title = extractTitle(markdown);
  let source = stripH1(markdown);
  source = preprocessContainers(source, theme);
  source = fixCjkSpacing(source);
  const parser = new MarkdownIt({
    html: true,
    breaks: true,
    linkify: false,
    highlight(code, language) {
      const highlighted = language && hljs.getLanguage(language)
        ? hljs.highlight(code, { language }).value
        : escapeHtml(code);
      return `<pre${language ? ` data-lang="${escapeAttribute(language)}"` : ""}><code>${highlighted}</code></pre>`;
    }
  });
  const $ = loadHtml(parser.render(source), { xml: false }, false);
  processImages($);
  fixBoldPunctuation($);
  convertLists($, theme);
  convertLinksToFootnotes($, theme);
  applyInlineStyles($, theme);
  applyWechatFixes($, theme);
  injectDarkMode($, theme);
  if (theme.cssRandomize) randomizeStyles($);
  if (theme.aigcFooter) {
    $.root().append('<p style="text-align: center; font-size: 13px; color: #9ca3af; margin-top: 48px; padding-top: 24px; border-top: 1px solid #e5e7eb;">本文由 AI 辅助创作，作者进行了实测验证和编辑修改。</p>');
  }
  const html = $.html().trim();
  return {
    title,
    digest: utf8Digest($.root().text().replace(/\s+/g, " ").trim(), 120),
    html,
    images: $("img").map((_, element) => $(element).attr("src") ?? "").get().filter(Boolean)
  };
}

function preprocessContainers(markdown: string, theme: Theme): string {
  const primary = color(theme, "primary", "#2563eb");
  return markdown
    .replace(/:::dialogue\s*\n([\s\S]*?)\n:::/g, (_, body: string) => body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const right = line.startsWith("> ");
      const text = right ? line.slice(2).trim() : line;
      const justify = right ? "flex-end" : "flex-start";
      const bubble = right
        ? `background: ${primary}; color: white; padding: 10px 14px; border-radius: 12px 12px 2px 12px`
        : "background: #f3f4f6; color: #333; padding: 10px 14px; border-radius: 12px 12px 12px 2px";
      return `<section style="display: flex; justify-content: ${justify}; margin-bottom: 12px"><section style="${bubble}; max-width: 80%; font-size: 15px; line-height: 1.6">${text}</section></section>`;
    }).join("\n"))
    .replace(/:::timeline\s*\n([\s\S]*?)\n:::/g, (_, body: string) => body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) =>
      `<section style="display: flex; margin-bottom: 16px"><section style="flex-shrink: 0; width: 12px; display: flex; flex-direction: column; align-items: center"><section style="width: 10px; height: 10px; border-radius: 50%; background: ${primary}; margin-top: 6px"></section><section style="width: 2px; flex: 1; background: #e5e7eb; margin-top: 4px"></section></section><section style="flex: 1; padding-left: 12px; padding-bottom: 8px; font-size: 15px; line-height: 1.7">${line}</section></section>`
    ).join("\n"))
    .replace(/:::callout\s+(\w+)\s*\n([\s\S]*?)\n:::/g, (_, kindValue: string, body: string) => {
      const kind = kindValue.toLowerCase();
      const variants: Record<string, [string, string, string]> = {
        tip: ["#059669", "#ecfdf5", "💡"],
        warning: ["#d97706", "#fffbeb", "⚠️"],
        info: ["#2563eb", "#eff6ff", "ℹ️"],
        danger: ["#dc2626", "#fef2f2", "🚨"]
      };
      const [accent, background, icon] = variants[kind] ?? variants.info;
      return `<section style="background: ${background}; border-left: 4px solid ${accent}; padding: 14px 16px; border-radius: 4px; margin: 16px 0; font-size: 15px; line-height: 1.7"><section style="font-weight: 700; color: ${accent}; margin-bottom: 6px">${icon} ${kind.toUpperCase()}</section>${body.trim()}</section>`;
    })
    .replace(/:::quote\s*\n([\s\S]*?)\n:::/g, (_, body: string) =>
      `<section style="margin: 24px 0; padding: 20px 24px; border-left: 4px solid ${primary}; background: linear-gradient(135deg, #f8f9fa 0%, #ffffff 100%); border-radius: 0 8px 8px 0"><section style="font-size: 18px; line-height: 1.8; color: #333; font-style: italic">"${body.trim()}"</section></section>`)
    .replace(/:::(highlight|summary)\s*\n([\s\S]*?)\n:::/g, (_, kind: string, body: string) => {
      const [heading, ...rest] = body.trim().split(/\r?\n/);
      const accent = kind === "highlight" ? color(theme, "secondary", "#c4820e") : primary;
      const background = color(theme, kind === "highlight" ? "highlight_bg" : "summary_bg", kind === "highlight" ? "#fef7e8" : "#e8f5f0");
      const border = color(theme, kind === "highlight" ? "highlight_border" : "summary_border", "rgba(0,0,0,0.12)");
      return `<section style="margin: 24px 0; padding: 20px 24px; background: ${background}; border: 1px solid ${border}; border-radius: 6px"><p style="margin: 0"><strong style="color: ${accent}">${heading || "总结"}</strong></p>${rest.length ? `<p style="margin: 8px 0 0 0">${rest.join("\n")}</p>` : ""}</section>`;
    });
}

function fixCjkSpacing(markdown: string): string {
  let inFence = false;
  return markdown.split(/\r?\n/).map((line) => {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return line
      .replace(/([\u3400-\u9fff\u3000-\u303f\uff00-\uffef])([A-Za-z0-9])/g, "$1 $2")
      .replace(/([A-Za-z0-9])([\u3400-\u9fff\u3000-\u303f\uff00-\uffef])/g, "$1 $2");
  }).join("\n");
}

function processImages($: CheerioAPI): void {
  $("img").each((_, element) => {
    const current = $(element).attr("style") ?? "";
    if (!/max-width\s*:/.test(current)) {
      $(element).attr("style", mergeStyleText(current, "max-width: 100%; height: auto; display: block; margin: 24px auto"));
    }
  });
}

function fixBoldPunctuation($: CheerioAPI): void {
  $("strong").each((_, element) => {
    const text = $(element).text();
    const match = text.match(/([，。！？；：、]+)$/);
    if (!match) return;
    const contents = $(element).contents();
    const last = contents.last();
    if (last[0]?.type === "text") last[0].data = (last[0].data ?? "").slice(0, -match[1].length);
    $(element).after(match[1]);
  });
}

function convertLists($: CheerioAPI, theme: Theme): void {
  const primary = color(theme, "primary", "#2563eb");
  const text = color(theme, "text", "#333333");
  $("ul, ol").each((_, list) => {
    const ordered = list.tagName === "ol";
    const wrapper = $("<section></section>");
    $(list).children("li").each((index, li) => {
      const marker = ordered ? `${index + 1}.` : "•";
      const markerStyle = ordered
        ? `color: ${primary}; margin-right: 8px; flex-shrink: 0; font-weight: 700; line-height: 1.8`
        : `color: ${primary}; margin-right: 8px; flex-shrink: 0; font-size: 18px; line-height: 1.6`;
      wrapper.append(`<section style="display: flex; align-items: flex-start; margin-bottom: 8px; color: ${text}"><span style="${markerStyle}">${marker}</span><span style="flex: 1">${$(li).html() ?? ""}</span></section>`);
    });
    $(list).replaceWith(wrapper);
  });
}

function convertLinksToFootnotes($: CheerioAPI, theme: Theme): void {
  const notes: Array<{ text: string; href: string }> = [];
  const primary = color(theme, "primary", "#2563eb");
  $("a").each((_, element) => {
    const href = $(element).attr("href") ?? "";
    if (!href || href.startsWith("#")) return;
    notes.push({ text: $(element).text(), href });
    const number = notes.length;
    $(element).replaceWith(`${escapeHtml($(element).text())}<sup><span style="color: ${primary}; font-size: 12px">[${number}]</span></sup>`);
  });
  if (notes.length === 0) return;
  $.root().append('<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 32px 0 16px"><p style="font-size: 13px; color: #999999; margin-bottom: 8px; font-weight: 700">参考链接</p>');
  notes.forEach((note, index) => {
    $.root().append(`<p style="font-size: 12px; color: #999999; margin: 2px 0; word-break: break-all">[${index + 1}] ${escapeHtml(note.text)}: ${escapeHtml(note.href)}</p>`);
  });
}

function applyInlineStyles($: CheerioAPI, theme: Theme): void {
  const css = resolveCssVariables(theme.baseCss, theme.colors);
  const rules = parseSimpleCssRules(css);
  for (const [selector, declarations] of rules) {
    if (selector === "body") continue;
    try {
      $(selector).each((_, element) => {
        $(element).attr("style", mergeStyleText(declarations, $(element).attr("style") ?? ""));
      });
    } catch {
      // Unsupported selector: skip it, matching the previous converter behavior.
    }
  }
}

function parseSimpleCssRules(css: string): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = match[2].trim();
    if (!body) continue;
    for (const rawSelector of match[1].split(",")) {
      const selector = rawSelector.trim();
      if (!selector || /[:@>+~[\]*]/.test(selector)) continue;
      result.push([selector, body]);
    }
  }
  return result;
}

function applyWechatFixes($: CheerioAPI, theme: Theme): void {
  const textColor = color(theme, "text", "#333333");
  $("p").each((_, element) => {
    const current = $(element).attr("style") ?? "";
    if (!/(^|;)\s*color\s*:/.test(current)) $(element).attr("style", mergeStyleText(current, `color: ${textColor}`));
  });
  $("pre").each((_, element) => {
    const current = $(element).attr("style") ?? "";
    if (!/white-space\s*:/.test(current)) $(element).attr("style", mergeStyleText(current, "white-space: pre-wrap; word-wrap: break-word"));
  });
}

function injectDarkMode($: CheerioAPI, theme: Theme): void {
  if (Object.keys(theme.darkmode).length === 0) return;
  const dmText = stringValue(theme.darkmode.text, "#c8c8c8");
  const dmPrimary = stringValue(theme.darkmode.primary, "#6aadff");
  $("p, span, section").each((_, element) => {
    if (/color\s*:/.test($(element).attr("style") ?? "")) {
      $(element).attr("data-darkmode-color", dmText).attr("data-darkmode-bgcolor", "transparent");
    }
  });
  $("h1, h2, h3, h4").attr("data-darkmode-color", dmText).attr("data-darkmode-bgcolor", "transparent");
  $("pre").attr("data-darkmode-bgcolor", stringValue(theme.darkmode.code_bg, "#2d2d2d")).attr("data-darkmode-color", stringValue(theme.darkmode.code_color, "#d4d4d4"));
  $("code").attr("data-darkmode-color", stringValue(theme.darkmode.code_color, "#d4d4d4"));
  $("blockquote").attr("data-darkmode-bgcolor", stringValue(theme.darkmode.quote_bg, "#2a2a2a")).attr("data-darkmode-color", dmText);
  $("strong").attr("data-darkmode-color", dmPrimary);
}

function randomizeStyles($: CheerioAPI): void {
  const fontDelta = Math.random() < 0.5 ? -1 : 0;
  $("p").each((_, element) => {
    let style = $(element).attr("style") ?? "";
    style = style.replace(/font-size:\s*17px/g, `font-size: ${17 + fontDelta}px`);
    style = style.replace(/line-height:\s*1\.9/g, `line-height: ${(1.8 + Math.random() * 0.15).toFixed(2)}`);
    $(element).attr("style", style);
  });
  $("h2").each((_, element) => {
    const style = ($(element).attr("style") ?? "").replace(/font-size:\s*22px/g, `font-size: ${21 + Math.floor(Math.random() * 3)}px`);
    $(element).attr("style", style);
  });
}

export function htmlFileToMarkdown(input: { htmlPath: string; outputMarkdownPath: string; sourceUrl?: string }) {
  const htmlPath = requireAbsoluteFile(input.htmlPath, "htmlPath");
  const outputPath = requireAbsoluteOutputFile(input.outputMarkdownPath, "outputMarkdownPath");
  const html = readTextFile(htmlPath);
  const $ = loadHtml(html);
  const title = $("#activity-name").first().text().trim() || $("h1.rich_media_title").first().text().trim() || $("title").first().text().trim();
  const author = $("#js_name").first().text().trim() || $(".rich_media_meta_nickname").first().text().trim();
  const publishTime = $("#publish_time").first().text().trim();
  const content = $("#js_content").first();
  if (content.length === 0) throw new Error(`未找到公众号正文容器 #js_content: ${htmlPath}`);
  content.find('[style*="display:none"], [style*="display: none"], [style*="visibility:hidden"], [style*="visibility: hidden"]').remove();
  content.find("img").each((_, image) => {
    const dataSrc = $(image).attr("data-src");
    if (dataSrc) $(image).attr("src", dataSrc);
  });
  const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
  const markdownBody = turndown.turndown(content.html() ?? "").replace(/\n{3,}/g, "\n\n").trim();
  const frontmatter: JsonRecord = {};
  if (title) frontmatter.title = title;
  if (author) frontmatter.author = author;
  if (publishTime) frontmatter.date = publishTime;
  if (input.sourceUrl) frontmatter.source = input.sourceUrl;
  const output = `---\n${yaml.dump(frontmatter, { noRefs: true, lineWidth: -1 }).trimEnd()}\n---\n\n${markdownBody}\n`;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, "utf8");
  return { ok: true, htmlPath, outputMarkdownPath: outputPath, title, author, publishTime, sourceUrl: input.sourceUrl ?? "", charCount: markdownBody.length };
}

export function extractTheme(input: { htmlPath: string; baseThemePath: string; outputThemePath: string; name: string }) {
  const htmlPath = requireAbsoluteFile(input.htmlPath, "htmlPath");
  const baseThemePath = requireAbsoluteFile(input.baseThemePath, "baseThemePath");
  const outputThemePath = requireAbsoluteOutputFile(input.outputThemePath, "outputThemePath");
  const html = readTextFile(htmlPath);
  const base = loadThemeFile(baseThemePath);
  const $ = loadHtml(html);
  const content = $("#js_content").length ? $("#js_content") : $("body");
  const styles: Array<Record<string, string>> = [];
  content.find("[style]").each((_, element) => {
    styles.push(parseStyleText($(element).attr("style") ?? ""));
  });
  const textColors = styles.map((style) => style.color).filter(isUsefulColor);
  const backgrounds = styles.map((style) => style["background-color"] ?? style.background).filter(isUsefulColor);
  const borders = styles.flatMap((style) => [style["border-left-color"], style["border-color"]]).filter(isUsefulColor);
  const fontSizes = styles.map((style) => style["font-size"]).filter(isPxValue);
  const lineHeights = styles.map((style) => style["line-height"]).filter(Boolean);
  const radii = styles.map((style) => style["border-radius"]).filter(Boolean);
  const primary = mostCommon(borders) || mostCommon(textColors.filter((value) => !isNeutralColor(value))) || color(base, "primary", "#2563eb");
  const text = mostCommon(textColors.filter(isDarkColor)) || color(base, "text", "#333333");
  const background = mostCommon(backgrounds.filter(isLightColor)) || color(base, "background", "#ffffff");
  const colors = {
    ...base.colors,
    primary,
    secondary: primary,
    text,
    background,
    border_radius: mostCommon(radii) || color(base, "border_radius", "8px")
  };
  let baseCss = base.baseCss;
  baseCss = baseCss.replaceAll(color(base, "primary", "#2563eb"), primary);
  baseCss = baseCss.replaceAll(color(base, "text", "#333333"), text);
  baseCss = baseCss.replaceAll(color(base, "background", "#ffffff"), background);
  if (fontSizes.length) baseCss = baseCss.replace(/(body\s*\{[^}]*font-size:\s*)[\d.]+px/s, `$1${mostCommon(fontSizes)}`);
  if (lineHeights.length) baseCss = baseCss.replace(/(body\s*\{[^}]*line-height:\s*)[\d.]+/s, `$1${mostCommon(lineHeights)}`);
  const title = $("#activity-name").first().text().trim() || $("h1").first().text().trim();
  const output = {
    name: input.name,
    description: title ? `从「${title}」学习的排版主题` : `Learned theme: ${input.name}`,
    colors,
    darkmode: deriveDarkMode(colors),
    base_css: baseCss
  };
  fs.mkdirSync(path.dirname(outputThemePath), { recursive: true });
  fs.writeFileSync(outputThemePath, yaml.dump(output, { noRefs: true, lineWidth: -1 }), "utf8");
  return {
    ok: true,
    htmlPath,
    baseThemePath,
    outputThemePath,
    name: input.name,
    sampledStyledElements: styles.length,
    analyzed: { primary, text, background, fontSize: mostCommon(fontSizes), lineHeight: mostCommon(lineHeights), borderRadius: mostCommon(radii) }
  };
}

export function analyzeArticleQualityFile(input: { markdownPath: string; outputReportPath: string }) {
  const markdownPath = requireAbsoluteFile(input.markdownPath, "markdownPath");
  const outputReportPath = requireAbsoluteOutputFile(input.outputReportPath, "outputReportPath");
  const report = analyzeArticleQuality(readTextFile(markdownPath));
  writeJsonFile(outputReportPath, report);
  return { ok: true, markdownPath, outputReportPath, summary: report.summary };
}

export function analyzeArticleQuality(markdown: string) {
  const text = stripMarkdownStructure(markdown);
  const sentences = splitSentences(text);
  const paragraphs = splitParagraphs(markdown);
  const lengths = sentences.map((sentence) => sentence.length);
  const paragraphLengths = paragraphs.map((paragraph) => paragraph.length);
  const negativeCount = sentences.filter((sentence) => NEGATIVE_MARKERS.some((marker) => sentence.includes(marker))).length;
  const adverbCount = ADVERBS.reduce((sum, word) => sum + countOccurrences(text, word), 0);
  const bannedWords = BANNED_WORDS.filter((word) => text.includes(word));
  const sourceIndicators = REAL_SOURCE_PATTERNS.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0);
  const selfCorrections = SELF_CORRECTION_PATTERNS.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0);
  const checks = {
    sentenceLength: summarizeNumbers(lengths),
    sentenceStddev: round(standardDeviation(lengths)),
    paragraphLength: summarizeNumbers(paragraphLengths),
    paragraphCv: round(coefficientOfVariation(paragraphLengths)),
    negativeEmotionRatio: round(sentences.length ? negativeCount / sentences.length : 0),
    adverbDensityPer100Chars: round(text.length ? adverbCount / text.length * 100 : 0),
    bannedWords,
    realSourceIndicators: sourceIndicators,
    selfCorrectionIndicators: selfCorrections
  };
  const concerns = [
    checks.sentenceStddev < 10 ? "句长变化较小，阅读节奏可能过于均匀" : null,
    checks.paragraphCv < 0.35 ? "段落长度变化较小，可检查是否需要调整节奏" : null,
    bannedWords.length ? `发现模板化表达：${bannedWords.join("、")}` : null,
    sourceIndicators < 2 ? "可验证的数据、报告或来源锚点较少" : null
  ].filter(Boolean);
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    disclaimer: "该报告只提供可解释的写作统计与模式证据，不是 AI 内容检测结论。",
    summary: { charCount: text.length, sentenceCount: sentences.length, paragraphCount: paragraphs.length, concernCount: concerns.length },
    checks,
    concerns
  };
}

export function extractExemplarFile(input: { markdownPath: string; outputExemplarPath: string; category?: typeof CATEGORIES[number]; source?: string }) {
  const markdownPath = requireAbsoluteFile(input.markdownPath, "markdownPath");
  const outputExemplarPath = requireAbsoluteOutputFile(input.outputExemplarPath, "outputExemplarPath");
  const markdown = readTextFile(markdownPath);
  const paragraphs = splitParagraphs(markdown);
  const sentences = splitSentences(stripMarkdownStructure(markdown));
  const headings = markdown.split(/\r?\n/).filter((line) => /^#{1,6}\s+/.test(line.trim())).map((line) => line.replace(/^#{1,6}\s+/, "").trim());
  const quality = analyzeArticleQuality(markdown);
  const category = input.category ?? detectCategory(markdown, headings);
  const transitions = paragraphs.find((paragraph) => /但是|不过|后来|直到|换句话说|准确地说/.test(paragraph)) ?? "";
  const emotionalPeak = [...paragraphs].sort((left, right) => emotionalWeight(right) - emotionalWeight(left))[0] ?? "";
  const result = {
    ok: true,
    title: extractTitle(markdown),
    source: input.source?.trim() || path.basename(markdownPath, path.extname(markdownPath)),
    category,
    fingerprint: {
      sentenceStddev: round(standardDeviation(sentences.map((sentence) => sentence.length))),
      negativeRatio: quality.checks.negativeEmotionRatio,
      paragraphCv: round(coefficientOfVariation(paragraphs.map((paragraph) => paragraph.length))),
      shortParagraphs: paragraphs.filter((paragraph) => paragraph.length <= 10).length
    },
    segments: {
      opening: takeChars(paragraphs.slice(0, 2).join("\n\n"), 250),
      emotionalPeak: takeChars(emotionalPeak, 400),
      transition: takeChars(transitions, 400),
      closing: takeChars(paragraphs.slice(-2).join("\n\n"), 250)
    },
    extractedAt: new Date().toISOString().slice(0, 10),
    charCount: stripMarkdownStructure(markdown).length
  };
  writeJsonFile(outputExemplarPath, result);
  return { ok: true, markdownPath, outputExemplarPath, category, source: result.source, segmentCount: Object.values(result.segments).filter(Boolean).length };
}

export function loadThemeFile(themePath: string): Theme {
  const parsed = yaml.load(readTextFile(themePath));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`主题 YAML 必须是对象: ${themePath}`);
  const record = parsed as JsonRecord;
  const name = stringValue(record.name);
  const description = stringValue(record.description);
  const baseCss = stringValue(record.base_css);
  const colors = asRecord(record.colors);
  const darkmode = Object.keys(asRecord(colors.darkmode)).length ? asRecord(colors.darkmode) : asRecord(record.darkmode);
  if (!name || !description || !baseCss || Object.keys(colors).length === 0) {
    throw new Error(`主题 YAML 缺少 name、description、colors 或 base_css: ${themePath}`);
  }
  return {
    name,
    description,
    baseCss,
    colors,
    darkmode,
    aigcFooter: record.aigc_footer === true,
    cssRandomize: record.css_randomize === true
  };
}

function resolveLocalImages(images: string[], markdownDir: string) {
  const localImages: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const source of images) {
    if (/^https?:\/\//i.test(source)) {
      warnings.push(`remote image preserved: ${source}`);
      continue;
    }
    if (/^data:/i.test(source)) continue;
    const resolved = path.isAbsolute(source) ? source : path.resolve(markdownDir, source);
    try {
      requireAbsoluteFile(resolved, "local image");
      localImages.push(resolved);
    } catch {
      errors.push(`local image not found: ${resolved}`);
    }
  }
  return { localImages, warnings, errors };
}

function normalizeLocalImageSources(html: string, markdownDir: string) {
  const $ = loadHtml(html, { xml: false }, false);
  const images: string[] = [];
  $("img").each((_, element) => {
    const source = ($(element).attr("src") ?? "").trim();
    if (!source) return;
    if (/^(?:https?:|data:|\/\/)/i.test(source)) {
      images.push(source);
      return;
    }
    const absolute = path.isAbsolute(source) ? source : path.resolve(markdownDir, source);
    $(element).attr("src", absolute);
    images.push(absolute);
  });
  return { html: $.html().trim(), images };
}

function buildPreviewHtml(bodyHtml: string, theme: Theme): string {
  return `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>Preview</title>\n<style>\n${theme.baseCss}\n</style>\n</head>\n<body>\n${bodyHtml}\n</body>\n</html>\n`;
}

function extractTitle(markdown: string): string {
  return markdown.split(/\r?\n/).find((line) => /^#\s+/.test(line.trim()))?.trim().replace(/^#\s+/, "") ?? "";
}

function stripH1(markdown: string): string {
  return markdown.split(/\r?\n/).filter((line) => !/^#\s+/.test(line.trim())).join("\n");
}

function utf8Digest(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = "...";
  let output = "";
  for (const char of text) {
    if (Buffer.byteLength(output + char + suffix, "utf8") > maxBytes) break;
    output += char;
  }
  return `${output.trimEnd()}${suffix}`;
}

function resolveCssVariables(css: string, colors: Record<string, unknown>): string {
  return css.replace(/var\(\s*--([A-Za-z0-9_-]+)\s*\)/g, (original, name: string) => {
    const direct = colors[name];
    const underscored = colors[name.replaceAll("-", "_")];
    return stringValue(direct || underscored) || original;
  });
}

function mergeStyleText(base: string, override: string): string {
  const merged = new Map<string, string>();
  for (const text of [base, override]) {
    for (const item of text.split(";")) {
      const separator = item.indexOf(":");
      if (separator < 1) continue;
      merged.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
    }
  }
  return [...merged.entries()].map(([key, value]) => `${key}: ${value}`).join("; ");
}

function parseStyleText(style: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of style.split(";")) {
    const separator = item.indexOf(":");
    if (separator < 1) continue;
    result[item.slice(0, separator).trim().toLowerCase()] = item.slice(separator + 1).trim();
  }
  return result;
}

function color(theme: Theme, key: string, fallback: string): string {
  return stringValue(theme.colors[key], fallback);
}

function deriveDarkMode(colors: Record<string, unknown>) {
  return {
    background: "#1e1e1e",
    text: "#d4d4d4",
    text_light: "#9ca3af",
    primary: lightenHex(stringValue(colors.primary, "#2563eb")),
    code_bg: "#2d2d2d",
    code_color: "#d4d4d4",
    quote_bg: "#2a2a2a",
    quote_border: lightenHex(stringValue(colors.primary, "#2563eb"))
  };
}

function lightenHex(value: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return value;
  const channels = [0, 2, 4].map((offset) => Math.min(255, parseInt(match[1].slice(offset, offset + 2), 16) + 48));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "";
}

function isUsefulColor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "transparent" && !value.startsWith("rgba(0, 0, 0, 0");
}

function isNeutralColor(value: string): boolean {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (!hex) return false;
  const rgb = [0, 2, 4].map((offset) => parseInt(hex[1].slice(offset, offset + 2), 16));
  return Math.max(...rgb) - Math.min(...rgb) < 25;
}

function isDarkColor(value: string): boolean {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (!hex) return false;
  const rgb = [0, 2, 4].map((offset) => parseInt(hex[1].slice(offset, offset + 2), 16));
  return rgb.reduce((sum, channel) => sum + channel, 0) / 3 < 150;
}

function isLightColor(value: string): boolean {
  return !isDarkColor(value);
}

function isPxValue(value: unknown): value is string {
  return typeof value === "string" && /^\d+(?:\.\d+)?px$/.test(value);
}

function stripMarkdownStructure(markdown: string): string {
  return markdown
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[*_>`~-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(text: string): string[] {
  return text.split(/[。！？；;…\n]/).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 1);
}

function splitParagraphs(markdown: string): string[] {
  return markdown
    .replace(/^---[\s\S]*?---\s*/m, "")
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph && !paragraph.startsWith("#") && !paragraph.startsWith("```"));
}

function detectCategory(markdown: string, headings: string[]): typeof CATEGORIES[number] {
  if (/复盘|故事|经历|那天|后来|情绪|生活/.test(markdown)) return "story-emotional";
  if (/清单|步骤|教程|方法|工具|第[一二三四五六七八九十]个/.test(markdown) || headings.length >= 5) return "list-practical";
  if (/热点|争议|为什么|评论|趋势|刚刚/.test(markdown)) return "hot-take";
  if (/技术|AI|软件|开发|产品|工程/.test(markdown)) return "tech-opinion";
  return "general";
}

function emotionalWeight(paragraph: string): number {
  return NEGATIVE_MARKERS.reduce((sum, marker) => sum + countOccurrences(paragraph, marker), 0)
    + (paragraph.match(/[！？]/g)?.length ?? 0);
}

function countOccurrences(text: string, search: string): number {
  if (!search) return 0;
  return text.split(search).length - 1;
}

function takeChars(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

function summarizeNumbers(values: number[]) {
  if (values.length === 0) return { min: 0, max: 0, average: 0, median: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { min: sorted[0], max: sorted.at(-1) ?? 0, average: round(values.reduce((sum, value) => sum + value, 0) / values.length), median: round(median) };
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return mean ? standardDeviation(values) / mean : 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function requireAbsoluteFile(value: string, field: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${field} 必须是绝对路径: ${value}`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(value);
  } catch {
    throw new Error(`${field} 不存在: ${value}`);
  }
  if (!stat.isFile()) throw new Error(`${field} 不是文件: ${value}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${field} 超过 ${MAX_FILE_BYTES} 字节限制: ${value}`);
  fs.accessSync(value, fs.constants.R_OK);
  return value;
}

function requireAbsoluteDirectoryPath(value: string, field: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${field} 必须是绝对路径: ${value}`);
  if (fs.existsSync(value) && !fs.statSync(value).isDirectory()) throw new Error(`${field} 不是目录: ${value}`);
  return value;
}

function requireAbsoluteOutputFile(value: string, field: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${field} 必须是绝对路径: ${value}`);
  if (fs.existsSync(value) && !fs.statSync(value).isFile()) throw new Error(`${field} 不是文件路径: ${value}`);
  return value;
}

function readTextFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
