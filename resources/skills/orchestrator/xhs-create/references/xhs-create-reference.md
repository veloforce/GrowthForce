## 通过url内容创建

当用户提供一个或多个网页 URL时，且域名不是 xiaohongshu.com，要求把这个内容变成笔记:

1. 调用 `web_fetch` 抓取网页，`outputPath` 必须位于当前工作目录；不要使用 `curl`、`wget` 或自行拼接 HTTP 请求。
2. 读取生成的 Markdown，区分来源事实与改写内容；基于正文生成适合小红书的标题、正文和标签，不直接复制网页全文。
3. 从 Markdown 的 `Images` 列表按页面顺序选择正文相关图片，排除 logo、图标、头像、追踪图、占位图和与主题无关的图片，最多选择 6 张。
4. 远程图片保留原始 HTTP/HTTPS URL，直接放入发布包交给 XHS CLI 下载；禁止手工下载后猜测临时路径。
5. 抓取失败、验证页或正文不足时停止 URL 改写并说明原因，不基于页面标题或模型记忆补写事实。
6. 没有有效内容图时，按references/img.md 的要求补齐。

URL 发布包必须记录 `sourceUrl`、抓取时间、`web_fetch` 返回的 method，以及每张素材的来源。
来源图片仍需在最终发布确认中展示，提醒用户确认素材使用权。

## 站内笔记参考
如果用户没有提供选题或明确的主题，或者用户要求进行小红书笔记调研

- 先由 `content-research-ops` 或 `xhs-explore` 搜索并分析2–3 篇与主题和账号定位匹配的公开笔记，再生成差异化发布包。
- 根据 `content-strategy-ops` 进行选题
- 不得复制参考笔记的原文、标题或视觉素材。
- 用户明确要求不做站内研究、已有充分 research、或搜索不可用时可以跳过，但必须说明采用的证据和限制。


## 图文视觉素材
如果用户已经提供使用的图片，则不重复生成或替换，否则参考下面流程来生成图片

- 图文发布包缺少图片时：
  - 已配置图片 Provider，调用 `image_generate` 生成与正文匹配的素材，远程调用失败时，报告错误并保留生成提示词，不静默改用本地模板。
  - 未配置图片 Provider，使用 image_template_list 和 image_template_generate 
  - 首图通过 `image_template_list(type="xhs_cover")`
  - 内容页调用 `image_template_list(type="xhs_content")`
  - 根据内容主题和返回选择模板，再调用 `image_template_generate`。两者均输出 `1080x1440`，素材来源标记为本地模板或用户提供。
  - title最多 18 字，subtitle 最多30字，content 最多 140 字。
  - 默认传 `size: "1080x1440"`；需要多张图片时，为每张使用包含画面目的和序号的不同 prompt，
    避免生成完全相同的素材。


