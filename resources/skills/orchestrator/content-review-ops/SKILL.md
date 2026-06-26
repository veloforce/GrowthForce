---
name: content-review-ops
agent: orchestrator
description: |
  平台无关的内容复盘聚合技能。回收指标、解释表现、维护长期 playbook（规律转正/衰减）
  和 history（滚动窗口）。当用户要求数据复盘、效果总结、历史沉淀或定时复盘聚合时触发。
version: 2.0.0
---

# 内容复盘（聚合角色）

本 Skill 是**全系统唯一的证据规律与 `history.md` 写者**。只有存在实际指标或用户明确反馈
证据时，才能沉淀长期规律。`playbook.md` 中的「用户明示偏好」区可由创作阶段按用户明确
要求整段维护；本 Skill 整写证据规律时必须保留该区。

## 输入

1. 待复盘的 Run：用 `content_runs_recent` 找出 `publication=completed` 且 `review=pending`
   或指标已更新的 Run，逐个用 `content_run_get`、`content_run_document_read` 读取
   `draft`/`final`/`publish`/`engagement` 与 `metrics` 等证据。
2. 长期数据：`content_profile_get`（最高优先级）、`content_playbook_read`、`content_history_read`。
3. 可选分析证据：用户修改/版本对比用 `content_compare_versions`，历史语料用 `content_analyze_corpus`。

## 账号定位 Gate

调用 `content_profile_get` 后，Profile 已有信息足以完成本轮任务时直接使用。Profile 缺失或
缺少本轮复盘必需字段时，遵循选中账号 system reminder 中统一的 Profile 缺失处理规则。
Profile 缺失不是复盘硬失败；本 Skill 只读 Profile，不直接写入，需要持久化用户补充的信息
时交给 `account-profile-ops`。

> **对 Run 证据文件只读**：本 Skill 对 Run 下的证据文件（`draft`/`final`/`metrics`/
> `engagement`/`publish`）一律只读，绝不改写。本 Skill 在 Run 内能写的只有自己的 `review`
> 文档和 `review` 阶段状态；跨 Run 的沉淀只写证据规律区与 `history.md`。

## 复盘流程

1. **解释**：区分事实、解释和建议，对每个 Run 形成表现解释；把结论用
   `content_run_record_review_result` 写入该 Run，并将其 `review` 阶段置为 `completed`。
   不编造缺失指标，不把相关性表述为因果。
   - 默认用 `mode="replace"` 写入该 Run 当前最新的完整复盘结论。
   - 如果同一 Run 因后续指标更新进行例行增量复盘，且需要保留上次结论，使用 `mode="append"`
     追加带日期的小节。
   - 做版本对比前先确认该 Run 同时存在 `draft` 与 `final` 文档：两者齐备才调用
     `content_compare_versions`；缺任一则**跳过对比**，在 review 结论中记明「无初稿/终稿，
     无法做版本对比」，不因此中断复盘流程。
2. **更新 playbook 证据规律（整读整写）**：按下方纪律更新候选/生效/退役规律，用
   `content_playbook_write(mode="replace")` 整体写回；工具会保留「用户明示偏好」区。
3. **更新 history（整读整写）**：按下方滚动窗口结构补齐/压缩，用
   `content_history_write(mode="replace")` 整体写回。

## playbook 记忆结构与纪律

playbook 分三段，每条规律带元数据。**判断由你完成（这条证据是否同向），计数与阈值是
机械纪律，必须严格执行，不得擅自放宽：**

```markdown
## 用户明示偏好
- 用户明确要求长期遵循的创作风格、结构、禁区或 CTA 习惯。

## 生效规律 (validated)
### R-001 标题带数字提升点击 [confidence:high | samples:5 | since:2026-03 | last_confirmed:2026-06-10]
- 证据: run 202603011200、202604051030…（5 篇同向）
- 适用: 平台级

## 候选规律 (candidate)
### C-012 长图文互动更高 [samples:2 | first_seen:2026-06-01]

## 已退役 (deprecated)
### R-003 ~~周末发布更好~~ [retired:2026-06 | reason:近 10 篇反向]
```

纪律：

- 单篇数据只能让候选规律 `samples+1`，**不得直接进 validated**。
- 候选规律累计达 **N=3** 篇同向证据 → 转正为 validated，记录支撑 runId 与 since。
- validated 规律出现 **K=2** 篇明确反向证据 → 降级回 candidate 或退役，记录 reason。
- validated 规律 `last_confirmed` 超过 **90 天**未被新证据确认 → 标记待复核（衰减）。
- 只沉淀**平台级规律**（标题、时段、结构等可跨内容复用的）；**内容级判断**（某个选题好不好）
  不可迁移，不进 playbook。
- 不改写或删除「用户明示偏好」区；如果偏好与证据规律冲突，复盘只能在 review 中说明冲突，
  不得用数据规律覆盖用户明示偏好。
- 规律与 Profile 冲突时**不写 playbook**，只在该 Run 的 review 文档记录冲突（Profile 最高优先级）。
- 因证据不足而未转正/未退役时，在复盘结论中明确说明，便于观察阈值是否合理。

## history 滚动窗口结构

```markdown
---
total_runs: 47
---
## 整体摘要（累计；超窗口的老条目浓缩至此，长期信号不丢）
## 近期明细（最多 30 篇 / 3 个月）
### 202606141230 - 标题 [status | 指标摘要 | 复盘摘要]
```

- 为本次复盘的 Run 在「近期明细」生成或补齐条目（状态、指标摘要、复盘摘要）。
- 「近期明细」超过 30 篇或 3 个月的老条目，浓缩其关键信号后并入「整体摘要」，再从明细移除。
- 更新 frontmatter `total_runs`。

## 边界

- 不编造缺失指标，不把相关性表述为因果。
- Profile 与历史规律冲突时以 Profile 为准。
- 对 Run 下的证据文件只读；在 Run 内只写自己的 `review` 文档与 `review` 阶段状态。
- 本 Skill 是证据规律区与 `history.md` 的唯一写者；不执行发布、互动或内容生成。
- 指标抓取与互动执行由 `content-collect-ops` 在 per-run 采集任务中完成，本 Skill 只消费其结果。
