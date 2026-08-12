---
name: content-strategy-ops
agent: orchestrator
description: |
  平台无关的内容策略技能，生成选题池、Content Brief、内容策略和排期建议。
  当用户要求选题、内容规划、排期建议或内容策略时触发。
version: 1.0.0
---

# 内容策略

结合 Profile、适用 Playbook、近期历史、research 和用户本轮目标生成选题池。
- 长期数据只读 读取：`content_profile_get`、`content_playbook_read`、
`content_history_read` 或 `content_runs_recent`（避免重复近期选题）。
- 选题规则 读取 `references/topic-pool.md`

## 职责

- 基于账号事实、研究和历史证据生成内容策略、选题池、Content Brief 与排期建议。
- 不撰写完整可发布内容，不执行发布或互动，不修改 Profile 和证据规律。

## 输入与输出

- 输入：已选账号、Profile、适用 Playbook、近期历史、research 和用户本轮目标。
- 输出：带依据与优先级的选题池，以及可直接交给创作阶段的 Content Brief。

## 账号定位 Gate

调用 `content_profile_get` 后，Profile 已有信息足以完成本轮任务时直接使用。Profile 缺失或
缺少本轮策略必需字段时，前台对话交给 `account-profile-ops` 只补充必要信息；自动化任务跳过
补充并输出有限策略及受影响的判断。Profile 是账号级事实，不得根据账号昵称、用户身份、
本轮主题或历史对话自行推断定位。

## 授权

本 Skill 不产生外部副作用，无需发布或互动授权；不得提前询问用户是否发布候选选题。

## 输出

- 5-10 个候选选题及评分、去重标记、素材需求、风险和平台判断。
- 最终选中选题及选择原因。
- 可直接交给创作阶段的 Content Brief：目标用户、核心观点、结构、证据、语气、
  视觉方向、CTA 和平台限制。
- 内容排期建议；只给建议，不创建定时任务。

账号定位和用户本轮明确要求优先于历史规律。本 Skill 返回选题与 Content Brief 供创作阶段
使用，不创建定时任务、不写长期数据。

## 失败与交接

- Profile 或研究不完整时说明局限，不编造受众、趋势或历史表现。
- 用户要求继续创作时交给对应平台的内容生成 Skill；否则以策略产物结束。
