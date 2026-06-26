---
name: xhs-publish
agent: orchestrator
description: |
  小红书内容发布技能，消费完整发布包并执行图文、视频或长文发布。
  当用户要求发布已准备好的小红书内容时触发。
version: 1.2.0
---

# 小红书内容发布

本 Skill 只负责发布，不负责研究、内容生成、改写或复盘。
发布确认的唯一责任方是本 Skill；`xhs-create` 不得提前询问确认。

## 工具边界

所有操作只能使用 `$AGENTSTUDIO_XHS_CLI`。允许的业务子命令按模式区分。

执行任何小红书业务命令前，遵循 system reminder 中的 XHS 前置登录检查规则。

发布模式允许：

- `check-session`
- `check-risk`
- `fill-publish`、`fill-publish-video`
- `publish`、`publish-video`
- `click-publish`、`save-draft`
- `long-article`、`select-template`、`next-step`

发布结果回补模式允许：

- `check-session`
- `user-profile`
- `get-feed-detail`

发布业务命令 Bash timeout 建议：

- `fill-publish`、`publish`：`600000` 毫秒。
- `fill-publish-video`、`publish-video`：`900000` 毫秒。
- `long-article`、`select-template`、`next-step`：`300000` 毫秒。
- `click-publish`、`save-draft`：`180000` 毫秒。
- 发布结果回补模式命令：`180000` 毫秒。

## 发布结果回补模式

当本轮是自动化任务，且任务描述明确包含 `xhs-publish-reconcile`、`accountId`、`runId`、
最终标题、发布触发时间和 attempt key 时，本 Skill 进入发布结果回补模式。

回补模式只读取 `references/publish-reconcile.md` 执行一次既有发布尝试核对；不得执行
`check-risk`、`fill-publish`、`fill-publish-video`、`publish`、`publish-video`、
`click-publish`、`save-draft`、`long-article`、`select-template` 或 `next-step`。
缺少任一回补输入时停止并报告，不猜测、不转入发布模式。

## 发布包硬依赖

- 图文：标题、正文、1-6 张图片、可选标签和发布设置。
- 视频：标题、正文、一个视频文件、可选标签和发布设置。
- 长文：完整长文、描述和可选模板。
- 本地路径必须是绝对路径；远程图片必须是 HTTP/HTTPS URL；图片与视频不能混合。
- 图文本地图片发布前必须逐张校验路径存在且为普通文件；任一无效即停止，不调用发布 CLI。
- 标题必须按小红书 UTF-16 计数规则不超过 20 单位；超出时停止发布，不调用发布 CLI，
  交给 `xhs-create` 保持语义重写。本 Skill 只校验，不截断或改写标题。
- 正文必须不超过 800 字；超出时停止发布，不调用发布 CLI，交给 `xhs-create` 压缩或让用户确认改短。
- CLI 参数和正文末尾 hashtag 合并、去重后的最终标签不得超过 6 个。
- `publish`、`fill-publish`、`publish-video`、`fill-publish-video` 会在下载远程素材和连接
  CDP 前执行同一套本地预检；预检失败时不得绕过或重试浏览器发布。
- runId：本次发布的runId。

发布包不完整时停止并交给 `xhs-create` 补齐，不在本 Skill 内生成或改写内容，也不调用图片生成工具。
远程图片 URL 原样传给 `fill-publish`/`publish`，由 CLI 下载；不得使用 `curl`、`wget` 手工下载。
远程图片下载失败时保留发布包并报告失败 URL，不静默删除、替换图片或改用模板。

## 流程

1. 发布确认前先运行 `$AGENTSTUDIO_XHS_CLI check-risk`，读取 `report.risk_level` 和风险摘要。
2. 若 `risk_level == high` 且本轮是手动对话，调用 `AskUserQuestion` 展示高风险原因；
   默认/推荐选项是“停止发布”，另一个选项是“仍要继续发布”。用户选择停止时，不调用
   `fill-publish`、`click-publish` 或 `save-draft`，返回保留的发布包。
3. 若 `risk_level == high` 且本轮 system-reminder 明确说明是自动化任务，直接停止发布，
   返回机器可读原因 `XHS_RISK_HIGH_BEFORE_PUBLISH`；不得调用 `fill-publish`、`click-publish`
   或 `save-draft`，也不得等待用户确认。
4. 若 `risk_level == medium`，手动对话继续进入发布确认，但确认文案必须附带风险摘要；
   自动化任务默认继续，但不做额外重试。
5. 若风控诊断不可用但主流程继续，记录机器可读原因 `XHS_RISK_OBSERVATION_UNAVAILABLE`。
6. 展示最终标题、正文、标签、图片或视频、定时和可见性设置，并调用 `AskUserQuestion`
   获取结构化确认；不得只用普通文字回复“请确认”，否则本轮会停止导致流程中断。
7. 用户确认后使用 `fill-publish` 或 `fill-publish-video` 填写表单。
8. 填写成功后直接调用 `click-publish`；不要再次等待浏览器预览确认。
9. 用户在首次确认时取消：表单尚未填写，不调用 `save-draft` 或其他发布 CLI，返回已保留的发布包。
10. `fill-publish` 成功后、`click-publish` 前后发生确定的技术失败：报告失败并保留发布包；
   如果页面已有完整内容且尚未进入“发布结果未知”状态，最多尝试一次 `save-draft` 并报告保存结果。
11. 返回发布记录：标题、正文摘要、标签、素材、发布时间、发布方式和平台结果。

若本轮 system-reminder 明确说明当前是自动化任务运行且无需用户确认，则跳过上述
发布包 `AskUserQuestion` 确认步骤，按任务描述和已绑定账号继续执行；但风控检查为 `high`
时必须按 `XHS_RISK_HIGH_BEFORE_PUBLISH` 停止。自动化上下文中不得因为等待用户确认而停止。

图文示例：

```bash
$AGENTSTUDIO_XHS_CLI fill-publish \
  --title-file /absolute/title.txt \
  --content-file /absolute/content.txt \
  --images /absolute/image.png \
  --tags 标签1 标签2
```

远程图片示例：

```bash
$AGENTSTUDIO_XHS_CLI fill-publish \
  --title-file /absolute/title.txt \
  --content-file /absolute/content.txt \
  --images "https://example.com/article-image.webp"
```

视频示例：

```bash
$AGENTSTUDIO_XHS_CLI fill-publish-video \
  --title-file /absolute/title.txt \
  --content-file /absolute/content.txt \
  --video /absolute/video.mp4
```

## 失败处理

- 发布页填写失败：报告平台错误并保留发布包。
- 首次发布确认前取消：不调用 CLI，保留发布包。
- 表单已经填写后因后续技术失败或用户要求停止：仅在页面内容完整且发布结果并非未知时，
  最多调用一次 `save-draft`。
- 发布前 `check-risk` 返回 `high`：手动对话必须通过 `AskUserQuestion` 反问且默认停止；
  自动化任务直接停止并返回 `XHS_RISK_HIGH_BEFORE_PUBLISH`。
- CLI 返回 `ACCOUNT_RESTRICTED`：这是不可重试的确定失败。立即停止发布，不得再次调用
  `publish`、`click-publish`；页面仍保留完整表单时最多尝试一次 `save-draft`。
- CLI 返回 `PUBLISH_RESULT_UNKNOWN` 且 `reason=timeout`：发布动作已经触发，但结果未知。
  不得重试发布，也不要调用 `save-draft`，避免形成重复笔记或重复草稿。
- CLI 返回 `PUBLISH_RESULT_UNKNOWN` 且
  `reason=published_redirect_without_response`：页面已进入发布完成跳转，优先视为可回补状态。
  不得重试发布或保存草稿。拿到 runId 时，先用 `automation_task_list` 按 attempt key 检查已有
  任务，再创建三个 `scheduleType="once"` 的发布结果回补任务，分别安排在触发后
  30 秒、2 分钟、5 分钟；任务名必须包含 `xhs-publish-reconcile:<accountId>:<runId>:<attemptKey>`，
  `selectedSkills` 必须是 `["xhs-publish"]`，任务描述必须包含 `xhs-publish-reconcile`、
  `accountId`、`runId`、最终标题、发布触发时间和 attempt key；已存在同名时间点任务时不得重复创建。
- CLI 返回其他 `PUBLISH_FAILED`：按确定失败处理，不自动重试点击发布；页面仍可保存时最多
  尝试一次 `save-draft`。
- 结果未知分支不得直接创建采集任务；仅
  `published_redirect_without_response` 可以创建发布结果回补任务。回补成功后才创建采集任务。
- 确定失败和普通 `timeout` 分支不得创建采集任务，也不得创建发布结果回补任务。

拿到 runId 时，失败分支必须更新 Run：

- `ACCOUNT_RESTRICTED` 或其他确定失败：`publication=failed`。
- `PUBLISH_RESULT_UNKNOWN`：`publication` 保持 `pending`。
- 两类分支都将 `engagement`、`metrics`、`review` 置为 `skipped`。
- 用 `content_run_record_publish_result` 记录错误码、错误消息、平台业务码/消息、触发时间、
  草稿保存结果和阶段原因。`publication` 对账号限制写 `ACCOUNT_RESTRICTED`，普通失败写实际
  `error_code`，结果未知写 `timeout`；被跳过的发布后阶段分别写 `publication_failed` 或
  `publication_unknown`。跳转无响应时 publication 原因写 `published_redirect_without_response`。
- 写 Run 失败不能触发采集任务。

## 发布成功后的运营接线

发布成功后，本 Skill 负责落地本次 Run 的状态并发起采集任务。只写本 Run 的隔离文件，
不碰 `history`、`playbook`，不创建复盘聚合任务。

**runId 守卫（不阻断主流程）**：本 Skill 不创建 Run，runId 由上游 `xhs-create` 传入。
若本次未拿到 runId（如用户直接发布一篇已有内容、未走完整运营闭环），则**跳过下面全部
Run 写入与采集任务创建**，只完成发布本身并正常返回发布记录。以下步骤仅在拿到 runId 时执行：

发布成功只接受 CLI 同时返回 `success=true`、`note_id`、`note_url` 和 `published_at`。
缺少任一字段都按 `PUBLISH_FAILED` 处理，不能标记完成。

1. 用 `content_run_record_publish_result(result="success")` 一次记录 `final.md`（**实际发布版**正文）、
   publish 证据（最终标题、正文摘要、标签、素材、发布方式、`note_id`、`note_url`、
   `published_at`、平台业务码和消息）并更新阶段状态：`publication=completed`、
   `engagement=pending`、`metrics=pending`、`review=pending`。
2. 状态更新成功后，用 `automation_task_create` 发起 **per-run 采集任务**：
   - `selectedSkills: ["content-collect-ops"]`，描述中带上本 Run 的 runId、平台与 feed 标识。
   - 指标采集建议 `scheduleType: "interval"`、`intervalUnit: "day"`、配合 `maxRuns`（如 T+1、T+7
     两次），任务自终止。
   - 互动采集若另起任务，错开时间，避免与指标任务同时写同一 `run.md`。
3. 「最近发布、待复盘」状态由 `run.md` 承载；生成阶段通过 `content_runs_recent` 读取，
   本 Skill 不写 `history`。

- 不创建复盘聚合（singleton）任务，不写 History、Playbook、metrics 或 review。

## 最终阶段总结

流程结束前，拿到 runId 时调用 `content_run_get` 读取最终状态，并逐项输出
`profile`、`materials_research`、`topic_pool`、`content_generation`、`validation`、
`publication`、`engagement`、`metrics`、`review` 的 `completed`、`failed`、`pending` 或
`skipped`；非正常状态同时输出 `stageReasons` 中的原因。没有 runId 时至少输出发布、
Run 写入和采集任务三个阶段的状态与原因，不能只回复最后一条异常。
