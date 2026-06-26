# 小红书账号运营闭环设计

## 目标

建立一套围绕小红书账号的内容运营闭环，让 GrowthForce 可以辅助用户完成：

- 热点抓取与趋势观察。
- 竞品账号和竞品笔记调研。
- 选题生成与优先级排序。
- 小红书笔记草稿生成。
- 用户确认后的图文、视频或长文发布。
- 发布后基于公开数据的效果复盘。
- 账号阶段性总结，并为下一次发布提供策略建议。

第一阶段只使用当前项目已有能力，不新增依赖、不新增工具、不新增 CLI 命令、不修改开源仓库。

## 当前已实现能力

当前小红书能力由 GrowthForce 小红书连接器、内置 XHS CLI 和阶段 Skill 组成：

- `xhs-explore`：搜索笔记、首页 Feed、笔记详情、用户主页。
- `xhs-create`：生成并校验完整发布包。
- `xhs-publish`：图文、视频、长文发布，是发布确认的唯一责任方；确认后填表并直接发布。
- `xhs-interact`：评论、回复、点赞、收藏。

当前 CLI 已支持：

- 登录态确认：`check-session`。
- 账号信息：`account-info`。
- 内容发现：`list-feeds`、`search-feeds`。
- 内容详情：`get-feed-detail`。
- 用户主页：`user-profile`。
- 互动动作：`post-comment`、`reply-comment`、`like-feed`、`favorite-feed`。
- 发布动作：`fill-publish`、`fill-publish-video`、`publish`、`publish-video`、`click-publish`、`save-draft`、`long-article`、`select-template`、`next-step`。

当前可以用于运营分析的数据包括：

- 笔记标题、正文、标签、图片、发布时间、作者信息。
- 公开互动数：点赞、收藏、评论、分享。
- 评论内容和评论点赞数。
- `user-profile --user-id <userId>` 从 `https://www.xiaohongshu.com/user/profile/<userId>` 读取的主页公开信息：昵称、小红书号、简介、关注数、粉丝数、获赞与收藏、主页当前可读取笔记列表和主页笔记公开互动字段。

## 当前能力边界

当前 `$AGENTSTUDIO_XHS_CLI` 已提供三个只读创作者数据命令：

- `creator-account-stats`：账号身份、7/30 日账号指标、粉丝、受众和直播概览。
- `creator-note-stats`：自动分页读取笔记管理列表，并合并周期内单篇分析数据。
- `creator-data-snapshot`：组合前两类数据，供诊断和复盘使用。

命令通过创作者页面自身 Network 响应读取数据，不主动重放接口。无权限、权限待生效、观看量
不足、粉丝门槛不足和零数据必须分别呈现；未返回的字段不能补成 0。粉丝画像、活跃粉丝和
受众来源的非空结构仍需更高数据量账号补验。

creator 数据覆盖明显多于个人主页。若创作中心返回 `CREATOR_SESSION_EXPIRED` 或明确的
401/登录页恢复失败，Skill 使用当前账号 ID 调用 `user-profile`，继续提供公开资料、公开笔记
和公开互动的有限结果，并标记 `dataSource=public_profile_fallback`。其他 creator 错误不使用
主页掩盖；partial、权限和数据门槛状态仍保留 creator 结果。

当前 `xsecToken` 只能从 `list-feeds`、`search-feeds` 或 `user-profile` 输出的 `feeds[].xsecToken` 获取。它不是登录态字段，也不能从 `account-info` 得到。用户主页可以直接通过 `userId` 访问；调用详情或互动命令前，必须先拿到对应 feed 的 `id` 和 `xsecToken`：

- `get-feed-detail` 使用同一条 feed 的 `id` 和 `xsecToken`。
- `user-profile` 使用用户 `userId`，不需要 `xsecToken`。
- 评论、点赞、收藏使用目标 feed 的 `id` 和 `xsecToken`。

如果详情或互动缺少 `xsecToken`，Agent 必须先执行 `search-feeds`、`list-feeds` 或 `user-profile` 获取，不得要求用户手填占位符。

## 第一阶段：只改现有 Skill

第一阶段目标是用现有能力跑通公开数据运营闭环，不新增任何工具：

1. 热点抓取
   - 使用 `search-feeds --sort-by 最新 --publish-time 一周内` 观察近期内容。
   - 使用 `search-feeds --sort-by 最多点赞` 找高互动内容。
   - 同一关键词同时执行近期和高互动两组搜索；结果只代表当前可访问搜索样本，不表述为
     平台全量热度。
   - 输出热点关键词、爆款标题模式、常见标签、内容结构和风险点。

2. 竞品账号调研
   - 先通过关键词搜索找到竞品账号相关 feed。
   - 从 feed 中取 `user.userId` 调用 `user-profile`。
   - 默认选取 3–5 篇覆盖高互动、近期和差异化表达的代表笔记，再用 `get-feed-detail` 拉详情。
   - 输出竞品内容定位、选题方向、标题、封面、开头 hook、正文结构、标签和互动表现对比。
   - 详情每组最多读取 3 篇，组间随机等待 10–20 秒；这是保守自动化节奏，不是平台官方规则。

3. 选题生成
   - 结合热点搜索、竞品分析和用户账号定位生成选题池。
   - 每个选题包含目标用户、核心卖点、标题方向、正文大纲、标签建议和预期互动点。
   - 按时效性、差异化、执行成本、账号匹配度排序。

4. 内容笔记生成
   - 先生成草稿，不直接发布。
   - 研究后创作默认先分析 2–3 篇匹配主题和账号定位的公开参考笔记；不得复制其内容或素材。
   - 图文和视频标题按 UTF-16 计数不超过 20 单位，正文不超过 800 字，最终标签不超过 6 个。
     超长标题由生成阶段保持语义重写到 19–20 单位，不机械截断。
   - 图文图片为 1-6 张；本地图片必须全部存在且为普通文件。
   - 正文保持口语化、段落清晰、标签自然。
   - `xhs-create` 只生成并校验发布包；目标包含发布时立即交给 `xhs-publish`，不得自行询问确认或停止当前流程。
   - 用户只提供网页 URL 时，使用通用 `web_fetch` 抓取正文和图片；从 Markdown `Images`
     选择最多 6 张正文相关图片。远程图片 URL 原样交给 XHS CLI 下载，不手工下载。
   - 抓取失败、验证页或缺少正文时停止 URL 改写；无有效内容图时才进入现有图片生成或模板兜底。

5. 发布
   - `publish`、`fill-publish`、`publish-video`、`fill-publish-video` 在下载远程素材或连接
     CDP 前执行同一套本地预检；超限或本地文件无效时直接返回结构化失败。
   - 标签上限按 CLI 参数与正文末尾 hashtag 合并、去重后的最终数量计算。
   - 预检不自动截断正文、删除图片或丢弃标签。
   - `xhs-publish` 先用 `AskUserQuestion` 展示最终发布包并执行唯一一次结构化确认。
   - 用户确认后使用 `fill-publish` 或 `fill-publish-video` 填表，成功后直接调用 `click-publish`，不得再次确认。
   - 首次确认前取消时表单尚未填写，不调用 `save-draft`；填表后发生确定技术失败或用户要求
     停止时，仅在页面内容完整且发布结果并非未知时最多保存一次草稿。
   - 远程图片下载失败时保留发布包并报告失败 URL，不静默删除、替换或改用模板。
   - 发布后记录标题、正文摘要、标签、素材、发布时间和本次目标，供复盘使用。

6. 公开数据复盘
   - 使用公开互动数做复盘：点赞、收藏、评论、分享。
   - 可拉取评论内容分析用户反馈。
   - 复盘结论只描述现有 CLI 实际返回的数据；优先使用 `creator-data-snapshot`，并保留
     权限、数据量门槛和 partial warning。
   - creator 登录失败时降级到 `user-profile`；此时仅复盘公开互动，曝光、观看、涨粉、
     审核状态和受众数据标记为不可获取。

7. 账号总结
   - 总结本轮选题、发布内容、公开互动表现、评论反馈和改进建议。
   - 输出下一轮选题建议、标题策略、标签策略、发布时间建议和素材方向。

阶段职责：

- `xhs-explore`：明确 `xsecToken` 来源和公开数据字段边界。
- `content-lifecycle-ops`：组织热点、竞品、选题、草稿、发布和复盘。
- `content-research-ops`、`content-strategy-ops`、`content-review-ops`：提供平台无关阶段能力。
- `xhs-publish`：独占发布确认，负责确认后的填表、发布、取消处理和发布记录。
- `xhs-interact`：明确互动前必须从 feed 获取 `id` 和 `xsecToken`，评论必须用户确认。

## 第二阶段：平台无关账号运营总控 Skill

平台无关的 `content-lifecycle-ops` 面向账号长期增长。它基于多次内容发布、发布记录
和复盘记录，总结账号有效内容模式，并调整下一轮选题、标题、标签和发布建议。

长期数据使用平台无关的 `content_ops_data` 工具维护。创作者后台数据 CLI 已提供
`creator-account-stats`、`creator-note-stats` 和 `creator-data-snapshot`；长期规律只能基于这些
命令和公开页面实际返回的数据、权限缺口及用户反馈，未返回字段不得补成 0。

总控 Skill 不新增底层原子操作，而是把现有 XHS skill、公开研究能力和长期 Markdown
组织成账号经营流程。具体设计见 `docs/spec/content-lifecycle-ops.md`。

建议职责：

- 接收账号定位、目标用户、内容方向、竞品账号、关键词和发布目标。
- 生成本轮运营计划。
- 调用探索和内容运营流程完成热点、竞品、选题和草稿。
- 调用发布流程完成用户确认后的发布。
- 调用复盘流程总结公开表现。
- 产出下一轮运营建议。

第一版总控 skill 可使用 `creator-data-snapshot` 纳入创作者后台数据，但不持久化长期快照。

## 第三阶段：长期数据

如果需要完整账号增长闭环，后续需要新增工具或存储流程：

- `published-notes`：记录已发布笔记的标题、正文摘要、标签、素材、发布时间、发布方式和笔记 ID。
- `ops-history`：维护账号运营历史，记录选题、发布、公开数据、后台数据、复盘结论和下次建议。
- `hotspot-sources`：接入小红书外部热点源，例如微博、百度、头条等。
- `account-playbook`：根据历史效果沉淀账号风格、标题规则、内容结构偏好和选题禁区。

这些能力会引入新的工具、数据结构或持久化边界，不属于第一阶段。

## 验收标准

第一阶段验收：

- 文档和 skill 都明确写清 `user-profile` 不需要 `xsecToken`，详情和互动需要 `feeds[].xsecToken`。
- Agent 在详情或互动缺少 `xsecToken` 时先搜索、拉首页或读取主页笔记，不要求用户手填。
- Agent 能完成基于公开数据的热点、竞品、选题、草稿、发布和复盘流程。
- Agent 只使用 `creator-*` 命令实际返回的浏览量、曝光数、观看数和创作中心私有数据，
  并明确权限或数据门槛缺口。
- 发布和评论动作都必须经过用户确认。

长期数据阶段验收：

- 能把发布记录和效果数据沉淀为可复用历史。
- 下一轮选题和内容生成能引用历史复盘结论。
