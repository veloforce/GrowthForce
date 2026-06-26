---
name: wechat-publish
agent: orchestrator
description: |
  公众号草稿箱发布技能，消费已排版校验的发布包并调用微信草稿发布工具。
  当用户要求推送公众号草稿箱或发布已准备好的公众号内容时触发。
version: 1.0.0
---

# 公众号草稿箱推送

本 Skill 只负责草稿箱推送，不正式发布公众号文章。

## 硬依赖

默认先使用 `wechat-markdown-to-html` 生成 `validationStatus=valid` 的发布包。用户已
直接提供非空 `title + contentHtmlPath + coverPath` 时，可以跳过排版阶段。

## 流程

1. 确认标题、摘要、正文 HTML 路径、封面和可选作者。未指定作者时由
   `wechat_draft_publish` 使用当前公众号连接器注入的默认作者。
2. 校验发布包完整；缺少排版 Skill、Python 依赖或必要字段时停止并保留现有产物。
3. 调用 `wechat_draft_publish(title, digest, contentHtmlPath, coverPath, ...)` 推送草稿箱。
   公众号草稿箱推送无需用户确认。
4. 返回 `media_id`、图片上传结果、warnings 和失败原因。

## 边界

- 不正式发布，不读取或回复留言。
- 凭据只由 Tool 从 turn-scoped 环境读取，不能要求用户在对话中提供密钥。

## 发布成功后的运营接线

草稿箱推送成功后，本 Skill 负责落地本次 Run 的状态并发起指标采集任务。只写本 Run 的
隔离文件，不碰 `history`、`playbook`，不创建复盘聚合任务。

**runId 守卫（不阻断主流程）**：本 Skill 不创建 Run，runId 由上游 `wechat-create` 传入。
若本次未拿到 runId（如用户直接推送一篇已有内容、未走完整运营闭环），则**跳过下面全部
Run 写入与采集任务创建**，只完成草稿箱推送并正常返回结果。以下步骤仅在拿到 runId 时执行：

1. 用 `content_run_record_publish_result(result="success", engagementStatus="skipped")` 一次记录
   `final.md`（**实际推送版**正文）、publish 证据（`media_id`、推送时间、图片上传结果、warnings 和最终
   内容信息）并更新阶段状态：`publication=completed`、`metrics=pending`、`review=pending`、
   `engagement=skipped`。
2. 用 `automation_task_create` 发起 **per-run 指标采集任务**：`selectedSkills: ["content-collect-ops"]`，
   描述中带上本 Run 的 runId、平台与 `media_id`；建议 `scheduleType: "interval"`、
   `intervalUnit: "day"`、配合 `maxRuns`（如 T+1、T+7），任务自终止。
3. 「最近发布、待复盘」状态由 `run.md` 承载；生成阶段通过 `content_runs_recent` 读取，
   本 Skill 不写 `history`。

- 不创建复盘聚合（singleton）任务，不写 History、Playbook 或 review。
