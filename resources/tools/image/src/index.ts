import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import * as PImage from "pureimage";
import { createSdkMcpServer, tool } from "../../runtime";
import { z } from "zod/v4";

type ImageProviderType = "doubao" | "openai" | "gemini" | "dashscope" | "minimax" | "openai-compatible";
type ImageSizePreset = "cover" | "article" | "vertical" | "square" | "wechat-cover";
type ImageTemplateType = "xhs_cover" | "xhs_content" | "gzh_cover" | "gzh_content";

type ImageProviderConfig = {
  id: string;
  name: string;
  providerType: ImageProviderType | "";
  baseUrl: string;
  apiKey: string;
  model: string;
};

type GenerateImageArgs = {
  prompt: string;
  outputPath: string;
  size?: string;
};

type GenerateTemplateImageArgs = {
  title: string;
  subtitle?: string;
  content?: string;
  template?: string;
  outputPath: string;
  type: ImageTemplateType;
};

type GeneratedImage = {
  bytes: Buffer;
  mimeType: string;
};

type GenerateImageResult = {
  ok: true;
  providerType: ImageProviderType;
  model: string;
  outputPath: string;
  size: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
};

type GenerateTemplateImageResult = {
  ok: true;
  source: "local-template";
  type: ImageTemplateType;
  templateId: string;
  outputPath: string;
  size: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: "image/png";
};

const CONFIG_PATH = path.join(os.homedir(), ".agentstudio", "config.yml");
const DEFAULT_MIME_TYPE = "image/png";
const SIZE_PRESETS = new Set<ImageSizePreset>(["cover", "article", "vertical", "square", "wechat-cover"]);
const TEMPLATE_ASSETS_DIR = path.resolve(__dirname, "..", "assets");
const TEMPLATE_TITLE_FONT_FAMILY = "GrowthForce Template Title";
const TEMPLATE_CONTENT_FONT_FAMILY = "GrowthForce Template Content";
const TEMPLATE_TEXT_LIMITS: Record<ImageTemplateType, { title: number; subtitle?: number; content?: number }> = {
  xhs_cover: { title: 18, subtitle: 30 },
  xhs_content: { title: 18, content: 140 },
  gzh_cover: { title: 18, subtitle: 30 },
  gzh_content: { title: 18, content: 160 }
};

type TemplateTextBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  align: "left" | "center";
  color: string;
  maxFontSize: number;
  minFontSize: number;
  maxLines: number;
  lineHeight: number;
};

type ImageTemplate = {
  id: string;
  type: ImageTemplateType;
  name: string;
  style: string;
  suitableFor: string[];
  recommendedTitleLength: string;
  width: number;
  height: number;
  background: string;
  title: TemplateTextBox;
  subtitle?: TemplateTextBox;
  content?: TemplateTextBox;
};

type BackgroundCrop = {
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
};

const IMAGE_TEMPLATES: readonly ImageTemplate[] = [
  xhsTemplate("xhs_bold_marker", "荧光笔撕纸", "方格稿纸、白色撕纸、黄色荧光笔，年轻直接", ["教程", "清单", "避坑", "新手指南"], { x: 105, y: 310, width: 870, height: 690, align: "left", color: "#111111", maxFontSize: 132, minFontSize: 68, maxLines: 4, lineHeight: 1.16 }),
  xhsContentTemplate("xhs_bold_marker", "荧光笔撕纸", "方格稿纸、白色撕纸、黄色荧光笔，年轻直接", ["教程", "清单", "避坑", "新手指南"], { x: 105, y: 310, width: 870, height: 690, align: "left", color: "#111111", maxFontSize: 132, minFontSize: 68, maxLines: 4, lineHeight: 1.16 }),
  xhsTemplate("xhs_color_block", "高对比色块", "红黄蓝几何色块、粗黑轮廓，活泼醒目", ["热点", "干货", "挑战", "强观点"], { x: 90, y: 220, width: 900, height: 760, align: "left", color: "#111111", maxFontSize: 136, minFontSize: 70, maxLines: 4, lineHeight: 1.14 }),
  xhsContentTemplate("xhs_color_block", "高对比色块", "红黄蓝几何色块、粗黑轮廓，活泼醒目", ["热点", "干货", "挑战", "强观点"], { x: 90, y: 220, width: 900, height: 760, align: "left", color: "#111111", maxFontSize: 136, minFontSize: 70, maxLines: 4, lineHeight: 1.14 }),
  xhsTemplate("xhs_notebook", "自然手帐", "横格笔记纸、胶带与回形针，温暖自然", ["生活经验", "学习笔记", "成长记录", "方法分享"], { x: 120, y: 270, width: 810, height: 700, align: "left", color: "#232323", maxFontSize: 126, minFontSize: 66, maxLines: 4, lineHeight: 1.18 }),
  xhsContentTemplate("xhs_notebook", "自然手帐", "横格笔记纸、胶带与回形针，温暖自然", ["生活经验", "学习笔记", "成长记录", "方法分享"], { x: 120, y: 270, width: 810, height: 700, align: "left", color: "#232323", maxFontSize: 126, minFontSize: 66, maxLines: 4, lineHeight: 1.18 }),
  xhsTemplate("xhs_editorial", "黑白编辑部", "黑白杂志拼贴、细红线，克制锋利", ["行业观察", "职场观点", "趋势分析", "深度评论"], { x: 86, y: 230, width: 700, height: 820, align: "left", color: "#111111", maxFontSize: 124, minFontSize: 64, maxLines: 5, lineHeight: 1.13 }),
  xhsContentTemplate("xhs_editorial", "黑白编辑部", "黑白杂志拼贴、细红线，克制锋利", ["行业观察", "职场观点", "趋势分析", "深度评论"], { x: 86, y: 230, width: 700, height: 820, align: "left", color: "#111111", maxFontSize: 124, minFontSize: 64, maxLines: 5, lineHeight: 1.13 }),
  xhsTemplate("xhs_collage_paper", "暖色拼贴", "暖米色纸张与四角拼贴，松弛有人情味", ["情绪", "生活", "成长", "故事"], { x: 145, y: 300, width: 790, height: 650, align: "center", color: "#201D19", maxFontSize: 124, minFontSize: 64, maxLines: 4, lineHeight: 1.18 }),
  xhsContentTemplate("xhs_collage_paper", "暖色拼贴", "暖米色纸张与四角拼贴，松弛有人情味", ["情绪", "生活", "成长", "故事"], { x: 145, y: 300, width: 790, height: 650, align: "center", color: "#201D19", maxFontSize: 124, minFontSize: 64, maxLines: 4, lineHeight: 1.18 }),
  xhsTemplate("xhs_blue_grid_paper", "蓝色方格稿纸", "浅蓝方格纸、手绘批注，简单清爽", ["攻略", "教程", "经验总结", "知识点"], { x: 105, y: 285, width: 870, height: 700, align: "left", color: "#111111", maxFontSize: 132, minFontSize: 68, maxLines: 4, lineHeight: 1.16 }),
  xhsContentTemplate("xhs_blue_grid_paper", "蓝色方格稿纸", "浅蓝方格纸、手绘批注，简单清爽", ["攻略", "教程", "经验总结", "知识点"], { x: 105, y: 285, width: 870, height: 700, align: "left", color: "#111111", maxFontSize: 132, minFontSize: 68, maxLines: 4, lineHeight: 1.16 }),
  xhsTemplate("xhs_yellow_ruled_paper", "奶油黄横格纸", "暖黄色横格笔记纸，课堂笔记感", ["知识点", "清单", "避坑", "复盘"], { x: 115, y: 300, width: 850, height: 680, align: "left", color: "#17130D", maxFontSize: 128, minFontSize: 66, maxLines: 4, lineHeight: 1.18 }),
  xhsContentTemplate("xhs_yellow_ruled_paper", "奶油黄横格纸", "暖黄色横格笔记纸，课堂笔记感", ["知识点", "清单", "避坑", "复盘"], { x: 115, y: 300, width: 850, height: 680, align: "left", color: "#17130D", maxFontSize: 128, minFontSize: 66, maxLines: 4, lineHeight: 1.18 }),
  xhsTemplate("xhs_exam_answer_sheet", "考试答题纸", "暖白答题纸、红笔批注，理性明确", ["标准答案", "重点题目", "一次讲清", "考试学习"], { x: 120, y: 275, width: 840, height: 720, align: "left", color: "#151515", maxFontSize: 128, minFontSize: 66, maxLines: 4, lineHeight: 1.17 }),
  xhsContentTemplate("xhs_exam_answer_sheet", "考试答题纸", "暖白答题纸、红笔批注，理性明确", ["标准答案", "重点题目", "一次讲清", "考试学习"], { x: 120, y: 275, width: 840, height: 720, align: "left", color: "#151515", maxFontSize: 128, minFontSize: 66, maxLines: 4, lineHeight: 1.17 }),
  xhsTemplate("xhs_pink_notepad", "粉色横格便签", "低饱和粉色横格纸，柔和简洁", ["成长", "情绪", "关系", "生活经验"], { x: 120, y: 310, width: 840, height: 660, align: "center", color: "#241A1D", maxFontSize: 126, minFontSize: 66, maxLines: 4, lineHeight: 1.18 }),
  xhsContentTemplate("xhs_pink_notepad", "粉色横格便签", "低饱和粉色横格纸，柔和简洁", ["成长", "情绪", "关系", "生活经验"], { x: 120, y: 310, width: 840, height: 660, align: "center", color: "#241A1D", maxFontSize: 126, minFontSize: 66, maxLines: 4, lineHeight: 1.18 }),
  wechatCoverTemplate("wechat_split_editorial", "左右编辑拼贴", "左侧留白、右侧纸张与建筑光影，专业通用", ["深度文章", "商业观察", "职场", "方法论"], { x: 90, y: 105, width: 760, height: 330, align: "left", color: "#191919", maxFontSize: 82, minFontSize: 46, maxLines: 3, lineHeight: 1.18 }),
  wechatCoverTemplate("wechat_dark_focus", "深色聚焦", "深海军蓝、玻璃弧面与冷光，深邃专业", ["科技", "商业", "观点", "深度分析"], { x: 100, y: 105, width: 790, height: 330, align: "left", color: "#FFFFFF", maxFontSize: 82, minFontSize: 46, maxLines: 3, lineHeight: 1.18 }),
  wechatCoverTemplate("wechat_minimal_magazine", "极简杂志", "暖白留白、细线与纸片，克制高级", ["人文", "个人成长", "品牌", "职场"], { x: 100, y: 100, width: 790, height: 340, align: "left", color: "#202020", maxFontSize: 80, minFontSize: 44, maxLines: 3, lineHeight: 1.2 }),
  wechatCoverTemplate("wechat_color_geometry", "彩色几何", "红蓝黄几何色块，高辨识度", ["清单", "教程", "趋势", "资讯"], { x: 115, y: 105, width: 800, height: 330, align: "left", color: "#111111", maxFontSize: 82, minFontSize: 46, maxLines: 3, lineHeight: 1.18 }),
  articleTemplate("article_section_divider", "章节分隔", "暖白纸张与右侧几何锚点，层次清晰", ["章节标题", "话题切换", "长文分隔"], { x: 110, y: 245, width: 830, height: 390, align: "left", color: "#171717", maxFontSize: 100, minFontSize: 54, maxLines: 3, lineHeight: 1.18 }),
  articleTemplate("article_key_takeaway", "重点摘要", "中央白卡、红色边线与荧光强调", ["核心结论", "重点摘要", "关键提醒"], { x: 170, y: 260, width: 1196, height: 390, align: "center", color: "#171717", maxFontSize: 94, minFontSize: 50, maxLines: 3, lineHeight: 1.2 }),
  articleTemplate("article_quote", "观点引用", "暖灰杂志纸张与抽象引用符号", ["金句", "观点", "人物引用"], { x: 175, y: 245, width: 1050, height: 420, align: "left", color: "#25211E", maxFontSize: 90, minFontSize: 48, maxLines: 4, lineHeight: 1.22 }),
  articleTemplate("article_checklist", "步骤清单", "蓝灰纸张与抽象勾选结构，清晰专业", ["方法步骤", "行动清单", "流程总结"], { x: 110, y: 230, width: 850, height: 430, align: "left", color: "#162026", maxFontSize: 94, minFontSize: 50, maxLines: 4, lineHeight: 1.2 })
];

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

export function createServer() {
  return createSdkMcpServer({
    name: "image",
    tools: [
      tool(
        "image_generate",
        "图片生成：根据提示词调用当前配置的图片模型供应商生成图片，并保存到调用方传入的本地 outputPath。",
        {
          prompt: z.string().min(1).describe("图片生成提示词，支持中文或英文。"),
          outputPath: z.string().min(1).describe("图片保存路径。相对路径基于当前工作目录，支持 ~/ 前缀。"),
          size: z.string().min(1).optional().describe("图片尺寸：wechat-cover、cover、article、vertical、square，或显式 WxH，例如 1024x1024。默认 square。")
        },
        async (args) => {
          try {
            return jsonResult(await generateImage(args));
          } catch (error) {
            return jsonResult({ ok: false, error: error instanceof Error ? error.message : String(error) }, true);
          }
        },
        {
          searchHint: "图片生成 生图 文生图 封面图 配图 image generate",
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true
          }
        }
      ),
      tool(
        "image_template_list",
        "查询指定业务类型可用的本地图片模板，只返回该类型模板的风格、适用场景和文字布局。",
        {
          type: z.enum(["xhs_cover", "xhs_content", "gzh_cover", "gzh_content"]).describe("模板业务类型：小红书封面、小红书内容图、公众号封面或公众号内容图。")
        },
        async (args) => jsonResult({
          ok: true,
          type: args.type,
          templates: listImageTemplates(args.type)
        }),
        {
          searchHint: "模板列表 模板风格 适用场景 小红书封面 公众号封面 内容图 image template list",
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
          }
        }
      ),
      tool(
        "image_template_generate",
        "本地模板图片生成：封面排版标题和可选副标题，内容图排版标题和可选正文，输出 PNG。",
        {
          type: z.enum(["xhs_cover", "xhs_content", "gzh_cover", "gzh_content"]).describe("模板业务类型：小红书封面、小红书内容图、公众号封面或公众号内容图。"),
          title: z.string().min(1).describe("必须显示的主标题。"),
          subtitle: z.string().optional().describe("封面可选副标题；仅用于 xhs_cover 和 gzh_cover，为空时不显示。"),
          content: z.string().optional().describe("内容图可选正文；仅用于 xhs_content 和 gzh_content，支持显式换行和自动换行。"),
          template: z.string().optional().describe("可选模板 id；应先用 image_template_list 查询当前 type。省略时根据标题稳定选择。"),
          outputPath: z.string().min(1).describe("以 .png 结尾的图片保存路径。相对路径基于当前工作目录，支持 ~/ 前缀。")
        },
        async (args) => {
          try {
            return jsonResult(await generateTemplateImage(args));
          } catch (error) {
            return jsonResult({ ok: false, error: error instanceof Error ? error.message : String(error) }, true);
          }
        },
        {
          searchHint: "模板图片生成 小红书封面 公众号封面 内文卡片 标题排版 template image generate",
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
          }
        }
      )
    ]
  });
}

export async function generateImage(args: GenerateImageArgs): Promise<GenerateImageResult> {
  const provider = loadActiveImageProvider();
  const requestedSize = args.size?.trim() || "square";
  const resolvedSize = resolveProviderSize(provider.providerType, requestedSize);
  const outputPath = resolveOutputPath(args.outputPath);
  const generated = await callProvider(provider, args.prompt, resolvedSize);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, generated.bytes);
  const dimensions = readImageDimensions(generated.bytes, generated.mimeType);

  return {
    ok: true,
    providerType: provider.providerType,
    model: provider.model,
    outputPath,
    size: resolvedSize,
    width: dimensions.width,
    height: dimensions.height,
    bytes: generated.bytes.byteLength,
    mimeType: generated.mimeType
  };
}

export async function generateTemplateImage(args: GenerateTemplateImageArgs, assetsDir = TEMPLATE_ASSETS_DIR): Promise<GenerateTemplateImageResult> {
  const title = args.title.trim();
  const subtitle = args.subtitle?.trim() || "";
  const content = args.content?.trim() || "";
  if (!title) throw new Error("模板图片生成需要非空 title。");
  const isContentTemplate = args.type === "xhs_content" || args.type === "gzh_content";
  if (isContentTemplate && subtitle) {
    throw new Error(`${args.type} 不支持 subtitle，请使用 content 传入正文。`);
  }
  if (!isContentTemplate && content) {
    throw new Error(`${args.type} 不支持 content，请使用 subtitle 传入副标题。`);
  }
  validateTemplateTextLengths(args.type, { title, subtitle, content });

  const outputPath = resolveOutputPath(args.outputPath);
  if (path.extname(outputPath).toLowerCase() !== ".png") {
    throw new Error("模板图片生成只支持 .png 输出路径。");
  }

  const template = selectImageTemplate(args.type, title, args.template);
  const backgroundPath = path.join(assetsDir, "templates", template.background);
  if (!fs.existsSync(backgroundPath)) {
    throw new Error(`模板背景不存在：${backgroundPath}。请按 docs/spec/image-template-prompts.md 生成并放入该路径。`);
  }

  loadTemplateFonts(assetsDir);

  const background = await PImage.decodePNGFromStream(fs.createReadStream(backgroundPath));
  const crop = resolveBackgroundCrop(background.width, background.height, template.width, template.height);

  const canvas = PImage.make(template.width, template.height);
  const context = canvas.getContext("2d");
  context.drawImage(
    background,
    crop.sourceX,
    crop.sourceY,
    crop.sourceWidth,
    crop.sourceHeight,
    0,
    0,
    template.width,
    template.height
  );
  drawTextBox(context, title, template.title, TEMPLATE_TITLE_FONT_FAMILY);
  if (subtitle && template.subtitle) {
    drawTextBox(context, subtitle, template.subtitle, TEMPLATE_TITLE_FONT_FAMILY);
  }
  if (content && template.content) {
    drawTextBox(context, content, template.content, TEMPLATE_CONTENT_FONT_FAMILY);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await PImage.encodePNGToStream(canvas, fs.createWriteStream(outputPath));
  const bytes = fs.statSync(outputPath).size;

  return {
    ok: true,
    source: "local-template",
    type: template.type,
    templateId: template.id,
    outputPath,
    size: `${template.width}x${template.height}`,
    width: template.width,
    height: template.height,
    bytes,
    mimeType: "image/png"
  };
}

export function listImageTemplates(type: ImageTemplateType): Array<{
  id: string;
  name: string;
  style: string;
  suitableFor: string[];
  titleLayout: string;
  secondaryTextLayout?: string;
  recommendedTitleLength: string;
}> {
  return templatesForType(type).map((template) => ({
    id: template.id,
    name: template.name,
    style: template.style,
    suitableFor: [...template.suitableFor],
    titleLayout: `${template.title.align === "center" ? "居中" : "左对齐"}，最多${template.title.maxLines}行`,
    secondaryTextLayout: template.content
      ? `可选正文，${template.content.align === "center" ? "居中" : "左对齐"}，最多${template.content.maxLines}行，支持换行`
      : template.subtitle
        ? `可选副标题，${template.subtitle.align === "center" ? "居中" : "左对齐"}，最多${template.subtitle.maxLines}行`
        : undefined,
    recommendedTitleLength: template.recommendedTitleLength
  }));
}

export function selectImageTemplate(type: ImageTemplateType, title: string, requestedTemplate?: string): ImageTemplate {
  const candidates = templatesForType(type);
  if (requestedTemplate?.trim()) {
    const selected = candidates.find((template) => template.id === requestedTemplate.trim());
    if (!selected) {
      throw new Error(`模板 ${requestedTemplate} 不属于 ${type}。请先调用 image_template_list 查询可选模板。`);
    }
    return selected;
  }
  return candidates[hashString(title.trim()) % candidates.length];
}

function templatesForType(type: ImageTemplateType): ImageTemplate[] {
  const candidates = IMAGE_TEMPLATES.filter((template) => template.type === type);
  if (candidates.length === 0) {
    throw new Error(`不支持的模板类型：${type}。请使用 xhs_cover、xhs_content、gzh_cover 或 gzh_content。`);
  }
  return candidates;
}

export function resolveBackgroundCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number
): BackgroundCrop {
  for (const [name, value] of Object.entries({ sourceWidth, sourceHeight, targetWidth, targetHeight })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`模板图片尺寸无效：${name}=${value}。`);
    }
  }

  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;
  if (Math.abs(sourceRatio - targetRatio) < 1e-9) {
    return { sourceX: 0, sourceY: 0, sourceWidth, sourceHeight };
  }
  if (sourceRatio > targetRatio) {
    const croppedWidth = sourceHeight * targetRatio;
    return {
      sourceX: (sourceWidth - croppedWidth) / 2,
      sourceY: 0,
      sourceWidth: croppedWidth,
      sourceHeight
    };
  }

  const croppedHeight = sourceWidth / targetRatio;
  return {
    sourceX: 0,
    sourceY: (sourceHeight - croppedHeight) / 2,
    sourceWidth,
    sourceHeight: croppedHeight
  };
}

export function loadActiveImageProvider(configPath = CONFIG_PATH): ImageProviderConfig & { providerType: ImageProviderType } {
  const parsed = readConfig(configPath);
  const provider = normalizeImageProvider(parsed.imageProvider);
  validateImageProvider(provider, configPath);
  return provider as ImageProviderConfig & { providerType: ImageProviderType };
}

export function validateImageProvider(provider: ImageProviderConfig, configPath = CONFIG_PATH): void {
  if (!provider.providerType && !provider.baseUrl && !provider.apiKey && !provider.model) {
    throw new Error(`图片生成配置为空：请先在 GrowthForce 设置页补充图片模型供应商，或手动配置 ${configPath} 的 imageProvider。`);
  }

  const missing = [];
  if (!provider.providerType) missing.push("providerType");
  if (!provider.baseUrl) missing.push("baseUrl");
  if (!provider.apiKey) missing.push("apiKey");
  if (!provider.model) missing.push("model");
  if (missing.length > 0) {
    throw new Error(`图片生成配置不完整：${configPath} 的 imageProvider 缺少 ${missing.join(", ")}。请补充后重试。`);
  }
}

export function resolveProviderSize(providerType: ImageProviderType, size: string): string {
  const normalized = size.trim();
  if (!normalized) return resolveProviderSize(providerType, "square");
  if (SIZE_PRESETS.has(normalized as ImageSizePreset)) {
    return resolvePresetSize(providerType, normalized as ImageSizePreset);
  }
  return normalized;
}

export function nearestAspectRatio(size: string): string {
  if (size.includes(":")) return size;
  const match = /^(\d+)x(\d+)$/i.exec(size.trim());
  if (!match) return "1:1";
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "1:1";
  const ratio = width / height;
  const aspects = [
    ["1:1", 1],
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["4:3", 4 / 3],
    ["3:4", 3 / 4],
    ["3:2", 3 / 2],
    ["2:3", 2 / 3]
  ] as const;
  return aspects.reduce((best, current) => Math.abs(current[1] - ratio) < Math.abs(best[1] - ratio) ? current : best)[0];
}

export function parseImageFromResponse(providerType: ImageProviderType, data: unknown): { image: string; mimeType: string } {
  const record = asRecord(data);
  if (providerType === "gemini") {
    const parts = asArray(asRecord(asArray(record.candidates)[0])?.content ? asRecord(asRecord(asArray(record.candidates)[0]).content).parts : undefined);
    for (const item of parts) {
      const inline = asRecord(asRecord(item).inlineData ?? asRecord(item).inline_data);
      const mimeType = normalizeString(inline.mimeType ?? inline.mime_type);
      const image = normalizeString(inline.data);
      if (image && mimeType.startsWith("image/")) return { image, mimeType };
    }
    throw new Error("Gemini 响应中没有图片数据。");
  }

  if (providerType === "dashscope") {
    const output = asRecord(record.output);
    const resultImage = normalizeString(output.result_image);
    if (resultImage) return { image: resultImage, mimeType: DEFAULT_MIME_TYPE };
    const choices = asArray(output.choices);
    for (const choice of choices) {
      const content = asArray(asRecord(asRecord(choice).message).content);
      for (const item of content) {
        const image = normalizeString(asRecord(item).image);
        if (image) return { image, mimeType: DEFAULT_MIME_TYPE };
      }
    }
    throw new Error("DashScope 响应中没有图片数据。");
  }

  if (providerType === "minimax") {
    const dataRecord = asRecord(record.data);
    const b64 = asArray(dataRecord.image_base64).map(normalizeString).find(Boolean);
    if (b64) return { image: b64, mimeType: "image/jpeg" };
    const url = asArray(dataRecord.image_urls).map(normalizeString).find(Boolean);
    if (url) return { image: url, mimeType: DEFAULT_MIME_TYPE };
    throw new Error("MiniMax 响应中没有图片数据。");
  }

  const item = asRecord(asArray(record.data)[0]);
  const b64 = normalizeString(item.b64_json);
  if (b64) return { image: b64, mimeType: DEFAULT_MIME_TYPE };
  const url = normalizeString(item.url);
  if (url) return { image: url, mimeType: DEFAULT_MIME_TYPE };
  throw new Error(`${providerType} 响应中没有图片数据。`);
}

async function callProvider(provider: ImageProviderConfig & { providerType: ImageProviderType }, prompt: string, size: string): Promise<GeneratedImage> {
  const response = await requestProvider(provider, prompt, size);
  const parsed = parseImageFromResponse(provider.providerType, response);
  return resolveImagePayload(parsed.image, parsed.mimeType);
}

async function requestProvider(provider: ImageProviderConfig & { providerType: ImageProviderType }, prompt: string, size: string): Promise<unknown> {
  switch (provider.providerType) {
    case "openai":
      return postJson(provider, "/images/generations", {
        model: provider.model,
        prompt,
        n: 1,
        size
      });
    case "openai-compatible":
      return postJson(provider, "/images/generations", {
        model: provider.model,
        prompt,
        n: 1,
        size,
        response_format: "b64_json"
      });
    case "doubao":
      return postJson(provider, "/images/generations", {
        model: provider.model,
        prompt,
        size,
        response_format: "b64_json",
        output_format: "png",
        stream: false,
        watermark: false
      });
    case "gemini":
      return postJson(provider, `/models/${encodeURIComponent(provider.model)}:generateContent`, {
        contents: [{ parts: [{ text: promptWithSize(prompt, size) }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
      }, { apiKeyHeader: "x-goog-api-key" });
    case "dashscope":
      return postJson(provider, "/services/aigc/multimodal-generation/generation", {
        model: provider.model,
        input: {
          messages: [{ role: "user", content: [{ text: prompt }] }]
        },
        parameters: {
          prompt_extend: false,
          size: size.replace(/x/i, "*"),
          watermark: false,
          n: 1
        }
      });
    case "minimax":
      return postJson(provider, "/image_generation", {
        model: provider.model,
        prompt,
        aspect_ratio: nearestAspectRatio(size),
        response_format: "base64",
        n: 1
      });
  }
}

async function postJson(
  provider: ImageProviderConfig & { providerType: ImageProviderType },
  endpoint: string,
  body: Record<string, unknown>,
  options: { apiKeyHeader?: string } = {}
): Promise<unknown> {
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}${endpoint}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.apiKeyHeader) headers[options.apiKeyHeader] = provider.apiKey;
  else headers.Authorization = `Bearer ${provider.apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const data = parseJsonOrText(text);
  if (!response.ok) {
    throw new Error(formatProviderError(provider.providerType, response.status, data));
  }
  return data;
}

async function resolveImagePayload(image: string, mimeType: string): Promise<GeneratedImage> {
  if (/^https?:\/\//i.test(image)) {
    const response = await fetch(image);
    if (!response.ok) throw new Error(`下载生成图片失败：HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { bytes, mimeType: response.headers.get("content-type")?.split(";")[0] || mimeType };
  }

  const dataUrl = /^data:(image\/[^;]+);base64,(.+)$/i.exec(image);
  if (dataUrl) {
    return { bytes: Buffer.from(dataUrl[2], "base64"), mimeType: dataUrl[1] };
  }

  return { bytes: Buffer.from(image, "base64"), mimeType };
}

export function readImageDimensions(bytes: Buffer, mimeType = ""): { width: number; height: number } {
  if (bytes.length >= 24
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return readJpegDimensions(bytes);
  }

  if (bytes.length >= 30
    && bytes.toString("ascii", 0, 4) === "RIFF"
    && bytes.toString("ascii", 8, 12) === "WEBP") {
    return readWebpDimensions(bytes);
  }

  throw new Error(`无法解析生成图片尺寸：${mimeType || "unknown image type"}`);
}

function readJpegDimensions(bytes: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > bytes.length) break;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;

    if (
      (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3)
      };
    }

    offset += segmentLength;
  }
  throw new Error("无法解析生成图片尺寸：invalid jpeg");
}

function readWebpDimensions(bytes: Buffer): { width: number; height: number } {
  const chunkType = bytes.toString("ascii", 12, 16);
  if (chunkType === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3)
    };
  }

  if (chunkType === "VP8L" && bytes.length >= 25) {
    const bits = bytes.readUInt32LE(21);
    return {
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >> 14) & 0x3fff)
    };
  }

  if (chunkType === "VP8 " && bytes.length >= 30) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff
    };
  }

  throw new Error("无法解析生成图片尺寸：invalid webp");
}

function readConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, "utf8")) ?? {};
    return asRecord(parsed);
  } catch (error) {
    throw new Error(`图片生成配置解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeImageProvider(value: unknown): ImageProviderConfig {
  const provider = asRecord(value);
  return {
    id: normalizeString(provider.id),
    name: normalizeString(provider.name),
    providerType: normalizeImageProviderType(provider.providerType),
    baseUrl: normalizeString(provider.baseUrl),
    apiKey: normalizeString(provider.apiKey),
    model: normalizeString(provider.model)
  };
}

function normalizeImageProviderType(value: unknown): ImageProviderConfig["providerType"] {
  if (
    value === "doubao" ||
    value === "openai" ||
    value === "gemini" ||
    value === "dashscope" ||
    value === "minimax" ||
    value === "openai-compatible"
  ) {
    return value;
  }
  return "";
}

function resolvePresetSize(providerType: ImageProviderType, preset: ImageSizePreset): string {
  if (preset === "wechat-cover") {
    if (providerType === "doubao") return "2952x1256";
    if (providerType === "minimax") return "16:9";
    return "1536x1024";
  }
  if (providerType === "minimax") {
    return ({ cover: "16:9", article: "16:9", vertical: "9:16", square: "1:1" })[preset];
  }
  if (providerType === "doubao") {
    return ({ cover: "2560x1440", article: "2560x1440", vertical: "1440x2560", square: "2048x2048" })[preset];
  }
  return ({ cover: "1536x1024", article: "1536x1024", vertical: "1024x1536", square: "1024x1024" })[preset];
}

function xhsTemplate(id: string, name: string, style: string, suitableFor: string[], title: TemplateTextBox): ImageTemplate {
  return {
    id,
    type: "xhs_cover",
    name,
    style,
    suitableFor,
    recommendedTitleLength: "6-18字",
    width: 1080,
    height: 1440,
    background: `${id}.png`,
    title,
    subtitle: { x: title.x, y: 1000, width: title.width, height: 150, align: title.align, color: title.color, maxFontSize: 42, minFontSize: 30, maxLines: 2, lineHeight: 1.25 }
  };
}

function xhsContentTemplate(id: string, name: string, style: string, suitableFor: string[], coverTitle: TemplateTextBox): ImageTemplate {
  const contentY = coverTitle.y + 220;
  return {
    id,
    type: "xhs_content",
    name,
    style,
    suitableFor,
    recommendedTitleLength: "6-24字",
    width: 1080,
    height: 1440,
    background: `${id}.png`,
    title: {
      x: coverTitle.x,
      y: coverTitle.y,
      width: coverTitle.width,
      height: 170,
      align: coverTitle.align,
      color: coverTitle.color,
      maxFontSize: 64,
      minFontSize: 42,
      maxLines: 2,
      lineHeight: 1.18
    },
    content: {
      x: coverTitle.x,
      y: contentY,
      width: coverTitle.width,
      height: Math.max(360, Math.min(620, 1160 - contentY)),
      align: coverTitle.align,
      color: coverTitle.color,
      maxFontSize: 38,
      minFontSize: 26,
      maxLines: 8,
      lineHeight: 1.38
    }
  };
}

function wechatCoverTemplate(id: string, name: string, style: string, suitableFor: string[], title: TemplateTextBox): ImageTemplate {
  return {
    id,
    type: "gzh_cover",
    name,
    style,
    suitableFor,
    recommendedTitleLength: "8-24字",
    width: 1476,
    height: 628,
    background: `${id}.png`,
    title,
    subtitle: { x: title.x, y: 430, width: title.width, height: 90, align: title.align, color: title.color, maxFontSize: 30, minFontSize: 22, maxLines: 2, lineHeight: 1.2 }
  };
}

function articleTemplate(id: string, name: string, style: string, suitableFor: string[], title: TemplateTextBox): ImageTemplate {
  return {
    id,
    type: "gzh_content",
    name,
    style,
    suitableFor,
    recommendedTitleLength: "4-20字",
    width: 1536,
    height: 1024,
    background: `${id}.png`,
    title: { ...title, y: 160, height: 360 },
    content: { x: title.x, y: 530, width: title.width, height: 190, align: title.align, color: title.color, maxFontSize: 34, minFontSize: 22, maxLines: 5, lineHeight: 1.4 }
  };
}

function validateTemplateTextLengths(type: ImageTemplateType, text: { title: string; subtitle: string; content: string }): void {
  const limits = TEMPLATE_TEXT_LIMITS[type];
  validateTemplateTextLength(type, "title", text.title, limits.title);
  if (text.subtitle && limits.subtitle !== undefined) {
    validateTemplateTextLength(type, "subtitle", text.subtitle, limits.subtitle);
  }
  if (text.content && limits.content !== undefined) {
    validateTemplateTextLength(type, "content", text.content, limits.content);
  }
}

function validateTemplateTextLength(type: ImageTemplateType, field: "title" | "subtitle" | "content", value: string, maxLength: number): void {
  const length = Array.from(value).length;
  if (length > maxLength) {
    throw new Error(`${type} 的 ${field} 超过字数限制：当前 ${length} 字，最多 ${maxLength} 字。`);
  }
}

export function resolveTemplateFontPaths(assetsDir = TEMPLATE_ASSETS_DIR): { title: string; content: string } {
  const fontsDir = path.join(assetsDir, "fonts");
  const fontPaths = {
    title: path.join(fontsDir, "JiangChengZhiYinTi-600W.ttf"),
    content: path.join(fontsDir, "JiangChengZhiYinTi-400W.ttf")
  };
  for (const [role, fontPath] of Object.entries(fontPaths)) {
    if (!fs.existsSync(fontPath)) {
      throw new Error(`缺少内置${role === "title" ? "标题" : "正文"}字体：${fontPath}。请重新安装包含完整模板资源的应用。`);
    }
  }
  return fontPaths;
}

function loadTemplateFonts(assetsDir = TEMPLATE_ASSETS_DIR): void {
  const fontPaths = resolveTemplateFontPaths(assetsDir);
  PImage.registerFont(fontPaths.title, TEMPLATE_TITLE_FONT_FAMILY).loadSync();
  PImage.registerFont(fontPaths.content, TEMPLATE_CONTENT_FONT_FAMILY).loadSync();
}

function drawTextBox(
  context: ReturnType<ReturnType<typeof PImage.make>["getContext"]>,
  text: string,
  box: TemplateTextBox,
  fontFamily: string
): void {
  const fitted = fitText(context, text, box, fontFamily);
  context.fillStyle = box.color;
  context.font = `${fitted.fontSize} ${fontFamily}`;
  context.textAlign = box.align;
  const x = box.align === "center" ? box.x + box.width / 2 : box.x;
  const totalHeight = fitted.lines.length * fitted.fontSize * box.lineHeight;
  let baseline = box.y + Math.max(fitted.fontSize, (box.height - totalHeight) / 2 + fitted.fontSize);
  for (const line of fitted.lines) {
    context.fillText(line, x, baseline);
    baseline += fitted.fontSize * box.lineHeight;
  }
}

function fitText(
  context: ReturnType<ReturnType<typeof PImage.make>["getContext"]>,
  text: string,
  box: TemplateTextBox,
  fontFamily: string
): { fontSize: number; lines: string[] } {
  for (let fontSize = box.maxFontSize; fontSize >= box.minFontSize; fontSize -= 2) {
    context.font = `${fontSize} ${fontFamily}`;
    const lines = wrapText(context, text, box.width);
    if (lines.length <= box.maxLines && lines.length * fontSize * box.lineHeight <= box.height) {
      return { fontSize, lines };
    }
  }
  throw new Error(`文字过长，无法放入模板：${text}`);
}

function wrapText(context: ReturnType<ReturnType<typeof PImage.make>["getContext"]>, text: string, maxWidth: number): string[] {
  const paragraphs = text.split(/\r?\n/);
  const lines: string[] = [];
  const cannotStartLine = /^[，。！？；：、）》」』】〕〉…]$/;
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const character of Array.from(paragraph)) {
      const candidate = line + character;
      if (line && context.measureText(candidate).width > maxWidth) {
        if (cannotStartLine.test(character)) {
          line = candidate;
        } else {
          lines.push(line);
          line = character;
        }
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function resolveOutputPath(outputPath: string): string {
  const trimmed = outputPath.trim();
  const expanded = trimmed === "~" ? os.homedir() : trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
  return path.resolve(expanded);
}

function promptWithSize(prompt: string, size: string): string {
  if (size.includes(":")) return `${prompt}\n\nAspect ratio: ${size}.`;
  return `${prompt}\n\nGenerate the image at ${size} resolution.`;
}

function parseJsonOrText(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatProviderError(providerType: ImageProviderType, status: number, data: unknown): string {
  const record = asRecord(data);
  const errorRecord = asRecord(record.error);
  const message = normalizeString(errorRecord.message) || normalizeString(record.message) || normalizeString(record.msg) || (typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300));
  const requestId = normalizeString(record.request_id) || normalizeString(record.id);
  return `${providerType} 图片生成失败：HTTP ${status}${requestId ? `，request_id=${requestId}` : ""}，${message}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export { CONFIG_PATH };
