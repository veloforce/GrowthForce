# 公开内容研究工具设计

## 目标

提供无登录态要求的内容研究原子工具，支持内容运营工作流中的：

- 通用泛热点抓取。
- 基于关键词的垂类热点抓取。
- 竞品账号、品牌或作者的公开内容候选抓取。

工具位于 `resources/tools/content_research/`，作为 Claude Agent SDK MCP server 注入。工具层只做单源抓取和结构化返回，不负责多源编排、去重评分、选题决策或降级策略；这些策略由 `resources/skills/` 中的运营 skill 承担。

## 能力分级

### 泛热点

不需要关键词，读取平台公开热榜或公开新闻源。

第一版 source：

- `weibo_hot`：HTTP 读取微博公开热搜接口。
- `toutiao_hot`：HTTP 读取今日头条公开热榜接口。
- `baidu_hot`：HTTP 读取百度实时热搜接口，参考 WeWrite 原实现。
- `36kr_news`：HTTP 读取 36kr RSS。
- `36kr_hot`：复用当前 Agent session 浏览器 runtime 抓取公开热榜页。

### 关键词热点

输入关键词，抓取公开搜索结果，用于垂类趋势观察。

第一版 source：

- `36kr_search`：浏览器公开搜索页抓取。
- `wechat_sogou_search`：搜狗微信 HTTP first，浏览器 fallback。

### 竞品公开内容

输入竞品账号名、品牌名、作者名或关键词，抓公开内容候选。

第一版 source：

- `wechat_account`：搜狗微信文章搜索。
- `36kr_author_or_keyword`：36kr 公开搜索。

小红书竞品账号调研继续使用现有 XHS connector/CLI，因为它有独立登录态、风控和平台连接器边界，不并入这个无登录公开研究工具。

## 浏览器复用规则

- 基于浏览器的 source 必须复用当前 Agent session 的 default browser runtime。
- in-process MCP server 只使用当前 Run 通过 `ToolServerContext` 注入的 page-level CDP URL
  和端口，不读取 Utility process 的 `process.env`。
- 不启动系统 Chrome，不启动 Playwright，不新建 tab。
- 同一 server 进程内 browser source 串行执行，避免同一个页面并发导航相互覆盖。
- 只访问公开页面；不要求登录，不处理验证码，不绕过平台风控。

## 返回结构

所有工具返回同一 envelope：

- `ok`: 是否有有效结果。
- `status`: `ok | no_results | blocked | auth_required | upstream_error | unavailable`。
- `source`: 本次调用的 source。
- `transport`: `http | browser`。
- `fetchedAt`: ISO 时间。
- `items[]`: 结构化内容列表。
- `warnings[]`: 可恢复问题，例如 browser runtime 缺失、验证码、导航超时。

`items[]` 字段：

- `id`
- `source`
- `tier`: `global | keyword | competitor`
- `title`
- `url`
- `rank`
- `hotValue`
- `hotText`
- `summary`
- `sourceAccount`
- `publishedAtText`
- `raw`

## 边界

- 不读取平台后台数据。
- 不承诺覆盖全网最新内容；搜索源只代表当前公开入口能发现的内容。
- 不把 OpenCLI 作为运行时依赖；只参考其 adapter 的 source 和字段设计。
- 工具层不做选题评分，skill 层结合账号定位和历史表现做二次判断。
- 需要登录态或 cookie 的源不暴露给 Agent。已对照 OpenCLI：`weibo/search`、`zhihu/search` 属于 `Strategy.COOKIE`，`zhihu/hot` 也依赖 `credentials: include`，因此不进入本工具的 source 枚举。
