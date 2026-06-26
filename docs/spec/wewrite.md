# 公众号内容执行能力设计

上游版本同步和 GrowthForce 专属 overlay 规则见
[`docs/spec/wewrite-upstream-sync.md`](./wewrite-upstream-sync.md)。

## Summary

公众号执行能力拆为阶段 Skill 与原子 Tool：

- `wechat-create` 负责单篇公众号内容生成、事实校验和视觉包装。
- `wechat-markdown-to-html` 负责组织 Markdown 排版、主题选择、预览和完整发布包校验。
- `wechat-publish` 负责组织发布阶段并调用 `wechat_draft_publish`。
- `wechat_content` 负责基于文件路径的排版、转换、主题提取和文章分析。
- `wechat_ops` 负责原始指标、草稿读取和真实草稿箱推送。

公众号内容工具全部使用 TypeScript 并随应用打包，不依赖用户机器的 Python 或 Node。
Markdown、HTML、主题、范文和报告均作为 workspace/Skill 中的文件通过绝对路径传入或返回；
Tool 不把主题、规则文件或用户内容作为内置资产。

## Skill 与 Tool 边界

- Skill 定义 SOP、依赖、降级、确认规则和阶段交接。
- Tool 只提供原子操作，不创建生命周期 Run、不写 History/Playbook、不生成复盘。
- 公众号草稿箱推送无需用户确认；公众号正式发布和互动当前不支持。
- 平台执行 Skill 可以读取 Profile、Playbook 和 History 作为本轮输入，但不得写长期数据。

## 路径型工具与发布包

`wechat_content` 原子工具：

- `wechat_markdown_render`：读取 Markdown 和主题 YAML，写正文 HTML 与预览 HTML。
- `wechat_html_to_markdown`：读取本地公众号 HTML，写带 frontmatter 的 Markdown。
- `wechat_theme_extract`：从本地 HTML 提取样式，基于显式传入的基础主题生成主题 YAML。
- `wechat_article_quality_analyze`：读取 Markdown，写可解释的质量分析 JSON。
- `wechat_exemplar_extract`：读取 Markdown，写范文结构与风格特征 JSON。

`wechat_draft_publish` 输入：

```text
title
digest
contentHtmlPath
coverPath
author?
openComment?
fansOnlyComment?
```

Tool 从 `contentHtmlPath` 读取正文，执行最小安全校验，上传 HTML 中引用的本地图片和封面，创建草稿并返回
`media_id`。标题、正文 HTML 和封面不能为空；所有本地文件必须是存在的绝对路径。

`wechat_ops` 原子工具：

- `wechat_metrics_fetch`
- `wechat_published_articles_fetch`
- `wechat_draft_get`
- `wechat_draft_publish`

`wechat_published_articles_fetch` 调用 `/cgi-bin/freepublish/batchget` 读取已成功发布消息及正文，
用于账号诊断等只读场景。该接口和指标接口都可能因账号认证、权限、凭据、IP 白名单或微信侧
限制失败；调用方必须显式降级或说明任务无法完成，不得把失败或空数据解释为账号表现差。

所有工具使用当前 Run 通过 `ToolServerContext` 注入的公众号 APPID、SECRET；
`wechat_draft_publish` 还可以使用注入的默认作者。显式非空 `author` 参数优先于
默认作者。凭据和默认作者不得进入 prompt、工具参数或工具返回值。
- `content_analysis`：无状态比较 draft/final，或分析历史文章语料，返回带证据的规则
  候选；不写 Playbook。

SDK query 的 `env` 不会自动成为 in-process MCP handler 的运行上下文。公众号凭据和
默认作者必须在创建 MCP Server 时按 Run 显式传入，handler 通过闭包持有不可变上下文，
不得修改或读取 Utility process 的共享 `process.env`。

## Runtime

- `wechat_content` 和 `wechat_ops` 随 tools 编译为自包含 CommonJS，使用 Electron 自带 Node。
- 主题 YAML 由调用方通过绝对路径传入；默认主题位于排版 Skill 的 `themes/` 目录。
- 用户可见输出写入当前 workspace，不写入 Skill 目录。
- HTML 抓取由 browser/content research 负责，`wechat_content` 只消费本地文件。

## Test Plan

- TypeScript converter 测试覆盖主题、容器、CJK、列表、脚注、图片和预览。
- 所有内置主题可加载并生成非空 HTML。
- 路径不存在、不是绝对路径、YAML 损坏和输出冲突返回明确错误。
- `wechat_draft_publish` 最小校验不依赖微信网络。
- 有真实凭据时才执行草稿箱集成验证；无凭据不声称真实发布已验证。
- 执行层 Skill 不创建 Run、不写 History/Playbook。


---

## 上游能力映射

- 图片生成由 `image_generate` 提供，排版 Skill 不包含图片生成代码。
- 账号定位和长期风格事实由 `content_ops_data` 管理。
- 热点、关键词和竞品研究复用 `content_research`。
- 修改学习和历史语料规律复用 `content_analysis` 与 `content-review-ops`。
- 发布、草稿和指标复用 `wechat_ops`。
- 不迁移上游构建脚本、环境诊断、自动写 History/Playbook、图片 provider fallback 和小绿书复合流程。
