# 自动化运营闭环设计（content-ops-loop）

> 本文取代 `content-lifecycle-ops.md`。`content-lifecycle-ops` Skill 解散：总原则上提
> system 层，执行细节下沉各阶段 Skill。旧文档保留作历史参考。

## 背景与目标

形成 profile → 内容生产 → 互动运营 → 复盘 的自动化迭代闭环：依据账号基础信息
（profile/playbook/history）+ 当前信息（热点竞品、workspace 素材、用户输入）生成并发布内容，
再由复盘把线上数据沉淀回 playbook/history，驱动下一轮。

三个决定性事实（决定本设计）：

1. **运行形态 = 用户在 UI 里逐步驱动**（非全自动 daemon）。中心不需要扛长流程时序编排，
   `content-lifecycle-ops` 可解散。
2. **playbook/history 原为 append-only**（`content_ops_data` 仅 `appendLongTermMarkdown`）。
   这是「越迭代越中毒/无法淘汰」的根因。需要整读整写（replace）以支持规律转正/衰减、history 压缩。
3. **scheduler 并行 fire-and-forget**（`src/main/main.ts` `drainDueAutomationWork` 循环 +
   `startAutomationAttempt` 不 await）。同 tick 到期的多任务并行各开 session。所以
   「每篇发布一个 once 复盘任务」会真并发写共享文件。

## 核心原则：按「文件归属」拆写者，不按「操作类型」拆

- 单次数据 → 每个 run 独立 `run.md`/`metrics.md`，物理隔离，多写者各写各的，零争抢。
- 跨 run 聚合 → `history.md` 与 playbook 的证据规律区只有 `content-review-ops` 写；
  playbook 的「用户明示偏好」区由创作阶段按用户明确要求整段维护。

→ 零锁、零冲突。**读可分散（无副作用），写必收口到单一写者。**

### 文件归属 / 单写者表（权威）

| 文件 | 唯一写者 | 读者 |
|---|---|---|
| `profile.md` | account-profile-ops（`content_profile_patch`） | 生产/复盘各阶段（只读 `content_profile_get`） |
| `runs/{runId}/run.md` | 事务型 Run 工具按阶段推进状态（create→content_generation、publish→publication、采集→engagement/metrics、review→review） | review 聚合、create（经 `content_runs_recent`） |
| `runs/{runId}/draft.md`（初稿不可变快照） | **create**（`content_run_create_with_draft`） | review 聚合（版本对比基线） |
| `runs/{runId}/final.md`（实际发布版） | **publish**（`content_run_record_publish_result`） | review 聚合（版本对比终稿） |
| `runs/{runId}/{publish,engagement,...}.md` | 该 run 的对应阶段（publish 写 publish、采集写 engagement） | review 聚合 |
| `runs/{runId}/metrics.md` | 该 run 的采集任务（`content_run_record_collection_result`） | review 聚合 |
| `runs/{runId}/review.md` + review 阶段 | **content-review-ops**（`content_run_record_review_result`） | 后续复盘参考 |
| `playbook.md` 用户明示偏好区 | create 阶段按用户明确要求整段替换 | 生产/复盘各阶段 |
| `playbook.md` 证据规律区 | **仅 content-review-ops 聚合任务**（`content_playbook_write` replace，保留用户偏好区） | 生产各阶段（只读 `content_playbook_read`） |
| `history.md` | **仅 content-review-ops 聚合任务**（`content_history_write` replace） | 生产各阶段（只读 `content_history_read`） |

> Run 是可发布草稿/发布包的**必备记录层**：runId 由 create 阶段唯一创建。create 写 `draft`
> 冻结初稿、publish 写 `final` 实际发布版，二者构成复盘 `content_compare_versions` 的两份输入。
> review 对 Run 下证据文件（draft/final/metrics/engagement/publish）只读，仅写自己的
> `review.md` 与 review 阶段。

> publish **完全不碰 history/playbook**。「最近发了什么、未复盘」状态在 `run.md`
> （`publication=completed, review=pending`），create 经只读 `content_runs_recent` 获取。
> `run.md` 的 `stage_reasons` 是可选映射，用于记录非正常阶段的机器可读原因；旧 Run
> 缺少该字段时按空映射读取。事务型 Run 写工具通过 `stageReasons` 更新它。

### runId 规则

- **create 是 runId 唯一来源**：只要产出可发布草稿或发布包，必须创建 Run 并随发布包传递
  runId；只有局部润色、标题备选、结构建议等不形成可发布草稿/发布包的任务才允许无 Run。
- **publish 缺 runId 全跳过**：未拿到 runId 时跳过 `content_run_record_publish_result`
  与采集任务创建，只完成发布/推送本身并正常返回。
- **采集任务缺 runId 早退**：content-collect-ops 开始前 `content_run_get(runId)` 校验，
  解析失败或 Run 不存在则记录原因后早退，不写任何文件。
- **review 缺 draft/final 不中断**：版本对比前确认 `draft` 与 `final` 同时存在才调用
  `content_compare_versions`；缺任一则跳过对比并在 review 结论说明，复盘流程继续。

## 四层架构

```
system-prompt (orchestrator.yml prompt) ── 四阶段世界观 + 统计纪律（稳定、不常改）
阶段 skill ───────────────────────────── 各管一段执行；读长期数据自由，写通过事务工具收口
  account-profile-ops      → 读/patch profile
  content-research-ops     → 热点/竞品研究（不变）
  content-strategy-ops     → 选题/brief（只读 profile/playbook/history）
  xhs-create / wechat-create → 生成（只读 profile/playbook/history、runs_recent）
  xhs-publish / wechat-publish → 写本 run 的 run.md + 起 per-run 采集任务
  content-collect-ops(新)  → per-run 薄编排：路由现有 xhs-interact/xhs-explore/wechat_metrics_fetch，
                              结果写本 run 隔离文件；maxRuns 自终止
  content-review-ops(聚合) → 单例：读 metrics+history+playbook+各 run review → 整写 playbook/history
工具层 (content_ops_data) ───────────── 事务型 Run 写入 + 原子读写 + atomicWrite + 沙箱
scheduler (main + automation tool) ──── 任务=继承上下文的 agent run；singleton 由 main 管生死（Step 6，推迟）
```

## content_ops_data API 变更

保留读工具，不向 Skill 暴露物理路径（沿用 AccountRef 寻址）。旧 Run 写工具不再作为公开
MCP API 暴露，统一改为事务型写接口。

### 新增

- `content_playbook_write(account, mode: "replace", markdown)`：整写 playbook，复用现有 `atomicWrite`。
- `content_playbook_preferences_read(account)`：只读用户明示偏好区。
- `content_playbook_preferences_replace(account, markdown)`：整段替换用户明示偏好区，保留证据规律区。
- `content_history_write(account, mode: "replace", markdown)`：整写 history，支撑滚动窗口压缩。
- `content_runs_recent(account, limit)`（只读）：扫 `runs/` 读 run.md 摘要，返回近 N 条
  `{runId, 选题/标题, stages, updated_at}`。publish 不写 history 后「最近发布状态」的唯一来源。
- `content_run_create_with_draft`：创建 Run、写不可变 draft、置 `content_generation=completed`。
- `content_run_record_publish_result`：写 final/publish 并同步 publication/engagement/metrics/review。
- `content_run_record_collection_result`：追加 metrics 或写 engagement 原始采集文档并更新阶段状态。
- `content_run_record_review_result`：写 review 并更新 review 阶段。

### 退役

- `content_playbook_append`、`content_history_append`：移除。playbook/history 只由 review-ops 整写。
  （历史调用点：旧 lifecycle/review 流程；重构后无任何角色 append 这两个文件。）
- `content_run_create`、`content_run_update`、`content_run_document_write`、
  `content_run_metrics_append`：移除公开使用，内部 helper 可保留供事务工具复用。

### 不变

- `content_profile_get/patch`、`content_run_get`、`content_run_document_read`、`content_runs_recent`、
  `content_playbook_read`、`content_history_read`。

## playbook 记忆结构

用户明示偏好由创作阶段整段维护；证据规律由 review-ops 聚合任务整读整写。证据规律三段式，
每条规律带置信度元数据：

```markdown
---
updated_at: 2026-06-15T...
---
# 运营 Playbook

## 用户明示偏好
- 用户明确要求长期遵循的创作风格、结构、禁区或 CTA 习惯。

## 生效规律 (validated)
### R-001 标题带数字提升点击 [confidence:high | samples:5 | since:2026-03 | last_confirmed:2026-06-10]
- 证据: run 202603011200、202604051030…（5 篇同向）
- 适用: 平台级

## 候选规律 (candidate)
### C-012 长图文互动更高 [samples:2 | first_seen:2026-06-01]
- 证据: run 202606011000、202606081000

## 已退役 (deprecated)
### R-003 ~~周末发布更好~~ [retired:2026-06 | reason:近 10 篇反向]
```

### 复盘纪律（写进 content-review-ops/SKILL.md）

- 单篇数据只能 `samples+1` 更新 candidate，**不得直接进 validated**。
- candidate 达 **N=3** 篇同向 → 转正 validated；validated 出现 **K** 篇反向 → 降级/退役；
  validated >90 天未确认 → 标记待复核（衰减）。
- 区分**平台级规律**（标题/时段，可复用，进 playbook）与**内容级判断**（选题好坏，不可迁移，不进 playbook）。
- 与 profile 冲突 → 不写 playbook，只在该 run 的 review 文档记录冲突（profile 最高优先级）。
- 因证据不足未转正时显式 `log`，便于观察阈值。

## history 滚动窗口结构

由 review-ops 聚合任务整写。近期明细 + 整体摘要，老条目折叠不丢长期信号：

```markdown
---
total_runs: 47
---
# 历史索引

## 整体摘要（累计；超窗口的老条目浓缩至此）
- 累计 47 篇，平均互动 …，最佳方向 …

## 近期明细（最多 30 篇 / 3 个月）
### 202606141230 - 标题 [status | 指标摘要 | 复盘摘要]
```

复盘时：从 `run.md`/`metrics.md` 生成/补齐该 run 条目；超窗口老条目折叠进「整体摘要」，
用 `content_history_write(replace)` 整写。

## 任务形态

| 任务 | 形态 | 触发 | 写什么 | 终止 |
|---|---|---|---|---|
| per-run 采集（互动+指标） | `once`/`interval`+`maxRuns` | **publish 发布成功后** `automation_task_create`，`selectedSkills=[content-collect-ops]` | 仅本 run 隔离文件 | maxRuns 自终止 |
| 聚合复盘 | 账号级单例 `daily` | **main 按账号自动复盘开关**幂等创建；任务 ID 保存在账号 `ops_state.review_task_id` | playbook/history（单写者） | 关闭账号开关、账号删除或登录失效时停用 |

> per-run 采集任务并行安全（各写各 run.md）。聚合单例永不自我并发 → 共享文件单写者 → 无锁。
> per-run 采集只回收指标和评论数据，不自动执行评论、回复、点赞、收藏等真实互动。
> 注意同一 run 的评论采集与指标任务错开时间或写不同文档，避免同时写同一 run.md。

## 各 Skill 边界改造

- **xhs-create / wechat-create**：只要产出可发布草稿/发布包，就用
  `content_run_create_with_draft` 创建 Run 并持有 runId；runId 随发布包向下传递。用户明确提出
  可长期复用的创作偏好时，用 playbook preferences 工具整段维护用户明示偏好区。
- **xhs-publish / wechat-publish**：收到 runId 时用 `content_run_record_publish_result` 写
  `final.md`（实际发布版）+ `publish` 文档 + 发布后阶段状态 + 起 per-run 采集任务。
  **没有 runId 时全部跳过，只完成发布本身。不碰 history/playbook；不创建聚合 singleton。**
- **XHS 发布完成门槛**：仅当平台业务码成功且返回 `note_id` 时成立。用
  `content_run_record_publish_result` 一次写包含 note ID、URL、平台确认时间的 publish 证据、
  final 证据和阶段状态，最后创建采集任务。
  `ACCOUNT_RESTRICTED` 等确定失败将 `publication` 置为 `failed`；结果确认超时保持 `pending`，
  原因记为 `timeout`。两类情况都将发布后阶段置为 `skipped`，且不得创建采集任务或自动重试。
- **content-collect-ops（薄编排）**：开始前 `content_run_get(runId)` 校验，失败早退。
  per-run 统一入口，路由到现有 `xhs-explore`（XHS 公开互动数和评论数据）、
  `wechat_metrics_fetch`（公众号指标）——**不复制其子命令与风控约束**；只负责把结果写进本 run
  `metrics.md`/`engagement` 和对应阶段状态，不执行真实互动。公众号接口权限、凭据、IP 白名单、
  统计门槛或网络失败时记录非敏感错误并将指标阶段置为 `failed`；成功但无数据或无法匹配时
  置为 `skipped`，不得把缺失解释为零或低表现。
- **content-review-ops（改聚合单例角色）**：读 metrics+各 run 证据（draft/final/engagement）+
  history+playbook → 执行转正/衰减 + history 压缩 → 整写证据规律区/history。
  **全系统唯一证据规律与 history 写者。** 对 run 下证据文件只读；只写自己的 `review.md` 与 review 阶段。
  `content_compare_versions` 在 draft+final 同时存在时调用，缺任一则跳过、不中断复盘。
- **create/strategy 系列**：显式声明只读 profile/playbook/history/`content_runs_recent`。
- **content-lifecycle-ops**：删除（含 references；总原则上提 orchestrator.yml）。

## system 层世界观（orchestrator.yml prompt）

注入四阶段闭环心智（profile→生产→互动→复盘）+ 三条铁律：
① 写收口/读分散 ② 单篇数据不转正、profile 优先 ③ 不编造指标。

## 能力保留（零丢失红线）

| 能力 | 现在 | 重构后 |
|---|---|---|
| XHS 互动（评论/回复/点赞/收藏） | xhs-interact | 原样保留，被采集任务复用 |
| XHS 公开互动数采集 | xhs-explore | 原样保留，被采集任务复用 |
| 公众号指标采集 | wechat_metrics_fetch | 工具不变，被采集任务复用 |
| 版本变化分析 | content_compare_versions | 工具不变，review 复用；**依赖 create 写 `draft.md` + publish 写 `final.md`**；两者缺任一时跳过对比、不中断复盘 |
| 历史语料分析 | content_analyze_corpus | 工具不变，review 复用 |
| 复盘结论/规则 | content-review-ops | 改聚合角色，分析能力不减 |
| 公众号互动 | 未实现，记 skipped | 仍 skipped（非丢失） |

## 已知风险

1. 聚合任务与前台手动复盘可能并发写 playbook：`atomicWrite` 不损坏，但可能丢更新。v1 接受；
   后续可加版本号乐观锁。
2. 转正阈值 N=3 是经验值，靠 review log 观察后调。
3. 同一 run 多个采集任务并发写 run.md：靠错开调度或写不同文档规避。

## 分期

- 本次：Step 0 spec + Step 1 工具 + Step 2 playbook 结构 + Step 3 history 结构 +
  Step 4 各 skill 重接线 + Step 5 orchestrator 世界观。
- Step 6：main 按账号“自动复盘”开关启停聚合 singleton；账号表 `ops_state` 只保存
  `review_task_id`，开关状态由关联任务 `enabled` 派生。

## 测试用例设计

1. `content_playbook_write(replace)` 整写覆盖；读回一致；沙箱拒绝越权路径。
2. `content_history_write(replace)` 压缩后再读：近期明细裁剪 + 整体摘要保留，total_runs 正确。
3. `content_runs_recent(limit)` 返回近 N 条 run 摘要，按时间倒序，含 stages。
4. 退役工具：`content_playbook_append`/`content_history_append` 不再注册。
5. 并发：并行写两个不同 run.md → 两文件都正确（隔离）。
6. 闭环 e2e（不 mock）：profile→create(读 playbook)→publish(只写 run.md+起采集任务)→
   采集写 metrics→聚合从 run.md/metrics 生成 history 条目 + 转正→playbook 出现 validated +
   history 出现该 run→下一轮 create 读到该规律。
7. 规律生命周期：候选→3 篇同向转正→反向退役，元数据正确。
8. history 全程只被 review-ops 写（publish 不产生 history 变更）。
9. orchestrator 仍正确挂载 content_ops_data；现有 profile/run 行为不回归。
