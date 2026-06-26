# 连接器账号与多 Profile 设计

## 目标

在对话框左下角 `+` 按钮旁增加连接器入口，让用户可以为当前对话选择平台账号。当前支持小红书和公众号，后续扩展抖音等连接器。

核心约束：

- 一次对话中，每个连接器平台最多选择一个账号。
- 不同平台可以同时选择，例如“小红书 A + 公众号 B”。
- 当前选中的小红书和公众号账号分别保存到 `~/.agentstudio/settings.yml` 的 `connector.xhs.selected_account` 与 `connector.wechat.selected_account`。
- 账号选择是全局默认；同一个 session 下一轮提交使用发送时最新选中的账号。
- 多账号必须隔离登录态、运行态和自动化 target，避免误用账号。

## UI 交互

Composer 左下角控件顺序建议为：

1. `+` 添加入口。
2. 连接器按钮。
3. 项目目录选择。
4. 权限模式。
5. 发送按钮。

连接器按钮行为：

- 未选择账号时显示连接器图标和空状态。
- 已选择账号时显示已选状态，例如 `小红书 · 昵称` 或已选平台数量。
- 点击后打开连接器弹层。
- Agent 运行中禁止切换、添加、删除连接器账号，避免 UI 状态和本轮执行上下文不一致。

连接器弹层内容：

- 平台列表包含小红书、公众号、抖音。
- 首次发布仅启用小红书；公众号能力暂未完成发布前验证，和抖音一样先展示禁用态或“即将支持”。
- 小红书区域展示多个账号行：昵称、账号 id、授权状态、是否为当前对话选中账号。
- Composer 连接器弹层只承担添加、选择和取消选择。账号删除、自动复盘和完整信息统一放在“账号设置 > 连接器设置”。
- 账号行不显示独立状态圆点，通过账号区域色块表达授权状态，通过勾选和品牌强调表达选中状态。
- 小红书账号尚未读取到昵称、小红书号和账号 ID 时，展示名使用 `xhs_` 加 profile key 后续前 4 位；完整 `profileKey` 仅用于内部状态和 IPC 参数。
- “添加账号”入口沿用工作目录“选择目录”的中性菜单项样式，默认使用弹层底色，不使用品牌色块。
- 未授权账号显示 `授权`。
- 点击 `授权` 后打开独立扫码登录窗口，不占用工作台右侧 default 浏览器面板。
- 登录成功后等待拿到小红书昵称和账号 id，再回到连接器弹层并刷新该账号信息。
- 同一平台选择新账号时，替换当前对话原有账号，不允许同平台多选。
- 公众号能力恢复后，点击“添加账号”使用弹窗填写昵称、`WECHAT_APPID`、`WECHAT_SECRET`；保存后直接标记为已授权并自动选中，不执行浏览器授权或微信 API 连通性检查。
- 公众号配置不支持编辑；需要修改时先删除再重新添加。

连接器设置：

- 设置侧栏将“其他设置”替换为“连接器设置”，内容区使用小红书、公众号、抖音三个平台 Tab。
- 小红书账号展示昵称、小红书号、登录状态、自动复盘开关和删除操作。
- 公众号账号展示昵称、APPID、APPSECRET、自动复盘开关和删除操作。
- 抖音 tab 首次发布只保留空态占位，不支持添加账号。
- 自动复盘不持久化独立布尔状态；账号 `ops_state.review_task_id` 只保存关联任务 ID，
  开关由关联定时任务是否存在且启用派生。
- APPSECRET 默认隐藏，用户主动点击后通过独立 IPC 按账号读取；常规连接器状态、日志和 prompt 均不得包含密钥。
- 小红书和公众号账号均按 `created_at DESC` 固定排序，复盘配置和状态更新时间不影响位置。
- Composer 和连接器设置中的账号列表使用独立滚动区域，账号过多时不撑高弹层。
- Composer 连接器二级弹层保持紧凑密度，宽度不超过 232px，账号行高度控制在约 44px。
- 公众号 APPID 和 APPSECRET 支持复制；隐藏状态复制 APPSECRET 时按需读取但不自动显示。
- 隐藏密钥、切换平台或关闭设置弹窗时，Renderer 清除已读取的明文。
- 删除账号必须经过二次确认。确认文案说明登录信息和自动复盘任务会一并清除；删除当前选中账号只清除对应平台选择。

## 数据模型

新增通用连接器账号表：

```sql
CREATE TABLE connector_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  account_id TEXT,
  account_handle TEXT,
  display_name TEXT,
  avatar_url TEXT,
  credential_secret TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_authorized_at TEXT
);
```

字段含义：

- `platform`：连接器平台，例如 `xhs`、`wechat`、`douyin`。
- `profile_key`：本地稳定 profile 标识，用于生成独立 profile 目录。
- `account_id`：平台内部稳定账号 id。小红书下对应 `/user/profile/<id>` 的 `id`，用于去重和登录态串号检测。
- `account_handle`：平台面向用户展示的账号号。小红书下对应小红书号 `redId`，用于 UI 展示和业务上下文，不作为去重主键。
- `display_name`：平台账号昵称或公众号名称。
- `avatar_url`：平台账号头像。
- `credential_secret`：API 型连接器凭据。公众号下明文保存 `WECHAT_SECRET`，只能由 Main process 读取，不得返回 Renderer、写入日志或 prompt。
- `status`：`unauthorized`、`authorizing`、`authorized`、`needs_refresh`、`error`。

当前版本不在 `sessions` 表保存连接器选择；全局选中账号写入 settings：

```yaml
connector:
  xhs:
    selected_account: xhs_profile_key
  wechat:
    selected_account: wechat_profile_key
```

语义：

- `selected_account` 存 `connector_accounts.profile_key`。
- 运行中禁止切换。
- 如果选中账号被删除或退出授权，settings 中的选中值会被清空。
- Renderer 使用 Main process 返回的 `ConnectorState` 作为设置页、Composer 和自动化表单的统一账号状态。
- `ConnectorState.accounts: []` 是“当前没有账号”的有效权威状态；只有状态尚未初始化时才允许使用 bootstrap 快照，账号删除或刷新后的空列表不得回退到旧快照。

## 多 Profile 隔离

不能使用全局“当前账号”或全局“当前 CDP target”。隔离边界必须放在账号 runtime 上。

新增小红书 runtime manager：

```ts
XhsConnectorRuntimeManager.ensureContext(account, requestId);
```

每个账号 runtime 独立维护：

- `platform`
- `profileKey`
- `accountId`
- `accountHandle`
- `displayName`
- `targetId`
- `cdpPort`
- `cliCommand`（需要 CLI 时）
- 运行锁
- idle timer

runtime 是内存对象，只在需要时懒创建；磁盘 profile 持久保存登录态。turn 结束后释放锁并记录内存态 `lastReleaseTime`，按 2 小时减 1 分钟的阈值调度 idle 清理；timer 触发时必须重新计算 `lastReleaseTime` 到当前时间的间隔，未达到阈值则按剩余时间重排，达到阈值才销毁小红书登录/运行窗口和内存 runtime。app 重启后 runtime 自然销毁，下次使用同一 profile 重新创建 target。

小红书 profile 路径从当前单账号默认 profile：

```text
~/.agentstudio/user-profile/connectors/xhs/default
```

调整为多账号 profile：

```text
~/.agentstudio/user-profile/connectors/xhs/<profile_key>
```

公众号如果采用 API 型连接器，可以没有 CDP target，只维护 credential/profile metadata。若未来公众号或抖音也采用浏览器自动化，则同样为每个账号创建独立 `profilePath + targetId`。

公众号账号使用 `account_id` 保存 `WECHAT_APPID`、`display_name` 保存昵称并同时作为
`WECHAT_AUTHOR`、`credential_secret` 保存 `WECHAT_SECRET`。相同 APPID 不允许重复
创建；账号状态始终为 `authorized`。

## CDP Target 协同

多账号切换不是“切换全局 target”，而是 Main 在每个 turn 开始时按 settings 当前选中账号懒创建 runtime，并通过 env 注入当前账号 target。

小红书账号 A：

```json
{
  "platform": "xhs",
  "accountRef": "xhs-account-a",
  "profilePath": ".../user-profile/connectors/xhs/xhs-account-a",
  "runtime": "electron-cdp",
  "cdpPort": 45123,
  "targetId": "target-a"
}
```

小红书账号 B：

```json
{
  "platform": "xhs",
  "accountRef": "xhs-account-b",
  "profilePath": ".../user-profile/connectors/xhs/xhs-account-b",
  "runtime": "electron-cdp",
  "cdpPort": 45123,
  "targetId": "target-b"
}
```

两个账号可以共用 Electron remote debugging port，但必须使用不同 Electron window/session 和不同 `targetId`。Skill 只调用 `$AGENTSTUDIO_XHS_CLI <业务子命令>`，不能传 runtime/cdp/target 参数。Python CLI 从 env 读取 `AGENTSTUDIO_XHS_CDP_PORT` 和 `AGENTSTUDIO_XHS_TARGET_ID`。

## Skill 与 Agent 集成

`agentStartTurn` 读取 settings 中当前选中的小红书账号，并在 Main process 中解析为 runtime context。Agent process 注入 env：

- `AGENTSTUDIO_XHS_CLI`
- `AGENTSTUDIO_XHS_CDP_PORT`
- `AGENTSTUDIO_XHS_TARGET_ID`
- `AGENTSTUDIO_XHS_PROFILE_KEY`
- `AGENTSTUDIO_XHS_PROFILE_PATH`
- `AGENTSTUDIO_XHS_ACCOUNT_ID`
- `AGENTSTUDIO_XHS_DISPLAY_NAME`

Skill 约束：

- 小红书 skill 只调用 `$AGENTSTUDIO_XHS_CLI <业务子命令>`。
- 公众号 skill 只读取本轮选中公众号连接器注入的 `WECHAT_APPID`、`WECHAT_SECRET`、
  `WECHAT_AUTHOR`。
- 禁止 skill 依赖全局 `CURRENT_CONNECTOR_TARGET_ID` 这类变量。
- 禁止 skill 传入 `--runtime`、`--cdp-port`、`--target-id` 或 `--bridge-url`。
- 长期统一使用 `AGENTSTUDIO_CONNECTORS_JSON` 注入所有连接器上下文。

选择连接器表示“本轮如果触发小红书 skill，就使用该账号”。当前实现仅在选中小红书 skill 时注入小红书 env；没有已授权选中账号时，发送前拦截。

## 运行锁

按 `{ platform, accountRef }` 加运行锁。

- 同一个小红书账号同一时间只能有一个自动化操作。
- 小红书 A 和公众号 B 可以并行，因为 runtime 独立。
- 小红书 A 和小红书 B 可以并行，前提是它们使用不同 profile 和不同 target。
- 如果同账号忙碌，MVP 推荐直接返回明确错误，后续再考虑队列。
- 添加账号登录完成后，如果 `account_id` 已存在，则删除本次新建 connector account 记录，销毁新 runtime，清理新 profile 目录，并自动选中已有账号。

## 小红书账号信息补齐

当前小红书 `check-login` 只返回 `logged_in`，不足以支撑多账号 UI。

需要补充 CLI 能力：

- 新增 `account-info`，或扩展 `check-login` / `wait-login`。
- 已登录时返回：

```json
{
  "logged_in": true,
  "account_id": "xhs_profile_id",
  "account_handle": "xhs_red_id",
  "nickname": "小红书昵称",
  "avatar_url": ""
}
```

- 未登录时返回：

```json
{
  "logged_in": false
}
```

授权完成后必须从 `window.__INITIAL_STATE__.user.userInfo` 拿到 `account_id`、`account_handle` 和 `nickname` 才能标记账号为 `authorized`。`avatar_url` 暂不采集，固定允许为空，避免从首页笔记或当前浏览个人页取错头像。如果拿不到完整账号资料，账号保持 `needs_refresh`，登录窗口不自动关闭。

## 测试场景

- 同一平台多次选择只保留最后一个账号。
- 不同平台账号选择可以共存。
- 对话创建时保存当前连接器选择。
- 打开历史对话时恢复该对话连接器选择。
- 小红书两个账号生成不同 profile 目录。
- 不同小红书账号拥有不同 CDP target。
- 小红书 skill 只读取小红书连接器上下文。
- 公众号 skill 只读取公众号连接器上下文。
- 选中小红书账号但未选择小红书 skill 时，Agent 仍能拿到小红书连接器上下文。
- 未授权账号、账号不存在、账号忙碌时，发送前明确拦截。
- 退出账号 A 不影响账号 B。
