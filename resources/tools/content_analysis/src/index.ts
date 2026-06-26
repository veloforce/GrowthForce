import { createSdkMcpServer, tool } from "../../runtime";
import { z } from "zod/v4";

type ArticleInput = { title?: string; markdown: string };
type Section = { heading: string; body: string };

const MAX_ARTICLES = 50;
const MAX_ARTICLE_CHARS = 100_000;

function jsonResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    isError
  };
}

export function createServer() {
  return createSdkMcpServer({
    name: "content_analysis",
    tools: [
      tool(
        "content_compare_versions",
        "无状态比较 Markdown 初稿和终稿，返回结构化变化与证据片段；不写文件、不沉淀规则。",
        {
          draftMarkdown: z.string().min(1).max(MAX_ARTICLE_CHARS).describe("待比较的初稿 Markdown。"),
          finalMarkdown: z.string().min(1).max(MAX_ARTICLE_CHARS).describe("用户修改后的终稿 Markdown。")
        },
        async (args) => invoke(() => compareVersions(args.draftMarkdown, args.finalMarkdown)),
        readOnlyAnnotations("内容版本对比 编辑修改 diff 证据")
      ),
      tool(
        "content_analyze_corpus",
        "无状态分析历史文章语料的可量化写作模式并返回证据；不生成或写入 playbook。",
        {
          articles: z.array(z.object({
            title: z.string().optional().describe("可选标题；未传时从 Markdown H1 提取。"),
            markdown: z.string().min(1).max(MAX_ARTICLE_CHARS).describe("文章 Markdown。")
          })).min(1).max(MAX_ARTICLES)
        },
        async (args) => invoke(() => analyzeCorpus(args.articles)),
        readOnlyAnnotations("历史文章 语料 风格 模式 分析 证据")
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
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  };
}

export function compareVersions(draftMarkdown: string, finalMarkdown: string) {
  const draft = requireMarkdown(draftMarkdown, "draftMarkdown");
  const final = requireMarkdown(finalMarkdown, "finalMarkdown");
  const draftTitle = extractTitle(draft);
  const finalTitle = extractTitle(final);
  const draftHeadings = splitSections(draft).map((section) => section.heading).filter(Boolean);
  const finalHeadings = splitSections(final).map((section) => section.heading).filter(Boolean);
  const draftLines = meaningfulLines(draft);
  const finalLines = meaningfulLines(final);
  const draftSet = new Set(draftLines);
  const finalSet = new Set(finalLines);
  const additions = finalLines.filter((line) => !draftSet.has(line));
  const deletions = draftLines.filter((line) => !finalSet.has(line));
  const replacements = pairLikelyReplacements(deletions, additions);

  return {
    ok: true,
    title: { changed: draftTitle !== finalTitle, draft: draftTitle, final: finalTitle },
    structure: {
      changed: !sameArray(draftHeadings, finalHeadings),
      draftHeadings,
      finalHeadings
    },
    length: {
      draftChars: visibleCharCount(draft),
      finalChars: visibleCharCount(final),
      deltaChars: visibleCharCount(final) - visibleCharCount(draft)
    },
    evidence: {
      additions: additions.slice(0, 30),
      deletions: deletions.slice(0, 30),
      replacements: replacements.slice(0, 20)
    }
  };
}

export function analyzeCorpus(articles: ArticleInput[]) {
  if (!Array.isArray(articles) || articles.length === 0) throw new Error("articles 不能为空");
  if (articles.length > MAX_ARTICLES) throw new Error(`articles 最多 ${MAX_ARTICLES} 篇`);

  const normalized = articles.map((article, index) => {
    const markdown = requireMarkdown(article.markdown, `articles[${index}].markdown`);
    const title = article.title?.trim() || extractTitle(markdown) || `未命名文章 ${index + 1}`;
    const paragraphs = extractParagraphs(markdown);
    const headings = splitSections(markdown).map((section) => section.heading).filter(Boolean);
    return {
      title,
      markdown,
      paragraphs,
      headings,
      opening: paragraphs[0] ?? "",
      closing: paragraphs.at(-1) ?? ""
    };
  });

  const titleLengths = normalized.map((article) => article.title.length);
  const paragraphLengths = normalized.flatMap((article) => article.paragraphs.map((paragraph) => visibleCharCount(paragraph)));
  const headingLengths = normalized.flatMap((article) => article.headings.map((heading) => heading.length));
  const questionHeadingCount = normalized.flatMap((article) => article.headings).filter((heading) => /[?？]$/.test(heading)).length;
  const totalHeadingCount = normalized.reduce((sum, article) => sum + article.headings.length, 0);
  const commonTerms = collectCommonTerms(normalized.map((article) => article.markdown));

  const evidence = {
    titleSamples: normalized.map((article) => article.title).slice(0, 20),
    openingSamples: normalized.map((article) => article.opening).filter(Boolean).slice(0, 10),
    closingSamples: normalized.map((article) => article.closing).filter(Boolean).slice(0, 10),
    headingSamples: normalized.flatMap((article) => article.headings).slice(0, 20),
    commonTerms
  };

  return {
    ok: true,
    articleCount: normalized.length,
    metrics: {
      titleLength: summarizeNumbers(titleLengths),
      articleCharCount: summarizeNumbers(normalized.map((article) => visibleCharCount(article.markdown))),
      paragraphLength: summarizeNumbers(paragraphLengths),
      paragraphsPerArticle: summarizeNumbers(normalized.map((article) => article.paragraphs.length)),
      headingsPerArticle: summarizeNumbers(normalized.map((article) => article.headings.length)),
      headingLength: summarizeNumbers(headingLengths),
      questionHeadingRate: totalHeadingCount === 0 ? 0 : round(questionHeadingCount / totalHeadingCount)
    },
    evidence,
    patternCandidates: [
      evidence.commonTerms.length > 0 ? {
        key: "common_terms",
        observation: `语料中重复出现的特征词包括：${evidence.commonTerms.map((item) => item.term).join("、")}`,
        evidence: evidence.commonTerms
      } : null,
      paragraphLengths.length > 0 ? {
        key: "paragraph_length",
        observation: `段落长度中位数为 ${summarizeNumbers(paragraphLengths).median} 字`,
        evidence: { paragraphLength: summarizeNumbers(paragraphLengths) }
      } : null,
      totalHeadingCount > 0 ? {
        key: "heading_style",
        observation: `问句型 H2 占比为 ${Math.round((questionHeadingCount / totalHeadingCount) * 100)}%`,
        evidence: { headingSamples: evidence.headingSamples, questionHeadingCount, totalHeadingCount }
      } : null
    ].filter(Boolean)
  };
}

function requireMarkdown(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} 不能为空`);
  if (trimmed.length > MAX_ARTICLE_CHARS) throw new Error(`${field} 超过 ${MAX_ARTICLE_CHARS} 字符`);
  return trimmed;
}

function extractTitle(markdown: string): string {
  return markdown.split(/\r?\n/).find((line) => /^#\s+/.test(line.trim()))?.trim().replace(/^#\s+/, "") ?? "";
}

function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { heading: "", body: "" };
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current.heading || current.body.trim()) sections.push({ ...current, body: current.body.trim() });
      current = { heading: heading[1].trim(), body: "" };
    } else {
      current.body += `${current.body ? "\n" : ""}${line}`;
    }
  }
  if (current.heading || current.body.trim()) sections.push({ ...current, body: current.body.trim() });
  return sections;
}

function meaningfulLines(markdown: string): string[] {
  return markdown.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^!\[.*]\(.*\)$/.test(line));
}

function extractParagraphs(markdown: string): string[] {
  return markdown
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function pairLikelyReplacements(deletions: string[], additions: string[]) {
  const available = [...additions];
  const pairs: Array<{ before: string; after: string; similarity: number }> = [];
  for (const before of deletions) {
    let bestIndex = -1;
    let bestSimilarity = 0;
    for (let index = 0; index < available.length; index += 1) {
      const similarity = textSimilarity(before, available[index]);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0 && bestSimilarity >= 0.2) {
      pairs.push({ before, after: available[bestIndex], similarity: round(bestSimilarity) });
      available.splice(bestIndex, 1);
    }
  }
  return pairs;
}

function textSimilarity(left: string, right: string): number {
  const leftChars = new Set(Array.from(left.replace(/\s+/g, "")));
  const rightChars = new Set(Array.from(right.replace(/\s+/g, "")));
  const union = new Set([...leftChars, ...rightChars]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const char of leftChars) if (rightChars.has(char)) intersection += 1;
  return intersection / union.size;
}

function collectCommonTerms(markdowns: string[]) {
  const counts = new Map<string, number>();
  for (const markdown of markdowns) {
    const unique = new Set(markdown.match(/[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_-]{1,15}/gu) ?? []);
    for (const term of unique) {
      if (/^(一个|这个|我们|你们|他们|因为|所以|但是|可以|没有|不是)$/.test(term)) continue;
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 20)
    .map(([term, articleOccurrences]) => ({ term, articleOccurrences }));
}

function summarizeNumbers(values: number[]) {
  if (values.length === 0) return { min: 0, max: 0, average: 0, median: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return {
    min: sorted[0],
    max: sorted.at(-1) ?? sorted[0],
    average: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    median: round(median)
  };
}

function visibleCharCount(value: string): number {
  return value.replace(/\s+/g, "").length;
}

function sameArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
