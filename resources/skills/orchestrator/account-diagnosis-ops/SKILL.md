---
name: account-diagnosis-ops
agent: orchestrator
description: |
  诊断当前选中的小红书或公众号账号，结合已有账号定位和最近发布内容，输出评分卡、
  做得好的地方、主要问题、证据和改进优先级。当用户要求账号诊断、账号体检、账号分析、
  运营现状评估、内容表现分析或改进方向时触发。未选择小红书或公众号账号时不要触发。
version: 1.1.0
---

# 账号诊断

对当前选中的内容账号执行只读诊断。默认分析最近 10 篇已发布内容。

开始前读取 [诊断框架](references/framework.md)，严格使用其中的评分、覆盖率和缺失数据规则。

## 账号定位 Gate

使用选中账号的稳定 AccountRef 调用 `content_profile_get`。Profile 已有信息足以完成本轮诊断时直接使用，
不要求用户重复提供或确认。Profile 缺失或缺少本轮诊断必要字段时，遵循选中账号 system reminder
中统一的 Profile 缺失处理规则。诊断本身只读 Profile；需要持久化用户补充的信息时交给
`account-profile-ops`。

未选择账号时停止并提示用户先选择账号，不要求用户补充 Profile。

## 边界

- 只读数据；不修改 Profile，不创建或更新 Run，不写 `history.md` 或 `playbook.md`。
- 不使用无来源的行业平均值，不把相关性写成因果，不用单篇表现概括整个账号。
- Profile 缺失字段本身不按零分；自动化任务跳过缺失信息获取后，只说明受影响的判断。
- 多个平台同时被选中且用户未指定平台时，分别诊断，禁止合并为一个跨平台分数。
- 所有工具实际返回的缺失、空值和失败都必须保留，不估算、不补猜、不按 0 分。

## 通用流程

1. 从 system reminder 确认选中账号和稳定 AccountRef。没有已选账号时停止，提示用户先选择账号。
2. 执行账号定位 Gate；前台手动对话在必要字段补全后继续，自动化任务按缺失处理规则继续有限诊断。
3. 按平台采集最近 10 篇内容和可用指标。
4. 使用 `content_analyze_corpus` 分析有正文的样本；只有标题时不得声称分析了正文风格。
5. 按参考框架完成六维评分。每个维度同时记录事实、解释、得分依据和置信度。
6. 输出固定报告；数据覆盖率低于 60% 时不输出总评级。

## 小红书

1. 先读取完整创作者数据快照：

   ```bash
   $AGENTSTUDIO_XHS_CLI creator-data-snapshot --period all --max-pages 10
   ```

2. creator 快照成功时，从 `noteData.notes.items` 取最近可读取的 10 篇，使用笔记管理指标和可匹配的
   `analysis`；字段为空时保留为空，不转换为 0。
3. 仅当快照失败的 `error_code=CREATOR_SESSION_EXPIRED`，或错误明确表示创作中心 401/登录页
   无法恢复时，使用当前 AccountRef 的稳定 ID 降级：

   ```bash
   $AGENTSTUDIO_XHS_CLI user-profile --user-id <accountId>
   ```

   此时继续“有限诊断”，在数据范围中标记 `dataSource=public_profile_fallback`，保留非敏感
   creator 登录错误摘要。只使用公开主页资料、粉丝/关注/获赞收藏汇总和 `feeds[]` 的公开
   互动；曝光、点击率、观看时长、主页访客、涨粉、审核状态和受众数据记为 `N/A`。
4. creator 返回 `partial=true`、`permission_pending`、`insufficient_data` 或
   `threshold_not_met` 时继续使用 creator 结果，不降级。页面结构变化、业务校验失败及其他
   非登录错误也不降级，直接记录失败，避免掩盖回归。
5. 用可比较的后台阅读/互动或公开互动总量选取高表现、中位表现、低表现各一篇；样本不足时
   去重后尽可能选取。
6. 需要正文和评论时，使用个人主页取得公开 feed；只有同一条 feed 同时存在 `id` 和
   `xsecToken` 时读取详情：

   ```bash
   $AGENTSTUDIO_XHS_CLI get-feed-detail \
     --feed-id <id> \
     --xsec-token <xsecToken> \
     --load-all-comments \
     --max-comment-items 30
   ```

   最多访问 3 篇详情，遵守 `xhs-explore` 的频率和风控约束。详情失败不阻断其他公开数据分析。
7. 曝光、观看、点击率、主页访客和涨粉只使用 `accountData` 实际返回的周期指标。受众或
   粉丝画像不可用时保留原因，不推断画像；不得把公开互动除以粉丝数称为平台互动率。
8. creator 登录失败后 `user-profile` 也失败时，记录两个非敏感错误并停止小红书诊断，
   不输出伪完整评分卡。

## 公众号

1. 调用 `wechat_published_articles_fetch(offset=0, count=10, includeContent=true)` 获取已发布文章。
   排除 `isDeleted=true`，多图文中的每篇文章分别计入样本，最多取 10 篇。
2. 调用 `wechat_metrics_fetch(days=7)` 获取最近 7 个完整自然日的原始指标。该接口只提供近期
   窗口，不能覆盖最近 10 篇的全部历史表现。
3. 指标只能在标题、发表日期或平台标识能够可靠对应时绑定文章。匹配不唯一时保留为账号级
   近期证据，不分配给具体文章。
4. `wechat_published_articles_fetch` 失败时，调用 `content_runs_recent(limit=10)` 检查本地记录，
   对存在 `final` 或 `draft` 的 Run 用 `content_run_document_read` 读取文稿：
   - 有本地文稿：输出“有限诊断”，明确不代表线上账号全貌。
   - 没有本地文稿：停止，明确说明当前无法完成公众号账号诊断。
5. `wechat_metrics_fetch` 失败但已发布文章读取成功时，继续内容诊断；传播表现及依赖指标的
   项目记为 `N/A`。

## `wechat_ops` 失败规则

`wechat_published_articles_fetch`、`wechat_metrics_fetch` 以及其他 `wechat_ops` 接口都可能因
权限不足、账号未认证、AppID/Secret/access token invalid、IP 白名单、调用频率或额度、
接口权限被回收、统计数据为空或延迟、网络错误或微信服务异常而失败。

发生失败时必须：

1. 保留接口名和非敏感错误摘要；不得输出 AppSecret、access token 或完整凭据。
2. 说明受影响的诊断维度和本轮采用的降级路径。
3. 不把失败或空数据解释为账号表现差，不将缺失数据计为 0。
4. 必要内容数据不可用时明确说“当前无法完成相关任务”，不得输出伪完整报告。

## 输出格式

```markdown
# 账号诊断：<账号名>

## 数据范围
- 平台、样本篇数、时间范围、数据来源
- 数据覆盖率、失败接口和限制

## 评分卡
| 维度 | 得分 | 状态 | 置信度 | 核心证据 |

## 当前做得好的
## 当前主要问题
## 最近内容分布与代表内容
## 未来 30 天改进优先级
## 无法判断的数据
```

改进动作限制为 3–5 条，按“影响 × 可执行性”排序，并明确第一步。
