# wechat-markdown-to-html

将 Markdown 转为微信公众号兼容 HTML，使用路径型主题文件生成预览并校验发布包。

运行时由本 Skill 调用内置 `wechat_markdown_render`，显式传入：

- Markdown 文件绝对路径
- `themes/*.yaml` 或 workspace 自定义主题的绝对路径
- 输出目录绝对路径
- 可选封面、标题和摘要

工具返回正文 HTML 路径、浏览器预览路径和发布包校验结果，不依赖 Python。
