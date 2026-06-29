# 图片 Provider 配置设计

## Summary

当前阶段实现图片供应商配置和内置图片生成工具。图片生成统一使用 TypeScript SDK
MCP server，不依赖排版 Skill 的 Python runtime。

## Provider Types

首版支持 6 种类型：

- `doubao`：豆包 Seedream，默认 `baseUrl` 为 `https://ark.cn-beijing.volces.com/api/v3`，默认模型 `doubao-seedream-5-0-260128`。
- `openai`：OpenAI，默认 `baseUrl` 为 `https://api.openai.com/v1`，默认模型 `gpt-image-1`。
- `gemini`：Gemini，默认 `baseUrl` 为 `https://generativelanguage.googleapis.com/v1`，默认模型 `gemini-2.5-flash-image`。
- `dashscope`：阿里云 DashScope，默认 `baseUrl` 为 `https://dashscope.aliyuncs.com/api/v1`，默认模型 `qwen-image-2.0-pro`。
- `minimax`：MiniMax，默认 `baseUrl` 为 `https://api.minimaxi.com/v1`，默认模型 `image-01`。
- `openai-compatible`：OpenAI Compatible，`baseUrl` 和 `model` 由用户填写。

## Config Shape

`~/.agentstudio/config.yml` 当前生效图片供应商：

```yaml
imageProvider:
  id: image-provider-xxxx
  name: OpenAI
  providerType: openai
  baseUrl: https://api.openai.com/v1
  apiKey: sk-...
  model: gpt-image-1
```

`~/.agentstudio/settings/image-providers.yml` 图片供应商列表：

```yaml
imageProviders:
  - id: image-provider-xxxx
    name: OpenAI
    providerType: openai
    baseUrl: https://api.openai.com/v1
    apiKey: sk-...
    model: gpt-image-1
```

旧的 `endpoint` 字段不是有效配置，不迁移、不兼容、不写回。

## Validation

- 图片供应商必须填写 `id`、`name`、`providerType`、`baseUrl`、`apiKey`、`model`。
- `providerType` 必须是首版 6 种类型之一。
- 图片供应商 id 必须唯一，格式由 UI 默认生成 `image-provider-xxxxxxxx`。
- 保存设置时不进行连通性测试，不产生外部 API 请求。
- 图片供应商配置与普通模型配置使用独立 IPC 和独立保存按钮；保存图片供应商不会触发普通模型连通性测试。
- 旧 `model-providers.yml` 中的 `imageProviders` 不迁移、不读取。

## Image Tool

- 工具源码放在 `resources/tools/image`，server id 为 `image`。
- MCP tool 协议名为 `image_generate`；中文“图片生成”放在描述和 search hint，避免中文 tool name 触发 MCP/SKD 命名兼容问题。
- 同一 server 提供独立原子工具 `image_template_generate`，用于没有图片 Provider 时，把封面的
  标题与可选副标题，或内容图的标题与可选正文，确定性排版到项目内置模板。该工具不读取 Provider
  配置、不访问网络，也不处理 `image_generate` 的远程调用失败。
- `image_template_list` 按业务 `type` 查询模板，只返回对应类型模板的名称、风格、适用场景、
  标题/辅助文字布局和建议标题长度。`type` 支持 `xhs_cover`、`xhs_content`、`gzh_cover`、
  `gzh_content`。
- `image_template_generate` 接收 `type`、`title`、可选 `subtitle`、可选 `content`、可选
  `template` 和 `outputPath`。封面只接受 `subtitle`；`xhs_content` 和 `gzh_content` 只接受支持
  显式及自动换行的 `content`。`title`、`subtitle`、`content` 均同时识别真实换行符和字面量
  `\n`；字面量 `\r\n` 也统一为单次换行。Agent 需要内容匹配时先查询同类型模板；未指定模板时
  按标题哈希稳定选择。
- 模板生成前硬校验文字长度：`xhs_cover` title/subtitle 为 18/30 字，`xhs_content`
  title/content 为 18/140 字，`gzh_cover` title/subtitle 为 18/30 字，`gzh_content`
  title/content 为 18/160 字；超出时返回错误，不自动截断。
- 模板背景和字体位于 `resources/tools/image/assets`，随安装包分发。标题和封面副标题固定使用
  江城知音体 600W，内文正文固定使用 400W；不回退到平台字体。输出路径必须使用 `.png`。
- 模板背景不要求与标准输出像素完全一致；工具按目标比例等比覆盖并居中裁切，最终仍输出
  小红书封面/内容图 `1080x1440`、公众号封面 `1476x628` 或公众号内文 `1536x1024`，不拉伸背景。
- 工具调用时必须传入 `prompt` 和 `outputPath`，`outputPath` 由 Agent 按当前 session 工作目录决定。
- `image_generate` 与 `image_template_generate` 只返回结构化元数据，包含 `outputPath`、`width`、
  `height`、`mimeType`、`bytes` 等字段；图片二进制、data URL、base64 或 media content 只写入本地文件，
  不放进工具返回内容。
- `size` 支持 `wechat-cover`、`cover`、`article`、`vertical`、`square` 和显式 `WxH`。
- `wechat-cover` 表示公众号宽封面优先：Doubao 映射为 `2952x1256`，MiniMax
  映射为 `16:9`，其他 provider 映射为当前稳定支持的最宽横图 `1536x1024`。
- 工具只读取 `~/.agentstudio/config.yml` 的当前 `imageProvider`，不从 `settings/image-providers.yml` 反向选择供应商。
- 如果 `imageProvider` 为空或缺少 `providerType/baseUrl/apiKey/model`，工具直接返回中文错误，提示用户补充图片模型供应商配置。
- 首版不实现多 provider 自动 fallback；当前 UI 与 config 只表达一个生效图片供应商。
- Provider 是否存在及调用哪个工具由 Skill 决策：未配置 Provider 时可使用本地模板；已配置 Provider
  但远程调用失败时保留错误，不静默替换为模板图。
- `wechat-create` 的封面使用 `wechat-cover`、内文配图使用 `article`；`xhs-create` 的图文素材默认
  使用显式 `1080x1440`。两个 Skill 都将工具返回的绝对 `outputPath` 传给后续流程。
- `xhs-publish` 不生成素材；图文发布包缺图时退回 `xhs-create` 补齐。
