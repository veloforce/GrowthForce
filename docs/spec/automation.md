# 自动化定时任务设计

## 目标

自动化任务是可重复执行的 Agent Run 定义。任务创建后必须固定运行上下文，不依赖
后续变化的全局工作空间、当前选中账号或聊天权限设置。

Agent 可以通过 `automation` Tool 查询、创建、暂停、重新开启和删除任务。Tool 只提供
原子操作，调度、资源校验、失败重试和达到次数上限后的停用由 Main process 负责。

## 任务模型

任务持久化以下运行上下文：

- `workspacePath`：任务固定工作空间。
- `connectorBindings`：小红书和公众号账号绑定。运行路由使用稳定 `profileKey`；
  `accountId` 和 `displayName` 只作为展示及审计快照，不保存凭据。
- `selectedSkills`：创建时显式选择的 Skill 引用。
- `attachments`：创建时显式选择的文件名称和绝对路径，不复制文件内容。
- `maxRetries`：单个计划 Run 的最大重试次数。
- `maxRuns`、`runCount`：固定间隔任务的可选最大计划 Run 数和已经触发的计划 Run 数。

固定间隔使用 `intervalValue + intervalUnit`，单位支持 `minute | hour | day`。旧数据中的
`intervalMinutes` 在读取和保存时兼容为分钟单位。未设置 `maxRuns` 表示无限运行。

所有自动化 Run 固定使用 `bypassPermissions`（完全访问），并禁用 `AskUserQuestion`，
该权限不作为任务可编辑字段，也不读取 `settings.yml`。自动化 Agent Run 的 prompt 会注入
system-reminder，明确当前是后台自动化任务，并注入最小运行上下文：`automationTaskId`、
`automationTaskName`、`automationRunId`、`automationAttemptCount`。`automationAttemptCount` 与
`automation_runs.attempt_count` 同义，只表示同一 run 下第几次真正启动 Agent 执行；
账号资源等待不是一次 Agent 执行，不增加 `automationAttemptCount`。首次执行提示“这是该自动化任务
run 的第一次执行”，后续重试提示“这是同一 run 的第 N 次执行尝试”。system-reminder 不注入
计划触发时间、最大执行尝试次数、历史执行记录或工具名。

自动化上下文中所有环节无需用户确认；发布、评论、互动等手动
对话中需要确认的步骤跳过确认，直接按任务描述、绑定账号和已生成产物执行。
跳过确认不等于跳过输入完整性、内容校验、账号绑定校验或风控检查；评论/回复只能使用任务
描述、附件或上游 Run 产物中已经明确给定且预授权的内容。若缺少硬依赖、需要临场补写/改写
对外内容，或安全条件不满足，应失败并说明原因，不得停下来等待用户确认。

## 调度与执行

- 固定间隔首次执行发生在创建或重新计划后的一个完整间隔之后。
- 每次计划触发先创建独立 Run，并将 `runCount` 增加一；同一 Run 的失败重试不增加。
- 同一个任务已有未完成 Run（`running`、`retrying`、`waiting_resource`）时，新的计划触发
  不再创建堆积 Run，也不增加 `runCount`；只推进任务的下一次计划时间，错过的周期不回补。
- 达到 `maxRuns` 后任务自动停用、清空 `nextRunAt`，最后一个 Run 仍正常执行和重试。
- 修改固定间隔数值、单位或最大运行次数时视为新一轮，`runCount` 重置为零。
- 修改名称、描述、工作空间、账号、Skill、文件或最大重试次数时保留 `runCount`。
- 应用启动时不能让已经达到次数上限的任务重新进入调度。

每次尝试开始前由 Main process 校验固定运行上下文：

- 工作空间存在且是目录。
- 附件存在且是普通文件。
- 选择的 Skill 仍已安装、启用且 runtime 状态有效。
- 绑定账号仍存在且可用；公众号凭据从连接器存储读取，小红书按绑定 profile 获取
  runtime。

任一资源失效时，本次尝试明确失败并进入现有重试流程；该计划 Run 已经消耗一次运行
次数。系统不得自动切换账号、启用 Skill 或忽略缺失附件。

绑定的小红书账号被其他任务占用时，不视为普通失败。Run 进入 `waiting_resource`，不创建
Agent 会话、不增加 `automationAttemptCount`、不消耗 `maxRetries`，并复用 `automation_runs.next_retry_at`
记录下一次账号空闲检查时间。现有全局 automation timer 同时调度任务计划、失败重试和资源
等待检查；账号持续忙时默认 2 分钟后再次检查。应用关闭期间错过的资源等待不回补，启动时标记
为失败并说明“应用关闭期间错过账号资源等待”。

`automation_runs.execution_history` 保存同一 run 内的历史最终状态，格式为 JSON 数组。
每条记录包含 `status`、`at`、可选 `sessionId` 和可选 `reason`；`status` 只允许
`succeeded`、`failed`、`waiting_resource`。历史记录不保存 `automationAttemptCount`，数组顺序即历史顺序。
系统只在一次 Agent 执行结束（成功或失败）或账号等待时追加一条记录，不记录 attempt start。
`automation_runs.error_message` 继续保存最新错误摘要。

Agent Tool 创建任务时，Main process 还会立即校验工具显式传入的 Skill 和附件。附件
必须使用绝对路径、存在且是普通文件；Skill 必须已安装、启用且 runtime 状态有效。
未显式传入时任务不携带当前主 Agent 对话的附件或已选 Skill。

## Agent Tool RPC

`automation` MCP server 运行在 Agent process，不能直接读取 Main process 持有的
sql.js 数据库。Tool 通过类型化 Agent process 与 Main process RPC 调用任务服务：

- `automation_task_list`
- `automation_task_get`
- `automation_task_create`
- `automation_task_pause`
- `automation_task_resume`
- `automation_task_delete`
- `automation_run_current`
- `automation_run_get`
- `automation_run_list`

Tool 创建任务接收任务描述、调度参数、可选 `selectedSkills: string[]` 和可选
`attachmentPaths: string[]`。Main process 自动快照发起该 Tool 调用的 workspace 和
绑定账号；Skill 与附件由 Agent 显式决策。Main process 解析并校验引用、写入数据库、
重排 timer 并通知 Renderer。

Agent Tool 的任务返回值使用面向 Agent 的 DTO，不直接返回数据库/UI 内部 `AutomationTask`。
任务 ID 暴露为 `automationTaskId`，任务名称为 `automationTaskName`，执行次数为
`automationRunCount`，最大运行次数为 `maxAutomationRuns`；不得在 Agent 工具结果中暴露裸
`id`、`runCount` 或 `maxRuns`，避免和内容 Run 或 SDK 原生 task 工具混淆。

暂停和重新开启复用任务 `enabled` 状态。暂停只阻止后续计划触发，不取消运行中或等待
重试的 Run；重新开启从当前时间重新计算下一次执行时间。重复暂停或重复开启是幂等
操作。删除、暂停和重新开启均只接受稳定 task ID。

Run 查询工具均为只读原子操作。`automation_run_current` 仅在自动化 run 内返回当前 run 上下文
和完整 `executionHistory`；`automation_run_get` 按稳定 `automationRunId` 查询单个 run 和完整
历史执行记录；`automation_run_list` 支持按 `automationTaskId`、`statuses`、`limit`、`offset`
分页过滤，不支持按 `automationRunId` 过滤，单个 run 应使用 `automation_run_get`。

账号自动复盘开关不单独持久化布尔状态。连接器账号 `ops_state.review_task_id` 只保存
账号与自动复盘任务的关联，开关状态由关联任务是否存在且 `enabled = 1` 派生。定时任务
页面或 Agent Tool 暂停、重新开启关联任务后，Main process 通过 `automation:changed`
主动通知 Renderer 刷新连接器状态；删除关联任务时 Main process 清空账号的
`review_task_id`。

## 测试用例

- 1 号创建每 2 天、最多 3 次的任务，分别在 3、5、7 号触发，第 3 次后自动停用。
- 失败重试不增加 `runCount`；完整失败仍消耗一个计划 Run。
- 分钟、小时、天正确换算；旧 `intervalMinutes` 数据继续按分钟运行。
- 修改固定间隔或最大运行次数重置计数，修改其他字段保留计数。
- 修改 `settings.yml` 当前账号不影响任务绑定账号。
- 账号删除或失效、Skill 禁用、附件移动、工作空间删除时，本次运行明确失败。
- 自动化 Run 始终使用 `bypassPermissions`。
- 自动化 Run 注入 system-reminder，说明当前为自动化任务、无需用户确认、不得调用
  `AskUserQuestion` 或只返回等待确认，并包含 `automationTaskId`、`automationTaskName`、
  `automationRunId` 和 `automationAttemptCount`。
- 自动化 Run 的 system-reminder 不包含计划触发时间、最大执行尝试次数、历史执行记录或 run
  查询工具名。
- 自动化 Run 执行成功、失败、账号等待时追加 `execution_history` 最终状态；账号等待不增加
  `automationAttemptCount`，历史记录不包含 `automationAttemptCount`。
- 自动化评论/回复缺少明确预授权内容时失败，不调用互动命令，也不等待确认。
- Agent Tool 查询全部、按 ID 查询、创建、暂停、重新开启、删除成功。
- Agent Tool 的 task 返回结果包含 `automationTaskId`、`automationTaskName`、
  `automationRunCount`、`maxAutomationRuns`，不包含裸 `id`、`runCount`、`maxRuns`。
- Agent Tool 查询当前 run、按 `automationRunId` 查询、按 `automationTaskId`/status 分页查询 run 成功。
- Agent Tool 创建未传资源时不继承当前 Run 的 Skill 和附件；显式资源在创建与触发时
  均校验。
- 定时任务页或 Agent Tool 停用、启用、删除账号自动复盘任务后，连接器开关同步更新。
