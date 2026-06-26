const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { installToolRuntime } = require("../../dist/agent/tool-registry.js");
installToolRuntime();
const browserTool = require("../../resources/tools/browser/dist/index.js");

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-xhs-capabilities-"));
  const outputPath = path.join(tempDir, "source.md");
  const articleText = "这是一段用于验证网页正文抓取的小红书素材。".repeat(20);
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html>
        <head><title>网页转小红书素材</title></head>
        <body>
          <header><img class="site-logo" src="/assets/logo.png" alt="site logo"></header>
          <article>
            <h1>网页转小红书素材</h1>
            <p>${articleText}</p>
            <img src="/shims/placeholder.png" data-src="/media/real-cover.webp" alt="正文封面">
            <img src="data:image/svg+xml;base64,PHN2Zy8+" alt="占位图">
            <img src="/tracking/pixel.gif" width="1" height="1" alt="">
            <img src="/media/second.jpg" alt="正文步骤图">
          </article>
        </body>
      </html>`);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local HTTP server did not expose a port");
    const result = await browserTool.webFetch(
      `http://127.0.0.1:${address.port}/article`,
      { outputPath }
    );
    if (result.ok !== true || result.method !== "http") {
      throw new Error(`Expected real HTTP web_fetch success, got ${JSON.stringify(result)}`);
    }
    const markdown = fs.readFileSync(outputPath, "utf8");
    for (const expected of [
      `http://127.0.0.1:${address.port}/media/real-cover.webp`,
      `http://127.0.0.1:${address.port}/media/second.jpg`,
      "## Images"
    ]) {
      if (!markdown.includes(expected)) throw new Error(`Expected fetched Markdown to include ${expected}`);
    }
    for (const forbidden of ["placeholder.png", "data:image", "tracking/pixel.gif", "assets/logo.png"]) {
      if (markdown.includes(forbidden)) throw new Error(`Expected fetched Markdown to filter ${forbidden}`);
    }

    const researchSkill = fs.readFileSync(
      path.join("resources", "skills", "orchestrator", "content-research-ops", "SKILL.md"),
      "utf8"
    );
    const researchReference = fs.readFileSync(
      path.join("resources", "skills", "orchestrator", "content-research-ops", "references", "xhs.md"),
      "utf8"
    );
    const createSkill = fs.readFileSync(
      path.join("resources", "skills", "orchestrator", "xhs-create", "SKILL.md"),
      "utf8"
    );
    const createUrlReference = fs.readFileSync(
      path.join("resources", "skills", "orchestrator", "xhs-create", "references", "url-to-note.md"),
      "utf8"
    );
    const createXhsReference = fs.readFileSync(
      path.join("resources", "skills", "orchestrator", "xhs-create", "references", "xhs.md"),
      "utf8"
    );
    const publishSkill = fs.readFileSync(
      path.join("resources", "skills", "orchestrator", "xhs-publish", "SKILL.md"),
      "utf8"
    );
    const interactSkill = fs.readFileSync(
      path.join("resources", "skills", "orchestrator", "xhs-interact", "SKILL.md"),
      "utf8"
    );
    const exploreSkill = fs.readFileSync(
      path.join("resources", "skills", "orchestrator", "xhs-explore", "SKILL.md"),
      "utf8"
    );
    const diagnosisSkill = fs.readFileSync(
      path.join("resources", "skills", "orchestrator", "account-diagnosis-ops", "SKILL.md"),
      "utf8"
    );
    const collectSkill = fs.readFileSync(
      path.join("resources", "skills", "orchestrator", "content-collect-ops", "SKILL.md"),
      "utf8"
    );
    const diagnosisFramework = fs.readFileSync(
      path.join(
        "resources",
        "skills",
        "orchestrator",
        "account-diagnosis-ops",
        "references",
        "framework.md"
      ),
      "utf8"
    );

    const researchContract = `${researchSkill}\n${researchReference}`;
    for (const expected of ["双排序搜索", "3–5 篇", "批量详情节奏"]) {
      if (!researchContract.includes(expected)) throw new Error(`Missing XHS research contract: ${expected}`);
    }
    for (const expected of ["最多点赞", "一周内", "标题", "封面特点", "开头 hook", "10–20 秒"]) {
      if (!researchReference.includes(expected)) throw new Error(`Missing XHS research SOP: ${expected}`);
    }
    const createContract = `${createSkill}\n${createUrlReference}\n${createXhsReference}`;
    for (const expected of [
      "调用 `web_fetch`",
      "Markdown 的 `Images`",
      "直接放入发布包交给 XHS CLI 下载",
      "19–20 单位",
      "2–3 篇",
      "sourceUrl"
    ]) {
      if (!createContract.includes(expected)) throw new Error(`Missing XHS create contract: ${expected}`);
    }
    for (const expected of [
      "UTF-16 计数规则",
      "本 Skill 只校验，不截断或改写标题",
      "不得使用 `curl`、`wget`",
      "表单尚未填写，不调用 `save-draft`"
    ]) {
      if (!publishSkill.includes(expected)) throw new Error(`Missing XHS publish contract: ${expected}`);
    }
    for (const expected of ["30–60 秒", "不是平台官方安全阈值", "目标列表和评论内容"]) {
      if (!interactSkill.includes(expected)) throw new Error(`Missing XHS interaction SOP: ${expected}`);
    }
    for (const expected of [
      "CREATOR_SESSION_EXPIRED",
      "user-profile --user-id <当前选中账号的 accountId>",
      "public_profile_fallback",
      "reviewing",
      "rejected",
      "partial=true 不触发降级"
    ]) {
      if (!exploreSkill.includes(expected)) throw new Error(`Missing creator fallback contract: ${expected}`);
    }
    for (const expected of [
      "creator-data-snapshot",
      "CREATOR_SESSION_EXPIRED",
      "user-profile --user-id <accountId>",
      "有限诊断",
      "dataSource=public_profile_fallback"
    ]) {
      if (!diagnosisSkill.includes(expected)) throw new Error(`Missing diagnosis fallback contract: ${expected}`);
    }
    for (const expected of [
      "公开主页兜底",
      "曝光、点击率、观看时长、主页访客、涨粉和受众",
      "N/A",
      "不降低为 0 分"
    ]) {
      if (!diagnosisFramework.includes(expected)) {
        throw new Error(`Missing diagnosis fallback scoring rule: ${expected}`);
      }
    }
    for (const expected of [
      "发布后 per-run 原始数据采集不要求读取 Profile",
      "creator-data-snapshot --period 7 --max-pages 10",
      "creator-note-stats",
      "按目标 `note_id` 匹配",
      "不能补成 0",
      "`metrics only`：先 creator",
      "成功匹配 `note_id` 后，不再查 `user-profile` 或个人主页",
      "`metrics + engagement/comments`",
      "补 token 不是为了补后台 metrics",
      "dataSource=public_profile_fallback",
      "不再用主页“洗掉”缺口",
      "collectionType=\"metrics\"",
      "collectionType=\"engagement\""
    ]) {
      if (!collectSkill.includes(expected)) throw new Error(`Missing XHS collect creator contract: ${expected}`);
    }
    for (const forbidden of ["创作者后台数据 CLI 仍未实现", "待创作者数据命令支持后"]) {
      if (collectSkill.includes(forbidden) || exploreSkill.includes(forbidden) || diagnosisSkill.includes(forbidden)) {
        throw new Error(`Expected XHS skills not to contain stale creator wording: ${forbidden}`);
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
