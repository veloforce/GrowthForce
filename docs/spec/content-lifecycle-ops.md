# 全生命周期内容运营与数据工具设计

> ⚠️ 已被 `docs/spec/content-ops-loop.md` 取代。`content-lifecycle-ops` Skill 解散：
> 总原则上提 orchestrator.yml，执行细节下沉各阶段 Skill，长期数据写入收口到单一写者
> （content-review-ops）。本文保留作历史参考，不再作为当前设计。

## 目标

平台无关的 `content-lifecycle-ops` Skill 组织账号长期运营和单次内容生产：

```text
账号定位与长期经验 → workspace 素材 → 热点与竞品 → 选题池 → 内容生成与校验
→ 平台发布 → 互动运营 → 指标回收 → 复盘沉淀
```

Skill 负责流程、策略、降级和平台路由。平台无关的 `content_ops_data` MCP server
负责账号定位、长期数据和 Run 生命周期的原子存储操作。

## 存储边界

物理数据目录由工具内部管理：

```text
~/.agentstudio/user-data/{platform}/{accountId}/
├── profile.md
├── playbook.md
├── history.md
└── runs/{runId}/
```

- 不兼容、不读取旧的 `user-data/accounts/...`。
- AccountRef 由调用方显式传入 `{ platform, accountId }`。
- 工具限制所有访问位于对应账号根目录，拒绝路径穿越和 symlink 越界。
- 工具响应只暴露账号根目录，不暴露具体文档路径。
- Prompt 和 Skill 不指定或拼接物理目录，只要求使用 `content_ops_data`。

workspace 只作为全生命周期任务的素材来源。Agent 优先查找相关项目资料，但运营数据
必须通过工具管理。

## 数据职责

- Profile：用户明确的账号定位和长期要求，最高优先级。使用结构化字段 patch。
- Playbook：历史复盘学到的规律，使用自由 Markdown 读取和追加，不得覆盖 Profile。
- History：Run 精简索引，使用结构化追加。
- Run：记录用户目标、workspace、素材、要求、决策和生命周期状态。
- Run 文档：research、topics、draft、final、publish、engagement、review。
- Metrics：只追加原始指标快照，不生成分析结论。

RunId 使用本地时间 `YYYYMMDDHHmm`；同一分钟冲突时追加 `-02`、`-03`。

## content_ops_data API

### Profile

- `content_profile_get`
- `content_profile_patch`

Profile patch 支持摘要、人设、目标用户、内容领域、核心价值、内容风格、选题边界、
转化目标和参考账号。未传字段保持不变，`null` 清空字段；未知 frontmatter 和未知章节
保留。Profile 只由 `content_ops_data` 读取和更新。

### 长期数据

- `content_playbook_read`
- `content_playbook_append`
- `content_history_read`
- `content_history_append`

### Run

- `content_run_create`
- `content_run_get`
- `content_run_update`
- `content_run_document_read`
- `content_run_document_write`
- `content_run_metrics_append`

Run 文档写入由调用方显式选择 `create_only | replace | append`。工具只固化路径和写入
语义，不判断内容质量或运营策略。

## Prompt 与 Skill

- 通用系统 prompt 只告诉 Agent 当前 workspace，并要求运营数据使用
  `content_ops_data`，不出现 user-data 物理目录。
- system reminder 只注入本轮已选账号的平台、昵称和稳定账号 ID，不读取或注入定位
  状态、摘要、缺失字段或物理路径。
- `account-profile-ops` 在已选账号的运营任务中先使用 `content_profile_get` 读取定位；
  已有定位直接使用，缺失本轮必要信息时才询问，创建或更新使用
  `content_profile_patch`。
- Skill 不直接操作 profile、playbook、history 或 Run 文件。
- `content-lifecycle-ops` 是长期管控层；阶段 Skill 是执行层。阶段 Skill 可以读取
  Profile、Playbook 和 History 作为本轮输入，但不得创建 Run、写长期数据或执行复盘
  沉淀。

默认阶段路由为：

- `account-profile-ops`
- `content-research-ops`
- `content-strategy-ops`
- `wechat-create` → `wechat-markdown-to-html` → `wechat-publish`
- `xhs-create` → `xhs-publish` → `xhs-interact`
- `content-review-ops`

## 平台规则

- 公众号使用当前连接器 APPID 作为 AccountRef，只推送草稿箱且无需
  用户确认；互动阶段暂时跳过。公众号写作、排版和草稿箱推送由阶段 Skill 执行，
  生命周期层负责保存 Run 文档和长期沉淀。
- 公众号原始指标和草稿读取使用 `wechat_ops`；版本对比与历史语料分析使用
  `content_analysis`。这些工具只返回原始数据或分析证据，不写运营数据。
- 小红书使用当前连接器稳定 accountId；发布、评论和真实互动继续要求用户确认。
- 热点与公开竞品候选使用 `content_research`；补充网页事实使用 browser；小红书站内
  研究继续使用 XHS connector/CLI。

## 测试用例设计

1. 扁平账号目录正确解析，完全不读取旧 `user-data/accounts/...`。
2. 路径穿越、绝对路径和 symlink 越界被拒绝。
3. Profile patch 保留未传字段、未知章节和未知 frontmatter；`null` 清空字段并重新
   计算状态。
4. 工具写出的 XHS profile 可被 Main 摘要读取器解析。
5. RunId 和同分钟数字后缀正确；Run 状态和文档列表正确。
6. Run 文档 `create_only | replace | append` 行为正确。
7. Playbook 自由追加、History 结构化追加、Metrics 多次追加不覆盖旧快照。
8. Prompt 不包含 profile 路径或 user-data 物理目录。
9. 生命周期 Skill 不指导 Agent 直接操作运营数据文件。
10. orchestrator 正确挂载 `content_ops_data`。
11. 执行层 Skill 不创建 Run、不写 History/Playbook。
12. 公众号工具只从 turn scoped 环境变量读取凭据，返回原始指标或草稿内容。
13. 版本对比和语料分析返回可追溯证据且不写文件。
