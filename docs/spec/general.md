## 项目整体设计

- 这是 Electron 桌面应用 ，必须同时兼容 mac 和Windows ；
- 用户可见产品名和安装包展示名是 GrowthForce；历史兼容数据目录仍固定为 `~/.agentstudio`，不随品牌名迁移。
- 整个项目打包后的 app，安装后运行依赖的 node环境、 Chromium 必须是 Electron自带的 node、 Chromium
- 使用 Renderer + Main + Agent process的架构设计，Main process 不要被长任务阻塞
- 存储方案 使用 sqllite + 本地文件的形式，不考虑多端同步
   1、对话消息绝对不要使用 sqlite 存储，使用 内存map + jsonl 的方式
- 目前单机使用，有默认头像和账号，用户可以修改，不需要登录
- 目录结构
   1、本地app安装后的目录，偏静态，包括内置的agent、prompt、skill、tool
   2、用户自定义的能力，偏资源型，比如用户上传的 skill 资源包等。可以放在 ~/.agentstudio/user-resources/skills/
   3、用户动态配置，比如模型配置 ~/.agentstudio/config.yml 、agent 实际扫描的skill目录 ~/.agentstudio/skills/，用户默认的项目操作空间（类似claude 项目空间） ~/.agentstudio/workspace/
- 安装包不能内置开发机或用户机器上的 `~/.agentstudio` 用户数据，尤其不能把 `~/.agentstudio/config.yml` 打进安装包
- DMG/Windows 安装过程本身不能创建、覆盖、清空或写入 `~/.agentstudio` 及其下任何文件；安装只负责写 app 安装目录内的静态资源
- 应用运行后可以根据功能需求读取或写入 `~/.agentstudio`，包括 `~/.agentstudio/config.yml`（例如后续模型设置页面保存配置）、SQLite 会话索引、workspace/skills 目录和 Agent/Claude 运行态文件
- 应用首次运行时如果 `~/.agentstudio` 不存在，可以按需创建 `~/.agentstudio`、`skills`、`user-resources/skills`、`workspace` 和默认 `config.yml`；如果已存在，应使用现有目录和配置，不能因为安装或启动流程覆盖用户已有模型信息

## skill 管理

内容运营能力按三层组织：

- Tool：原子、确定的操作，不承载跨步骤策略、降级或长期数据沉淀。
- 阶段 Skill：定义单个阶段的 SOP、工具顺序、输入输出、校验、降级和确认规则。
- Recipe Skill：原由 `content-lifecycle-ops` 承担多阶段编排与长期数据写入。**已解散**：
  总原则上提 system 层（orchestrator.yml），执行细节下沉各阶段 Skill，长期数据写入收口到
  单一写者（见 `docs/spec/content-ops-loop.md`）。

阶段 Skill 之间不建立代码级依赖；通过标准阶段产物交接。用户可以替换某个阶段
Skill，而不需要替换整个生命周期 Recipe。

- 安装包内 `resources/skills/{agent}/{skill}` 是内置 skill 模板目录，只读使用，不能直接作为 Claude runtime skill source。
- `~/.agentstudio/user-resources/skills/{agent}/{skill}` 是 GrowthForce 管理的本地 skill 资源池，所有实际运行的 skill 都必须落在这里，包括内置 skill 的首次复制副本、市场安装 skill 和用户自定义 skill。
- `~/.agentstudio/agents/orchestrator/skills/{skill}` 是 Claude 可见的 runtime 视图，只放 enabled skill 的 symlink / junction，链接目标必须指向 `user-resources/skills` 下的可写副本。
- 首次启动或同步时，如果发现新的内置 skill 且用户资源池缺少对应副本，应从安装包只读模板复制到 `user-resources/skills`；已有副本不自动覆盖，避免破坏用户运行状态。
- `~/.agentstudio/settings.yml` 中 `skills.installed` 是状态源，表示 GrowthForce 管理的本地资源池中已安装的 skill；`skills.disabled` 也是状态源，表示 installed skill 中当前关闭的 skill。
- skill enabled 状态由 `installed[name] && !disabled.includes(name)` 推导；runtime symlink 只是派生结果，不参与业务状态判断。
- `installed[name].version` 是可选字段，只从 `SKILL.md` frontmatter 读取；当前版本不做内置 skill 自动升级覆盖，后续可基于该字段提醒用户升级。

## agent设计
- agent process 基于 claude agent sdk Typescript 封装，安装命令 npm install @anthropic-ai/claude-agent-sdk 。 这样可以方便基于本地文件管理 和 skill扩展 可以参考 https://code.claude.com/docs/en/agent-sdk/typescript
- Claude Code 使用 claude agent sdk 随包提供的平台 native binary；不能使用本地 `claude` 命令，也不能依赖用户机器的全局 Node 环境
- 只有显式配置 JS CLI fallback 时才可能使用 JS runtime；生产打包应避免这种模式，必须优先使用 SDK optionalDependencies 中对应平台的 native binary
- 执行项目 需要绑定一个本地目录，如果没有选择，默认 ~/.agentstudio/workspace
- agent使用的 model provider（baseurl 、 ak 、model）等使用配置文件读取 `~/.agentstudio/config.yml` 的 `provider`。
- 普通对话提交前必须检查 `provider.baseUrl`、`provider.apiKey`、`provider.model` 是否完整。首次启动缺失时进入 onboarding；已经进入工作台后提交缺失时打开账号设置里的“大模型”供应商弹窗，并保留输入框内容、附件、已选 Skill 和已选连接器账号，不创建失败会话。
- 图片 Provider 配置使用 `providerType`、`baseUrl`、`apiKey`、`model` 等字段读取 `~/.agentstudio/config.yml` 的 `imageProvider`。图片生成工具位于 `resources/tools/image`，通过 MCP server 注入，调用时由 Agent 显式传入输出路径。该 server 同时提供无网络访问的 `image_template_list` 和 `image_template_generate`，按 `xhs_cover`、`xhs_content`、`gzh_cover`、`gzh_content` 过滤模板并完成结构化文字排版；封面支持标题与副标题，内容图支持标题与可换行正文，四类模板在渲染前校验 title/subtitle/content 字数，并使用随包分发的固定字体保证跨平台一致。是否在未配置 Provider 时使用模板由 Skill 决策。
- 公众号文件处理工具位于 `resources/tools/wechat_content`，负责 Markdown 排版、HTML/Markdown
  转换、主题提取和文章分析。Markdown、HTML、主题 YAML、范文和报告均通过绝对路径交接；
  Tool 不内置主题或用户内容资产，也不承担抓取、主题选择、降级和长期数据写入。
- 普通模型供应商设置列表保存在 `~/.agentstudio/settings/model-providers.yml`，只包含 `providers` 数组；图片供应商设置列表保存在 `~/.agentstudio/settings/image-providers.yml`，只包含 `imageProviders` 数组。普通模型供应商的 `model` 使用英文逗号保存多个候选模型，图片供应商只保存一个模型。
- 普通模型供应商仅支持 Claude Messages API 兼容协议。设置页保存当前选中的普通供应商时，仅使用其第一个候选模型测试连通性。
- 首次 onboarding 的普通模型在连通性测试通过后同时写入 `model-providers.yml` 和 `config.yml`。后续不允许从 `config.yml` 反向生成或覆盖 `model-providers.yml`。
- 设置页普通模型和图片模型独立保存。普通模型配置内容发生变化时，先测试当前普通模型供应商的第一个候选模型，通过后才写入 `model-providers.yml`；仅切换已有普通供应商时不重新测试。图片模型保存只做本地字段校验并写入 `image-providers.yml`，不测试普通模型或图片模型连通性。
- 当前生效的普通模型和图片模型供应商同步到 `~/.agentstudio/config.yml` 对应字段。普通模型默认同步候选列表中的第一个模型；后续由对话框模型选择功能覆盖当前模型。
- 普通模型供应商 id 使用 `provider-` 加 8 位随机 UUID 十六进制片段；图片供应商使用 `image-provider-` 加同样格式。
- 图片供应商设置页只保存配置，不测试图片模型连通性；provider 类型和字段设计见 `docs/spec/image-providers.md`。
- 平台连接器账号和多 profile 隔离设计见 `docs/spec/connector-accounts.md`。连接器选择按对话保存，同一对话每个平台最多选择一个账号，不同平台账号可以同时存在。
- 小红书账号运营闭环设计见 `docs/spec/xhs-account-ops.md`。当前第一阶段只使用已有 skill 和公开互动数，不新增依赖或工具。
- 公开内容研究工具设计见 `docs/spec/content_research.md`。该工具负责无登录态的泛热点、关键词热点和竞品公开内容候选抓取。
- 自动化运营闭环设计见 `docs/spec/content-ops-loop.md`（取代 `content-lifecycle-ops.md`）。
  运营任务优先从当前 workspace 读取用户素材，账号定位、长期数据和单次 Run 数据统一通过
  `content_ops_data` 工具管理。核心原则：按文件归属拆写者，读可分散、写用事务工具收口；
  `history.md` 与 playbook 证据规律区只由 content-review-ops 聚合任务整写，playbook 用户
  明示偏好区由创作阶段按用户明确要求整段维护。
- 账号诊断设计见 `docs/spec/account-diagnosis.md`。诊断只读 Profile、最近发布内容和平台可用
  指标，输出评分卡与证据报告；缺失或无权限的数据不按零分处理，也不写长期运营数据。
- 自动化定时任务、固定运行上下文和 Agent Tool RPC 设计见 `docs/spec/automation.md`。
- 平台 Skill 是执行层，可以读取长期运营数据作为本轮输入。只要产出可发布草稿或发布包，
  create 阶段必须创建 Run 并传递 runId；各阶段通过 `content_ops_data` 事务工具写自己的隔离
  数据。`history.md` 与证据规律沉淀只由 content-review-ops 聚合任务收口写入。

`~/.agentstudio/config.yml` 图片生成配置示例：

```yaml
imageProvider:
  id: openai-image
  name: OpenAI
  providerType: openai
  baseUrl: https://api.openai.com/v1
  apiKey: sk-...
  model: gpt-image-1
```

`~/.agentstudio/settings/model-providers.yml` 示例：

```yaml
providers:
  - id: anthropic-default
    name: Anthropic
    baseUrl: https://api.anthropic.com
    apiKey: sk-...
    model: claude-sonnet-4-5,claude-opus-4-5
```

`~/.agentstudio/settings/image-providers.yml` 示例：

```yaml
imageProviders:
  - id: openai-image
    name: OpenAI
    providerType: openai
    baseUrl: https://api.openai.com/v1
    apiKey: sk-...
    model: gpt-image-1
```


## 登录态设计

登录态按 runtime 边界隔离，不按 Agent 对话进程隔离。一个对话 session 可以同时持有多个 Electron 浏览器 runtime 和多个 profile，但每个 runtime 的用途必须固定，不能依赖“当前浏览器”或让 Agent 自己选择 profile。

### default 浏览器登录态

- default 浏览器用于普通网页自动化，例如用户已在默认 profile 中登录的 SaaS、后台系统、文档站点等。
- default profile 路径固定为 `~/.agentstudio/user-profile/default`。
- default 浏览器页面按 GrowthForce 对话 session 创建 `WebContentsView`，但登录态共享 default profile。
- 右侧 web 页面展示区默认只展示 default 浏览器的当前 session 页面。
- 非平台连接器请求只能使用 default 浏览器 runtime，不读取平台连接器 profile。

### 小红书连接器登录态

- 小红书属于浏览器型平台连接器，不能复用 default profile。
- 小红书账号 profile 路径为 `~/.agentstudio/user-profile/connectors/xhs/<profile_key>`。
- 一个小红书账号对应独立 `profilePath + BrowserWindow + targetId`，用于隔离 cookie、localStorage、风控状态和 CDP target。
- 同一个对话 session 中，小红书平台最多选择一个账号；切换账号会替换该 session 的小红书选择。
- 系统支持管理多个小红书账号状态，包括已授权、需重新授权、授权失败、忙碌等；但同一轮对话执行时只能绑定当前 session 选中的一个小红书账号。
- 小红书连接器使用独立登录/运行窗口，不抢占右侧 default 浏览器展示区。

### 多 Electron Runtime 路由

- 一个对话 session 可以同时存在 default 浏览器 view 和小红书连接器窗口。
- 这些 runtime 可以共用同一个 Electron remote debugging port，但必须有不同 CDP target。
- Main process 负责创建、保存和路由这些 runtime；Agent process 不直接枚举 CDP target。
- 普通网页自动化命令由工程侧固定绑定到 default 浏览器 target。
- 小红书 skill 命令由工程侧固定绑定到当前 session 选中的小红书账号 target。
- Agent 只选择调用普通浏览器能力或小红书 skill；具体 profile、`targetId`、`cdpPort` 由 Main process 在 turn env 中注入，不暴露给 Agent 做选择。
- 如果未选择已授权小红书账号，发起小红书 skill 前由 Main process 返回明确错误，提示用户先选择账号。

### 运行锁

- default 浏览器按对话 session 维度串行保护，避免同一 default 页面被多个任务同时操作。
- 小红书按 `{ platform: "xhs", profile_key }` 加锁，同一个小红书账号同一时间只能有一个自动化操作。
- 不同小红书账号可以并行运行，前提是它们使用不同 profile 和不同 target。
- default 浏览器和小红书连接器可以在同一对话 session 中先后或并行存在，但高风险发布、评论等操作仍需要 skill 层按业务规则要求用户确认。

## app页面布局

整体布局分3部分 样式参考 docs/image.png
- 左侧导航栏（可折叠）,目前只有 工作台、skill中心和 定时任务（本期只实现工作台页面）
- 中间 agent 对话区域
- 右侧内容或web页面展示区（默认隐藏关闭）

### 工作台导航行为

- 每次点击左侧“工作台”导航都进入新建对话界面，不恢复当前选中的历史对话。
- 进入新建对话界面时清空未发送输入、当前消息、附件和已选技能，并取消历史记录选中态；不删除历史记录，也不取消后台运行中的会话。
- 用户点击左侧创作记录时才打开对应历史对话；新建界面发送首条消息时不携带旧会话 `sessionId`，由 Main process 创建新会话。

## 打包与版本管理

- Electron app 重新打包不会自动升级 Electron、`@anthropic-ai/claude-agent-sdk` 或 Claude Code；版本由 `package.json` 和 `package-lock.json` 共同决定
- 打包和 CI 安装依赖必须使用 lockfile，推荐 `npm ci`；不要删除 lockfile 后做浮动安装，避免 SDK 或 Electron 版本被意外升级
- `@anthropic-ai/claude-agent-sdk` 的版本升级必须显式执行，例如修改依赖版本或运行定向升级命令，并提交更新后的 `package-lock.json`
- Claude Code 版本跟随 claude agent sdk 包声明的 `claudeCodeVersion`，实际运行文件来自平台 optional dependency，例如 mac x64 是 `@anthropic-ai/claude-agent-sdk-darwin-x64/claude`
- mac 和 Windows 打包时必须确认对应平台的 SDK native binary 被安装并打进安装包；不能依赖开发机本地安装的 `claude`、`node` 或用户 PATH
- 升级 Electron 时需要同步验证 Electron 自带 Node/Chromium 版本、`utilityProcess` 行为、mac/Windows 安装包启动和 Agent process 调用链路
- 每次升级 Electron、claude agent sdk 或 Claude Code 对应版本，都要在 `docs/changes/${date}.md` 记录升级原因、版本号、验证结果和遗留风险
