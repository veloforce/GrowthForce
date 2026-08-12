---
name: wechat-markdown-to-html
agent: orchestrator
description: |
  将 Markdown 转为微信公众号兼容 HTML，使用路径传入的排版主题，生成预览并校验发布包。
  当用户要求公众号排版、Markdown 转公众号 HTML、生成公众号预览或校验发布包时触发。
version: 2.0.0
---

# 公众号 Markdown 排版

本 Skill 是无状态排版编排层。只负责选择文件、调用 `wechat_content`、检查结果和交接发布包；
不调用微信 API，不创建 Run，不读取或写入长期运营数据。

## 职责

- 将已有 Markdown 转为微信公众号兼容 HTML，生成预览并验证发布包。
- 不改写账号定位，不推送草稿箱，不创建 Run 或长期运营数据。

## 输入与输出

- 输入：Markdown 绝对路径、主题 YAML、输出目录、可选封面、标题与摘要。
- 输出：校验状态、HTML 与预览绝对路径、封面、本地图片、主题和 warnings。

## 授权

本 Skill 只处理本地内容文件，不产生平台外部副作用，无需发布授权；不得代替
`wechat-publish` 推送草稿箱。

## 运行约定

- `{skill_dir}` 指本 Skill 根目录。
- 输入和输出必须使用绝对路径。输出写入当前 workspace，不写入 Skill 目录。
- 主题是普通 YAML 文件，默认主题路径为
  `{skill_dir}/themes/professional-clean.yaml`；用户主题可位于 workspace 的任意位置。

## 排版流程

1. 确认 Markdown 路径、主题 YAML 路径、输出目录和可选封面路径。
2. 未指定主题时使用 `{skill_dir}/themes/professional-clean.yaml`。
3. 调用 `wechat_markdown_render(markdownPath, themePath, outputDir, coverPath?, title?, digest?)`。
4. 检查 `validationStatus`：
   - `valid`：可以交给 `wechat-publish`。
   - `invalid`：停止发布，先解决 `errors`。
5. 返回标题、摘要、正文 HTML 路径、预览路径、主题、封面、本地图片和 warnings。

只需要查看主题时，列出 `{skill_dir}/themes/*.yaml` 并读取其中的 `name` 与 `description`；
不要调用排版工具，也不要把主题内容复制进工具参数。

## 发布包边界

完整发布包至少包含：

- 非空标题。
- 非空正文 HTML。
- 存在的绝对封面路径。
- 所有本地正文图片均可读取且为绝对路径。

远程 HTTP/HTTPS 图片会保留并记录 warning；真实发布时由 `wechat_draft_publish`
决定是否接受。完整平台限制见 `references/wechat-constraints.md`。

## 失败处理

- Markdown 不存在或不是绝对路径：停止并返回错误。
- 主题不存在：停止并列出可用主题。
- 本地图片或封面不存在：返回 `invalid`，不得进入发布。
- 工具失败：保留原 Markdown 和已存在产物，报告错误，不尝试调用发布 Tool。

校验成功且用户目标包含草稿箱推送时，把完整发布包和上游 runId 交给 `wechat-publish`；
校验失败时不得交接发布。
