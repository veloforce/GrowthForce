
## claude sdk

query options 里比较值得纳入后续配置的字段，我按用途分一下：

  - 模型与成本：model、fallbackModel、thinking、effort、maxThinkingTokens、
    maxTurns、maxBudgetUsd、taskBudget
  - agent 能力：agent、agents、tools、allowedTools、disallowedTools、skills、
    mcpServers、plugins
  - 权限与安全：permissionMode、canUseTool、permissionPromptToolName、
    allowDangerouslySkipPermissions、sandbox、managedSettings
  - 上下文与会话：cwd、additionalDirectories、resume、continue、sessionId、
    forkSession、persistSession、sessionStore
  - Prompt：systemPrompt、planModeInstructions、outputFormat、promptSuggestions
  - 运行时集成：env、pathToClaudeCodeExecutable、abortController、stderr、
    debug、debugFile、includePartialMessages、includeHookEvents
  - 扩展控制：hooks、onElicitation、toolAliases、toolConfig、strictMcpConfig

## 用户输入与权限等待

SDK 嵌入场景没有 Claude CLI 自带的 TUI，所有会中断 agent loop 的用户输入都必须由宿主
应用实现。

- `AskUserQuestion` 和普通工具权限审批统一走 `canUseTool`。
  - `toolName === "AskUserQuestion"` 时，Renderer 展示 `input.questions[]`，返回
    结构化回答时返回 `updatedInput.questions` 和 `updatedInput.answers`；用户选择直接泛化回复时返回
    `updatedInput.questions` 和 `updatedInput.response`，不再同时回传 per-question answers。
  - `query` options 显式设置 `toolConfig.askUserQuestion.previewFormat = "markdown"`；
    Renderer 只按安全 markdown/plain text 渲染 preview，不启用 HTML。
  - 其他工具审批提供“允许本次”“始终允许”“拒绝”“建议替代方案”四个动作。
    “允许本次”透传原始 `input`；“始终允许”仅在 SDK `suggestions` 中存在
    `destination: "localSettings"` 项时展示，并将这些 suggestions 回传到 `updatedPermissions`。
  - 用户拒绝或建议替代方案时返回 `behavior: "deny"`，并把用户填写的原因/建议作为
    `message` 交给 Claude 重新规划。
  - 本项目不支持 `approve with changes`，不提供工具入参 JSON 编辑。
  - 本项目不支持 `redirect entirely`。
- 运行中用户补充消息走 request-scoped 内存 queue，当前 SDK `query` 返回 `result` 后再用同一个
  `sdk_session_id` 自动 resume 一轮后续 query：
  - 初始 `query.prompt` 仍使用本轮原始 prompt。补充消息不写入当前 active query 的
    streaming input，因为实测 Claude SDK 会把运行中补充排到当前 assistant 结果之后，当前
    run 结束时模型不会回答这条消息。
  - queue 只存在于 Main/Agent process 内存，不落 SQLite；SQLite 只保存 session 索引、
    `sdk_session_id` 和 JSONL 路径。
  - queue 按 `requestId` 隔离，并用 `sessionId` 做校验。多个 session 并发运行时，
    补充消息只能进入对应 request。
  - 补充消息在 agent claim 前是 pending，可撤销；agent 每次只向 Main process claim
    一条 pending 消息，Main 原子地发送 consumed 事件，之后不可撤销，并作为运行时用户消息缓存展示。
  - 每条补充消息单独 resume 一轮后续 query，不把多条补充合并成编号 prompt，保证运行时
    transcript 和 Claude JSONL 历史的 user message 顺序一致。
  - pending 补充消息只显示在 composer 上方队列，不混入正式对话消息流；consumed 后
    才转成正式用户消息。
  - 每次后续 resume query 结束后都会再次 claim 下一条 pending 消息；如果用户在后续 query
    运行期间继续补充，会排到后续 resume query。
  - `done`、`error`、`cancel` 都关闭并清空未消费 queue。任务快结束时提交但尚未被 drain
    的消息不会进入下一轮用户手动 query；下一轮 request 会创建新的 queue。
  - 切换 session 再切回时，Renderer 从 Main 的 runtime cache 恢复 `runningRequestId`、
    pending queue 和已 consumed 的补充用户消息；应用重启后未消费 queue 丢失。
- `onElicitation` 只用于 MCP server 主动发起的 form/url elicitation，不作为
  `AskUserQuestion` 的实现入口。
- 自动化任务没有前台用户可交互界面；自动化 Run 禁用 `AskUserQuestion` 并注入
  system-reminder，要求发布、评论、互动等环节无需用户确认。遇到其他 `canUseTool`
  等待时默认拒绝，避免后台 Run 无限挂起。

## Dev-only 模型 HTTP 日志

目标：本地 `dev.sh --debug` 调试时记录 Claude Code SDK 调模型 API 的 HTTP request body 和 response body；默认 `dev.sh` 直接请求配置的 Base URL，安装版用户运行时不能启用。

实现采用 agent 进程内本地反向代理，而不是依赖 SDK debug 日志：

- `scripts/dev.sh --debug` 是唯一自动开启入口，注入 `AGENTSTUDIO_DEV_MODEL_HTTP_LOGS=dev.sh`；不带 `--debug` 时不注入该变量。
- agent 进程只有同时满足以下条件才启用代理：
  - `AGENTSTUDIO_DEV_MODEL_HTTP_LOGS === "dev.sh"`
  - `VITE_DEV_SERVER_URL` 存在
  - 当前不是 packaged runtime
- 启用时，本次 SDK `query` 的 `env.ANTHROPIC_BASE_URL` 指向 `http://127.0.0.1:{port}`；代理再转发到配置里的原始 provider `baseUrl`。
- 未启用时完全沿用现有 `ANTHROPIC_BASE_URL` 逻辑，不启动代理、不改写 env、不写 HTTP 日志。

日志落盘：

- 文件：`~/.agentstudio/logs/model-http-YYYYMMDD.log`
- 格式：YAML-like 可读分块，每条 request/response 使用 `---` 分隔，并以 `request:`、`response:` 或 `proxy_error:` 作为顶层键，方便 IDE 折叠。
- request 记录 method、redacted url、redacted upstreamUrl、redacted headers、pretty body、requestId、sdkSessionId、model。
- response 记录 status、redacted headers、pretty body、durationMs。
- `authorization`、`x-api-key`、cookie、token 等 header 必须打码。
- body 默认保留原文，因为这是调试模型输入输出的目的；通过最大字节数限制防止日志无限增长。

限制：

- 只能记录模型 API 实际返回的内容。若 provider 未返回私有 thinking，代理无法获得。
- 代理仅用于本地开发诊断，不作为运行时功能依赖。
