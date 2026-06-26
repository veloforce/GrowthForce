# 小红书连接器设计

## 目标

将 `xiaohongshu-skills` 集成到 GrowthForce，作为小红书账号连接器和业务 Skill 能力。账号态由 Electron 原生运行时管理，搜索、发布、互动、复合运营由内置 Skill 调用连接器 CLI 完成。

## 运行模型

- 默认浏览器 profile 继续使用 `~/.agentstudio/user-profile/default`。
- 小红书连接器使用独立 profile：`~/.agentstudio/user-profile/connectors/xhs/default`。后续多账号时按 `~/.agentstudio/user-profile/connectors/xhs/<profile_key>` 扩展。
- Main process 为每个小红书账号创建独立 Electron 登录/运行窗口，并通过 Electron remote debugging 获取该窗口页面的 `targetId`。
- 小红书登录扫码页使用独立窗口展示，不占用工作台右侧 default 浏览器面板。
- 小红书连接器 profile 只持久化账号态；Electron session 禁用磁盘 HTTP cache，并通过 Chromium flag 禁用 Shared Dictionary 压缩字典缓存。创建 runtime 前允许清理 Chromium 可重建 cache 目录（如 `Cache`、`Code Cache`、`GPUCache`、`Shared Dictionary`），不得清理 Cookie、Local Storage、IndexedDB 等登录态数据。
- 小红书 CLI 只以 Electron CDP 模式运行，使用 Main 注入的 `cdpPort` 和 `targetId` 连接同一个页面；缺少 CDP env 时必须报错，不得回退 Extension Bridge。
- dev 默认使用仓库内 `resources/connectors/xhs/bin/<platform>/<arch>/xhs-cli/<executable>` sidecar，其中 macOS executable 为 `xhs-cli`，Windows executable 为 `xhs-cli.exe`。
- packaged macOS 使用 `<App>.app/Contents/Resources/resources/connectors/xhs/bin/<platform>/<arch>/xhs-cli/xhs-cli`，packaged Windows 使用 `<App>/resources/resources/connectors/xhs/bin/win32/x64/xhs-cli/xhs-cli.exe`。
- 小红书 sidecar 使用 PyInstaller `--onedir` 打包，不再支持旧 `--onefile` 单文件路径；App 升级时由安装包 resources 替换整目录，CLI 启动时不得重复解压临时目录。
- 只有显式设置 `AGENTSTUDIO_XHS_ALLOW_SOURCE_CLI=1` 时，dev 才允许回退源码 `cli.py`；源码调试必须通过 `AGENTSTUDIO_PYTHON` 指向 Python >= 3.11 且已安装 `websockets`。
- 不加载 Chrome 扩展，不依赖外部 Chrome、用户全局 Python、uv 或开发机上的源码路径。

## 资源布局

- `resources/connectors/xhs/engine` 保存 vendor 后的小红书 Python 自动化引擎。
- `resources/skills/orchestrator/xhs-create`、`xhs-publish`、`xhs-explore`、`xhs-interact` 保存阶段业务 Skill。
- 不内置 `xhs-auth` Skill；登录、状态检查、退出登录由原生连接器承担。

## Agent 集成

当本轮请求携带小红书账号 `profileKey`，且 DB 中该账号为 `authorized` 时，Main process 按该账号懒创建或复用小红书 CDP runtime，并向 Agent process 注入 CLI 与 Electron CDP env。是否注入不再依赖本轮选择的小红书 Skill name：

- `AGENTSTUDIO_XHS_CLI`
- `AGENTSTUDIO_XHS_CDP_PORT`
- `AGENTSTUDIO_XHS_TARGET_ID`
- `AGENTSTUDIO_XHS_PROFILE_KEY`
- `AGENTSTUDIO_XHS_PROCESS_REGISTRY_DIR`
- `AGENTSTUDIO_XHS_ACCOUNT_ID`
- `AGENTSTUDIO_XHS_ACCOUNT_HANDLE`
- `AGENTSTUDIO_XHS_DISPLAY_NAME`

Skill 必须通过 `$AGENTSTUDIO_XHS_CLI <子命令>` 调用 CLI，不得启动外部 Chrome 或 Chrome 扩展 Bridge，也不得显式传入 `--runtime`、`--cdp-port`、`--target-id`。Python CLI 从 env 读取真实 CDP target，缺少 `AGENTSTUDIO_XHS_CDP_PORT` 或 `AGENTSTUDIO_XHS_TARGET_ID` 时直接失败。

## CLI 进程清理

- `xhs-cli` 在 Agent turn 中运行时，读取 `AGENTSTUDIO_AGENT_REQUEST_ID` 和 `AGENTSTUDIO_XHS_PROCESS_REGISTRY_DIR`，将当前进程登记到 `~/.agentstudio/runtime/xhs-cli-processes/`。
- registry 文件只保存可删除运行态：`pid`、`requestId`、`profileKey`、`targetId`、`startedAt`、`argv`。不得放入 `user-data` 或账号 profile 目录。
- `xhs-cli` 正常退出时删除自己的 registry 文件；启动时可清理同一 `requestId` 下已经不存在的 stale PID。
- 用户取消 turn 时，Main process 必须先按 `requestId` 扫描 registry 并终止匹配的 `xhs-cli` 进程，再释放小红书账号锁。
- registry 清理只匹配精确 `requestId`，不得影响其他正在运行的 turn 或其他账号。

登录窗口的系统关闭按钮只隐藏窗口，不销毁该账号 runtime 或 CDP target，也不取消当前 `wait-login`；等待会继续到登录成功或超时结束。只有删除账号、应用退出、idle dispose 等 Main process 内部释放路径才真正关闭窗口并移除 runtime；删除账号还必须删除该账号 profile 目录并取消 pending `wait-login`。
关闭登录窗口后，Renderer 仍保持连接器面板 busy 状态，直到 `wait-login` 返回成功或超时；再次点击当前授权中的账号只重新显示登录窗口，不启动第二个 `waitLogin`。

## 创作中心发布页会话与结果判定

- `check-session` 只校验主站账号，本轮不扩展其职责。
- `fill-publish` 打开创作中心后，不以 `document.readyState=complete` 作为唯一就绪条件。发布页目标
  tab 和图文上传控件可用即可继续。
- 创作中心首次返回 401 并跳转 `/login` 时，允许页面利用现有账号态自行完成 CAS 跳转；最多等待
  30 秒。只有本次导航观察到 `/api/galaxy/user/info` 返回 200、回到发布页且发布组件可用时
  才继续，避免误用旧页面残留 DOM；出现短信、扫码、验证码且未自动恢复，或超时则返回明确
  会话失效错误。CLI 不主动请求或伪造 CAS ticket。
- 图片上传必须定位当前图文面板内、`accept` 支持图片的 input。相同文件重试前清空 input，避免
  浏览器因值未变化而不触发上传。
- 图片上传完成使用图文预览/编辑表单可用状态组合判定，不只依赖单个历史 CSS selector。
- `click-publish` 以 CDP Network 响应为主证据，页面 hook 和 `published=true` 跳转为辅助证据。
  当前发布接口 `/web_api/sns/v2/note` 的成功结构为 `result=0`、`success=true`、`data.id` 和
  `share_link`；旧结构 `code=0`、`note_id` 继续兼容。
- CDP websocket 必须由单 reader 分发命令响应与异步事件，禁止命令等待过程直接丢弃 Network
  事件。明确响应优先；仅出现 `published=true` 而未拿到笔记 ID 时仍按结果未知处理，交给上层
  异步回补，禁止自动重复点击。
- `published=true` 无响应使用独立原因 `published_redirect_without_response`。上层以 accountId、
  runId 和 attempt key 幂等创建 30 秒、2 分钟、5 分钟三个一次性回补任务；任务只查询本人主页
  最近笔记并修正 Run，绝不重新发布。唯一匹配才完成，多候选或无匹配保持 pending。

## 测试场景

- Skill discovery 能加载 4 个小红书业务 Skill。
- 小红书 profile 路径固定为 `~/.agentstudio/user-profile/connectors/xhs/default`。
- 请求未携带小红书账号时，不创建小红书 runtime。
- 请求携带已授权小红书账号时，即使本轮未选择小红书 Skill，也能复用或创建 runtime 并注入 CLI/CDP env。
- 小红书 CLI 能用 Electron CDP target 执行 `check-login` 并返回 JSON。
- 真实账号验收：扫码登录、搜索、填充发布表单、确认发布。
- 创作中心 401 后能在页面自行完成 CAS 跳转时，30 秒内恢复并继续填表；需要人工登录时快速失败。
- 同一路径图片重试仍会触发上传，图文预览 selector 变化时不会误判为网络超时。
- 发布接口返回 `result=0 + data.id` 时能从 CDP Network 响应确认成功，不因页面跳转误报超时。
- 授权验收：扫码/验证码登录后从 `window.__INITIAL_STATE__.user.userInfo` 拿到当前登录账号的 `userId`、`redId`、`nickname` 后才关闭登录窗口并标记已授权；`guest=true` 必须判定为未登录，头像暂不采集；`check-session` 登录失败时必须在 JSON 中返回 `failure_reason`，用于区分 `guest`、`timeout`、CDP 连接失败、读取 userInfo 失败等原因。
