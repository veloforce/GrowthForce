# 小红书发布结果回补

本 reference 只用于 `xhs-publish` 的发布结果回补模式。

只核对一次既有发布尝试，不生成内容、不填写表单、不调用任何发布命令、不重复点击发布。

## 输入要求

任务描述必须包含 `accountId`、`runId`、最终标题、发布触发时间和 attempt key。缺少任一项时
停止并报告，不猜测。

## 核对流程

1. 执行回补核对前，遵循 system reminder 中的 XHS 前置登录检查规则；登录检查未通过时停止后续核对。
2. 运行 `$AGENTSTUDIO_XHS_CLI user-profile --user-id <accountId>`，只读取本人主页最近笔记。
3. 对标题做 Unicode NFKC、去首尾空白和连续空白归一化，只接受标题完全一致的候选。
4. 对候选调用 `get-feed-detail`，使用其 `xsecToken`，确认作者 accountId 一致且发布时间不早于
   触发时间前 2 分钟、不晚于当前回补时间。
5. 唯一候选才判定成功；零候选保持 pending；多个候选写入 `reconcile_ambiguous`，不得任选。

## 成功回填

- 用 `content_run_record_publish_result(result="reconciled", engagementStatus="skipped")` 一次写
  `final` 和 `publish` 证据，记录 note ID、URL、平台发布时间、attempt key 与
  `reconciled=true`，并更新 `publication=completed`、`engagement=skipped`、
  `metrics=pending`、`review=pending`。engagement 保持 skipped，因为异步回补不补做发布后的
  即时互动；engagement 原因写 `publish_result_reconciled_after_window`。
- 创建正常的 per-run `content-collect-ops` 采集任务。
- 用 `automation_task_list` 找到任务名中相同 attempt key 的其它回补任务并删除，避免重复执行。

## 未匹配

- 保持 `publication=pending`，在 publish 文档追加本次检查时间和 `reconcile_no_match`。
- 不发布、不保存草稿、不创建采集任务。
- 当前任务是一次性任务，不自行创建下一次任务。
