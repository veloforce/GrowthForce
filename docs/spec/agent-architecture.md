# Agent Architecture

## 主 Agent 配置

- `resources/agents/*.yml` 中每个 yml 文件表示一个主 agent。
- 当前默认主 agent 是 `orchestrator`，也是工作台默认对话入口。
- 主 agent 顶层字段适配 Claude SDK query options，包括 `description`、`prompt`、`tools`、`disallowedTools`、`skills`、`model`、`maxTurns`、`permissionMode`。
- `display_name` 只用于 UI 展示，不传给 Claude SDK。

## Subagent 配置

- 主 agent 可以省略 `subagents`，也可以配置为数组。
- 当前 subagent 项只支持 `name`、`description`、`prompt`。
- 运行时会把当前主 agent 的 `subagents` 转成 Claude SDK `options.agents`。
- 其他主 agent 文件不会自动成为当前主 agent 的 subagent。

示例：

```yaml
display_name: 内容运营总监
description: 内容运营总监
prompt: |
  你是小灵。
subagents:
  - name: writer_agent
    description: 内容写作 Agent
    prompt: |
      你是内容写作专家。
```

## Runtime 目录

- 应用全局配置仍在 `~/.agentstudio/config.yml` 和 `~/.agentstudio/settings.yml`。
- 用户上传或安装的静态 skill 源目录仍在 `~/.agentstudio/user-resources/skills/{agent}/{skill}`。
- Claude SDK 的 `CLAUDE_CONFIG_DIR` 按主 agent 隔离；当前默认是 `~/.agentstudio/agents/orchestrator`。
- 默认主 agent 的 runtime skill link 同步到 `~/.agentstudio/agents/orchestrator/skills/{skill}`。
- 启动和 skill enable/disable 时，以全局 `settings.yml` 的 disabled 列表为准：未禁用的 skill 会同步到 runtime skills 目录。

## 运行中补充消息

- 用户在任务运行中发送的补充消息不创建新的桌面端 turn，而是进入当前 `requestId` 的内存 queue。
- queue 不落 SQLite；切换 session 时由 Main process 的 runtime cache 提供 pending 和已 consumed 的即时展示。
- `sessions:get` 必须返回 runtime `runningRequestId`，Renderer 用它恢复运行态，避免 running session 的输入误走普通 `startTurn`。
- pending 补充消息显示在 composer 上方队列，不进入正式对话消息流；agent 在当前 SDK query 返回后向 Main process claim 下一条 pending 消息，Main 原子地把该消息标记为 consumed 并发送 `supplementConsumed`，agent 再用同一个 `sdk_session_id` resume 一轮后续 SDK query。
- Renderer/Main 收到 `supplementConsumed` 后必须立即从 composer queue 移除对应 pending 项，并把正式用户消息追加到上一轮 assistant result 之后，不允许原地替换 pending 项。
- 每条补充消息单独 resume 一轮；后续 SDK query 运行期间继续提交的补充消息仍保持 pending，等该 query 返回后再 claim 下一条。
- revoke 和 claim 都必须由 Main process 串行处理：claim 成功后的消息不可撤销，避免 Renderer 撤销成功但 Agent 已经消费的双进程竞态。
- queue 生命周期绑定单个 request：任务完成、失败、取消都会清空未消费消息；未 drain 的消息不会转移到下一轮用户手动 query。
- 多 session 并发时，所有 queue 操作必须同时校验 `requestId` 和 `sessionId`，避免跨 session 串消息。

## Agent Run 工具上下文

- Main Agent 的 MCP Server 在每次 Run 构建 query options 时创建。
- 依赖当前 Run 的工具上下文必须由 `buildDefaultAgentOptions` 显式传给工具注册层，不能在
  Server 创建时从进程级 `process.env` 捕获。
- 当前显式上下文包含 `requestId`、default browser runtime 和公众号连接器凭据：
  `automation` 用 `requestId` 路由 RPC，`browser` / `content_research` 使用对应 Run 的
  page-level CDP 地址，`wechat_ops` 使用对应 Run 的 APPID、SECRET 和默认作者。
- 工具模块的 `createServer(context?)` 参数保持可选，不依赖 Run 上下文的工具忽略该参数。
- Claude Code/Bash/XHS CLI 等外部子进程仍通过每次 SDK query 的 `env` 获取 Run 数据。
- Utility process 不为 Run 修改 `process.env`。该约束用于保证单 utility process 内多个
  并发 Run 不会串用 request、浏览器 target 或公众号账号。

## 暂不处理

- `@某个主agent` 的对话选择。
- 非 orchestrator 主 agent 的 session 归属和历史记录隔离。
- orchestrator 调度其他主 agent。
- 旧 `~/.agentstudio/skills` runtime 目录迁移或清理。


# 对话设计

  # 多主 Agent Session 与 Agent Run 独立表方案

  ## Summary

  - sessions 只表示用户可见父对话。
  - 新增独立 agent_runs 表表示每次主 agent 执行，包括 @xxx 直接调用和 orchestrator 工具式委托。
  - 父 session 创建时固定写入 workspace_path，后续不可修改。
  - agent_runs 不保存独立 workspace，运行时永远继承父 session 的 workspace_path。
  - orchestrator 后续总结时，从父 session ledger 和 agent_runs 结果构建上下文。

  ## Data Model

  - sessions 保持父对话语义：
      - id
      - sdk_session_id
      - agent_name
      - title
      - workspace_path
      - jsonl_path
      - status
      - origin
      - timestamps
  - 当前 v1 只有主入口 `orchestrator`，legacy session 的 `agent_name` 默认按 `orchestrator` 处理。
  - 父 session 的 Claude JSONL transcript 按 `~/.agentstudio/agents/{agent_name}/projects/{workspaceSlug}/{sdk_session_id}.jsonl` 定位；`workspaceSlug` 由绑定的 `workspace_path` 绝对路径按 Claude 项目目录规则转换（非字母数字替换为 `-`，不压缩连续 `-`）。
  - 新增 agent_runs：
      - id
      - session_id: 父 session id，必填。关联 sessions.id
      - agent_name: 目标主 agent name。
      - sdk_session_id: 该 agent run 自己的 Claude SDK session。
      - request_id: 本次运行 request id。
      - invocation_kind: direct | delegation
      - task: 本次交给 agent 的任务文本。
      - status: running | completed | failed | cancelled
      - handoff_summary: 给 orchestrator 的摘要。
      - final_result: 给用户或调用方的结果。
      - error_message
      - started_at
      - completed_at
      - created_at
      - updated_at

  ## Workspace Rules

  - 创建父 session 时立即写入当前 workspace_path。
  - 父 session 的 workspace_path 后续不可修改。
  - 不管第一条消息是默认发给 orchestrator，还是 @writer_agent，都先创建父 session 并固定 workspace。
  - agent_runs 不存 workspace；所有 SDK query 的 cwd 都从父 session 查出。
  - 新对话 才支持切换 workspace

  ## Context Build

  - 新对话第一句 @writer_agent：
      - 创建父 session，sdk_session_id=NULL。
      - 创建 agent_runs(agent_name='writer_agent', invocation_kind='direct')。
      - writer 完成后写入 handoff_summary（writer_agent必须输出）、final_result
  - 后续让 orchestrator 总结：
      - 如果父 session 没有 sdk_session_id，新建 orchestrator SDK session，并把sdk_session_id 更新到 父 session 。
      - 用 agent_runs 构建 Parent Conversation Context。

  - 同一个对话再次 @writer_agent
      - 复用父 session
      - 新建 agent_runs ，但是 sdk_session_id 和  之前的 writer_agent 的 agent_runs的sdk_session_id 保持一致（就是为了writer_agent的上下文连贯）
      - writer 完成写入新的 agent_runs 的 handoff_summary（writer_agent必须输出）、final_result

  ## Summary Generation

  - 子运行摘要由目标 agent 自己生成。
  - 目标 agent 运行 prompt 追加要求：
      - 输出给用户看的 final_result。
      - 输出给 orchestrator 的 handoff_summary。
  - 如果 agent 未返回摘要， summary 为空
  - orchestrator 默认只读取 handoff_summary + final_result，不读取子 agent 完整转录。

  ## Routing And Invocation

  - 无 @agentName：发给 orchestrator。
  - 有 @agentName：创建该 agent 的 agent_run，不切换父 session。
  - orchestrator 工具式委托：
      - 内置工具 delegate_to_agent。
      - 入参：agentName、task、可选 contextSummary。
      - 工具创建 agent_runs 记录，执行目标 agent，返回 handoff_summary + final_result 给 orchestrator。
  - UI：
      - 左侧只展示 sessions。
      - 父对话消息区读取 session_events。
      - agent_run 显示为独立消息区块，可按 agent 名称配色。

  ## Test Plan

  - DB migration:
      - 创建 agent_runs、session_events、agent_context_checkpoints。
      - 旧 sessions 保持可读，默认没有 agent runs。
  - Workspace:
      - 默认新会话和 @agent 新会话都会固定父 session workspace。
      - agent run 执行 cwd 使用父 session workspace。
  - Direct @agent:
      - 第一条 @writer_agent 创建父 session + writer agent_run。
      - 父 session sdk_session_id=NULL。
      - writer run 有自己的 sdk_session_id 和结果记录。
  - Orchestrator after @agent:
      - 第一次 orchestrator 总结创建父 session sdk_session_id。
      - prompt 注入父 ledger 和 writer run 摘要/结果。
      - checkpoint 更新。
  - Delegation:
      - orchestrator 调用 delegate_to_agent 创建 agent_run。
      - agent_run 结果返回 orchestrator，并写入父 session events。
  - UI:
      - 左侧只显示父 session。
      - agent_run 不出现在会话列表。
      - 父对话内显示不同 agent 的消息区块。

  ## Assumptions

  - sessions 不再承担子运行语义。
  - agent_runs 不拥有 workspace。
  - origin 继续只表示 manual | automation。
  - 首版只实现 @agent 直接调用和工具式委托，不实现长期会话移交。
