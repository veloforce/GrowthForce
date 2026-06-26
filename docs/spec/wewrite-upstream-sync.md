# 公众号排版上游同步规范

## 目标

`wechat_content` 的排版行为和 Skill 中的主题源自 `oaker-io/wewrite`。本项目只同步
可复用的纯逻辑能力，不再完整引入 WeWrite 复合 Skill，也不保留 Python 运行时。

## 可同步范围

- Markdown 转公众号 HTML 的兼容行为
- 上游 `toolkit/themes/*.yaml`，同步后存放到 Skill 的 `themes/*.yaml`
- HTML 转 Markdown、主题提取、质量分析和范文特征提取中的纯逻辑
- 对应的行为测试

不得同步进入本 Skill：

- 真实公众号发布、凭据或指标代码
- 内容生成、热点、SEO 或图片生成流程
- 本地 Profile、History、Playbook、修改学习和效果复盘
- 范文导入、学习排版、小绿书和多平台构建脚本

## 同步流程

1. 记录上游版本和 commit。
2. 只对比并同步允许范围。
3. 将上游逻辑翻译到 `wechat_content` TypeScript Tool；主题仍由 Skill 以路径提供。
4. 保留 GrowthForce Skill 的 SOP、发布包校验边界和既有工具职责。
5. 运行全部 converter 测试、路径契约测试和项目 build smoke。
6. 在当天 changes 文档记录同步内容、差异和风险。
