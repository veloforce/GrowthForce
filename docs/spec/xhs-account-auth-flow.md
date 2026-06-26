# 小红书账号 User Story 链路梳理

本文基于当前代码梳理小红书账号相关 user story 的调用链路，覆盖新增账号、重新授权、切换/选中账号、直接使用已选账号发起任务，并追到 Claude Agent SDK `query()` 调用为止。

当前策略是“数据库状态优先 + 5h 后台静默检测 + skill 前置确认”：选择账号和提交任务不再同步 `check-session`，以保证交互流畅；真实登录态由后台检测和 skill 执行业务命令前确认兜底。

## 核心职责

Renderer 只负责 UI 状态和 IPC 编排：

- `addXhsAccount()`：创建新账号后立即进入授权流程。
- `reauthorizeXhsAccount(profileKey)`：复用已有 profile 重新授权。
- `authorizeXhsAccount(profileKey)`：串联 `startXhsLogin -> waitXhsLogin`。
- `selectXhsAccount(profileKey)`：只用于 `authorized` 账号选择，选择结果由 Main 决定。

Main IPC 负责账号状态机：

- `connectorsXhsAccountCreate`：生成 `profileKey`，写入 `authorizing`。
- `connectorsXhsAccountSelect`：只校验 DB 中账号存在且 `status === authorized`，直接写 selected，不同步检测登录态。
- `xhsLoginStart`：直接 `ensureRuntime + showLoginWindow + loadURL(loginUrl)`，不先 `check-session`，也不清理 cache。
- `xhsLoginWait`：等待登录完成，处理资料不完整、登录错账号、重复账号、授权成功。
- `ensureXhsContext(profileKey, requestId)`：任务发起前只校验 DB selected 和 `authorized`，然后生成小红书 runtime context。
- 5h 后台检测：根据 `lastAuthorizedAt` 调度静默 `check-session`，确认有效后刷新 `lastAuthorizedAt`。

`XhsConnectorRuntimeManager` 负责 runtime 和 sidecar 原子能力：

- `ensureRuntime(profileKey)`：按 `profileKey` 创建独立 Electron session、窗口和 CDP target。
- `startLogin(profileKey, options)`：展示登录窗口并打开小红书登录页；不做账号身份前置检测。
- `waitLogin/checkSession/getAccountInfo`：通过 `runCommand` 调用 sidecar。`waitLogin` 和
  `checkSession` 的 Main 子进程超时均为 sidecar 业务等待时间加 60 秒，只用于覆盖
  sidecar 启动、CDP attach 和页面准备；业务超时仍由 sidecar 返回结构化原因。
- `ensureContext(account, requestId)`：加同账号运行锁，返回 SDK 进程需要的 CLI/CDP/account context。
- `clearAuth/logout/deleteProfile`：处理授权清理、退出和 profile 删除。

Agent 进程不参与账号选择：

- `agent.ts` 的 `buildAgentEnv()` 把 `AGENTSTUDIO_XHS_*` 注入 SDK 运行环境。
- `prompt.ts` 的 `composePrompt()` 注入小红书连接器 system reminder。
- Claude Agent SDK `query()` 只接收已验证的 env 和 prompt，不理解账号状态机。

## 状态语义

`connector_accounts.status` 当前支持：

- `authorizing`：已创建本地 profile，正在或曾经进入授权流程。
- `authorized`：DB 认为该账号可用。选择账号和提交任务只看这个状态。
- `needs_refresh`：后台检测、登录等待或退出登录确认该账号需要重新授权。
- `error`：profile 中实际登录账号与记录中的 `accountId` 不一致。
- `unauthorized`：模型保留状态，当前添加账号直接创建为 `authorizing`。

`lastAuthorizedAt` 表示“最近一次确认授权有效的时间”。扫码授权成功和 5h 后台检测确认同账号仍登录时都会更新它。

## User Story 调用链路

### 新增账号并登录成功

1. 用户点击“添加账号”。
2. Renderer 调用 `createXhsAccount()`。
3. Main 生成新 `profileKey`，写入 `status=authorizing`。
4. Renderer 调用 `startXhsLogin(profileKey)`。
5. Main 调用 `xhsConnector.startLogin(profileKey)`。
6. Runtime 创建独立 Electron session/window/CDP target，立刻展示登录窗口并打开小红书登录页。
7. Renderer 调用 `waitXhsLogin({ profileKey, timeout: 120 })`。
8. Main 调用 sidecar `wait-login`，sidecar 等待完整 `account_id/account_handle/nickname`；
   未登录页面的 `guest` 是等待中的正常状态，不提前结束。用户关闭登录窗口时只隐藏窗口，
   等待继续到成功或 120 秒业务超时；Main 另留 60 秒进程余量。
9. Main 校验账号资料完整，写入 `authorized`、账号资料和 `lastAuthorizedAt=now`。
10. Main 写入 `settings.connector.xhs.selected_account = profileKey`。
11. Main 调度下一次 5h 后台检测。
12. Main 隐藏登录窗口并返回 state。

结果：账号被授权并选中。

### 新增账号但登录到已存在账号

前半段与新增账号一致，差异发生在 `xhsLoginWait` 拿到完整账号资料后：

1. Main 通过真实 `accountId` 查到已有账号。
2. Main 更新已有账号为 `authorized`，刷新账号资料和 `lastAuthorizedAt=now`。
3. Main 删除本次临时账号记录和临时 profile。
4. Main 选中已有账号。
5. Main 调度已有账号下一次 5h 后台检测。

结果：不会保留重复账号；用户被切换到已有账号。

### 重新授权已有账号

1. 用户点击 `authorizing`、`needs_refresh` 或 `error` 账号行。
2. Renderer 调用 `reauthorizeXhsAccount(profileKey)`。
3. Main 调用 `xhsConnector.startLogin(profileKey)`。
4. Runtime 立刻展示登录窗口并打开小红书登录页，不先 `check-session`。
5. 用户扫码后，Renderer 等待 `waitXhsLogin`。
   - 如果用户关闭登录窗口，窗口只隐藏，`waitXhsLogin` 仍继续等待到成功或超时。
   - 如果用户再次点击同一账号，Renderer 只重新调用 `startXhsLogin(profileKey)` 显示窗口，不启动第二个 `waitXhsLogin`。
6. Main 校验登录结果：
   - 登录回原账号：更新为 `authorized`，刷新 `lastAuthorizedAt=now`，选中账号并调度 5h 检测。
   - 登录到另一个账号：调用 `clearAuth(..., showLoginWindow=true)`，状态更新为 `error`，清空 selected，返回 `accountMismatch=true`。
   - 资料不完整或等待失败：状态更新为 `needs_refresh`。

结果：重新授权入口不会被 `check-session` 阻塞；账号归属仍在登录完成后校验。

### 选择或切换一个已授权账号

1. 用户点击状态为 `authorized` 的账号行。
2. Renderer 调用 `selectXhsAccount(profileKey)`。
3. Main 校验无 active request。
4. Main 按 `profileKey` 读取账号；账号不存在则抛错。
5. Main 要求 `status === authorized`；否则抛错。
6. Main 直接写入 `settings.connector.xhs.selected_account = profileKey`。
7. Main 按该账号 `lastAuthorizedAt` 调度或刷新 5h 后台检测。
8. Main 返回 `valid=true` 和最新 state。

结果：选择账号不再创建 runtime，不再同步 `check-session`，交互只依赖 DB 状态。

### 直接使用当前已选账号发起任务

1. 用户发送 prompt。
2. Renderer 在 `startTurn()` 中把当前 `connectorState.selected.xhs` 作为 `xhsProfileKey` 传给 Main。
3. Main `agentStartTurn` 只要收到 `xhsProfileKey`，就调用 `ensureXhsContext(profileKey, requestId)`。
4. `ensureXhsContext` 先读取目标账号，再只校验：
   - selected 账号存在。
   - 账号 `status === authorized`。
5. Main 调用 `xhsConnector.ensureContext(account, requestId)`。
6. Runtime 创建或复用该账号 runtime，设置同账号运行锁。
7. Main 把 `cliCommand/cdpPort/targetId/profileKey/accountId/accountHandle/displayName` 写入 `request.xhsConnector`。
8. Main 调用 `agentHost.run(request)`。
9. Agent 进程通过 `buildAgentEnv()` 注入 `AGENTSTUDIO_XHS_*`。
10. Agent 进程通过 `composePrompt()` 注入小红书连接器 system reminder。
11. Agent 进程调用 Claude Agent SDK `query({ prompt, options: { env, cwd, resume, ... } })`。

结果：提交任务本身不再同步检测登录态；如果真实登录态已失效，由对应 skill 在执行小红书业务命令前的 `check-session` 前置确认拦截。

### Skill 前置确认

小红书 skills 在执行需要登录态的业务命令前，必须先运行：

```bash
$AGENTSTUDIO_XHS_CLI check-session
```

处理规则：

- 返回已登录且 `account_id` 与 `AGENTSTUDIO_XHS_ACCOUNT_ID` 一致：继续业务命令。
- 返回 `guest=true`：调用内置工具
  `xhs_account_mark_needs_refresh(reason="not_logged_in")`，把当前 Run 绑定账号更新为
  `needs_refresh`，再停止业务命令并提示用户在连接器中点击该账号重新授权。
- 返回不同 `account_id`：调用内置工具
  `xhs_account_mark_needs_refresh(reason="account_mismatch", actual_account_id="<实际账号 ID>")`。
  Main process 清理该 profile 的错误授权态并把账号更新为 `needs_refresh`，随后停止业务命令。
- 返回 `timeout`、`cdp_error`、`connect_failed`、`ensure_page_failed`、
  `read_user_info_failed`、`missing_account_id`、`no_user_info`、`check_failed` 等无法确认状态：
  不调用状态工具，不改变连接器账号状态；停止本次业务命令并说明检查失败原因。
- 离线文案、策略、草稿整理等不调用小红书业务命令的步骤，不需要前置确认。

`xhs_account_mark_needs_refresh` 不接受 `profileKey`。工具通过当前 Agent Run 的
`xhsConnector` 上下文锁定账号，Main process 再校验数据库账号与 Run 的
`profileKey/accountId` 一致，避免模型修改其他账号。状态更新统一清空该账号 selected、
停用自动复盘任务并清理后台检测 timer。工具不主动展示登录窗口；当前 Run 结束释放账号锁后，
用户点击连接器中的“需要重新授权”账号进入现有登录流程。

通过 Bash 工具运行 `check-session` 时，timeout 必须设置为 180 秒。sidecar 业务等待
`userInfo` 最多 120 秒，Main/子进程层额外保留 60 秒余量，用于覆盖 sidecar 启动、
系统校验和进程退出成本。

CLI 业务命令还有一层同页轻量保护：对会主动导航的业务命令（查询、详情、主页、评论、
点赞收藏、图文/视频发布填表和长文初始步骤），连接 CDP 后只读取当前页面
`window.__INITIAL_STATE__.user.userInfo`，不导航、不等待。如果明确读到 `guest=true`，
或读到的 `account_id` 与 `AGENTSTUDIO_XHS_ACCOUNT_ID` 不一致，则在业务动作前返回结构化
失败并停止；如果当前页没有暴露 userInfo、读取失败或缺少 account_id，则不阻断，交给
前置 `check-session` 和业务命令自身处理。发布页后续状态型命令（`click-publish`、
`save-draft`、`select-template`、`next-step`）和诊断命令不做这层保护，避免破坏当前页面
状态。

### 5h 后台静默检测

1. app 启动后扫描 `status === authorized` 的小红书账号。
2. 如果 `lastAuthorizedAt` 为空或距离当前超过 5h，立即安排后台检测；否则安排在 5h 到期时执行。
3. 任务运行中、自动化任务运行中或该账号 runtime 被锁定时，检测延后 15 分钟。
4. 后台检测调用 `xhsConnector.checkSession(profileKey)`；sidecar 最多等待 120 秒读取
   `userInfo`，Main 子进程上限为 180 秒。已授权账号检测到 `guest` 时立即返回未登录；
   其他未确认状态继续等待到业务超时。失败 JSON 必须包含 `failure_reason`，例如
   `guest`、`timeout`、`ensure_page_failed`、`read_user_info_failed`、`cdp_error`，
   超时时同时保留 `last_failure_reason`。
5. 检测结果：
   - 同一账号仍登录：保持 `authorized`，更新 `lastAuthorizedAt=now`，重新安排 5h 后检测。
   - 未登录：更新为 `needs_refresh`，清空 selected，清理该账号检测 timer。
   - 登录到不同账号：更新为 `error`，清空 selected，清理该账号检测 timer。
   - sidecar/CDP/运行时系统错误：不降级账号，15 分钟后重试。

## Auth 清理

当前不再为新增账号或重新授权清理浏览器 cache。新建账号使用新 profile，天然没有旧 cache；已有账号重新授权也不应清 cache，以免引入额外不可见副作用。

`clearAuth` 是唯一保留的授权清理能力。它清登录态，包括 cookies、localstorage、cachestorage、indexdb、serviceworkers。仅用于用户退出登录、登录完成后确认登录错账号等明确需要清授权的场景。

## 建议测试场景

- 选择 `authorized` 账号不调用 `check-session`，直接写 selected。
- 提交小红书 skill 时 Main 不调用 `check-session`，但 SDK env 包含 `AGENTSTUDIO_XHS_*`。
- 点击重新授权后窗口立即显示，不等待 `check-session`。
- 新建账号和已有账号重新授权都不清 cache。
- 5h 内账号不触发后台检测。
- 超过 5h 后，检测同账号成功会更新 `lastAuthorizedAt`。
- 超过 5h 后，检测未登录会变 `needs_refresh`。
- 超过 5h 后，检测到不同账号会变 `error`。
- 后台检测系统错误不降级账号。
- Skill 前置 `check-session` 失败时不执行业务命令，直接提示重新授权。
- Skill 明确读到 `guest=true` 时调用状态工具，账号变为 `needs_refresh`。
- Skill 读到不同 `account_id` 时调用状态工具、清理错误授权态，账号变为 `needs_refresh`。
- Skill 遇到 timeout/CDP/页面读取错误时不调用状态工具。
- 状态工具不能通过参数指定或修改其他 profile，重复调用保持幂等。

## 验证记录

本文档对应代码核对范围：

- `src/renderer/src/App.tsx`
- `src/preload/preload.ts`
- `src/main/main.ts`
- `src/main/xhs-connector.ts`
- `src/main/database.ts`
- `src/agent/agent.ts`
- `src/agent/prompt.ts`
- `resources/connectors/xhs/engine/scripts/cli.py`
- `resources/connectors/xhs/engine/scripts/xhs/login.py`
- `resources/skills/orchestrator/xhs-*`
