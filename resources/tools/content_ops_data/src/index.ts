import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { createSdkMcpServer, tool } from "../../runtime";
import { z } from "zod/v4";

type AccountRef = { platform: string; accountId: string };
type WriteMode = "create_only" | "replace" | "append";
type StageStatus = "pending" | "completed" | "skipped" | "failed";
type StageReasonPatch = Record<string, string | null>;
type RunDocument = "research" | "topics" | "draft" | "final" | "publish" | "metrics" | "engagement" | "review";
type PublishResult = "success" | "failed" | "unknown" | "reconciled";
type CollectionType = "metrics" | "engagement";

type ProfilePatch = {
  summary?: string | null;
  persona?: string | null;
  targetAudience?: string | null;
  contentDomains?: string | null;
  coreValue?: string | null;
  contentStyle?: string | null;
  topicBoundaries?: string | null;
  conversionGoal?: string | null;
  referenceAccounts?: string[] | null;
};

type ProfileFieldDetail = {
  key: keyof ProfilePatch;
  label: string;
  description: string;
  constraints: string[];
};

type RunState = {
  run_id: string;
  platform: string;
  account_id: string;
  workspace: string;
  created_at: string;
  updated_at: string;
  stages: Record<string, StageStatus>;
  stage_reasons: Record<string, string>;
};

type RecentRunSummary = {
  runId: string;
  goal: string;
  stages: Record<string, StageStatus>;
  created_at: string;
  updated_at: string;
  documents: RunDocument[];
  hasMetrics: boolean;
};

const USER_DATA_ROOT = path.join(os.homedir(), ".agentstudio", "user-data");
const PLATFORM_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const RUN_ID_PATTERN = /^\d{12}(?:-\d{2})?$/;
const STAGE_STATUSES = ["pending", "completed", "skipped", "failed"] as const;
const RUN_DOCUMENTS = ["research", "topics", "draft", "final", "publish", "metrics", "engagement", "review"] as const;
const WRITE_MODES = ["create_only", "replace", "append"] as const;
const PUBLISH_RESULTS = ["success", "failed", "unknown", "reconciled"] as const;
const COLLECTION_TYPES = ["metrics", "engagement"] as const;
const PLAYBOOK_PREFERENCES_HEADING = "用户明示偏好";
const RUN_STAGES = [
  "profile",
  "materials_research",
  "topic_pool",
  "content_generation",
  "validation",
  "publication",
  "engagement",
  "metrics",
  "review"
] as const;
const PROFILE_SECTIONS = {
  summary: "Agent 注入摘要",
  persona: "人设",
  targetAudience: "目标用户",
  contentDomains: "内容领域",
  coreValue: "核心价值",
  contentStyle: "内容风格",
  topicBoundaries: "选题边界",
  conversionGoal: "转化目标",
  referenceAccounts: "参考账号"
} as const;
const PROFILE_FIELD_DETAILS: Record<keyof ProfilePatch, Omit<ProfileFieldDetail, "key">> = {
  summary: {
    label: PROFILE_SECTIONS.summary,
    description: "供 Agent 快速注入上下文的账号定位短摘要，概括账号服务谁、提供什么价值和主要内容方向。",
    constraints: ["建议 1-3 句话", "必须来自用户明确事实，不根据单次内容表现自动推断"]
  },
  persona: {
    label: PROFILE_SECTIONS.persona,
    description: "账号对外呈现的人设、身份或可信来源，例如专业背景、经验角色或表达视角。",
    constraints: ["描述稳定身份定位", "不要把临时选题、单篇内容角色写成人设"]
  },
  targetAudience: {
    label: PROFILE_SECTIONS.targetAudience,
    description: "账号长期服务的主要人群，以及他们的阶段、需求、痛点或使用场景。",
    constraints: ["尽量具体到人群和场景", "避免只写泛化人群，例如“所有人”"]
  },
  contentDomains: {
    label: PROFILE_SECTIONS.contentDomains,
    description: "账号稳定覆盖的内容领域、主题支柱或栏目范围。",
    constraints: ["建议列出 2-5 个稳定方向", "用于选题筛选，不包含一次性热点"]
  },
  coreValue: {
    label: PROFILE_SECTIONS.coreValue,
    description: "账号持续向目标用户提供的核心价值、核心卖点或关注理由。",
    constraints: ["说明用户为什么持续关注", "优先写可复用价值，不写单篇结论"]
  },
  contentStyle: {
    label: PROFILE_SECTIONS.contentStyle,
    description: "内容表达风格、语气、结构偏好和平台呈现方式。",
    constraints: ["可包含语气、节奏、结构、视觉或标题偏好", "不得覆盖高优先级事实和平台规则"]
  },
  topicBoundaries: {
    label: PROFILE_SECTIONS.topicBoundaries,
    description: "选题边界、禁区、谨慎触碰的主题，以及不符合账号定位的内容范围。",
    constraints: ["同时可写“不做什么”和“谨慎做什么”", "用于淘汰候选选题"]
  },
  conversionGoal: {
    label: PROFILE_SECTIONS.conversionGoal,
    description: "账号内容希望长期引导的用户行动或业务目标，例如关注、咨询、私域、产品试用或品牌信任。",
    constraints: ["写长期目标，不写单次发布 KPI", "没有商业转化时也应说明期望的互动或关系目标"]
  },
  referenceAccounts: {
    label: PROFILE_SECTIONS.referenceAccounts,
    description: "用户明确指定的参考账号、竞品账号或风格参照。",
    constraints: ["可选字段，不参与 Profile 完整性判断", "只保存用户确认过的参考对象"]
  }
};
const REQUIRED_PROFILE_KEYS: Array<keyof ProfilePatch> = [
  "summary",
  "persona",
  "targetAudience",
  "contentDomains",
  "coreValue",
  "contentStyle",
  "topicBoundaries",
  "conversionGoal"
];

const accountSchema = {
  platform: z.string().min(1).describe("平台标识，例如 xhs、wechat。"),
  accountId: z.string().min(1).describe("平台账号稳定标识。")
};

function jsonResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    isError
  };
}

export function createServer() {
  return createSdkMcpServer({
    name: "content_ops_data",
    tools: [
      tool(
        "content_profile_get",
        "读取指定平台账号的结构化账号定位；缺失字段会附带字段说明和约束。不要直接读取 profile.md。",
        accountSchema,
        async (args) => invoke(() => getProfile(args)),
        readOnlyAnnotations("账号定位 人设 profile 读取")
      ),
      tool(
        "content_profile_patch",
        "字段级更新指定平台账号的账号定位；未传字段保持不变，null 清空字段。",
        {
          ...accountSchema,
          patch: z.object({
            summary: z.string().nullable().optional(),
            persona: z.string().nullable().optional(),
            targetAudience: z.string().nullable().optional(),
            contentDomains: z.string().nullable().optional(),
            coreValue: z.string().nullable().optional(),
            contentStyle: z.string().nullable().optional(),
            topicBoundaries: z.string().nullable().optional(),
            conversionGoal: z.string().nullable().optional(),
            referenceAccounts: z.array(z.string()).nullable().optional()
          })
        },
        async (args) => invoke(() => patchProfile(args, args.patch)),
        writeAnnotations("账号定位 人设 profile 设置 更新")
      ),
      tool(
        "content_playbook_read",
        "读取指定平台账号的长期运营 playbook Markdown。",
        accountSchema,
        async (args) => invoke(() => readLongTermMarkdown(args, "playbook")),
        readOnlyAnnotations("运营经验 playbook 读取")
      ),
      tool(
        "content_playbook_write",
        "整体覆盖写入指定平台账号的证据规律 playbook；会保留用户明示偏好区。只应由复盘聚合角色调用。",
        { ...accountSchema, mode: z.enum(["replace"]), markdown: z.string().min(1) },
        async (args) => invoke(() => writeLongTermMarkdown(args, "playbook", args.markdown)),
        writeAnnotations("运营经验 playbook 整写 覆盖")
      ),
      tool(
        "content_playbook_preferences_read",
        "读取指定平台账号 playbook 中的用户明示偏好区。",
        accountSchema,
        async (args) => invoke(() => readPlaybookPreferences(args)),
        readOnlyAnnotations("用户明示偏好 playbook 读取")
      ),
      tool(
        "content_playbook_preferences_replace",
        "整段替换 playbook 中的用户明示偏好区；只保存用户明确表达的长期创作偏好，不写表现判断或数据规律。",
        { ...accountSchema, markdown: z.string().optional() },
        async (args) => invoke(() => replacePlaybookPreferences(args, args.markdown ?? "")),
        writeAnnotations("用户明示偏好 playbook 替换")
      ),
      tool(
        "content_history_read",
        "读取指定平台账号的内容运营历史索引 Markdown。",
        accountSchema,
        async (args) => invoke(() => readLongTermMarkdown(args, "history")),
        readOnlyAnnotations("运营历史 history 读取")
      ),
      tool(
        "content_history_write",
        "整体覆盖写入指定平台账号的历史索引（支撑滚动窗口压缩）。只应由复盘聚合角色调用。",
        { ...accountSchema, mode: z.enum(["replace"]), markdown: z.string().min(1) },
        async (args) => invoke(() => writeLongTermMarkdown(args, "history", args.markdown)),
        writeAnnotations("运营历史 history 整写 覆盖 压缩")
      ),
      tool(
        "content_run_get",
        "读取指定内容运营 Run 的状态、元数据和已有文档类型。",
        { ...accountSchema, runId: z.string().min(1) },
        async (args) => invoke(() => getRun(args, args.runId)),
        readOnlyAnnotations("内容运营 Run 状态 读取")
      ),
      tool(
        "content_run_document_read",
        "读取内容运营 Run 中指定类型的 Markdown 文档。",
        { ...accountSchema, runId: z.string().min(1), document: z.enum(RUN_DOCUMENTS) },
        async (args) => invoke(() => readRunDocument(args, args.runId, args.document)),
        readOnlyAnnotations("内容运营 Run 文档 读取")
      ),
      tool(
        "content_run_create_with_draft",
        "创建内容运营 Run，写入不可变 draft 快照，并将 content_generation 阶段置为 completed。",
        {
          ...accountSchema,
          goal: z.string().min(1),
          workspace: z.string().min(1),
          draftMarkdown: z.string().min(1),
          materials: z.array(z.string()).optional(),
          requirements: z.array(z.string()).optional(),
          decisions: z.array(z.string()).optional()
        },
        async (args) => invoke(() => createRunWithDraft(args, args)),
        writeAnnotations("内容运营 Run 创建 初稿 快照")
      ),
      tool(
        "content_run_record_publish_result",
        "记录发布结果：写入 final/publish 证据并同步更新发布后生命周期状态。",
        {
          ...accountSchema,
          runId: z.string().min(1),
          result: z.enum(PUBLISH_RESULTS),
          finalMarkdown: z.string().optional(),
          publishMarkdown: z.string().min(1),
          engagementStatus: z.enum(STAGE_STATUSES).optional(),
          metricsStatus: z.enum(STAGE_STATUSES).optional(),
          reviewStatus: z.enum(STAGE_STATUSES).optional(),
          stageReasons: z.record(z.string(), z.string().min(1).nullable()).optional()
        },
        async (args) => invoke(() => recordPublishResult(args, args.runId, args)),
        writeAnnotations("内容运营 Run 发布 终稿 状态")
      ),
      tool(
        "content_run_record_collection_result",
        "记录采集结果：追加指标原始快照或写入互动原始采集文档，并同步更新对应阶段状态。",
        {
          ...accountSchema,
          runId: z.string().min(1),
          collectionType: z.enum(COLLECTION_TYPES),
          status: z.enum(STAGE_STATUSES),
          capturedAt: z.string().optional(),
          source: z.string().optional(),
          metrics: z.record(z.string(), z.unknown()).optional(),
          markdown: z.string().optional(),
          mode: z.enum(["replace", "append"]).optional(),
          reason: z.string().min(1).nullable().optional()
        },
        async (args) => invoke(() => recordCollectionResult(args, args.runId, args)),
        writeAnnotations("内容运营 Run 采集 指标 评论")
      ),
      tool(
        "content_run_record_review_result",
        "记录复盘结果：写入 review 文档并同步更新 review 阶段状态。",
        {
          ...accountSchema,
          runId: z.string().min(1),
          reviewMarkdown: z.string().min(1),
          mode: z.enum(["replace", "append"]).optional(),
          status: z.enum(STAGE_STATUSES).optional(),
          reason: z.string().min(1).nullable().optional()
        },
        async (args) => invoke(() => recordReviewResult(args, args.runId, args)),
        writeAnnotations("内容运营 Run 复盘 review")
      ),
      tool(
        "content_runs_recent",
        "只读列出指定平台账号最近的 Run 摘要（按 runId 倒序），用于了解最近发布与待复盘状态，无需读 history。",
        { ...accountSchema, limit: z.number().int().min(1).max(100).optional() },
        async (args) => invoke(() => recentRuns(args, args.limit ?? 10)),
        readOnlyAnnotations("最近 Run 摘要 发布状态 读取")
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
  return { searchHint, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
}

function writeAnnotations(searchHint: string) {
  return { searchHint, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } };
}

export function resolveAccountRoot(ref: AccountRef, userDataRoot = USER_DATA_ROOT): string {
  const platform = normalizePlatform(ref.platform);
  const accountId = safePathSegment(ref.accountId);
  const root = path.resolve(userDataRoot);
  assertNoSymlinkAncestors(root, path.join(root, platform, accountId));
  return path.join(root, platform, accountId);
}

export function getProfile(ref: AccountRef, userDataRoot = USER_DATA_ROOT) {
  const accountRoot = resolveAccountRoot(ref, userDataRoot);
  const file = path.join(accountRoot, "profile.md");
  if (!fs.existsSync(file)) {
    return {
      ok: true,
      account: normalizeAccountRef(ref),
      accountRoot,
      status: "missing",
      profile: {},
      missingFields: REQUIRED_PROFILE_KEYS,
      missingFieldDetails: profileFieldDetails(REQUIRED_PROFILE_KEYS)
    };
  }
  const parsed = parseMarkdown(fs.readFileSync(file, "utf8"));
  const profile = profileFromSections(parsed.sections);
  const missingFields = collectMissingProfileKeys(profile);
  return {
    ok: true,
    account: normalizeAccountRef(ref),
    accountRoot,
    status: parsed.frontmatter.status === "complete" && missingFields.length === 0 ? "complete" : "incomplete",
    profile,
    missingFields,
    missingFieldDetails: profileFieldDetails(missingFields)
  };
}

export function patchProfile(ref: AccountRef, patch: ProfilePatch, userDataRoot = USER_DATA_ROOT) {
  const accountRoot = resolveAccountRoot(ref, userDataRoot);
  ensureAccountRoot(accountRoot, userDataRoot);
  const file = path.join(accountRoot, "profile.md");
  const parsed = fs.existsSync(file) ? parseMarkdown(fs.readFileSync(file, "utf8")) : { frontmatter: {}, preamble: "", sections: [] };
  const sections = [...parsed.sections];
  for (const [key, heading] of Object.entries(PROFILE_SECTIONS) as Array<[keyof ProfilePatch, string]>) {
    if (!(key in patch)) continue;
    const value = patch[key];
    const content = key === "referenceAccounts"
      ? Array.isArray(value) ? value.map((item) => `- ${item.trim()}`).filter((item) => item !== "-").join("\n") : ""
      : normalizeNullableText(value as string | null | undefined);
    setSection(sections, heading, content);
  }
  const profile = profileFromSections(sections);
  const missingFields = collectMissingProfileKeys(profile);
  const now = new Date().toISOString();
  const account = normalizeAccountRef(ref);
  const frontmatter = {
    ...parsed.frontmatter,
    platform: account.platform,
    account_id: account.accountId,
    status: missingFields.length === 0 ? "complete" : "incomplete",
    summary: profile.summary || "",
    updated_at: now
  };
  atomicWrite(file, renderMarkdown(frontmatter, parsed.preamble, sections));
  return { ok: true, account, accountRoot, status: frontmatter.status, profile, missingFields };
}

export function readLongTermMarkdown(ref: AccountRef, kind: "playbook" | "history", userDataRoot = USER_DATA_ROOT) {
  const accountRoot = resolveAccountRoot(ref, userDataRoot);
  const file = path.join(accountRoot, `${kind}.md`);
  return {
    ok: true,
    account: normalizeAccountRef(ref),
    accountRoot,
    kind,
    exists: fs.existsSync(file),
    markdown: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
  };
}

export function writeLongTermMarkdown(ref: AccountRef, kind: "playbook" | "history", markdown: string, userDataRoot = USER_DATA_ROOT) {
  const accountRoot = resolveAccountRoot(ref, userDataRoot);
  ensureAccountRoot(accountRoot, userDataRoot);
  const file = path.join(accountRoot, `${kind}.md`);
  const content = kind === "playbook" && fs.existsSync(file)
    ? preservePlaybookPreferences(fs.readFileSync(file, "utf8"), markdown)
    : markdown;
  atomicWrite(file, ensureTrailingNewline(content.trim()));
  return { ok: true, account: normalizeAccountRef(ref), accountRoot, kind, mode: "replace" as const };
}

export function readPlaybookPreferences(ref: AccountRef, userDataRoot = USER_DATA_ROOT) {
  const accountRoot = resolveAccountRoot(ref, userDataRoot);
  const file = path.join(accountRoot, "playbook.md");
  const markdown = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const parsed = parseMarkdown(markdown);
  return {
    ok: true,
    account: normalizeAccountRef(ref),
    accountRoot,
    exists: fs.existsSync(file),
    markdown: sectionContent(parsed.sections, PLAYBOOK_PREFERENCES_HEADING)
  };
}

export function replacePlaybookPreferences(ref: AccountRef, markdown: string, userDataRoot = USER_DATA_ROOT) {
  const accountRoot = resolveAccountRoot(ref, userDataRoot);
  ensureAccountRoot(accountRoot, userDataRoot);
  const file = path.join(accountRoot, "playbook.md");
  const parsed = fs.existsSync(file) ? parseMarkdown(fs.readFileSync(file, "utf8")) : { frontmatter: {}, preamble: "", sections: [] };
  const sections = [...parsed.sections];
  setSection(sections, PLAYBOOK_PREFERENCES_HEADING, normalizePreferenceMarkdown(markdown));
  atomicWrite(file, renderMarkdown(parsed.frontmatter, parsed.preamble, sections));
  return { ok: true, account: normalizeAccountRef(ref), accountRoot, section: PLAYBOOK_PREFERENCES_HEADING };
}

export function recentRuns(ref: AccountRef, limit: number, userDataRoot = USER_DATA_ROOT) {
  const accountRoot = resolveAccountRoot(ref, userDataRoot);
  const runsRoot = path.join(accountRoot, "runs");
  const account = normalizeAccountRef(ref);
  if (!fs.existsSync(runsRoot)) return { ok: true, account, accountRoot, runs: [] as RecentRunSummary[] };
  const runIds = fs.readdirSync(runsRoot)
    .filter((id) => RUN_ID_PATTERN.test(id) && fs.existsSync(path.join(runsRoot, id, "run.md")))
    .sort()
    .reverse()
    .slice(0, limit);
  const runs: RecentRunSummary[] = runIds.map((runId) => {
    const runRoot = path.join(runsRoot, runId);
    const parsed = parseRun(fs.readFileSync(path.join(runRoot, "run.md"), "utf8"));
    return {
      runId,
      goal: parsed.goal,
      stages: parsed.state.stages,
      created_at: parsed.state.created_at,
      updated_at: parsed.state.updated_at,
      documents: existingRunDocuments(runRoot),
      hasMetrics: fs.existsSync(path.join(runRoot, "metrics.md"))
    };
  });
  return { ok: true, account, accountRoot, runs };
}

export function createRun(ref: AccountRef, goal: string, workspace: string, userDataRoot = USER_DATA_ROOT, now = new Date()) {
  const accountRoot = resolveAccountRoot(ref, userDataRoot);
  ensureAccountRoot(accountRoot, userDataRoot);
  const runsRoot = path.join(accountRoot, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });
  const runId = nextRunId(runsRoot, now);
  const runRoot = path.join(runsRoot, runId);
  fs.mkdirSync(path.join(runRoot, "assets"), { recursive: true });
  const timestamp = now.toISOString();
  const account = normalizeAccountRef(ref);
  const state: RunState = {
    run_id: runId,
    platform: account.platform,
    account_id: account.accountId,
    workspace: workspace.trim(),
    created_at: timestamp,
    updated_at: timestamp,
    stages: Object.fromEntries(RUN_STAGES.map((stage) => [stage, "pending"])),
    stage_reasons: {}
  };
  atomicWrite(path.join(runRoot, "run.md"), renderRun(state, goal.trim(), [], [], []));
  return { ok: true, account, accountRoot, runId, stages: state.stages, documents: [], hasAssets: true };
}

export function createRunWithDraft(
  ref: AccountRef,
  input: {
    goal: string;
    workspace: string;
    draftMarkdown: string;
    materials?: string[];
    requirements?: string[];
    decisions?: string[];
  },
  userDataRoot = USER_DATA_ROOT,
  now = new Date()
) {
  const created = createRun(ref, input.goal, input.workspace, userDataRoot, now);
  const runRoot = path.join(resolveAccountRoot(ref, userDataRoot), "runs", created.runId);
  try {
    writeRunDocument(ref, created.runId, "draft", "create_only", input.draftMarkdown, userDataRoot);
    updateRun(ref, created.runId, {
      materials: input.materials,
      requirements: input.requirements,
      decisions: input.decisions,
      stages: { content_generation: "completed" }
    }, userDataRoot);
    return getRun(ref, created.runId, userDataRoot);
  } catch (error) {
    fs.rmSync(runRoot, { recursive: true, force: true });
    throw error;
  }
}

export function getRun(ref: AccountRef, runId: string, userDataRoot = USER_DATA_ROOT) {
  const { accountRoot, runRoot } = resolveRun(ref, runId, userDataRoot);
  const parsed = parseRun(fs.readFileSync(path.join(runRoot, "run.md"), "utf8"));
  return {
    ok: true,
    account: normalizeAccountRef(ref),
    accountRoot,
    runId,
    state: parsed.state,
    goal: parsed.goal,
    materials: parsed.materials,
    requirements: parsed.requirements,
    decisions: parsed.decisions,
    documents: existingRunDocuments(runRoot),
    hasMetrics: fs.existsSync(path.join(runRoot, "metrics.md")),
    hasAssets: fs.existsSync(path.join(runRoot, "assets"))
  };
}

export function updateRun(
  ref: AccountRef,
  runId: string,
  update: {
    materials?: string[];
    requirements?: string[];
    decisions?: string[];
    stages?: Record<string, StageStatus>;
    stageReasons?: StageReasonPatch;
  },
  userDataRoot = USER_DATA_ROOT
) {
  const { accountRoot, runRoot } = resolveRun(ref, runId, userDataRoot);
  const file = path.join(runRoot, "run.md");
  const parsed = parseRun(fs.readFileSync(file, "utf8"));
  const stages = { ...parsed.state.stages };
  for (const [stage, status] of Object.entries(update.stages ?? {})) {
    if (!RUN_STAGES.includes(stage as typeof RUN_STAGES[number])) throw new Error(`未知生命周期阶段: ${stage}`);
    if (!STAGE_STATUSES.includes(status)) throw new Error(`无效阶段状态: ${status}`);
    stages[stage] = status;
  }
  const stageReasons = { ...parsed.state.stage_reasons };
  for (const [stage, reason] of Object.entries(update.stageReasons ?? {})) {
    if (!RUN_STAGES.includes(stage as typeof RUN_STAGES[number])) throw new Error(`未知生命周期阶段: ${stage}`);
    if (reason === null) delete stageReasons[stage];
    else stageReasons[stage] = reason.trim();
  }
  const state = {
    ...parsed.state,
    updated_at: new Date().toISOString(),
    stages,
    stage_reasons: stageReasons
  };
  const materials = appendUnique(parsed.materials, update.materials);
  const requirements = appendUnique(parsed.requirements, update.requirements);
  const decisions = appendUnique(parsed.decisions, update.decisions);
  atomicWrite(file, renderRun(state, parsed.goal, materials, requirements, decisions));
  return { ok: true, account: normalizeAccountRef(ref), accountRoot, runId, stages };
}

export function readRunDocument(ref: AccountRef, runId: string, document: RunDocument, userDataRoot = USER_DATA_ROOT) {
  const { accountRoot, runRoot } = resolveRun(ref, runId, userDataRoot);
  const file = runDocumentPath(runRoot, document);
  return {
    ok: true,
    account: normalizeAccountRef(ref),
    accountRoot,
    runId,
    document,
    exists: fs.existsSync(file),
    markdown: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
  };
}

export function writeRunDocument(ref: AccountRef, runId: string, document: RunDocument, mode: WriteMode, markdown: string, userDataRoot = USER_DATA_ROOT) {
  const { accountRoot, runRoot } = resolveRun(ref, runId, userDataRoot);
  const file = runDocumentPath(runRoot, document);
  if (mode === "create_only" && fs.existsSync(file)) throw new Error(`${document}.md 已存在，create_only 拒绝覆盖`);
  if (mode === "append") appendMarkdown(file, markdown);
  else atomicWrite(file, ensureTrailingNewline(markdown.trim()));
  return { ok: true, account: normalizeAccountRef(ref), accountRoot, runId, document, mode };
}

export function appendMetrics(
  ref: AccountRef,
  runId: string,
  snapshot: { capturedAt?: string; source: string; metrics: Record<string, unknown>; note?: string },
  userDataRoot = USER_DATA_ROOT
) {
  const { accountRoot, runRoot } = resolveRun(ref, runId, userDataRoot);
  const markdown = [
    `## ${snapshot.capturedAt?.trim() || new Date().toISOString()} - ${snapshot.source.trim()}`,
    "",
    "```yaml",
    yaml.dump(snapshot.metrics, { lineWidth: 100 }).trimEnd(),
    "```",
    ...(snapshot.note?.trim() ? ["", snapshot.note.trim()] : [])
  ].join("\n");
  appendMarkdown(path.join(runRoot, "metrics.md"), markdown);
  return { ok: true, account: normalizeAccountRef(ref), accountRoot, runId, source: snapshot.source.trim() };
}

export function recordPublishResult(
  ref: AccountRef,
  runId: string,
  input: {
    result: PublishResult;
    finalMarkdown?: string;
    publishMarkdown: string;
    engagementStatus?: StageStatus;
    metricsStatus?: StageStatus;
    reviewStatus?: StageStatus;
    stageReasons?: StageReasonPatch;
  },
  userDataRoot = USER_DATA_ROOT
) {
  if (!PUBLISH_RESULTS.includes(input.result)) throw new Error(`无效发布结果: ${input.result}`);
  if ((input.result === "success" || input.result === "reconciled") && !input.finalMarkdown?.trim()) {
    throw new Error(`${input.result} 发布结果必须提供 finalMarkdown`);
  }

  const { accountRoot } = resolveRun(ref, runId, userDataRoot);
  if (input.finalMarkdown?.trim()) writeRunDocument(ref, runId, "final", "replace", input.finalMarkdown, userDataRoot);
  writeRunDocument(ref, runId, "publish", "replace", input.publishMarkdown, userDataRoot);

  const stages = publishStages(input);
  const stageReasons = {
    ...defaultPublishStageReasons(input.result),
    ...(input.stageReasons ?? {})
  };
  updateRun(ref, runId, { stages, stageReasons }, userDataRoot);
  return { ok: true, account: normalizeAccountRef(ref), accountRoot, runId, result: input.result, stages };
}

export function recordCollectionResult(
  ref: AccountRef,
  runId: string,
  input: {
    collectionType: CollectionType;
    status: StageStatus;
    capturedAt?: string;
    source?: string;
    metrics?: Record<string, unknown>;
    markdown?: string;
    mode?: "replace" | "append";
    reason?: string | null;
  },
  userDataRoot = USER_DATA_ROOT
) {
  if (!COLLECTION_TYPES.includes(input.collectionType)) throw new Error(`无效采集类型: ${input.collectionType}`);
  if (!STAGE_STATUSES.includes(input.status)) throw new Error(`无效阶段状态: ${input.status}`);

  const { accountRoot } = resolveRun(ref, runId, userDataRoot);
  if (input.collectionType === "metrics") {
    if (input.status === "completed") {
      if (!input.source?.trim()) throw new Error("指标采集完成时必须提供 source");
      if (!input.metrics) throw new Error("指标采集完成时必须提供 metrics");
      appendMetrics(ref, runId, {
        capturedAt: input.capturedAt,
        source: input.source,
        metrics: input.metrics,
        note: input.markdown
      }, userDataRoot);
    } else if (input.markdown?.trim()) {
      appendMetricsNote(ref, runId, input.markdown, input.capturedAt, input.source, userDataRoot);
    }
    updateRun(ref, runId, { stages: { metrics: input.status }, stageReasons: { metrics: input.reason ?? null } }, userDataRoot);
    return { ok: true, account: normalizeAccountRef(ref), accountRoot, runId, collectionType: input.collectionType, status: input.status };
  }

  if (input.markdown?.trim()) {
    writeRunDocument(ref, runId, "engagement", input.mode ?? "replace", input.markdown, userDataRoot);
  }
  updateRun(ref, runId, { stages: { engagement: input.status }, stageReasons: { engagement: input.reason ?? null } }, userDataRoot);
  return { ok: true, account: normalizeAccountRef(ref), accountRoot, runId, collectionType: input.collectionType, status: input.status };
}

export function recordReviewResult(
  ref: AccountRef,
  runId: string,
  input: { reviewMarkdown: string; mode?: "replace" | "append"; status?: StageStatus; reason?: string | null },
  userDataRoot = USER_DATA_ROOT
) {
  const status = input.status ?? "completed";
  if (!STAGE_STATUSES.includes(status)) throw new Error(`无效阶段状态: ${status}`);
  const { accountRoot } = resolveRun(ref, runId, userDataRoot);
  writeRunDocument(ref, runId, "review", input.mode ?? "replace", input.reviewMarkdown, userDataRoot);
  updateRun(ref, runId, { stages: { review: status }, stageReasons: { review: input.reason ?? null } }, userDataRoot);
  return { ok: true, account: normalizeAccountRef(ref), accountRoot, runId, status };
}

function resolveRun(ref: AccountRef, runId: string, userDataRoot: string) {
  requireRunId(runId);
  const accountRoot = resolveAccountRoot(ref, userDataRoot);
  const runRoot = path.join(accountRoot, "runs", runId);
  assertNoSymlinkAncestors(path.resolve(userDataRoot), runRoot);
  if (!fs.existsSync(path.join(runRoot, "run.md"))) throw new Error(`Run 不存在: ${runId}`);
  return { accountRoot, runRoot };
}

function runDocumentPath(runRoot: string, document: RunDocument): string {
  if (!RUN_DOCUMENTS.includes(document)) throw new Error(`不支持的 Run 文档类型: ${document}`);
  return path.join(runRoot, `${document}.md`);
}

function existingRunDocuments(runRoot: string): RunDocument[] {
  return RUN_DOCUMENTS.filter((document) => fs.existsSync(path.join(runRoot, `${document}.md`)));
}

function normalizeAccountRef(ref: AccountRef): AccountRef {
  return { platform: normalizePlatform(ref.platform), accountId: ref.accountId.trim() };
}

function normalizePlatform(value: string): string {
  const trimmed = value.trim();
  if (!PLATFORM_PATTERN.test(trimmed)) throw new Error(`无效 platform: ${value}`);
  return trimmed;
}

function safePathSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("accountId 不能为空");
  if (/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(trimmed)) return trimmed;
  return encodeURIComponent(trimmed).replace(/%/g, "_");
}

function ensureAccountRoot(accountRoot: string, userDataRoot: string): void {
  assertNoSymlinkAncestors(path.resolve(userDataRoot), accountRoot);
  fs.mkdirSync(accountRoot, { recursive: true });
  assertNoSymlinkAncestors(path.resolve(userDataRoot), accountRoot);
}

function assertNoSymlinkAncestors(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("目标路径越出 user-data 沙箱");
  }
  const relative = path.relative(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("账号数据路径包含 symlink");
  }
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, ensureTrailingNewline(content), "utf8");
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    if (!fs.existsSync(file)) throw error;
    fs.rmSync(file, { force: true });
    fs.renameSync(temp, file);
  }
}

function appendMarkdown(file: string, markdown: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prefix = fs.existsSync(file) && fs.statSync(file).size > 0 ? "\n" : "";
  fs.appendFileSync(file, `${prefix}${ensureTrailingNewline(markdown.trim())}`, "utf8");
}

function appendMetricsNote(ref: AccountRef, runId: string, markdown: string, capturedAt?: string, source?: string, userDataRoot = USER_DATA_ROOT): void {
  const { runRoot } = resolveRun(ref, runId, userDataRoot);
  const heading = `## ${capturedAt?.trim() || new Date().toISOString()} - ${source?.trim() || "collection"}`;
  appendMarkdown(path.join(runRoot, "metrics.md"), `${heading}\n\n${markdown.trim()}`);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

type MarkdownSection = { heading: string; content: string };

function parseMarkdown(markdown: string): { frontmatter: Record<string, unknown>; preamble: string; sections: MarkdownSection[] } {
  const parsed = parseFrontmatter(markdown);
  const lines = parsed.body.split(/\r?\n/);
  const sections: MarkdownSection[] = [];
  const preamble: string[] = [];
  let current: MarkdownSection | null = null;
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      current = { heading: match[1].trim(), content: "" };
      sections.push(current);
      continue;
    }
    if (current) current.content += `${current.content ? "\n" : ""}${line}`;
    else preamble.push(line);
  }
  return {
    frontmatter: parsed.frontmatter,
    preamble: preamble.join("\n").trim(),
    sections: sections.map((section) => ({ ...section, content: section.content.trim() }))
  };
}

function parseFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!markdown.startsWith("---")) return { frontmatter: {}, body: markdown };
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(markdown);
  if (!match) return { frontmatter: {}, body: markdown };
  const loaded = yaml.load(match[1]) ?? {};
  return {
    frontmatter: loaded && typeof loaded === "object" && !Array.isArray(loaded) ? loaded as Record<string, unknown> : {},
    body: match[2]
  };
}

function renderMarkdown(frontmatter: Record<string, unknown>, preamble: string, sections: MarkdownSection[]): string {
  const body = [
    preamble.trim(),
    ...sections.map((section) => `## ${section.heading}\n\n${section.content.trim()}`)
  ].filter(Boolean).join("\n\n");
  return `---\n${yaml.dump(frontmatter, { lineWidth: 100 }).trimEnd()}\n---\n\n${body}\n`;
}

function setSection(sections: MarkdownSection[], heading: string, content: string): void {
  const existing = sections.find((section) => section.heading === heading);
  if (existing) {
    existing.content = content;
    return;
  }
  sections.push({ heading, content });
}

function preservePlaybookPreferences(existingMarkdown: string, incomingMarkdown: string): string {
  const existing = parseMarkdown(existingMarkdown);
  const incoming = parseMarkdown(incomingMarkdown);
  const existingPreferences = sectionContent(existing.sections, PLAYBOOK_PREFERENCES_HEADING);
  const incomingPreferences = sectionContent(incoming.sections, PLAYBOOK_PREFERENCES_HEADING);
  const preferences = existingPreferences || incomingPreferences;
  const sections = incoming.sections.filter((section) => section.heading !== PLAYBOOK_PREFERENCES_HEADING);
  if (preferences) setSection(sections, PLAYBOOK_PREFERENCES_HEADING, preferences);
  return renderMarkdown(incoming.frontmatter, incoming.preamble, sections);
}

function normalizePreferenceMarkdown(markdown: string): string {
  return markdown.trim();
}

function profileFromSections(sections: MarkdownSection[]): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, heading] of Object.entries(PROFILE_SECTIONS)) {
    const content = sections.find((section) => section.heading === heading)?.content.trim() ?? "";
    result[key] = key === "referenceAccounts"
      ? content.split(/\r?\n/).map((line) => line.replace(/^[-*]\s*/, "").trim()).filter(Boolean)
      : content;
  }
  return result;
}

function collectMissingProfileKeys(profile: Record<string, string | string[]>): Array<keyof ProfilePatch> {
  return REQUIRED_PROFILE_KEYS.filter((key) => {
    const value = profile[key];
    return typeof value !== "string" || !value.trim();
  });
}

function profileFieldDetails(keys: Array<keyof ProfilePatch>): ProfileFieldDetail[] {
  return keys.map((key) => ({ key, ...PROFILE_FIELD_DETAILS[key] }));
}

function normalizeNullableText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function nextRunId(runsRoot: string, now: Date): string {
  const base = formatRunId(now);
  if (!fs.existsSync(path.join(runsRoot, base))) return base;
  for (let index = 2; index <= 99; index += 1) {
    const candidate = `${base}-${String(index).padStart(2, "0")}`;
    if (!fs.existsSync(path.join(runsRoot, candidate))) return candidate;
  }
  throw new Error(`同一分钟 Run 数量超过限制: ${base}`);
}

function formatRunId(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function requireRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`无效 runId: ${runId}`);
}

function renderRun(state: RunState, goal: string, materials: string[], requirements: string[], decisions: string[]): string {
  const sections: MarkdownSection[] = [
    { heading: "用户目标", content: goal },
    { heading: "使用素材", content: renderList(materials) },
    { heading: "用户修改要求", content: renderList(requirements) },
    { heading: "关键决策", content: renderList(decisions) }
  ];
  return renderMarkdown(state, "# 内容运营 Run", sections);
}

function parseRun(markdown: string) {
  const parsed = parseMarkdown(markdown);
  const state = parsed.frontmatter as Partial<RunState>;
  if (!state.run_id || !state.platform || !state.account_id || !state.workspace || !state.stages) {
    throw new Error("run.md 结构无效");
  }
  return {
    state: {
      ...state,
      stage_reasons: state.stage_reasons ?? {}
    } as RunState,
    goal: sectionContent(parsed.sections, "用户目标"),
    materials: parseList(sectionContent(parsed.sections, "使用素材")),
    requirements: parseList(sectionContent(parsed.sections, "用户修改要求")),
    decisions: parseList(sectionContent(parsed.sections, "关键决策"))
  };
}

function sectionContent(sections: MarkdownSection[], heading: string): string {
  return sections.find((section) => section.heading === heading)?.content.trim() ?? "";
}

function renderList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "";
}

function parseList(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
}

function appendUnique(existing: string[], incoming?: string[]): string[] {
  return Array.from(new Set([...existing, ...(incoming ?? []).map((item) => item.trim()).filter(Boolean)]));
}

function publishStages(input: {
  result: PublishResult;
  engagementStatus?: StageStatus;
  metricsStatus?: StageStatus;
  reviewStatus?: StageStatus;
}): Record<string, StageStatus> {
  if (input.result === "success" || input.result === "reconciled") {
    return {
      publication: "completed",
      engagement: input.engagementStatus ?? (input.result === "reconciled" ? "skipped" : "pending"),
      metrics: input.metricsStatus ?? "pending",
      review: input.reviewStatus ?? "pending"
    };
  }
  if (input.result === "unknown") {
    return {
      publication: "pending",
      engagement: input.engagementStatus ?? "skipped",
      metrics: input.metricsStatus ?? "skipped",
      review: input.reviewStatus ?? "skipped"
    };
  }
  return {
    publication: "failed",
    engagement: input.engagementStatus ?? "skipped",
    metrics: input.metricsStatus ?? "skipped",
    review: input.reviewStatus ?? "skipped"
  };
}

function defaultPublishStageReasons(result: PublishResult): StageReasonPatch {
  if (result === "success") {
    return { publication: null, engagement: null, metrics: null, review: null };
  }
  if (result === "reconciled") {
    return {
      publication: null,
      engagement: "publish_result_reconciled_after_window",
      metrics: null,
      review: null
    };
  }
  if (result === "unknown") {
    return {
      publication: "publish_result_unknown",
      engagement: "publication_unknown",
      metrics: "publication_unknown",
      review: "publication_unknown"
    };
  }
  return {
    publication: "publish_failed",
    engagement: "publication_failed",
    metrics: "publication_failed",
    review: "publication_failed"
  };
}
