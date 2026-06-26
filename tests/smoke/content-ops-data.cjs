const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

global[Symbol.for("agentstudio.tool-runtime")] = {
  createSdkMcpServer: (server) => server,
  tool: (name, description, schema, handler, annotations) => ({ name, description, schema, handler, annotations })
};

const contentOps = require("../../resources/tools/content_ops_data/dist/index.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "content-ops-data-"));
const account = { platform: "xhs", accountId: "acct_001" };

try {
  const profileAccount = { platform: "xhs", accountId: "acct_profile" };
  let profile = contentOps.getProfile(profileAccount, root);
  assert.equal(profile.status, "missing");
  assert.deepEqual(profile.missingFields, [
    "summary",
    "persona",
    "targetAudience",
    "contentDomains",
    "coreValue",
    "contentStyle",
    "topicBoundaries",
    "conversionGoal"
  ]);
  assert.equal(profile.missingFieldDetails.length, profile.missingFields.length);
  assert.equal(profile.missingFieldDetails[0].key, "summary");
  assert.equal(profile.missingFieldDetails[0].label, "Agent 注入摘要");
  assert.match(profile.missingFieldDetails[0].description, /账号定位短摘要/);
  assert.ok(profile.missingFieldDetails[0].constraints.length > 0);

  contentOps.patchProfile(profileAccount, { summary: "AI 实战账号", persona: "后端工程师" }, root);
  profile = contentOps.getProfile(profileAccount, root);
  assert.equal(profile.status, "incomplete");
  assert.deepEqual(profile.missingFields, [
    "targetAudience",
    "contentDomains",
    "coreValue",
    "contentStyle",
    "topicBoundaries",
    "conversionGoal"
  ]);
  assert.deepEqual(profile.missingFieldDetails.map((field) => field.key), profile.missingFields);
  assert.equal(profile.missingFieldDetails.some((field) => field.key === "summary"), false);
  assert.equal(profile.missingFieldDetails.some((field) => field.key === "referenceAccounts"), false);
  assert.match(
    profile.missingFieldDetails.find((field) => field.key === "targetAudience").description,
    /主要人群/
  );

  contentOps.patchProfile(profileAccount, {
    targetAudience: "AI 应用开发者",
    contentDomains: "AI Agent、后端工程化",
    coreValue: "提供可执行方案",
    contentStyle: "直接、克制、结构化",
    topicBoundaries: "不追娱乐热点",
    conversionGoal: "沉淀专业用户",
    referenceAccounts: ["参考 A"]
  }, root);
  profile = contentOps.getProfile(profileAccount, root);
  assert.equal(profile.status, "complete");
  assert.deepEqual(profile.missingFields, []);
  assert.deepEqual(profile.missingFieldDetails, []);
  assert.deepEqual(profile.profile.referenceAccounts, ["参考 A"]);

  const created = contentOps.createRunWithDraft(
    account,
    {
      goal: "写一篇小红书笔记",
      workspace: "/workspace/demo",
      draftMarkdown: "# 初稿\n\n正文",
      materials: ["素材 A"],
      requirements: ["短段落"],
      decisions: ["图文"]
    },
    root,
    new Date("2026-06-25T10:30:00Z")
  );

  assert.equal(created.ok, true);
  assert.equal(created.state.stages.content_generation, "completed");
  assert.deepEqual(created.documents, ["draft"]);

  const draft = contentOps.readRunDocument(account, created.runId, "draft", root);
  assert.match(draft.markdown, /# 初稿/);

  const accountRoot = contentOps.resolveAccountRoot(account, root);
  fs.writeFileSync(
    path.join(accountRoot, "playbook.md"),
    [
      "# 运营 Playbook",
      "",
      "## 用户明示偏好",
      "",
      "- 保持口语化",
      "",
      "## 生效规律 (validated)",
      "",
      "### R-001 数字标题 [samples:3]"
    ].join("\n"),
    "utf8"
  );

  contentOps.replacePlaybookPreferences(account, "- 多用清单结构", root);
  let playbook = contentOps.readLongTermMarkdown(account, "playbook", root).markdown;
  assert.match(playbook, /## 用户明示偏好\n\n- 多用清单结构/);
  assert.match(playbook, /## 生效规律 \(validated\)/);

  contentOps.writeLongTermMarkdown(
    account,
    "playbook",
    [
      "# 运营 Playbook",
      "",
      "## 生效规律 (validated)",
      "",
      "### R-002 开头给结论 [samples:4]"
    ].join("\n"),
    root
  );
  playbook = contentOps.readLongTermMarkdown(account, "playbook", root).markdown;
  assert.match(playbook, /## 用户明示偏好\n\n- 多用清单结构/);
  assert.match(playbook, /### R-002 开头给结论/);

  contentOps.recordPublishResult(
    account,
    created.runId,
    {
      result: "success",
      finalMarkdown: "# 终稿\n\n正文",
      publishMarkdown: "note_id: note-1\nnote_url: https://example.com/note-1\npublished_at: 2026-06-25T10:40:00Z"
    },
    root
  );
  let run = contentOps.getRun(account, created.runId, root);
  assert.equal(run.state.stages.publication, "completed");
  assert.equal(run.state.stages.metrics, "pending");
  assert.deepEqual(run.documents.sort(), ["draft", "final", "publish"].sort());

  contentOps.recordCollectionResult(
    account,
    created.runId,
    {
      collectionType: "metrics",
      status: "completed",
      source: "xhs",
      metrics: { likes: 10 },
      markdown: "第一次采集"
    },
    root
  );
  contentOps.recordCollectionResult(
    account,
    created.runId,
    {
      collectionType: "metrics",
      status: "completed",
      source: "xhs",
      metrics: { likes: 12 },
      markdown: "第二次采集"
    },
    root
  );
  const metrics = fs.readFileSync(path.join(accountRoot, "runs", created.runId, "metrics.md"), "utf8");
  assert.match(metrics, /likes: 10/);
  assert.match(metrics, /likes: 12/);
  const metricsDocument = contentOps.readRunDocument(account, created.runId, "metrics", root);
  assert.match(metricsDocument.markdown, /第二次采集/);

  contentOps.recordReviewResult(account, created.runId, { reviewMarkdown: "# 复盘\n\n表现稳定" }, root);
  contentOps.recordReviewResult(account, created.runId, { reviewMarkdown: "## 增量复盘\n\n新增指标稳定", mode: "append" }, root);
  const review = contentOps.readRunDocument(account, created.runId, "review", root);
  assert.match(review.markdown, /# 复盘/);
  assert.match(review.markdown, /## 增量复盘/);
  run = contentOps.getRun(account, created.runId, root);
  assert.equal(run.state.stages.review, "completed");

  console.log("content_ops_data smoke passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
