---
name: wechat-create
agent: orchestrator
description: |
  公众号单篇内容生成技能，负责框架、素材、写作、SEO、质量校验和视觉包装。
  当用户要求撰写公众号文章、生成微信推文或准备公众号 Markdown 时触发。
version: 1.0.0
---

# 公众号内容生成

本 Skill 输出 Markdown 和视觉素材，不负责排版、推送草稿箱或长期复盘。

## 输入

- 用户目标或 Content Brief。
- 可选 Profile、适用 Playbook、近期重复选题和 research。
- workspace 中用户明确提供的素材。

## 账号定位 Gate

如果 system reminder 提供了已选内容账号，本 Skill 在生成前必须使用该账号的 AccountRef
调用 `content_profile_get` 检查 Profile。Profile 是账号级事实，不得根据账号昵称、用户身份、
本轮主题或历史对话自行推断定位后继续创作。

- Profile 已存在且足以完成本轮任务时，按 Profile 约束生成。
- Profile 缺失或缺少本轮目标必需字段时，遵循选中账号 system reminder 中统一的 Profile
  缺失处理规则。
- 用户明确提出可长期复用的创作偏好、结构要求、风格要求、禁区或 CTA 习惯时，先用
  `content_playbook_preferences_read` 读取「用户明示偏好」区，再用
  `content_playbook_preferences_replace` 整段替换该区。不得写入表现判断或数据规律。

## 流程

1. 读取 `references/frameworks.md` 和 `references/content-enhance.md`，确定结构并补齐
   真实素材；证据不足时明确标记。
2. 读取 `references/writing-guide.md`、`references/persona-selection.md` 和选中的
   `personas/*.yaml`，生成完整 Markdown 初稿。
3. 使用 `references/realtime-check.md`、`references/seo-rules.md` 完成定向修订，
   输出最终标题、摘要和标签。
4. 读取 `references/visual-prompts.md`，生成公众号封面和必要配图：
   - 已配置图片 Provider 时调用 `image_generate`，封面传 `size: "wechat-cover"`，内文配图
     传 `size: "article"`。
   - 未配置图片 Provider 时，封面先调用 `image_template_list(type="gzh_cover")`，内文卡片
     调用 `image_template_list(type="gzh_content")`，根据返回的风格和适用场景选择模板。
     再调用 `image_template_generate`：封面传 `type: "gzh_cover"`、文章标题和可选摘要；
     内文传 `type: "gzh_content"`、章节标题和可选 `content` 正文要点。正文支持显式换行，
     也会根据模板宽度自动换行；内文图不传 `subtitle`。结果标明素材来源为本地模板。
   - 不需要内容匹配时可省略 `template`，由工具根据标题稳定选择。
   - 图片 Provider 已配置但远程调用失败时报告错误并保留提示词，不静默改用本地模板，也不阻断
     Markdown 输出。
5. 将最终 Markdown、主题 YAML 和素材路径返回给 `wechat-markdown-to-html`。

## Run 记录与初稿快照

Run 是完整运营任务的记录层，由本 Skill 作为生产起点创建并持有 runId：

- 只要本轮产出可发布草稿或发布包，必须用 `content_run_create_with_draft`（传入本轮目标、
  当前工作目录和初稿 Markdown）创建 Run，并记下 runId。Markdown 交给
  `wechat-markdown-to-html`、最终交给 `wechat-publish` 时一并把 runId 向下传递。
- 该工具会把初稿写成**不可变快照**，并将 `content_generation` 阶段置为 `completed`。该快照
  供后续复盘做版本对比，与用户在工作目录里继续编辑的工作文件相互独立。
- 只有局部润色、标题备选、结构建议等不形成可发布草稿/发布包的任务，才允许不创建 Run。

## 边界

- 用户明确要求和 Profile 优先于 Playbook。
- 本 Skill 只创建本次 Run 并写 `draft` 快照；不创建发布后采集任务，不写 History、证据规律、
  metrics 或 review。
- 不调用微信 API，不声称已排版或推送草稿箱。
