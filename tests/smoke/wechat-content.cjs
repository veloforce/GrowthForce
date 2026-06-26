const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sdk = require("@anthropic-ai/claude-agent-sdk");

const rootDir = path.resolve(__dirname, "../..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-wechat-content-"));
const runtimeSymbol = Symbol.for("agentstudio.tool-runtime");
globalThis[runtimeSymbol] = Object.freeze({
  createSdkMcpServer: sdk.createSdkMcpServer,
  tool: sdk.tool
});

const contentTool = require(path.join(rootDir, "resources/tools/wechat_content/dist/index.js"));
const wechatOps = require(path.join(rootDir, "resources/tools/wechat_ops/dist/index.js"));

try {
  const articlePath = path.join(tempDir, "article.md");
  const imagePath = path.join(tempDir, "inline.png");
  const coverPath = path.join(tempDir, "cover.png");
  const outputDir = path.join(tempDir, "output");
  fs.writeFileSync(imagePath, "image");
  fs.writeFileSync(coverPath, "cover");
  fs.writeFileSync(articlePath, [
    "# 测试标题",
    "",
    "中文AI混排，访问[示例](https://example.com)。",
    "",
    "## 列表",
    "",
    "- 第一项",
    "- 第二项",
    "",
    ":::callout tip",
    "真实提示",
    ":::",
    "",
    ":::dialogue",
    "左侧消息",
    "> 右侧消息",
    ":::",
    "",
    ":::timeline",
    "**第一步** 开始",
    "**第二步** 完成",
    ":::",
    "",
    ":::quote",
    "引用内容",
    ":::",
    "",
    ":::highlight",
    "高亮标题",
    "高亮正文",
    ":::",
    "",
    ":::summary",
    "总结标题",
    "总结正文",
    ":::",
    "",
    "| 列一 | 列二 |",
    "| --- | --- |",
    "| A | B |",
    "",
    "```js",
    "console.log('中文AI不应被加空格');",
    "```",
    "",
    "![本地图](./inline.png)"
  ].join("\n"));

  const themesDir = path.join(rootDir, "resources/skills/orchestrator/wechat-markdown-to-html/themes");
  const themes = fs.readdirSync(themesDir).filter((name) => name.endsWith(".yaml")).sort();
  assert.ok(themes.length >= 16, "expected all bundled theme files");
  for (const themeName of themes) {
    const result = contentTool.renderMarkdownPackage({
      markdownPath: articlePath,
      themePath: path.join(themesDir, themeName),
      outputDir,
      coverPath
    });
    assert.equal(result.validationStatus, "valid", `${themeName} should produce a valid package`);
    const html = fs.readFileSync(result.contentHtmlPath, "utf8");
    assert.ok(html.length > 100);
    assert.match(html, /参考链接/);
    assert.match(html, /data-darkmode/);
    assert.match(html, /src="\/.*inline\.png"/);
    assert.match(html, /justify-content: flex-end/);
    assert.match(html, /border-radius: 50%/);
    assert.match(html, /引用内容/);
    assert.match(html, /高亮正文/);
    assert.match(html, /总结正文/);
    assert.match(html, /<table/);
    assert.match(html, /data-lang="js"/);
    assert.match(html, /中文AI不应被加空格/);
    assert.ok(fs.readFileSync(result.previewPath, "utf8").includes("<!DOCTYPE html>"));
  }

  const impeccableTheme = path.join(themesDir, "impeccable.yaml");
  const randomizedOutputs = new Set();
  for (let index = 0; index < 8; index += 1) {
    const result = contentTool.renderMarkdownPackage({
      markdownPath: articlePath,
      themePath: impeccableTheme,
      outputDir: path.join(tempDir, `random-${index}`),
      coverPath
    });
    const html = fs.readFileSync(result.contentHtmlPath, "utf8");
    assert.match(html, /AI 辅助创作/);
    randomizedOutputs.add(html);
  }
  assert.ok(randomizedOutputs.size >= 2, "impeccable theme should randomize CSS");

  const defaultTheme = path.join(themesDir, "professional-clean.yaml");
  const noCover = contentTool.renderMarkdownPackage({
    markdownPath: articlePath,
    themePath: defaultTheme,
    outputDir: path.join(tempDir, "without-cover")
  });
  assert.equal(noCover.validationStatus, "invalid");
  assert.ok(noCover.errors.includes("cover is required for a complete publish package"));
  assert.throws(
    () => contentTool.renderMarkdownPackage({
      markdownPath: "relative.md",
      themePath: defaultTheme,
      outputDir
    }),
    /必须是绝对路径/
  );
  const brokenThemePath = path.join(tempDir, "broken.yaml");
  fs.writeFileSync(brokenThemePath, "name: broken\n");
  assert.throws(
    () => contentTool.renderMarkdownPackage({
      markdownPath: articlePath,
      themePath: brokenThemePath,
      outputDir
    }),
    /缺少 name、description、colors 或 base_css/
  );
  const conflictPath = path.join(tempDir, "not-a-directory");
  fs.writeFileSync(conflictPath, "file");
  assert.throws(
    () => contentTool.renderMarkdownPackage({
      markdownPath: articlePath,
      themePath: defaultTheme,
      outputDir: conflictPath
    }),
    /不是目录/
  );

  const packageResult = contentTool.renderMarkdownPackage({
    markdownPath: articlePath,
    themePath: defaultTheme,
    outputDir: path.join(tempDir, "publish"),
    coverPath
  });
  const validated = wechatOps.validateDraftPublishInput({
    title: packageResult.title,
    digest: packageResult.digest,
    contentHtmlPath: packageResult.contentHtmlPath,
    coverPath
  }, { appId: "unused", secret: "unused", author: "作者" });
  assert.equal(validated.author, "作者");
  assert.equal(validated.contentHtmlPath, packageResult.contentHtmlPath);

  const sourceHtmlPath = path.join(tempDir, "source.html");
  fs.writeFileSync(sourceHtmlPath, [
    "<html><head><title>后备标题</title></head><body>",
    '<h1 id="activity-name">公众号标题</h1>',
    '<a id="js_name">测试作者</a><em id="publish_time">2026-06-23</em>',
    '<div id="js_content" style="visibility:hidden">',
    "<h2>章节</h2><p>正文<strong>重点</strong></p>",
    '<img data-src="https://example.com/a.png" alt="图">',
    '<p style="display:none">隐藏文字</p>',
    "</div></body></html>"
  ].join(""));
  const markdownOutput = path.join(tempDir, "imported.md");
  const imported = contentTool.htmlFileToMarkdown({
    htmlPath: sourceHtmlPath,
    outputMarkdownPath: markdownOutput,
    sourceUrl: "https://mp.weixin.qq.com/s/example"
  });
  assert.equal(imported.title, "公众号标题");
  const importedText = fs.readFileSync(markdownOutput, "utf8");
  assert.match(importedText, /title: 公众号标题/);
  assert.match(importedText, /!\[图\]\(https:\/\/example\.com\/a\.png\)/);
  assert.doesNotMatch(importedText, /隐藏文字/);

  const learnedThemePath = path.join(tempDir, "learned-theme.yaml");
  const learned = contentTool.extractTheme({
    htmlPath: sourceHtmlPath,
    baseThemePath: defaultTheme,
    outputThemePath: learnedThemePath,
    name: "learned_test"
  });
  assert.equal(learned.name, "learned_test");
  assert.ok(contentTool.loadThemeFile(learnedThemePath).baseCss.length > 0);
  const learnedRender = contentTool.renderMarkdownPackage({
    markdownPath: articlePath,
    themePath: learnedThemePath,
    outputDir: path.join(tempDir, "learned-render"),
    coverPath
  });
  assert.equal(learnedRender.validationStatus, "valid");

  const qualityPath = path.join(tempDir, "quality.json");
  const quality = contentTool.analyzeArticleQualityFile({
    markdownPath: articlePath,
    outputReportPath: qualityPath
  });
  assert.ok(quality.summary.charCount > 0);
  assert.match(fs.readFileSync(qualityPath, "utf8"), /不是 AI 内容检测结论/);

  const exemplarPath = path.join(tempDir, "exemplar.json");
  const exemplar = contentTool.extractExemplarFile({
    markdownPath: articlePath,
    outputExemplarPath: exemplarPath,
    source: "测试来源"
  });
  assert.equal(exemplar.source, "测试来源");
  assert.ok(exemplar.segmentCount >= 1);
  assert.equal(JSON.parse(fs.readFileSync(exemplarPath, "utf8")).title, "测试标题");

  console.log(`WeChat content smoke test passed with ${themes.length} themes.`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete globalThis[runtimeSymbol];
}
