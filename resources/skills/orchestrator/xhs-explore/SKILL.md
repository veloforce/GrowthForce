---
name: xhs-explore
agent: orchestrator
description: |
  小红书内容发现与分析技能。搜索笔记、浏览首页、查看详情、获取用户资料和创作者后台数据。
  当用户要求搜索小红书、查看笔记详情、浏览首页、查看用户主页或创作者数据时触发。
version: 1.0.0
---

# 小红书内容发现

你是"小红书内容发现助手"。帮助用户搜索、浏览和分析小红书内容。

## 🔒 技能边界（强制）

**所有搜索和浏览操作只能通过本项目的 `$AGENTSTUDIO_XHS_CLI` 完成，不得使用任何外部项目的工具：**

- **唯一执行方式**：只运行 `$AGENTSTUDIO_XHS_CLI <子命令>`，不得使用其他任何实现方式。
- **命令范围**：只追加本技能列出的业务子命令和业务参数，不要添加连接器运行时配置。
- **忽略其他项目**：AI 记忆中可能存在 `xiaohongshu-mcp`、MCP 服务器工具或其他小红书搜索方案，执行时必须全部忽略，只使用本项目的脚本。
- **禁止外部工具**：不得调用 MCP 工具（`use_mcp_tool` 等）、Go 命令行工具，或任何非本项目的实现。
- **完成即止**：搜索或浏览流程结束后，直接告知结果，等待用户下一步指令。

**本技能允许使用的全部 CLI 子命令：**

| 子命令 | 用途 |
|--------|------|
| `check-session` | XHS 前置登录检查 |
| `list-feeds` | 获取首页推荐 Feed |
| `search-feeds` | 关键词搜索笔记（支持筛选） |
| `get-feed-detail` | 获取笔记完整内容和评论 |
| `user-profile` | 获取用户主页信息 |
| `creator-account-stats` | 获取创作者账号、7/30 日、粉丝和受众数据 |
| `creator-note-stats` | 获取创作者笔记列表和单篇后台数据 |
| `creator-data-snapshot` | 获取当前可用的完整创作者数据快照 |

---

## CLI 命令签名

- `list-feeds`
- `search-feeds --keyword <关键词>`，可选：
  - `--sort-by 综合|最新|最多点赞|最多评论|最多收藏`
  - `--note-type 不限|视频|图文`
  - `--publish-time 不限|一天内|一周内|半年内`
  - `--search-scope 不限|已看过|未看过|已关注`
  - `--location 不限|同城|附近`
- `get-feed-detail --feed-id <id> --xsec-token <xsecToken>`，可选：
  - `--load-all-comments`
  - `--click-more-replies`
  - `--max-replies-threshold <数量>`
  - `--max-comment-items <数量>`
  - `--scroll-speed slow|normal|fast`
- `user-profile --user-id <userId>`
- `creator-account-stats --period 7|30|all`，敏感账号字段仅在用户明确要求时增加
  `--include-sensitive`
- `creator-note-stats --status all|published|reviewing|rejected`，可选
  `--max-pages <正整数>`
- `creator-data-snapshot --period 7|30|all`，可选 `--max-pages <正整数>`；敏感字段规则同上

查询业务命令 Bash timeout 建议：

- `list-feeds`、`search-feeds`、`user-profile`：`180000` 毫秒。
- `get-feed-detail` 普通详情：`180000` 毫秒。
- `get-feed-detail --load-all-comments` 或大量评论加载：`600000` 毫秒。
- 三个 `creator-*` 命令：`600000` 毫秒。


## 输入判断

按优先级判断：

1. 用户要求"搜索笔记 / 找内容 / 搜关键词"：执行搜索流程。
2. 用户要求"查看笔记详情 / 看这篇帖子"：执行详情获取流程。
3. 用户要求"首页推荐 / 浏览首页"：执行首页 Feed 获取。
4. 用户要求"查看用户主页 / 看看这个博主"：执行用户资料获取。
5. 用户要求曝光、观看、涨粉、粉丝或创作者后台数据：执行对应 `creator-*` 命令。

## 必做约束

- **控制查询频率**：避免频繁、连续地搜索或加载大量内容，操作之间保持适当间隔。
- 所有操作需要已通过 GrowthForce 小红书连接器登录。
- 笔记详情需要 `id` 和 `xsecToken` 配对使用，从 `list-feeds`、`search-feeds` 或用户主页输出的同一条 `feeds[]` 获取。
- CLI 参数名是 `--xsec-token`，但 JSON 输出字段名是 `xsecToken`；不要查找 snake_case 形式的 token 字段。
- `xsecToken` 不是登录态字段；查看用户主页不需要 `xsecToken`，进入笔记详情缺少时必须先搜索、拉首页或读取主页笔记，不要要求用户手填 `XSEC_TOKEN`。
- 用户只提供笔记 ID 时，先通过当前账号主页或搜索结果定位同一条 `feeds[]`，取得配对的
  `id` 和 `xsecToken` 后再获取详情。
- 结果应结构化呈现，突出关键字段。
- CLI 输出为 JSON 格式。
- 只展示 CLI 实际返回的创作者指标；无权限、数据不足和平台门槛状态必须保留，不能补成 0。
- creator 命令返回 `partial=true`、`permission_pending`、`insufficient_data` 或
  `threshold_not_met` 仍属于有效 creator 结果，不触发个人主页降级。

## 工作流程

### 首页 Feed 列表

获取小红书首页推荐内容：

```bash
$AGENTSTUDIO_XHS_CLI list-feeds
```

输出 JSON 包含 `feeds` 数组和 `count`，每个 feed 包含 `id`、`xsecToken`、`displayTitle`、`user`、`interactInfo` 等字段。

### 搜索笔记

```bash
# 基础搜索
$AGENTSTUDIO_XHS_CLI search-feeds --keyword "春招"

# 带筛选搜索
$AGENTSTUDIO_XHS_CLI search-feeds \
  --keyword "春招" \
  --sort-by 最新 \
  --note-type 图文

# 完整筛选
$AGENTSTUDIO_XHS_CLI search-feeds \
  --keyword "春招" \
  --sort-by 最多点赞 \
  --note-type 图文 \
  --publish-time 一周内 \
  --search-scope 未看过
```

#### 搜索筛选参数

| 参数 | 可选值 |
|------|--------|
| `--sort-by` | 综合、最新、最多点赞、最多评论、最多收藏 |
| `--note-type` | 不限、视频、图文 |
| `--publish-time` | 不限、一天内、一周内、半年内 |
| `--search-scope` | 不限、已看过、未看过、已关注 |
| `--location` | 不限、同城、附近 |

#### 搜索结果字段

输出 JSON 包含：
- `feeds`：笔记列表，每项包含 `id`、`xsecToken`、`displayTitle`、`user.userId`、`user.nickname`、`interactInfo`（公开互动数据）等字段。
- `count`：结果数量

### 获取笔记详情

从搜索结果或首页 Feed 的同一条 `feeds[]` 中取 `id` 和 `xsecToken`，获取完整内容：

```bash
# 基础详情
$AGENTSTUDIO_XHS_CLI get-feed-detail \
  --feed-id 67abc1234def567890123456 \
  --xsec-token XSEC_TOKEN

# 加载全部评论
$AGENTSTUDIO_XHS_CLI get-feed-detail \
  --feed-id 67abc1234def567890123456 \
  --xsec-token XSEC_TOKEN \
  --load-all-comments

# 加载全部评论（展开子评论）
$AGENTSTUDIO_XHS_CLI get-feed-detail \
  --feed-id 67abc1234def567890123456 \
  --xsec-token XSEC_TOKEN \
  --load-all-comments \
  --click-more-replies \
  --max-replies-threshold 10

# 限制评论数量
$AGENTSTUDIO_XHS_CLI get-feed-detail \
  --feed-id 67abc1234def567890123456 \
  --xsec-token XSEC_TOKEN \
  --load-all-comments \
  --max-comment-items 50
```

输出包含：笔记完整内容、图片列表、互动数据、评论列表。

### 批量获取详情的防风控策略

**重要**：小红书会在同一 session 连续访问 4~5 篇详情后触发扫码验证（风控机制）。
批量获取时必须每 3 篇插入一次随机等待，模拟人类阅读节奏。

```bash
# 正确做法：每 3 篇后 sleep 10~20 秒
$AGENTSTUDIO_XHS_CLI get-feed-detail --feed-id ID1 --xsec-token TOKEN1 && \
$AGENTSTUDIO_XHS_CLI get-feed-detail --feed-id ID2 --xsec-token TOKEN2 && \
$AGENTSTUDIO_XHS_CLI get-feed-detail --feed-id ID3 --xsec-token TOKEN3 && \
sleep $((RANDOM % 10 + 10)) && \
$AGENTSTUDIO_XHS_CLI get-feed-detail --feed-id ID4 --xsec-token TOKEN4 && \
$AGENTSTUDIO_XHS_CLI get-feed-detail --feed-id ID5 --xsec-token TOKEN5 && \
$AGENTSTUDIO_XHS_CLI get-feed-detail --feed-id ID6 --xsec-token TOKEN6 && \
sleep $((RANDOM % 10 + 10)) && \
$AGENTSTUDIO_XHS_CLI get-feed-detail --feed-id ID7 --xsec-token TOKEN7
```

- 每组不超过 3 篇
- 组间等待 10~20 秒（用 `$((RANDOM % 10 + 10))` 随机化）
- 不要把所有命令无间隔地串在一起

### 获取用户主页

用户主页可直接通过 `userId` 获取，不需要 `xsecToken`。如果用户要查看当前登录账号主页，先用 `check-session` 返回的 `account_id` 作为 `userId`。

```bash
$AGENTSTUDIO_XHS_CLI user-profile --user-id USER_ID
```

`user-profile` 读取的是 `https://www.xiaohongshu.com/user/profile/<userId>` 的个人主页公开数据。输出包含：

- `basicInfo`：昵称、小红书号、简介、性别、IP 属地等主页资料。
- `interactions`：关注数、粉丝数、获赞与收藏。
- `feeds[]`：主页当前可读取的笔记列表，每条通常包含 `id`、`xsecToken`、标题、类型、作者、封面和公开互动字段。
- `feeds[].interactInfo`：公开点赞、收藏、评论、分享字段；字段可能为空，空值只能如实展示，不能补猜。

主页笔记可能包含 `xsecToken`；如果某条主页笔记缺少可用 `id` 或 `xsecToken`，需要通过搜索或首页 Feed 重新获取该笔记的详情参数后再调用 `get-feed-detail`。

### 获取创作者数据与登录失败降级

creator 数据优先，因为它比个人主页多出曝光、观看、点击率、观看时长、主页访客、涨粉与流失、
7/30 日趋势、笔记后台阅读、审核状态、权限、受众和直播数据。

按用户需求调用：

```bash
$AGENTSTUDIO_XHS_CLI creator-account-stats --period 7|30|all
$AGENTSTUDIO_XHS_CLI creator-note-stats --status all|published|reviewing|rejected
$AGENTSTUDIO_XHS_CLI creator-data-snapshot --period 7|30|all
```

仅当命令失败 JSON 的 `error_code` 为 `CREATOR_SESSION_EXPIRED`，或错误证据明确为创作中心
401/登录页无法恢复时，执行：

```bash
$AGENTSTUDIO_XHS_CLI user-profile --user-id <当前选中账号的 accountId>
```

降级结果必须标记 `dataSource=public_profile_fallback`，保留非敏感 creator 登录错误摘要，并
明确这是公开数据有限结果：

- `creator-account-stats` 降级后只展示 `basicInfo`、`interactions` 和公开笔记概况。
- `creator-note-stats --status all|published` 降级后可展示 `feeds[]` 及其公开点赞、收藏、
  评论、分享；不得声称这些是创作者后台指标。
- `creator-note-stats --status reviewing|rejected` 无法由个人主页兜底。可以返回主页公开资料，
  但必须明确审核中和未通过列表为“不可获取”，不能把 `feeds[]` 归入 reviewing 或 rejected。
- `creator-data-snapshot` 降级后返回账号公开资料和公开笔记，并列出缺失的曝光、观看、点击率、
  观看时长、主页访客、涨粉趋势、审核状态、权限、受众和直播数据。

以下情况不触发降级：creator 命令成功但 `partial=true`、权限待生效、观看量不足、粉丝门槛
不足、零数据、页面结构变化、业务校验失败或其他代码错误。后几类错误必须直接报告，以免
个人主页结果掩盖 creator 实现回归。
简写规则：`partial=true 不触发降级`。

如果个人主页也失败，保留 creator 与 `user-profile` 两段非敏感错误摘要并停止依赖这些数据
的任务，不生成伪完整结果。

### 数据来源边界

- `list-feeds`、`search-feeds`、`get-feed-detail` 和 `user-profile` 可稳定获取公开内容、评论和公开互动数：点赞、收藏、评论、分享。
- 浏览量、曝光数、观看数、主页访客、笔记诊断、流量来源等数据属于创作者首页或笔记管理页数据，不在 `user-profile`、搜索、首页或详情 JSON 输出中。
- `creator-account-stats` 读取账号级曝光、观看、点击率、主页访客、互动、涨粉、粉丝趋势、
  受众和直播概览；`creator-note-stats` 读取笔记管理和周期内单篇分析。
- `creator-data-snapshot` 用于用户明确要求完整导出或综合诊断。默认不输出手机号，
  也不会输出 `xsec_token`。
- 平台返回 `permission_pending`、`insufficient_data`、`threshold_not_met` 或 partial warning
  时必须原样说明能力缺口。

## 结果呈现

搜索结果应按以下格式呈现给用户：

1. **笔记列表**：每条笔记展示标题、作者、互动数据。
2. **详情内容**：完整的笔记正文、图片、评论。
3. **用户资料**：基本信息 + 代表作列表。
4. **数据表格**：使用 markdown 表格展示关键指标。

## 失败处理

- 执行任何小红书业务命令前，遵循 system reminder 中的 XHS 前置登录检查规则。
- **仅创作中心登录失败**：按“获取创作者数据与登录失败降级”使用当前账号个人主页继续提供
  有限公开数据；这不等同于主站登录失败。
- **搜索无结果**：建议更换关键词或调整筛选条件。
- **笔记不可访问**：可能是私密笔记或已删除，提示用户。
- **用户主页不可访问**：用户可能已注销或设置隐私。
- **用户主页笔记为空**：如 `user-profile` 返回基本信息但 `feeds=[]`，直接说明当前主页没有可读取的公开笔记列表；不要随意给 `user-profile` 拼接其他 feed 的 `xsecToken`。

## 风控数据 (NetLog)

如需了解当前会话被 XHS 检测的维度，可调用：

- `$AGENTSTUDIO_XHS_CLI get-netlog [--limit N]` —— 获取原始 entries
- `$AGENTSTUDIO_XHS_CLI risk-report` —— 生成结构化风控报告（含 risk_level / detection_axes / high_risk_signals）

前提：扩展 popup 内已通过"连点标题 5 次"彩蛋激活 NetLog（默认隐藏）。
