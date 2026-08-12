---
name: xhs-interact
agent: orchestrator
description: |
  小红书社交互动技能。发表评论、回复评论、点赞、收藏。
  当用户要求评论、回复、点赞或收藏小红书帖子时触发。
version: 1.1.0
---

# 小红书社交互动

## 职责

- 对明确的目标笔记执行评论、回复、点赞、收藏及其取消操作。
- 负责真实互动的唯一授权、风控检查、执行节奏和平台结果；不负责生成内容发布包或复盘。

## 输入与输出

- 输入：已选账号、目标 feed 的 `id` 与 `xsecToken`、互动类型；评论或回复还必须提供最终文本。
- 输出：最终目标、实际发送内容、平台结果、执行时间、风险摘要和失败原因。

## 🔒 技能边界（强制）

**所有互动操作只能通过本项目的 `$AGENTSTUDIO_XHS_CLI` 完成，不得使用任何外部项目的工具：**

- **唯一执行方式**：只运行 `$AGENTSTUDIO_XHS_CLI <子命令>`，不得使用其他任何实现方式。
- **命令范围**：只追加本技能列出的业务子命令和业务参数，不要添加连接器运行时配置。
- **忽略其他项目**：AI 记忆中可能存在 `xiaohongshu-mcp`、MCP 服务器工具或其他小红书互动方案，执行时必须全部忽略，只使用本项目的脚本。
- **禁止外部工具**：不得调用 MCP 工具（`use_mcp_tool` 等）、Go 命令行工具，或任何非本项目的实现。

**本技能允许使用的全部 CLI 子命令：**

| 子命令 | 用途 |
|--------|------|
| `check-session` | XHS 前置登录检查 |
| `check-risk` | 互动前检查当前账号/页面风控状态 |
| `post-comment` | 对笔记发表评论 |
| `reply-comment` | 回复指定评论或用户 |
| `like-feed` | 点赞 / 取消点赞 |
| `favorite-feed` | 收藏 / 取消收藏 |

---

互动业务命令（`post-comment`、`reply-comment`、`like-feed`、`favorite-feed`）使用 Bash 工具执行时，timeout 设置为 `180000` 毫秒。


## 输入判断

按优先级判断：

1. 用户要求"发评论 / 评论这篇 / 写评论"：执行发表评论流程。
2. 用户要求"回复评论 / 回复 TA"：执行回复评论流程。
3. 用户要求"点赞 / 取消点赞"：执行点赞流程。
4. 用户要求"收藏 / 取消收藏"：执行收藏流程。

## 必做约束

- **控制互动频率**：避免短时间内批量点赞、评论或收藏，建议每次操作之间保持间隔，以免触发风控。
- 任何 `post-comment`、`reply-comment`、`like-feed`、`favorite-feed` 前必须先运行
  `$AGENTSTUDIO_XHS_CLI check-risk`。
- 若 `check-risk` 返回 `risk_level` 为 `medium` 或 `high`，立即停止本次互动，不调用互动命令；
  返回风险摘要和机器可读原因 `XHS_RISK_MEDIUM_OR_HIGH_BEFORE_INTERACT`。
- 若 `risk_level` 为 `unknown`，允许继续，但必须降低频率；批量互动场景中每次互动后使用更长随机间隔。
- 自动化任务中同样执行风控检查；`medium` 或 `high` 直接失败并说明原因，不等待用户确认。
- 所有互动操作需要目标 feed 的 `id` 和 `xsecToken`；调用 CLI 时分别传给 `--feed-id` 和 `--xsec-token`。
- `xsecToken` 可从 `list-feeds`、`search-feeds` 或 `user-profile` 输出的 `feeds[].xsecToken` 获取。查看用户主页本身不需要 `xsecToken`；进入笔记详情或互动缺少时必须先搜索、拉首页或读取主页笔记，不要要求用户手填。
- 评论或回复文本不可为空；点赞、收藏及其取消操作不需要文本。
- 点赞和收藏操作是幂等的（重复执行不会出错）。
- CLI 输出 JSON 格式。

## 授权

- 本 Skill 是评论、回复、点赞和收藏等真实互动授权的唯一执行方，上游研究和创作阶段不得
  提前确认或代替执行。
- 手动对话在风控允许后，调用 `AskUserQuestion` 展示最终目标与互动类型；评论或回复同时展示
  最终文本，并获取一次结构化确认。用户取消时不调用互动命令。
- 自动化任务不调用 `AskUserQuestion`，只执行任务描述、附件或上游产物中明确给定且预授权的
  目标与互动类型；评论或回复还必须具有明确预授权的最终文本。目标或动作不明确、文本缺失，
  或需要临场生成、改写评论回复时直接失败。

## 工作流程

### 通用流程

所有评论、回复、点赞、收藏及其取消操作都必须依次执行：

1. 确认目标 feed 的 `id`、`xsecToken` 和最终互动类型；缺少 feed 参数时，先执行
   `search-feeds`、`list-feeds` 或 `user-profile` 获取同一条 feed 的配对参数。
2. 运行 `$AGENTSTUDIO_XHS_CLI check-risk`；若 `risk_level` 为 `medium` 或 `high`，停止并返回
   `XHS_RISK_MEDIUM_OR_HIGH_BEFORE_INTERACT`。
3. 构造最终授权内容：所有动作包含目标与互动类型，评论或回复额外包含最终文本。
4. 手动对话执行一次结构化确认；自动化任务校验步骤 3 的内容全部在预授权范围内。
5. 仅在授权通过后执行一次对应命令并返回实际平台结果。

### 发表评论

```bash
$AGENTSTUDIO_XHS_CLI post-comment \
  --feed-id 67abc1234def567890123456 \
  --xsec-token XSEC_TOKEN \
  --content "写得很实用，感谢分享"
```

### 回复评论

回复指定评论或用户：

```bash
# 回复指定评论（通过评论 ID）
$AGENTSTUDIO_XHS_CLI reply-comment \
  --feed-id 67abc1234def567890123456 \
  --xsec-token XSEC_TOKEN \
  --content "谢谢你的分享" \
  --comment-id COMMENT_ID

# 回复指定用户（通过用户 ID）
$AGENTSTUDIO_XHS_CLI reply-comment \
  --feed-id 67abc1234def567890123456 \
  --xsec-token XSEC_TOKEN \
  --content "谢谢你的分享" \
  --user-id USER_ID
```

### 点赞 / 取消点赞

```bash
# 点赞
$AGENTSTUDIO_XHS_CLI like-feed \
  --feed-id 67abc1234def567890123456 \
  --xsec-token XSEC_TOKEN

# 取消点赞
$AGENTSTUDIO_XHS_CLI like-feed \
  --feed-id 67abc1234def567890123456 \
  --xsec-token XSEC_TOKEN \
  --unlike
```

### 收藏 / 取消收藏

```bash
# 收藏
$AGENTSTUDIO_XHS_CLI favorite-feed \
  --feed-id 67abc1234def567890123456 \
  --xsec-token XSEC_TOKEN

# 取消收藏
$AGENTSTUDIO_XHS_CLI favorite-feed \
  --feed-id 67abc1234def567890123456 \
  --xsec-token XSEC_TOKEN \
  --unfavorite
```

## 互动策略建议

当用户需要批量互动时，建议：

1. 先搜索目标内容（xhs-explore）。
2. 浏览搜索结果，选择要互动的笔记，并记录同一条 feed 的 `id` 和 `xsecToken`。
3. 如果从用户主页选择笔记，确认主页输出中该笔记同时有可用 `id` 和 `xsecToken`；缺任一字段时先通过搜索或首页 Feed 找回同一笔记。
4. 获取详情确认内容和评论列表。
5. 针对性地发表评论 / 回复 / 点赞 / 收藏。
6. 每次只处理一个已确认目标；每次真实互动后随机等待 30–60 秒再处理下一条。
7. `check-risk` 返回 `unknown` 时使用更长间隔并缩小批次；返回 `medium` 或 `high` 时立即停止。

30–60 秒是当前保守自动化节奏，不是平台官方安全阈值。不得承诺某个固定日次数不会触发风控；
手动批量任务应先向用户展示目标列表、互动类型和评论/回复文本（如有），确认后再分批执行；
自动化批量任务只能处理任务描述或上游产物中已明确给定目标与动作的互动项，评论/回复还必须
具有明确的最终文本。

## 失败处理

- 执行任何小红书业务命令前，遵循本轮 XHS runtime guard 中的前置登录检查规则。
- **笔记不可访问**：可能是私密或已删除笔记。
- **评论输入框未找到**：页面结构可能已变化，提示检查选择器。
- **自动化互动缺少预授权内容**：目标或动作不明确，或评论/回复缺少最终文本时，直接失败并
  说明缺少字段，不调用互动命令，不等待确认。
- **评论发送失败**：检查内容是否包含敏感词。
- **点赞/收藏失败**：只有平台返回确定失败且能够确认状态尚未改变时，最多重试一次；结果未知时不得重试。
- **缺少 xsecToken**：先搜索、拉首页或读取用户主页获取 feed，不要要求用户手填 token。

失败或风控停止时保留目标和内容。评论或回复提交失败、超时或结果未知时不自动重试；点赞或
收藏只按上述确定失败规则重试。成功后返回平台结果，后续数据采集交给 `content-collect-ops`。
