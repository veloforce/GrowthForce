# 小红书创作者后台数据 CLI 设计

## 目标

在现有小红书连接器 CDP target 上增加只读 CLI，读取当前账号的创作者后台私有数据：

- 账号身份、主页资料、权限和成长信息。
- 近 7 日、近 30 日账号与笔记总览指标及每日趋势。
- 已发布、审核中、未通过笔记列表。
- 单篇笔记的私有表现指标。
- 粉丝总量、新增、流失、趋势、画像和活跃粉丝。
- 账号访问来源、内容分析和直播数据；无权限时返回明确的权限状态。

本功能只扩展 `resources/connectors/xhs/engine` 的 XHS CLI，不新增 MCP 工具。CLI 保持原子、
只读，不负责复盘、重试策略或长期数据写入；业务策略由 Skill 承担。

## 2026-06-23 实测事实

测试环境：

- 最新 Electron remote debugging port：`40945`（旧探索会话为 `52725`）。
- 主站 target 初始页面：`https://www.xiaohongshu.com/explore`。
- 创作者账号为“悠哉”，当前有 14 名粉丝、16 篇笔记，部分数据中心权限处于
  “已申请，次日可查看”状态。

### 登录态续接

1. 从主站直接进入 `https://creator.xiaohongshu.com/new/home`，首次返回 401 并跳转创作者
   登录页。
2. 进入现有发布实现使用的
   `https://creator.xiaohongshu.com/publish/publish?source=official` 后，页面成功利用现有账号态
   恢复创作者会话。
3. 再进入 `/new/home`、`/new/note-manager` 和 `/statistics/*` 页面均能读取数据。

因此创作者数据导航必须复用 `publish._navigate_to_publish_page` 的会话恢复事实，但不能依赖
发布表单就绪。应抽出通用的 `ensure_creator_session(page)`：

- 导航发布页触发创作者会话恢复。
- 观察 `/api/galaxy/user/info` 返回 200。
- 不点击发布 tab、不填写表单、不触发任何写操作。
- 会话恢复后再导航目标数据页。
- 需要短信、扫码或验证码且未自动恢复时，返回 `creator_session_expired`。

### 数据获取方式

页面自身发起的创作者 API 请求返回 200，CDP `Network.getResponseBody` 可以读取完整 JSON。
在页面上下文中对相同 GET URL 直接执行 `fetch`，实测返回 503
`failure to get a peer from the ring-balancer`。

第一版必须：

- 先启用 CDP Network domain。
- 清空同 session 的旧 Network 事件。
- 导航目标页面，按 URL 精确等待页面自身请求。
- 在响应加载完成后调用 `Network.getResponseBody`。
- 校验 HTTP 状态和 JSON 业务状态。
- 不复制 Cookie、不自行调用接口、不生成签名、不重放页面请求。

DOM 文本只能作为页面/权限状态辅助证据，不能作为主要数据源。

## 已确认页面与接口

### 创作者首页

页面：`https://creator.xiaohongshu.com/new/home`

- `/api/galaxy/user/info`
  - `userId`、`userName`、`userAvatar`、`userDesc`、`redId`、`role`。
  - `permissions`、区号、绑定手机号。
  - 实名状态、Skill Hub 实名状态、长音频能力、共创/商业合作相关状态。
- `/api/galaxy/creator/home/personal_info`
  - 昵称、头像、关注数、粉丝数、获赞与收藏、小红书号、简介。
  - 账号诊断状态、直播状态、成长等级和当前等级粉丝区间。
- `/api/galaxy/v2/creator/datacenter/account/base`
  - 同时返回 `seven`、`thirty` 两个周期。
  - 曝光数 `impl_count`、观看数 `view_count`、封面点击率 `cover_click_rate`。
  - 视频完播率、平均观看时长、主页访客。
  - 点赞、收藏、评论、弹幕、分享。
  - 新增关注、取消关注、净涨粉、主页访问转粉率。
  - 发布笔记数、图文数、视频数。
  - 各指标环比、是否展示环比、每日趋势列表、周期起止时间和平台总结。
- `/api/galaxy/creator/data/note_detail_new`
  - 近 7/30 日观看、平均观看时长、主页访客、互动和涨粉总览及趋势。
- `/api/galaxy/creator/home/latest_note_data`
  - 最近周期笔记数据；当前账号虽有历史笔记，但该接口本次返回
    `noteInfo/viewData/fansData=null`，不能用它代替笔记管理列表。
- `/api/galaxy/v2/creator/datacenter/livedata/overview`
  - POST，页面传入 `start_time`、`end_time`。
  - 有效直播场次、直播时长、平均观看人数、平均互动、新增粉丝、薯钻、收入和成交包裹数。

### 笔记管理

页面：`https://creator.xiaohongshu.com/new/note-manager`

- `/api/galaxy/v2/creator/note/user/posted?tab=<tab>&page=<page>`
  - 响应结构包含 `notes`、`tags`、`page`，平台固定每页 10 条。
  - `tab=0/1/2/3` 分别为全部、已发布、审核中、未通过。
  - `page` 是下一页游标：首屏返回 `1`，末页返回 `-1`。
  - “悠哉”共 16 篇；首屏 10 篇、第二页 6 篇；审核中和未通过均为空。
  - `notes[]` 已确认字段：标题、ID、图文/视频类型、tab 状态、权限状态、发布时间、
    定时发布时间、阅读、点赞、收藏、评论、分享、置顶、共创、封面列表和视频时长。
  - 响应还包含 `xsec_token`，属于临时访问凭据，稳定输出必须移除。

### 内容分析

页面：`https://creator.xiaohongshu.com/statistics/data-analysis`

- `/api/galaxy/creator/datacenter/note/analyze/list?type=0&page_size=10&page_num=1`
  - 返回 `note_infos`、`total` 和内层业务结果。
  - 当前返回 1 篇周期内笔记，字段包含 ID、封面、类型、审核状态、发布时间、更新时间、
    阅读、点赞、收藏、评论和分享。
  - 可按 note ID 与笔记管理数据合并；历史笔记未进入该列表时不能把私有指标补成 0。
- `/api/galaxy/v2/creator/live_rooms`
  - 支持起止时间、有效直播筛选和分页，返回 `live_data`、`total`。
- 页面可返回“暂未开通数据权限”；CLI 必须区分无权限与零数据。

### 账号概览与粉丝

页面：

- `https://creator.xiaohongshu.com/statistics/account/v2`
- `https://creator.xiaohongshu.com/statistics/fans-data`

接口：

- `/api/galaxy/creator/datacenter/permission/query`
  - 权限展示状态、权限状态、提示文案和业务结果。
- `/api/galaxy/v2/creator/datacenter/audience/source/account`
  - 账号访问来源，支持 7/30 日周期；当前数组为空，提示“观看数不足50，暂时无法分析”。
- `/api/galaxy/v2/creator/datacenter/audience/view/periods`
  - 受众观看时段，支持 7/30 日周期；当前数组为空，提示“观看数不足50，暂时无法分析”。
- `/api/galaxy/creator/data/fans/overall_new`
  - 7/30 日总粉丝、新增粉丝、流失粉丝和每日趋势。
- `/api/galaxy/creator/data/active_fans_new`
  - 7/30 日活跃粉丝；当前账号为空。

页面还展示“粉丝画像”，当前明确显示“粉丝数过少，先去涨粉吧～”，且未触发画像接口。
这属于 `threshold_not_met`，与权限不足、零数据和观看数不足必须分开编码。

## CLI 方案

### 命令

第一版提供三个原子命令：

1. `creator-account-stats`
   - 返回账号身份、主页资料、权限、7/30 日账号指标、粉丝指标、受众来源/时段和直播总览。
   - 参数：`--period 7|30|all`，默认 `all`；`--include-sensitive` 默认关闭。
2. `creator-note-stats`
   - 返回笔记管理列表和内容分析列表。
   - 参数：`--status all|published|reviewing|rejected`、`--max-pages`。
   - 默认从 `page=0` 自动遍历至平台返回 `page=-1`；`--max-pages` 用于限制耗时。
3. `creator-data-snapshot`
   - 顺序组合前两个只读命令的内部 collector，一次返回当前可用的完整快照。
   - 该命令仍不做分析、不写文件，供账号诊断和复盘 Skill 使用。

### 输出契约

所有命令输出 JSON：

```json
{
  "success": true,
  "account": {
    "userId": "...",
    "redId": "...",
    "name": "...",
    "phone": null
  },
  "permissions": {
    "creatorData": true,
    "accountOverview": {
      "available": false,
      "reason": "permission_required",
      "message": "..."
    }
  },
  "periods": {
    "7": {
      "startDate": "2026-06-15",
      "endDate": "2026-06-21",
      "metrics": {},
      "trends": {}
    }
  },
  "notes": {
    "items": [],
    "nextPage": null
  },
  "partial": false,
  "warnings": [],
  "source": {
    "kind": "creator_page_network",
    "capturedAt": "ISO-8601"
  }
}
```

字段规则：

- 默认不输出绑定手机号；只有显式 `--include-sensitive` 才输出。
- 原始平台字段使用稳定的 camelCase 对外字段，避免把 thrift/protobuf 生成的
  `set_*`、`*_iterator`、`*_size` 暴露给上层。
- 计数保留整数，比例统一保留平台原始数值并增加 `unit` 或固定字段语义，不猜测百分比倍率。
- 时间戳统一转换为本地日期字符串，同时可保留 `timestampMs`。
- 无权限、无数据、接口缺失、页面变化分别编码，不把缺失值填成 0。
- 权限待生效、粉丝门槛不足和观看量不足分别编码为 `permission_pending`、
  `threshold_not_met`、`insufficient_data`。
- `xsec_token` 等临时访问凭据无论是否开启 `--include-sensitive` 都不输出。
- 部分接口成功时返回 `success=true`、`partial=true` 和逐项 warning；身份接口或核心账号接口
  失败时整体失败。

## 模块边界

建议新增：

- `scripts/xhs/creator_session.py`
  - 创作者会话恢复和目标页导航。
- `scripts/xhs/creator_network.py`
  - Network 事件等待、响应体读取、超时和 URL 匹配。
- `scripts/xhs/creator_data.py`
  - 页面 collector、响应校验和稳定字段归一化。

`cli.py` 只负责参数解析、连接 target、调用 collector 和 JSON 输出。`publish.py` 改为调用
通用 `ensure_creator_session`，避免两套创作者登录态恢复逻辑漂移。

## Skill 登录失败降级

creator 页面数据比个人主页完整：

- 两者都有账号昵称、简介、粉丝/关注/获赞收藏汇总和笔记列表。
- 只有 creator 页面提供曝光、观看、点击率、观看时长、主页访客、涨粉/流失/净涨粉、
  7/30 日趋势、后台阅读、审核状态、权限、受众和直播数据。

因此 Skill 采用 creator 优先、个人主页有限兜底，不修改原子 CLI：

1. 实际使用三个 `creator-*` 命令的 Skill 为 `xhs-explore`；`account-diagnosis-ops`
   使用 `creator-data-snapshot`。
2. 仅在 `CREATOR_SESSION_EXPIRED` 或明确的创作中心 401/登录页恢复失败时，调用
   `user-profile --user-id <当前 AccountRef ID>`。
3. 主页结果标记 `dataSource=public_profile_fallback`，只使用公开资料和公开互动。
4. `reviewing`、`rejected` 无法从个人主页推断；曝光、观看、涨粉、审核、权限、受众和直播
   等缺失项必须明确列出，不填 0。
5. creator 的 partial、权限待生效、数据不足和平台门槛状态不触发降级；结构或业务错误也
   不降级，避免掩盖回归。
6. creator 与个人主页均失败时停止依赖数据的任务，返回两段非敏感错误摘要。

## Test Cases For Review

以下测试已由用户 Review，按“先写测试、再实现”执行。

### 单元测试

不 mock CDP、网络或时间。解析测试使用本次真实 CDP 捕获后脱敏的响应样本：

1. `account/base` 同时归一化 7/30 日指标、趋势、周期、环比和 display flag。
2. 曝光、观看、主页访客、互动、涨粉、发布数、点击率、完播率和观看时长字段不遗漏。
3. 清理 `set_*`、`*_iterator`、`*_size`，不把传输层辅助字段输出。
4. `fans/overall_new` 归一化总粉丝、新增、流失和每日趋势。
5. 非空 `notes` 保留标题、状态、发布时间和互动字段；空 `notes`、空 `note_infos`、空画像
   返回空数组，不返回失败。
6. permission query 返回未开通时标记 `available=false`，不把指标写成 0。
7. 默认移除手机号；`include_sensitive=true` 时保留。
8. 比例、计数和毫秒时间戳保持类型，不进行未经验证的倍率换算。
9. 某个非核心接口超时或结构变化时生成 partial warning；核心身份或账号总览失败时整体失败。

### 真实 CDP 集成测试

使用本地 Electron XHS connector 的真实 profile 和 target，不 mock：

1. 主站已登录、创作者页未登录时，先跳转登录页，再通过发布页续接创作者会话。
2. 续接成功后读取 `/api/galaxy/user/info` 和 `account/base` 的真实 200 响应体。
3. 直接页面 `fetch` 返回 503 时，CLI 仍通过页面真实 Network 响应成功。
4. `creator-account-stats --period all` 返回 7/30 日结构和真实周期日期。
5. `creator-note-stats` 自动读取 16 篇笔记至 `page=-1`，审核中和未通过返回成功空列表。
6. 数据中心无权限时返回 `permission_required`，与零数据可区分。
7. target 当前位于主站、创作者首页、笔记管理或发布页时均能执行。
8. 需要人工验证码且无法自动续接时，在限定时间内返回
   `creator_session_expired`，不无限等待。
9. 整个读取流程不出现 POST/PUT/DELETE 写接口，不点击发布、编辑、删除或申请权限。

### 模拟用户行为验收

1. 用户在 GrowthForce 选择已授权 XHS 账号后请求“查看近 7 天创作者数据”，Skill 调用
   `creator-account-stats --period 7` 并展示指标来源和权限缺口。
2. 用户请求“列出已发布笔记及后台数据”，CLI 遍历分页并返回笔记列表；人工核对标题、
   状态、发布时间和至少一组私有指标。
3. 用户请求“尽可能完整导出当前创作者数据”，调用 `creator-data-snapshot`，成功项完整返回，
   无权限项列入 warnings。
4. 默认输出和 Agent 回复中不出现手机号；用户明确要求敏感账号字段时才传
   `--include-sensitive`。
5. creator 登录态恢复失败时，Skill 使用当前账号 ID 读取个人主页，输出有限公开数据和
   缺失指标；partial 或权限待生效时继续使用 creator 结果，不错误降级。

### 仍需更高数据量账号补充的验收

- 粉丝画像接口、画像维度和平台最低粉丝门槛。
- 活跃粉丝非空字段。
- 账号访问来源和观看时段非空字段。
- 审核中、未通过笔记的非空字段差异。

这些场景不能从当前账号推断字段；实现只输出已确认字段，并通过状态和 warning 保留缺口。
