
# Design System
## Overview
桌面客户端支持亮暗主题切换。默认亮色采用瓷白深海蓝，以 `#075985` 作为主操作与基础强调色，搭配瓷白表面；暗色采用石墨深灰，以低对比深灰面板和清晰浅海蓝强调保持长期使用舒适度。

设计语言定位：
- **轻量克制**：避免大面积高饱和色铺底，用表面色区分层级
- **清爽中性**：亮色使用瓷白与高辨识度深海蓝，暗色使用石墨灰阶，避免纯黑纯白刺眼对比
- **紧凑高效**：基础字号 15px，行高 1.6，标题 18px，信息密度优先
- **系统一致**：主题模式支持 `system / light / dark`，由 Main process 使用 Electron `nativeTheme` 解析系统外观

## App Icon
macOS app 图标按 1024px 基准画布设计，所有平台图标从同一主 logo 源图生成，避免 Finder、Dock、安装包、窗口图标和应用内 logo 视觉漂移。

### macOS 图标几何规范
- 总画布：`1024 x 1024px`，背景透明。
- 内部圆角载体：`824 x 824px`，居中放置。
- 外部透明留白：四边各 `100px`，即 `(1024 - 824) / 2`。
- 圆角半径：`185.4px`，约等于载体宽度的 `22.5%`，用于匹配 macOS squircle 曲率。
- 关键图形安全区：在 `824 x 824px` 载体内再向内收缩约 `10%`，四边各约 `82px`。
- 安全区尺寸：`660 x 660px`。文字、logo、箭头、圆环等关键图形不得超出该区域，避免缩放后被圆角遮罩切掉或显得拥挤。

### 生成与校验
- 源图位置：`docs/logo.png`。源图可以是高分辨率 RGB/PNG，但生成产物必须是带 alpha 的 RGBA 图标。
- 生成入口：`npm run generate:icons`，由 `scripts/generate-app-icons.cjs` 负责裁剪、缩放、圆角遮罩、`.icns`、`.ico` 和 PNG 同步。
- 打包脚本必须在 electron-builder 前执行图标生成，确保 mac arm64、mac x64、Windows 安装包使用同一套最新图标。
- macOS `.app` bundle 必须声明 `CFBundleIconFile=icon.icns`，且 `Contents/Resources/icon.icns`
  必须来自 `build/icon.icns`；不能依赖运行时 `app.dock.setIcon()` 修正 Finder、Applications
  或启动瞬间 Dock 图标。
- macOS `1024 x 1024` 输出应满足：
  - alpha 可见载体约为 `824 x 824px`。
  - 外部透明 padding 四边约为 `100px`。
  - 蓝色主体或关键图形边界不超过 `660 x 660px`。
- 应同步更新：
  - `build/icon.icns`、`build/icon.ico`、`build/icon.png`、`build/icon.iconset/*`
  - `resources/icons/app-icon.*`
  - `src/renderer/src/assets/logo.png`

## Colors
### 品牌色
| Token | 色值 | 用途 |
| ---- | ---- | ---- |
| `primary` | `#075985` | `--brand-primary`，亮色主按钮与基础强调色 |
| `primary-hover` | `#06476D` | `--brand-hover`，亮色主按钮 hover 与强强调色 |
| `accent` | `#0E7490` | `--brand-accent`，焦点环、当前状态细线、少量品牌点缀 |
| `brand-soft` | `#E0F2FE` | 轻品牌背景、弱选中底色 |
| `on-primary` | `#FFFFFF` | 品牌色上的文字/图标色 |

`--always-black: 0 0% 0%` 是 HSL 片段，仅用于 `hsl(var(--always-black))` 的文字渐隐 mask，不作为颜色 token 或纯黑 CTA 色。

### 文字色
| Token | 色值 | 用途 |
| ---- | ---- | ---- |
| `text-primary` | `#20252A` | 正文主色 |
| `text-secondary` | `#5D6870` | 次要文字 |
| `text-tertiary` | `#89949B` | 辅助说明、placeholder |
| `text-disabled` | `rgba(93,104,112,0.48)` | 禁用态文字 |
| `delete` | `#8A2425` | 删除/危险操作 |

### 表面色
| Token | 色值 | 用途 |
| ---- | ---- | ---- |
| `surface-app` | `#F8FAFC` | 应用底色 |
| `surface-card` | `#FFFFFF` | 卡片/面板底色 |
| `surface-card-soft` | `#EEF3F5` | 柔和卡片/次要区域 |
| `surface-input` | `#FBFCFD` | 输入框背景 |

### 边框色
| Token | 色值 | 用途 |
| ---- | ---- | ---- |
| `border-default` | `#D6E0E5` | 默认边框 |
| `border-light` | `#0000000a` | 轻边框 |
| `border-muted` | `rgba(214,224,229,0.76)` | 柔和边框 |

### 交互态色
| Token | 色值 | 用途 |
| ---- | ---- | ---- |
| `interactive-hover` | `#EEF3F5` | 通用 hover 背景 |
| `interactive-selected` | `#E4EDF1` | 选中态背景 |
| `container-hover` | `rgba(0,0,0,0.05)` | 容器级 hover |

### 按钮 Token
| Token | 色值 | 用途 |
| ---- | ---- | ---- |
| `button-primary-active-bg` | `#075985` | 主按钮背景 |
| `button-primary-active-icon` | `#FFFFFF` | 主按钮图标/文字 |
| `button-primary-disabled-bg` | `#E0F2FE` | 主按钮禁用背景 |
| `button-primary-disabled-icon` | `rgba(115,114,108,0.5)` | 主按钮禁用图标 |
| `button-secondary-border` | `rgba(214,224,229,0.76)` | 次按钮默认边框 |
| `button-secondary-hover-border` | `#E0F2FE` | 次按钮 hover 边框 |
| `button-secondary-hover-bg` | `#EEF3F5` | 次按钮 hover 背景 |

### Schedule Token
| Token | 色值 | 用途 |
| ---- | ---- | ---- |
| `schedule-timeline-rail` | `#E4E1DA` | 时间线轨道 |
| `schedule-timeline-idle` | `#A9A8A3` | 未执行 / idle 节点 |
| `schedule-timeline-success` | `#48B96C` | 成功节点（语义色，亮暗一致） |
| `schedule-timeline-failed` | `#FF4D4F` | 失败节点（语义色，亮暗一致） |

### Notice / Advisory Token
输入框底部「连接和授权常用工具」等劝导/提示横幅使用以下成对 token，亮暗各一份；语义上属于「warning / advisory」，但目前只在这一处出现，不进入 brand preset 矩阵。

| Token | 亮色 | 暗色 | 用途 |
| ---- | ---- | ---- | ---- |
| `notice-warning-bg` | `#FFF8BED` | `rgba(195,96,0,0.14)` | 横幅背景 |
| `notice-warning-text` | `#C36000` | `#F5B26B` | 横幅文字 / 图标（`stroke="currentColor"`） |

### Markdown Token
| Token | 色值 | 用途 |
| ---- | ---- | ---- |
| `markdown-table-bg` | `transparent` | 表格背景 |
| `markdown-table-head-bg` | `rgba(0,0,0,0.04)` | 表头背景 |
| `markdown-table-head-color` | `#34322E` | 表头文字 |
| `markdown-table-divider` | `rgba(216,215,212,0.5)` | 表格分割线 |
| `markdown-table-scroll-shadow` | `rgba(52,50,46,0.16)` | 横向滚动阴影 |
| `markdown-table-scrollbar-thumb` | `rgba(115,114,108,0.28)` | 表格横向滚动条 |
| `markdown-blockquote-border` | `#D8D7D4` | 引用左边框 |
| `markdown-blockquote-text` | `#73726C` | 引用文字 |
| `markdown-link-color` | `#2C84DC` | 链接色 |
| `markdown-link-hover` | `#2C84DC` | 链接 hover |
| `markdown-link-focus-ring` | `rgba(198,98,64,0.28)` | 链接 focus ring 预留 token |
| `markdown-code-bg` | `transparent` | 代码块正文背景 |
| `markdown-code-header-bg` | `rgba(0,0,0,0.04)` | 代码块头部背景 |
| `markdown-code-header-text` | `#34322E` | 代码块语言标题文字 |

#### Markdown Dark Token
应用支持全局暗色模式，由 `<html data-theme="dark">` 切换，`.x-markdown-dark` 变量服务于 Markdown 暗色主题（由 `useMarkdownTheme()` 在 dark 下自动切换为 `x-markdown-dark` class）。新增/调整 Markdown 暗色 token 时同步本表与 `styles.css`。

| Token | 色值 | 用途 |
| ---- | ---- | ---- |
| `markdown-dark-table-bg` | `transparent` | 深色表格背景（与中性深色面板共底） |
| `markdown-dark-table-head-bg` | `rgba(255,255,255,0.04)` | 深色表头背景 |
| `markdown-dark-table-head-color` | `var(--text-primary)` | 深色表头文字（跟随暗色 text-primary） |
| `markdown-dark-table-text` | `var(--text-primary)` | 深色表格正文（跟随暗色 text-primary） |
| `markdown-dark-table-divider` | `rgba(255,255,255,0.1)` | 深色表格分割线 |
| `markdown-dark-table-strong` | `rgba(255,255,255,0.14)` | 深色表格强分割线 |
| `markdown-dark-table-row-hover` | `rgba(255,255,255,0.05)` | 深色行 hover 背景 |
| `markdown-dark-table-scroll-shadow` | `rgba(0,0,0,0.34)` | 深色横向滚动阴影 |
| `markdown-dark-table-scrollbar-thumb` | `rgba(255,255,255,0.2)` | 深色表格滚动条 |
| `markdown-dark-blockquote-bg` | `rgba(255,255,255,0.05)` | 深色引用背景 |
| `markdown-dark-blockquote-border` | `#D8D7D4` | 深色引用左边框 |
| `markdown-dark-blockquote-text` | `rgba(244,238,231,0.88)` | 深色引用文字 |
| `markdown-dark-link-color` | `#E9C7AA` | 深色链接 |
| `markdown-dark-link-hover` | `#F4EEE7` | 深色链接 hover |
| `markdown-dark-link-bg` | `rgba(233,199,170,0.12)` | 深色链接 hover 背景 |
| `markdown-dark-link-focus-ring` | `rgba(233,199,170,0.2)` | 深色链接 focus ring |
| `markdown-dark-code-bg` | `transparent` | 深色代码块正文背景 |
| `markdown-dark-code-header-bg` | `rgba(255,255,255,0.04)` | 深色代码块头部背景 |
| `markdown-dark-code-border` | `rgba(255,255,255,0.12)` | 深色代码块边框 |
| `markdown-dark-code-header-text` | `var(--text-secondary)` | 深色代码语言标题文字 |

深色 Markdown 主题中，`--markdown-table-row-alt` 为 `transparent`，`--markdown-table-shadow` 为 `none`，同样只在正文记录，不进入 YAML `colors`。

### Preview / Legacy 常量
以下值当前存在于 `styles.css` 的预览或第三方组件覆盖中，记录是为了如实反映运行时状态；新增业务样式不要复制这些硬编码值，应先沉淀 token。

| Token | 色值 | 用途 |
| ---- | ---- | ---- |
| `docx-preview-text` | `#2C2620` | mammoth HTML 预览正文 |
| `docx-preview-heading` | `#34322E` | mammoth HTML 预览标题 |
| `docx-preview-table-border` | `rgba(138,90,48,0.15)` | mammoth HTML 表格边框 |
| `docx-preview-table-head-bg` | `#F7F5F0` | mammoth HTML 表头背景 |
| `markdown-action-color` | `#73726C` | Markdown code / mermaid action 图标 |
| `artifact-code-bg` | `#FAF9F7` / `#1F1F1F` | Artifact 代码预览正文背景（亮/暗） |
| `artifact-code-header-bg` | `#F7F7F5` / `#262626` | Artifact 代码预览头部背景（亮/暗） |
| `artifact-code-header-text` | `#34322E` / `var(--text-secondary)` | Artifact 代码预览语言标题文字（亮/暗） |

## Themes
应用支持亮暗双主题，通过 `<html data-theme="light" | "dark">` 驱动。用户设置保存为 `system / light / dark`，`system` 由 Main process 使用 Electron `nativeTheme` 解析系统外观；Renderer 只消费最终 `resolvedTheme` 并同步 `.dark` class。

主题模式保存到 `settings.yml` 的 `ui.themeMode`。Main process 在启动和设置更新时设置 `nativeTheme.themeSource`，并通过 IPC 把主题变化同步给 Renderer。

### Dark Token
`:root[data-theme='dark']` 覆写下列 token；其余 token 保持 light 默认。语义色以及 `--always-black`、字体相关属性与主题无关。

暗色强调色不直接复用亮色高亮 cyan。桌面长期使用场景下，active 导航、tab、主按钮采用低亮度蓝青色，保持可见但不压过正文层级。

| Token | 暗色值 | 用途 |
| ---- | ---- | ---- |
| `chat-bg` | `#151615` | 聊天区背景 |
| `chat-fade-color` | `#171917` | 聊天淡入色 |
| `chat-container` | `#181A18` | 聊天容器 |
| `tab-active-bg` | `#252825` | Tab 激活背景 |
| `welcome-logo-bg` | `rgba(255,255,255,0.06)` | 欢迎页 Logo 底 |
| `welcome-title-color` | `#F2F4EF` | 欢迎页标题 |
| `text-primary` | `#F2F4EF` | 正文主色 |
| `text-secondary` | `#C3C9C0` | 次要文字 |
| `text-tertiary` | `#8E978B` | 辅助说明 |
| `text-disabled` | `rgba(242,244,239,0.36)` | 禁用文字 |
| `surface-app` | `#151615` | 应用底色 |
| `surface-card` | `#1D1F1D` | 卡片/面板 |
| `surface-card-soft` | `#252825` | 柔和卡片 |
| `surface-input` | `#202320` | 输入框背景 |
| `border-default` | `rgba(255,255,255,0.1)` | 默认边框 |
| `border-light` | `rgba(255,255,255,0.05)` | 轻边框 |
| `border-muted` | `rgba(255,255,255,0.08)` | 柔和边框 |
| `divider-color` | `rgba(255,255,255,0.06)` | 分割线 |
| `container-hover` | `rgba(255,255,255,0.05)` | 容器 hover |
| `container-selected` | `rgba(255,255,255,0.08)` | 容器选中 |
| `scroll-bar-color` | `rgba(255,255,255,0.2)` | 滚动条 thumb |
| `button-disable` | `rgba(255,255,255,0.08)` | 按钮禁用底 |
| `button-primary-disabled-bg` | `rgba(255,255,255,0.08)` | 主按钮禁用底 |
| `button-primary-disabled-icon` | `rgba(255,255,255,0.36)` | 主按钮禁用图标 |
| `button-secondary-border` | `rgba(255,255,255,0.12)` | 次按钮边框 |
| `schedule-timeline-rail` | `#2c2c2c` | 暗色时间线轨道 |
| `schedule-timeline-idle` | `#6a6a6a` | 暗色 idle 节点 |
| `brand-tooltip` | `#3a3a3a` | Tooltip 底 |
| `delete-text` | `#FF6B6B` | 危险文字（亮度提升） |
| `notice-warning-bg` | `rgba(195,96,0,0.14)` | Notice 横幅背景 |
| `notice-warning-text` | `#F5B26B` | Notice 横幅文字 / 图标 |

暗色基色取自灰阶体系，层级清晰，贴合原生深色面板视觉调性。

### Theme Modes
当前只实现主题模式，不实现多品牌预设。后续如需品牌色扩展，再引入 `data-brand`。
顶部主题切换使用单图标按钮，占用一个工具按钮位置；点击按 `system → light → dark → system` 循环，图标表达当前模式。

| 模式 | 存储值 | 渲染方式 |
| ---- | ---- | ---- |
| 跟随系统 | `system` | Main process 设置 `nativeTheme.themeSource = "system"`，将 resolved theme 同步给 Renderer |
| 亮色 | `light` | 固定渲染瓷白深海蓝亮色 |
| 暗色 | `dark` | 固定渲染石墨深灰暗色 |

### 主题协作规约
- 新增颜色 token 先更新文档表格，再同步样式文件
- 业务 UI 禁止直接使用裸色值，统一调用 CSS 变量
- 主题色不干扰成功、警告、错误类语义色展示
- 暗色变体与主题选择器效果等效，优先使用设计变量

## Typography
| 用途 | 字体 | 字号 | 字重 | 行高 |
| ---- | ---- | ---- | ---- | ---- |
| 正文 | `-apple-system, BlinkMacSystemFont, system-ui` | 15px | 400 | 1.6 |
| 标题 | `-apple-system, BlinkMacSystemFont, system-ui` | 18px | 600 | 1.35 |
| 衬线 | `Source Han Serif SC, Noto Serif SC, Georgia` | 15px | 400 | 1.6 |

Markdown 标题层级尺寸：h1=18px、h2=17px、h3=16px、h4/h5/h6=15px，全部加粗展示。
消息卡片支持自定义字号档位13px-18px，配套字体平滑渲染优化。

### 字体层级
业务 UI 需要明确区分 title / label / value / meta / action：
- 页面标题 28-30px / 650，仅欢迎区使用；普通面板标题 18px / 600。
- 列表主标题 14-15px / 600，描述和 meta 12-13px / 500，避免整行 700+ 造成信息糊成一片。
- 菜单、下拉、popover 的 item 使用 13-14px / 600；选中态通过背景、左侧细线或 check 图标表达，不依赖加粗。
- 表单 label 使用 13px / 600 和 `text-secondary`；输入值使用 14-15px / 500 和 `text-primary`。
- Chip / tag 默认 13px / 600，长文本必须截断；只有 active chip 使用品牌色。

## Layout
- 窗口区分可拖拽与非拖拽区域，管控标题栏交互
- 全局滚动条宽度6px，轨道透明，hover状态加深显示
- 聊天区域滚动条默认隐藏，滚动动作触发后展示
- 支持一键隐藏滚动条样式
- 窗口缩放过程禁用过渡动画，避免界面抖动
- 悬浮回底按钮搭配动态效果提示内容更新状态
- 按钮区分小中大三种内边距规格

## Elevation
仅下述场景使用阴影层级效果：
- 卡片组件：仅允许微阴影或内描边划分界面层次
- 下拉浮层：阴影凸显悬浮状态
- 内联权限请求卡片：模糊效果搭配低强度阴影
- 聊天悬浮控制按钮：保证界面上层可视性
- Markdown 表格滚动阴影：提示横向可滑动内容

普通面板、列表条目不额外添加阴影样式。工作台、技能中心、自动化中心这类高频操作界面优先使用边框、背景层级和选中细线表达结构，避免营销页式大投影、强渐变和大面积高饱和色。

## Shapes
| 组件 | 圆角 | CSS 变量 |
| ---- | ---- | ---- |
| 按钮 | 0.5rem | `rounded.button` |
| 输入框 | 0.5rem | `rounded.input` |
| 提示框 | 0.5rem | `rounded.tooltip` |
| 卡片/面板 | 0.625rem | `rounded.card` |
| 弹窗 | 0.75rem | `rounded.dialog` |
| 表格 | 0.5rem | `rounded.table` |
| 菜单 | 0.5rem | `rounded.menu` |
| 选择卡片 | 0.625rem | `rounded.selection-card` |

Markdown 表格固定圆角8px，由专属变量统一控制。

## Components
组件使用优先级
1. 优先复用项目内通用组件库
2. 全局样式类作为组件基础，兼容老旧页面场景
3. 通用交互功能统一封装组件，禁止页面零散复制样式

### 按钮体系
业务页面统一引入封装按钮组件，自动适配各类状态与尺寸，常规场景不手写原生按钮标签。

| 类名 | 用途 | 背景 | 文字色 | 圆角 |
| ---- | ---- | ---- | ---- | ---- |
| `.ui-brand-button` | 主操作 | `primary` | `on-primary` | 0.5rem |
| `.ui-soft-button` | 次操作 | `brand-soft` | `brand-text` | 0.5rem |
| `.ui-ghost-button` | 取消/返回 | transparent | `text-secondary` | 0.5rem |
| `.ui-tertiary-button` | 图标/轻量 | transparent | `brand-text` | 0.5rem |

按钮尺寸：图标/小尺寸2rem、常规2.25rem、弹窗主操作2.5rem。工具栏可使用2.75rem，但不得在同一操作组内混用三种以上高度。
所有按钮标配聚焦可视交互样式

#### Button API 对应关系
| Prop | 可选值 | 用途 |
| ---- | ---- | ---- |
| `variant` | `primary`/`secondary`/`tertiary` | 区分操作权重 |
| `size` | `sm`/`md`/`lg` | 控制按钮高度规格 |
| `presentation` | `surface`/`text` | 填充样式或纯文本样式 |
| `tone` | `default`/`danger` | 标记危险操作类型 |
| `loading` | 布尔值 | 加载态禁用与动画展示 |

危险操作规范：删除清空类操作使用轻量化危险样式，不随意新增红色主按钮。

### 输入框
统一使用通用输入框样式类，复用边框、选中、聚焦主题变量，禁用状态搭配专属样式标识。

### 样式收敛规则
- 业务 UI 使用 `--surface-*`、`--text-*`、`--brand-*`、`--border-*`、`--danger-*` 等变量；允许裸色值仅用于文档/Markdown/第三方预览的 legacy 兼容区，并在本文件登记。
- 主操作按钮使用纯品牌色或极轻微同色系状态变化，不使用蓝紫渐变；危险按钮使用 `danger` 语义色，不用作普通强调。
- 弹窗、菜单、popover、表格、列表和表单控件共用同一套圆角、边框、hover、selected、focus-visible 状态。
- 亮暗主题必须同步验证；新增亮色样式时必须给出暗色下等效 token 表达，禁止把亮色背景硬编码进浮层和输入框。

### Menu / Popover
菜单、下拉和 popover 用于高频选择，不做大按钮视觉。默认背景使用 `surface-panel`，边框使用 `border-muted`，阴影只用于表达悬浮层级，不能出现营销页式大投影。

- 菜单标题、分组名使用 `text-secondary` 或 `text-tertiary`，字号 12-13px，不抢占 item 主信息。
- 可选择对象的主名称必须使用 `text-primary`；暗色模式下也不能退到 `text-tertiary`，避免目录名、账号名、模型名不可读。
- 对象图标、路径、授权说明、状态说明使用 `text-secondary` 或 `text-tertiary`，与主名称形成清晰层级。
- hover / focus-visible 只改变背景和必要的主文字色，不把主名称压暗；selected 通过弱背景、check 图标或左侧 3px 细线表达。
- 长对象名必须截断，保留 tooltip/title 展示完整信息。

### Object Picker
目录、模型、连接器账号、Skill 等对象选择器优先使用“对象列表 / listbox”表达，不把每一项做成厚重按钮。

- 单对象行建议结构为：leading icon/status + primary label + optional meta + trailing action/check/switch。
- 连接器这类二级选择器使用“平台菜单 + 账号列表”组合，平台只表达类别，账号列表表达授权状态、删除、开关等操作。
- 目录和文件类选择器中，目录名/文件名始终是主信息；图标和“最近使用的目录”等说明只作为辅助信息。
- Chip / tag 用于多选已选结果，不承担完整详情展示；长文本截断，只有 active/selected 状态使用品牌弱背景。

### Switch / 开关
全局二态开关统一使用组件库开关控件，固定小号尺寸。
开关激活色全局统一配置，不受主题色切换影响，全页面视觉样式保持一致。

### 交互态
包含悬浮、选中、菜单、卡片、聚焦等全套交互样式类，覆盖常规界面操作反馈场景。

### AppDialog
弹窗统一使用封装弹窗组件，内部控件、按钮沿用全局规范样式。

### Markdown / Preview / Feedback
- 富文本内容统一调用专属渲染组件，统一排版间距与字号
- 表格支持横向滚动、自适应宽、文本自动换行
- 代码块、引用、链接样式遵循设计规范
- 各类文档预览使用专用预览组件，区分文档排版样式
- 提示气泡、全局通知使用项目统一封装工具

### Schedule 控件样式
计划页面表单控件使用专属桥接样式，复用已有样式体系，不重复覆写组件默认样式。

## Motion
系统适配减弱动画偏好设置，包含滑动、呼吸、脉冲、光标、加载等动效；品牌渐变特效仅用作装饰展示，不作为通用颜色变量使用。

## 文本截断
侧边栏、标签页标题提供省略截断、渐变隐没两种文字溢出处理方案，规避原生样式冲突问题。

## Agent Implementation Guardrails
- 样式开发严格遵循本文档规范，局部需求不违背全局设计体系
- 通用功能优先调用现有组件，减少重复开发
- 禁止私自使用固定色值、私自修改基础按钮样式
- 特殊场景局部样式覆盖需标注原因，遵循项目校验规则

## Do's and Don'ts
### ✅ 规范做法
- 样式变更同步更新设计文档与样式文件
- 最大化复用已有组件与公共样式
- 采用CSS变量管理色彩样式
- 交互元素完备hover、选中、聚焦状态反馈
- 状态色仅用于标识业务语义

### ❌ 禁止做法
- 脱离全局规范自定义独立样式体系
- 重复编写已有通用组件功能
- 代码内硬编码颜色数值
- 零散定义全局通用样式规则
- 手写原生开关控件、私自篡改控件默认样式
