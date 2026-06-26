# 开源能力完整性审查

## 结论

当前项目不是对 `wewrite` 和 `xiaohongshu-skills` 的无损拆分重组。

- 小红书平台原子动作主体基本保留，Electron CDP、多账号隔离和登录态校验属于合理
  重组并有增强；但认证入口、复合运营 SOP、发布准备细节和风控诊断可达性存在退化。
- WeWrite 的 converter、主题、人格和多数写作 reference 被保留；但大量用户可触发能力
  被明确删除，部分能力被通用阶段 Skill 替代后丢失关键策略和确定性行为。
- 当前测试主要证明资源存在、架构边界和 converter 行为，不能证明大部分账号内容能力
  对真实用户仍然等价可用。

因此，若目标是“除连接方式外不丢失任何账号内容相关用户能力”，当前状态不满足目标。

## 审查口径

审查基于 2026-06-14 的本地快照：

- `Desktop/xhs/wewrite`：commit `e30a6df`
- `Desktop/xhs/xiaohongshu-skills`：commit `b043748`
- 当前项目：工作区现状；未提交修改不回退，按当前内容审查

全部用户可触发能力都纳入审查，包括创作、运营、学习、复盘、排版、发布和辅助命令。
Bridge 改为 Electron 内置 CDP、运行时参数注入和打包方式等纯连接差异不计为 gap。
上游自身已有且当前继承的问题单列为“继承风险”。

状态定义：

| 状态 | 含义 |
|---|---|
| 完整保留 | 用户语义、执行能力和关键策略均保留 |
| 等价重组 | 实现位置变化，但用户能力等价或增强 |
| 部分替代 | 主目标可完成，但关键细节、确定性或入口丢失 |
| 能力缺失 | 当前没有等价用户能力或实际调用路径 |

严重级别：

| 级别 | 含义 |
|---|---|
| P0 | 直接违背无损重组目标，核心用户能力缺失 |
| P1 | 能力名义存在，但关键行为、质量或可达性明显退化 |
| P2 | 辅助能力、细节约束或可靠性缺口 |

## 能力总览

### 小红书

| 能力 | 当前状态 | 结论 |
|---|---|---|
| Electron CDP、多账号 profile、运行锁 | 等价重组/增强 | 连接方式变化合理，账号隔离和账号一致性校验优于上游 |
| 首页、搜索、筛选、详情、评论加载、用户主页 | 完整保留/增强 | CLI 主体保留；主页不再强制要求 `xsecToken` |
| 评论、回复、点赞、取消点赞、收藏、取消收藏 | 完整保留/增强 | 主体保留；点赞/收藏状态识别增加了实现和测试 |
| 图文、视频、长文、定时、原创、可见性、草稿 | 原子能力保留 | CLI 命令保留，但 Skill 细节有退化，见 P1 |
| 扫码、手机号登录、退出、切换账号 | 部分替代 | 原生连接器替代 auth Skill，但用户可触发语义不完整 |
| 竞品分析、热点追踪、一键创作、互动管理 | 部分替代 | 通用生命周期可组织流程，但上游 XHS 专属 SOP 丢失 |
| 风控诊断 NetLog | 部分替代/不可达风险 | CLI 存在，Skill 允许命令和运行方式说明冲突 |
| 创作者后台私有指标 | 非迁移 gap | 上游同样没有结构化能力；当前文档已明确边界 |

### WeWrite

| 能力 | 当前状态 | 结论 |
|---|---|---|
| converter、主题、容器、微信兼容修复、暗黑模式 | 完整保留 | 源文件、主题集和 converter 测试与上游一致 |
| 草稿箱推送、草稿读取、公众号指标 | 等价重组/增强 | 下沉为 `wechat_ops` 原子 Tool，凭据边界更清晰 |
| 热点抓取 | 等价重组/增强 | `content_research` 支持微博、头条、百度、36Kr 等来源 |
| 框架、内容增强、写作人格、SEO 写作规则、视觉提示词 | 大部分保留 | reference/persona 主体保留，少量规则有意改写 |
| 全自动八步主管道和交互模式 | P0 能力缺失 | 通用生命周期没有等价执行协议 |
| SEO 量化评分 | P0 能力缺失 | `seo_keywords.py` 无替代 Tool |
| 范文导入、范文库、写作时 few-shot 注入 | P0 能力缺失 | 已明确删除，无等价存储和执行能力 |
| 学习排版、自定义主题生成 | P0 能力缺失 | 已明确删除 |
| 小绿书/图片帖 | P0 能力缺失 | 已明确删除 |
| 文章 URL 采集并导入范文 | P0 能力缺失 | `fetch_article.py` 无等价能力 |
| 文章质量评分和自然语言自检报告 | P0/P1 缺失 | `humanness_score.py` 与生成档案协议均不存在 |
| 学习用户修改 | 部分替代 | 可比较 draft/final 并沉淀 Playbook，但触发入口与规则更新协议弱化 |
| 主题画廊 | P1 能力缺失 | 只能列主题，不能并排预览和复制 |
| 图片生成 | 部分替代 | 单一活动 provider，丢失上游多 provider 自动 fallback |

## 迁移 Gap

### P0-1 WeWrite 全自动主管道被拆散后没有等价总控协议

上游 `wewrite` 明确承诺默认一次性执行固定八步，并提供交互模式、跨步骤降级标记、
进度追踪和 `DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT` 完成协议。

当前 `content-lifecycle-ops` 能路由研究、策略、创作、排版、发布和复盘，也能记录 Run；
但它没有规定：

- 单句“写一篇公众号文章”必须完整走完创作到草稿箱。
- 用户说“交互模式”时在选题、框架和配图暂停。
- `skip_publish`、`skip_image_gen` 等降级状态跨阶段传播。
- 八步进度或等价阶段进度必须向用户报告。
- 最终完成状态和降级项的固定报告协议。

结果是功能模块存在，但 Agent 是否完成全流程取决于临场判断，不再具有上游确定性。

证据：

- 上游：`wewrite/SKILL.md:28-40`、`wewrite/SKILL.md:54-63`
- 当前：`resources/agents/orchestrator.yml:15-25`（当前无 `content-lifecycle-ops` 目录，整体流程协议在 orchestrator.yml 主流程描述中）

建议：为 `content-lifecycle-ops` 增加公众号完整生产 recipe，保留阶段 Skill 边界，同时
恢复模式、进度、降级状态和完成协议。

### P0-2 WeWrite 范文风格库完整缺失

上游支持从本地 Markdown 或公众号 URL 导入范文、查看范文库、提取风格片段，并在写作
阶段按框架类别选择 top 3 范文进行 few-shot 注入。这是账号内容风格能力，不是构建辅助。

当前项目保留了 `exemplar-seeds.yaml`，但没有：

- `fetch_article.py`
- `extract_exemplar.py`
- 范文索引和账号级范文存储
- “学习这篇文章 / 导入范文 / 查看范文库”触发入口
- `wechat-create` 写作时读取真实范文的步骤

证据：

- 上游：`wewrite/README.md:33-36`、`wewrite/references/commands.md:13-14`
- 当前明确删除：`docs/spec/wewrite.md:92-97`

建议：新增账号级 exemplar 数据模型和原子导入/列表 Tool，由 `wechat-create` 按明确规则
读取；不要把范文放入 docs 或只依赖模型上下文。

### P0-3 学习排版、自定义主题生成和小绿书能力被明确删除

当前设计直接声明删除“范文导入、学习排版、自定义主题生成、小绿书”。这些都是上游
用户可触发能力：

- `learn_theme.py`：从公众号 URL 提取排版主题。
- `gallery`：并排预览所有主题并复制。
- `image-post`：创建最多 20 张的横滑图片帖。

当前排版 CLI 只有 `render` 和 `themes`，不存在等价能力。

证据：

- 上游：`wewrite/references/commands.md:12-17`、`wewrite/README.md:266-290`
- 当前：`docs/spec/wewrite-upstream-sync.md:15-20`、`docs/spec/wewrite.md:92-97`

建议：将这三项拆成独立 Skill/Tool，不重新塞回 converter Skill：

- `wechat-theme-gallery`
- `wechat-theme-learn`
- `wechat-image-post`

### P0-4 SEO 量化评分和文章质量评分缺失

上游不仅有 SEO 写作规则，还通过 `seo_keywords.py` 提供百度与 360 搜索量化评分；通过
`humanness_score.py` 提供文章质量检测和定向修复依据。

当前 `wechat-create` 只要求读取 SEO 和 realtime-check reference。没有量化 SEO Tool，
也没有质量评分器。`content_analysis` 的版本比较和历史语料分析不等价于单篇质量评分。

证据：

- 上游：`wewrite/README.md:22-24`、`wewrite/README.md:286-287`
- 当前：`resources/skills/orchestrator/wechat-create/SKILL.md:20-30`

建议：迁移为原子只读 Tool，并由 `wechat-create` 和自检 Skill 组织使用。

### P0-5 小红书认证用户语义未完整迁移

原生连接器接管登录态是合理重组，但上游 auth Skill 的用户触发能力并未全部映射：

- 用户可直接要求检查登录状态。
- 用户可明确选择手机号登录，并有“每次必须确认手机号”的安全规则。
- 用户可要求退出登录/清除登录。
- 二维码过期刷新和验证码错误重试有明确对话流程。

当前业务 Skill 不包含 `xhs-auth`，公开业务 CLI 隐藏手机号登录和退出命令。原生 UI
覆盖添加、重新授权、切换、删除账号，但没有证明自然语言请求“手机号登录/退出登录”
会路由到等价操作。

证据：

- 上游：`xiaohongshu-skills/skills/xhs-auth/SKILL.md:33-58`、`:108-150`
- 当前：`docs/spec/xhs-connector.md:21-25`

建议：不恢复直接暴露 CLI 的 auth Skill；新增连接器账号原子 Tool 或系统级账号操作
接口，并提供受控 auth Skill，保持手机号确认、退出确认、刷新和错误重试语义。

### P1-1 XHS 复合运营改为通用生命周期后丢失平台专属 SOP

2026-06-23 更新：该缺口已按阶段职责补齐，不恢复单体 `xhs-content-ops`：

- `content-research-ops/references/xhs.md` 负责热点双排序、3–5 篇竞品样本和详情访问节奏。
- `xhs-create` 负责创作前 2–3 篇参考笔记和差异化生成。
- `xhs-interact` 负责批量目标确认、30–60 秒随机间隔和风险等级停止规则。
- 固定日次数与发布时间不再当作平台事实，只保留为需验证的运营建议。

当前生命周期能力比上游覆盖更广，但没有等价保留以下 XHS 专属确定性规则：

- 竞品分析选取 3-5 篇高互动笔记，并输出标题、封面、结构、标签、互动对比表。
- 内容创作先分析 2-3 篇参考笔记。
- 互动目标优先筛选中等互动量且垂类相关的笔记。
- 每次互动间隔 30-60 秒。
- 每天评论不超过 20 条、竞品/热点建议频率、建议发布时间。
- 复合流程每一步报告进度并等待确认。

通用阶段 Skill 能完成类似任务，但这些细节没有进入 XHS reference，因此属于细节丢失。

证据：

- 上游：`xiaohongshu-skills/skills/xhs-content-ops/SKILL.md:54-65`、`:69-188`
- 当前：`resources/agents/orchestrator.yml:15-25`（当前无 `content-lifecycle-ops` 目录；XHS 专属 SOP 应进入 reference，而非独立 Skill）

建议：将平台专属 SOP 放入 `content-lifecycle-ops/references/xhs.md`，由通用 Recipe
读取，不恢复旧复合 Skill。

### P1-2 XHS 发布 Skill 丢失发布准备和错误处理细节

2026-06-23 更新：URL 输入和发布准备缺口已补齐。`xhs-create` 使用 `web_fetch` 处理
URL-only 请求、正文图片筛选和来源记录；`xhs-publish` 明确 UTF-16 标题校验、URL 图片由
CLI 下载、下载失败保留发布包，以及确认前取消和填表后草稿处理的区别。发布结果判定、
风控和异步回补已强于上游。

底层 CLI 命令完整保留，但当前发布 Skill 将上游详细 SOP 压缩成发布包检查，丢失：

- 用户只提供网页 URL 时的正文/图片提取模式（最高优先：真实用户常直接粘贴 URL）。
- 懒加载图片 `data-src`、占位图过滤和内容图选择规则。
- 标题 UTF-16 长度的具体计算与超长重写策略（汉字/全角=1单位，ASCII/数字/半角=0.5单位，上限20）。
- URL 图片直接交给 CLI 下载，不要手动下载。
- 视频处理、模板加载、标题过长等具体失败处理。

注：当前 `xhs-publish/SKILL.md` 示例命令已使用 `--title-file` / `--content-file`，
中文写临时文件的做法**已保留**，不属于缺口。

这不会删除 CLI 原子能力，但会降低 Agent 正确使用能力的概率。

证据：

- 上游：`xiaohongshu-skills/skills/xhs-publish/SKILL.md:47-140`、`:289-297`
- 当前：`resources/skills/orchestrator/xhs-publish/SKILL.md:32-48`

建议：把内容生成规则放入 `xhs-create`，把发布输入、文件和失败处理规则保留在
`xhs-publish`，避免职责混回单体 Skill。

### P1-3 WeWrite 创作策略被压缩，关键质量协议丢失

当前保留了框架、内容增强、人格、写作指南、实时检查、SEO 和视觉 reference，但
`wechat-create` 只有五步概要，未要求执行上游的关键策略：

- 10 个选题中 7-8 个热点、2-3 个常青，并按三维评分。
- 历史去重和基于表现的框架/增强策略加权。
- 最近 3 篇人格、维度和收尾方式降权。
- 真实范文优先、种子 fallback。
- 每 500 字/H2 实时检查，之后再做快速自检和两轮定向修复。
- 封面 3 组创意、视觉锚点、3-6 张内文配图。
- 2-3 个编辑锚点。

Reference 文件存在不等于这些行为会被执行；当前 Skill 没有要求读取 `exemplar-seeds`
或规定数量、轮次和降级。

建议：在 `wechat-create` 中恢复决策完整的执行协议，并通过阶段产物显式记录所选框架、
人格、证据、质量检查和视觉方案。

### P1-4 图片生成丢失多 provider 自动 fallback

上游 `image_gen.py` 支持按配置的 provider 列表自动 fallback。当前 `image_generate`
只读取当前活动图片 provider，调用失败后直接报错。`wechat-create` 会保留提示词继续，
但不能自动尝试备用 provider。

建议：若产品仍希望支持备用图片供应商，在 Tool 层保持单次原子调用，在 Skill 层读取
明确候选并组织重试；不要把降级策略塞回 Tool。

### P1-5 主题画廊退化为主题名称列表

上游 `gallery` 提供所有主题的手机视图并排预览和一键复制。当前只能执行
`themes --json` 返回名称和描述。用户仍可逐个 render，但不等价。

建议：恢复独立 gallery 产物生成，不要求排版 Tool 自动打开浏览器。

### P2-1 修改学习存在替代能力，但缺少明确用户入口和更新协议

当前生命周期会记录用户修改，`content_compare_versions` 可分析 draft/final，
`content_playbook_append` 可沉淀有证据规则。这比上游本地 `history.yaml/playbook.md`
结构更清晰。

但当前没有专门处理“学习我的修改”的 Skill，也没有上游的规则置信度更新、重复规则
合并和微信草稿同步学习流程。因此判定为部分替代。

建议：新增 `content-learning-ops` 或扩展 `content-review-ops` 的触发描述和 SOP，明确
何时比较版本、何时追加/合并规则以及用户如何查看结果。

### P2-2 WeWrite 首次风格设置被通用 Profile 替代，但字段不完全等价

当前 Profile 包含人设、目标用户、内容领域、核心价值、内容风格、边界、转化目标和
参考账号。它覆盖账号定位主体，但没有上游明确字段：

- blacklist
- theme
- cover_style
- author
- writing_persona 的固定选择

其中作者由公众号连接器提供，其他字段没有结构化等价位置。自由文本 `contentStyle`
可以描述它们，但可执行性较弱。

建议：根据实际产品需求扩展 Profile 字段，或定义 `contentStyle` 内稳定格式；避免
依赖模型从自由文本猜测主题和视觉约束。

### P2-3 人格与写作维度跨文章降权机制缺失

上游 `persona-selection.md` Rule 3 明确要求：最近 3 篇已使用的人格降权，避免重复；
Step 4 维度随机化同样要求追踪并降权最近已用维度组合和收尾方式。

当前状态：
- `references/persona-selection.md` 存在并定义了降权规则，但 `wechat-create` 未读取
  `content_runs_recent` 来获取近期人格/维度使用记录。
- `content_ops_data` Run 记录中已有 draft 快照，但没有 Skill 从中提取人格/维度元数据
  并反哺选择步骤。

影响：长期使用时，Agent 可能反复选择同一人格和维度组合，写作多样性下降。

证据：

- 上游：`wewrite/references/persona-selection.md`（Rule 3）、`wewrite/SKILL.md:Step 4`
- 当前：`resources/skills/orchestrator/wechat-create/SKILL.md:24-28`（无降权读取步骤）

建议：在 `wechat-create` 步骤 2 中，读取 `content_runs_recent` 并从最近 Run 的 draft
快照或 metadata 中提取人格/维度，按已定义规则降权。**不需要新建 Tool**，数据读取路径
已存在。

### P2-4 "检查一下"诊断命令缺失

上游 `references/commands.md` 中 `检查一下` 触发一份当前文章的即时诊断报告：
使用的框架、人格、激活的维度、SEO 评分、humanness 评分、5 条具体改进建议。
这是发布前的轻量自检，与 `content-review-ops` 的发布后复盘不同。

当前状态：
- 无用户可即时触发的"当前文章质量快照"路径。
- `wechat-create` 不记录本次框架/人格/维度选择元数据，Agent 无法随时汇报创作参数。
- P0-4 如果实现了 humanness 评分 Tool，此命令可复用其输出。

证据：

- 上游：`wewrite/references/commands.md:11`（`检查一下` 命令）、`wewrite/SKILL.md:Step 8`
- 当前：`resources/skills/orchestrator/wechat-create/SKILL.md`（无框架/人格/维度元数据记录）

建议：`wechat-create` 完成选择后，将框架、人格、维度记录到 Run 的 metadata（通过
`content_run_update`）；新增 `检查一下` 触发词路由到轻量自检流程，读取最近 Run
metadata + draft 快照，输出参数摘要与质量建议。

## 合理重组与增强

以下差异不应当被修复回上游形态：

- XHS Extension Bridge 改为 Electron CDP，并通过 Main 固定绑定目标账号和 target。
- XHS 多账号独立 profile、同账号运行锁和账号一致性检查。
- `check-session` 返回结构化失败原因，且业务 Skill 在动作前校验账号。
- `user-profile` 不再要求无意义的 `xsecToken`，并等待主页笔记加载。
- 点赞/收藏状态识别增强，并增加了解析测试。
- WeWrite 公众号凭据从 Skill 本地配置迁移为连接器 turn-scoped 环境。
- 公众号草稿发布、草稿读取和指标读取下沉为原子 Tool。
- Profile、Run、History 和 Playbook 从单 Skill 本地文件迁移为平台无关长期数据工具。
- 热点抓取迁移为多来源 `content_research` Tool。
- converter、主题集和 converter 测试完整保留。

## 继承风险

这些问题不是拆分重组新产生的，但当前项目仍需要处理：

1. `xhs-explore` 允许命令表只列出查询命令，却在末尾要求调用 `get-netlog` 和
   `risk-report`；当前仍继承矛盾。
2. 当前 XHS 使用 Electron CDP，不加载扩展，但 `xhs-explore` 仍说明需要通过扩展 popup
   彩蛋激活 NetLog，该前提在当前运行时不可成立。
3. 上游 XHS 几乎没有主体自动化测试；当前也只有点赞/收藏状态解析单测，搜索、详情、
   评论、发布、长文、登录等没有自动化能力测试。
4. XHS `get-netlog`、`risk-report`、`diagnose-404` 和 `check-risk` 存在于 CLI，但没有
   独立 Skill 明确拥有这些诊断能力。
5. 上游 WeWrite 多数用户流程本身由长提示词驱动，缺少对完整工作流的自动化验收；
   当前拆分后更需要契约测试，否则 reference 存在但行为可能不执行。

## 测试缺口与待 Review 用例

按项目规范，本节只设计测试用例，尚未编写。恢复能力前应先由用户 review。

### 契约测试

1. 建立上游能力 manifest，列出所有用户触发词、CLI 命令、阶段行为和辅助命令。
2. 检查每项能力在当前项目中存在且有唯一 owner：Skill、Tool、Connector 或明确排除项。
3. 检查 Skill 提到的命令都实际存在，且允许命令表与正文一致。
4. 检查所有阶段 Skill 引用的 reference 文件存在并会在 SOP 中被读取。
5. 检查完整 Recipe 不会因阶段拆分丢失确认、降级、进度和完成协议。

### 小红书真实用户操作验收

不 mock，使用测试账号和独立 profile：

1. 扫码登录、手机号登录、重新授权、切换账号、退出登录。
2. 搜索带全部筛选条件，读取详情、全部评论、子评论和用户主页。
3. 评论、回复、点赞/取消、收藏/取消，并验证幂等状态。
4. 图文 URL 图片、本地图片、混合图片、视频、长文、定时、原创和可见性。
5. 分步发布后取消，确认草稿真实保存。
6. 竞品分析、热点追踪、一键创作和互动管理，验证平台专属 SOP 与频控。
7. CDP 缺失、登录失效、账号错配、验证码错误、二维码超时和页面选择器失效。

### WeWrite 真实用户操作验收

不 mock；需要真实公众号凭据的测试仅在专用测试号运行：

1. 单句请求从研究走到草稿箱，验证全自动/交互模式、进度、降级和完成协议。
2. 热点抓取、SEO 评分、10 个选题评分、历史去重和框架选择。
3. 导入范文、查看范文库、写作时命中范文、学习用户修改并影响下一篇。
4. 文章质量评分与自然语言自检报告。
5. 主题画廊、学习排版、自定义主题、小绿书。
6. converter 全主题、容器、CJK、脚注、暗黑模式和预览回归。
7. 草稿箱推送、草稿读取和指标回收。
8. 图片主 provider 失败后备用 provider 重试，以及全部失败后保留提示词。

## 恢复优先级

1. **第一批 P0：恢复用户能力入口**
   - WeWrite 完整生产 Recipe。
   - 范文导入/范文库/写作注入。
   - SEO 与文章质量原子 Tool。
   - XHS 受控认证 Skill/Tool。
2. **第二批 P0/P1：恢复独立辅助能力与平台细节**
   - 学习排版、主题画廊、小绿书。
   - XHS 专属复合运营 reference。
   - XHS 发布准备和失败处理 SOP。
3. **第三批 P1/P2：增强可靠性**
   - 图片 provider Skill 层 fallback。
   - 修改学习入口和 Profile 风格字段。
   - P2-3：`wechat-create` 读取 `content_runs_recent` 实现人格/维度降权。
   - P2-4：记录创作元数据并新增 `检查一下` 轻量自检路由。
   - 能力 manifest、契约测试和真实账号验收。

恢复时应继续遵守当前三层架构：原子操作放 `resources/tools/` 或 Connector，降级、重试、
确认和流程策略放 `resources/skills/`，长期数据由 `content_ops_data` 管理。
