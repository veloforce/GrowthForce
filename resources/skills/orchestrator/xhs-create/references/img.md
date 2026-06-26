
## 图文视觉素材

- 图文发布包缺少图片时：
  - 已配置图片 Provider，调用 `image_generate` 生成与正文匹配的素材，远程调用失败时，报告错误并保留生成提示词，不静默改用本地模板。
  - 未配置图片 Provider，使用 image_template_list 和 image_template_generate 
  - 首图通过 `image_template_list(type="xhs_cover")`
  - 内容页调用 `image_template_list(type="xhs_content")`
  - 根据内容主题和返回选择模板，再调用 `image_template_generate`。两者均输出 `1080x1440`，素材来源标记为本地模板或用户提供。
  - title最多 18 字，subtitle 最多30字，content 最多 140 字。
  - 默认传 `size: "1080x1440"`；需要多张图片时，为每张使用包含画面目的和序号的不同 prompt，
    避免生成完全相同的素材。


