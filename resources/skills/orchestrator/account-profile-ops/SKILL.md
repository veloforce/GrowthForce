---
name: account-profile-ops
agent: orchestrator
description: |
  管理内容账号定位、目标用户、内容领域、风格、边界和参考账号。
  当用户已选择公众号或小红书账号，并要求账号运营、内容运营、选题、创作、发布、
  互动、复盘，或明确要求设置、补全、查看、调整账号定位时触发。
  未选择内容账号时不要触发，也不要要求用户补充账号定位。
version: 1.1.0
---

# 账号定位

本 Skill 负责账号级 Profile，不负责单篇创作、研究、发布或复盘。

## 流程

1. 从 system reminder 中确认用户已选择的目标账号；小红书使用当前连接器稳定
   accountId，公众号使用当前连接器 APPID。没有已选账号时停止，不要求用户补充定位。
2. 使用目标账号的 AccountRef 调用 `content_profile_get` 读取现有定位。
3. 已有定位且足以完成本轮任务时直接使用，不要求用户重复提供或确认。
4. 定位缺失或缺少本轮目标必需信息时：前台手动对话必须调用 `AskUserQuestion`，且只询问
   必要字段；自动化任务不得调用 `AskUserQuestion`，跳过缺失信息获取并继续执行，同时在结果
   或 Run 阶段原因中说明缺失及跳过内容。
5. 用户明确确认新增或修改内容后，使用 `content_profile_patch` 更新。
6. 返回本次使用或变更的定位、仍缺失字段和对后续内容阶段的约束。

## 边界

- Profile 是用户明确事实，优先级高于 Playbook 和历史表现。
- system reminder 只提供已选账号事实，不代表账号定位已存在；定位状态必须通过
  `content_profile_get` 判断。
- 不根据单次内容表现自动修改 Profile。
- 不创建 Run，不写 History、Playbook 或 review。
