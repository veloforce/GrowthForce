---
name: content-collect-ops
agent: orchestrator
description: |
  平台无关的 per-run 数据采集技能。在内容发布后由定时采集任务触发，
  回收指标和评论数据，并把结果写入本次 Run 的隔离文件。当定时采集任务运行、
  或用户要求回收某条已发布内容的线上数据与评论时触发。
version: 1.0.0
---

# 内容采集（per-run 薄编排）

本 Skill 是采集阶段的**薄编排层**：自身不实现任何抓取逻辑，只负责
①路由到现有执行 Skill / 工具，②把结果写进**本次 Run 的隔离文件**。

## 定位与边界

- **不复制**底层子命令、风控、频率或失败处理；这些仍由被调用的 Skill / 工具承载。
- 只采集指标和评论数据；**不执行评论、回复、点赞、收藏或其他真实互动动作**。
- 只写本 Run 的隔离文件：通过 `content_run_record_collection_result` 追加 `metrics.md`
  原始快照或写评论/engagement 原始采集文档，并同步更新对应阶段状态。
- **不写 `history.md`、`playbook.md`**，不做复盘解释或规律沉淀——那是 `content-review-ops` 的职责。
- 不创建复盘聚合任务。
- 发布后 per-run 原始数据采集不要求读取 Profile；开始前只校验目标 Run 和内容标识。

## 输入

采集任务的描述会带上目标 Run 的 runId、平台和内容标识（小红书 feed id / xsecToken，
公众号 media_id）。

**runId 校验早退（前置）**：开始任何采集或互动前，先从任务描述解析 runId 并用
`content_run_get(runId)` 确认 Run 存在与待采集阶段。若描述里没有 runId、解析失败或
`content_run_get` 报错（Run 不存在），则记录原因后**直接早退，不写任何文件**，避免向错误
或不存在的 Run 写入数据。校验通过后再继续下面的采集与互动。

## 指标采集

- **公众号**：调用 `wechat_metrics_fetch` 拉取原始指标，按 media_id、标题和发布时间与 Run
  发布记录核对；只把确认匹配的指标用 `content_run_record_collection_result` 写入。无法可靠
  匹配时记录缺失，不编造。
- **小红书**：优先通过 `xhs-explore` 的 creator 命令读取创作者后台数据；T+7、复盘指标或
  用户要求曝光/观看/阅读/主页访客等后台指标时，先调用
  `creator-data-snapshot --period 7 --max-pages 10`，或用 `creator-note-stats` 读取笔记管理数据并
  按目标 `note_id` 匹配。匹配到目标笔记时，只把 CLI 实际返回的曝光、观看、阅读、点击率、
  主页访客、互动等字段写入 `content_run_record_collection_result(collectionType="metrics")`。
  未返回、无权限、数据不足、门槛不足或字段为空时保留缺失原因，不能补成 0。
- **小红书分层执行策略**：
  - `metrics only`：先 creator；成功匹配 `note_id` 后，不再查 `user-profile` 或个人主页。
  - `metrics + engagement/comments`：creator 采 metrics，同时用 `get-feed-detail` 采评论；
    如果没有 `xsecToken`，才用 `user-profile`、`search-feeds` 或 `list-feeds` 补同一条 feed
    的 `xsecToken`，补 token 不是为了补后台 metrics。
  - creator 失败且是登录失效：仅此时降级公开主页/详情，并明确
    `dataSource=public_profile_fallback`。
  - creator 成功但 `partial=true`、权限不足、门槛不足或字段缺失：保留 creator 结果和
    缺失原因，不补 0，不再用主页“洗掉”缺口。
- **小红书 creator 降级**：仅当 creator 命令失败 JSON 的 `error_code=CREATOR_SESSION_EXPIRED`，
  或错误明确表示创作中心 401/登录页无法恢复时，降级到 `user-profile` 或 `get-feed-detail`
  采集公开互动数（点赞、收藏、评论、分享）。creator 返回 `partial=true`、权限待生效、
  `insufficient_data`、`threshold_not_met`、页面结构变化或其他非登录错误时，不用公开主页结果
  掩盖后台采集失败；应记录对应缺失/失败原因。
- **小红书公开互动兜底**：当任务只要求公开指标，或 creator 登录失效后降级时，通过
  `xhs-explore` 的 `get-feed-detail` 等读取公开互动数（点赞、收藏、评论、分享），用
  `content_run_record_collection_result` 追加原始快照。
- 采集完成后用同一次 `content_run_record_collection_result` 将该 Run 的 `metrics` 阶段置为
  `completed`、`failed` 或 `skipped`（并写明原因）。

## 评论采集

- **小红书**：通过 `xhs-explore` 读取详情和评论列表；只保存评论原始摘要、关键问题和可回复
  候选，不发送任何评论、回复、点赞或收藏。把采集结果用
  `content_run_record_collection_result(collectionType="engagement")` 写入本 Run，并更新
  `engagement` 阶段状态。
- **公众号**：留言/互动当前未实现，将 `engagement` 阶段置为 `skipped`。
- 用户主动要求评论、回复、点赞或收藏时，不使用本 Skill；改用 `xhs-interact` 并在当前对话
  中获得用户确认后执行。

## 失败处理

- 登录态失效、内容不可访问、指标无法匹配等：记录原因到对应 Run 文档并置相应阶段为
  `failed` 或 `skipped`，不阻断其他可执行环节。
- 同一 Run 的指标与评论采集若分属不同采集任务，避免同时写 `run.md`（错开时间或写不同文档）。

### 公众号接口失败

`wechat_metrics_fetch` 可能因公众号未认证或接口权限不足、AppID/Secret/access token invalid、
IP 白名单、调用频率或额度、统计窗口无数据、数据尚未完成统计、低阅读量未达到微信统计门槛、
网络错误或微信服务异常而失败。

失败时：

1. 在该 Run 的指标阶段原因中记录 `wechat_metrics_fetch` 和非敏感错误摘要；不得记录
   AppSecret、access token 或完整凭据。
2. 将 `metrics` 标记为 `failed`；如果接口成功但没有可匹配数据，则标记为 `skipped` 并说明
   是“未返回或无法匹配”，不得描述为指标为 0。
3. 不把接口失败、空列表或无法匹配解释为内容表现差，不估算指标，不串用其他文章的数据。
4. 公众号 `engagement` 仍按当前能力标记为 `skipped`；指标失败不改变已成功的发布状态。

## 与账号诊断的职责边界

- 本 Skill 是发布后定时、单 Run 的原始数据收集，只调用 `wechat_metrics_fetch` 并写该 Run 的
  `metrics.md`；不生成账号评分或改进建议。
- `account-diagnosis-ops` 是用户触发的账号级只读分析，可以读取已发布文章并临时调用
  `wechat_metrics_fetch`，但不写 Run、History 或 Playbook。
- 本 Skill 不调用 `wechat_published_articles_fetch`。账号诊断也不得代替本 Skill 写指标快照。
- 两者复用同一原子指标接口是能力复用，不共享写入目标；即使同时运行，也只有本 Skill 会写
  指定 Run。调用失败分别在各自任务中处理，互不修改对方状态。
