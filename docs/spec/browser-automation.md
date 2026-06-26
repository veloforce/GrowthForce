# Browser Automation Runtime

## Goal

Provide each Agent session with an independent Electron browser page while sharing one local login profile for the default user.

## Runtime Model

- Main process owns all browser state through `BrowserSessionManager`.
- Each Agent session gets one `WebContentsView`.
- Browser views are created lazily when a session receives a new Agent request. Manual turns default to attempting browser runtime creation even when the right panel is closed.
- If runtime creation fails, the Agent turn still starts without browser env; browser MCP tools then return `browser_runtime_missing`.
- All browser views use the shared Electron session at `~/.agentstudio/user-profile/default`.
- The shared profile path is created at app runtime only, never by the installer.

## CDP Integration

- App startup selects a random available local port and enables Electron remote debugging on `127.0.0.1`.
- The selected CDP port is stored only in Main process memory.
- Each new browser view loads a unique bootstrap title; Main discovers the matching CDP target from `/json/list`.
- Browser target binding is resolved inside Main. Main first asks the created `WebContentsView.webContents.debugger` for `Target.getTargetInfo`, then uses that target id to find the page-level `webSocketDebuggerUrl` from `/json/list`. If the debugger path is unavailable, Main falls back to matching a newly created bootstrap target by title and token.
- Claude Code and its Bash subprocesses receive browser runtime data through query env:
  - `AGENTSTUDIO_BROWSER_CDP_PORT`
  - `AGENTSTUDIO_BROWSER_CDP_WS_URL`
- In-process browser MCP servers receive the same values through the immutable per-Run
  `ToolServerContext`; they must not read Utility process `process.env`.
- The Agent prompt must not include raw browser commands, CDP URLs, target ids, or session names.
- Browser automation is exposed through MCP tools rather than instructing the Agent to run raw browser commands directly.
- Browser MCP tools must operate on the Run-scoped page-level CDP WebSocket URL directly and must not use commands that implicitly create or switch to another CDP page. The generic browser target id is a Main-process implementation detail and is not exposed to the Agent process.

## Browser Web Tools

- `resources/tools/browser` provides an in-process SDK MCP server.
- `web_search(query, maxResults?)` opens `https://cn.bing.com/search?q=...&setlang=zh-CN&mkt=zh-CN`, extracts title/link/snippet results, and falls back to Baidu when results are empty or blocked.
- One Agent session owns one browser target and `web_search` navigates that target. Multiple searches in
  the same session must run sequentially; parallel `web_search` calls are unsupported.
- `web_fetch(url, outputPath?, preferBrowser?)` fetches HTML with HTTP GET first, then falls back to the default browser runtime when HTTP fails, content is blocked, content is too short, or `preferBrowser` is true.
- URLs matching the direct-browser list skip HTTP and use browser rendering directly. v1 direct-browser list contains `https://mp.weixin.qq.com/`.
- Successful `web_fetch` calls convert content to Markdown with Turndown and write a `.md` file under `~/.agentstudio/workspace/web-fetch/` by default. Caller-provided relative `outputPath` resolves under `~/.agentstudio/workspace/`; absolute paths and `~/` paths write to the user-specified local location.
- For `mp.weixin.qq.com` article URLs, `web_fetch` applies WeChat-specific extraction: prefer `#js_content` / `.rich_media_content`, extract article title/author/publish time from WeChat DOM selectors, and read hidden article text with `textContent` fallback.
- All pages prefer lazy-load sources (`data-src`, `data-original`, `data-lazy-src`, related srcset fields) before `src`. Markdown conversion drops data URIs, tracking pixels, 1px images, common placeholder/shim/theme paths, and obvious site-logo/navigation-icon/avatar images. Real content images are represented inline as short `[图片 N]` placeholders and listed with absolute URLs in a final `Images` section.
- Markdown conversion removes clear non-content noise such as `script`, `style`, `noscript`, hidden SVG sprite/iconfont blocks, and common ad/script residue. It must not infer article structure from visual-only cues such as standalone section numbers, font size, color, or suspected image captions.
- `web_fetch` returns `blocked/verification` for verification pages such as WeChat "环境异常/去验证".
- 公众号文章和其他网页内容采集统一使用 `web_fetch`；排版 Skill 不提供独立抓取实现。
- Tools return `browser_runtime_missing` when the browser env is absent.
- Tools do not bypass login walls, captchas, or platform verification pages.
- Tools must not create extra tabs/pages for `web_search` or browser fallback `web_fetch`; navigation and extraction happen inside the Main-managed session target.
- Generic browser automation tools operate on the same Main-managed session target:
  - `browser_navigate`
  - `browser_snapshot`
  - `browser_click`
  - `browser_fill`
  - `browser_type`
  - `browser_press`
  - `browser_scroll`
  - `browser_wait`
  - `browser_get`
  - `browser_screenshot`
- Element targets may use CSS selectors, temporary `@eN` refs from `browser_snapshot`, or semantic locators by role/name, text, label, placeholder, alt, title, and `data-testid`.
- `@eN` refs are page-scoped and become stale after navigation.
- Generic browser automation tools must not expose `new tab`, `switch tab`, `close tab`, raw CDP URLs, session names, or target ids.
- `browser_navigate` treats an accepted navigation with a readable resulting page as successful even when its requested load-state wait times out. The result includes `navigationWarning`; callers may use `browser_wait` when they require a stronger readiness condition.
- `browser_navigate` waits up to 20 seconds by default; other generic browser operations keep their 10-second default timeout.

## UI Surface

- The workbench right panel contains a native browser surface placeholder.
- Renderer reports browser surface state through `browser:surface:update`.
- Renderer tracks the right panel mode explicitly. Only workbench browser mode is allowed to report `visible: true`.
- Opening an artifact/file preview uses artifact mode; the right panel may be open, but the browser remains offscreen.
- `visible: true` means the user has explicitly opened the workbench browser panel and the browser placeholder has valid bounds; Main places that session's `WebContentsView` over the placeholder bounds.
- `visible: false` means the browser must not be shown in the app UI; Main keeps the headed `WebContentsView` running but detaches it from the main window content view.
- The shared automation profile keeps cookies and localStorage but disables Electron's disk HTTP cache so a corrupted `Cache/Cache_Data` cannot prevent browser startup.
- Main only accepts visible bounds for the matching session when the rectangle is finite, non-empty, and inside the main window content area. Invalid bounds fall back to offscreen hidden placement.
- Main only attaches a `WebContentsView` to the main window for a valid visible surface, and always sets the target bounds before attaching, so hidden runtimes cannot flash at their old or initial bounds.
- XHS login uses a separate hidden-by-default `BrowserWindow` and is shown only during explicit login authorization. General XHS automation and generic browser tools stay offscreen.
- Idle session browser runtimes are released after 120 minutes.

## Packaging

- Generic browser automation does not package or depend on `agent-browser`.
- The app never downloads Chrome for Testing and never depends on global browser automation CLIs.

## Test Scenarios

- A historical session creates or reuses a browser runtime when it receives a new Agent request.
- Browser runtime creation failure does not fail the Agent turn.
- Two sessions keep independent URLs and DOM state.
- Two sessions share cookie and localStorage through `~/.agentstudio/user-profile/default`.
- Closing the right panel detaches the browser view from the main window while browser MCP tools can still operate through CDP.
- Opening an artifact/file preview does not make the browser surface visible.
- `web_search` returns structured results or falls back from Bing to Baidu.
- `web_fetch` writes Markdown for successful HTTP or browser fetches.
- `web_fetch` supports absolute and `~/` output paths outside `~/.agentstudio/workspace/`, while relative output paths remain workspace-relative.
- `web_fetch` does not emit long `data:image/svg+xml` placeholder image URLs in Markdown output.
- `web_fetch` removes obvious script/style/SVG-sprite noise from Markdown output without merging section numbers or deleting suspected captions.
- `web_fetch` skips HTTP for `mp.weixin.qq.com` and returns `blocked/verification` for WeChat verification pages instead of fabricated article content.
- `web_fetch` uses WeChat article metadata and chooses lazy-load image sources over placeholder `src` for both WeChat and generic webpages.
- A real local HTTP article with lazy-loaded content images produces ordered absolute URLs while placeholder, tracking, data URI, logo, and icon images are omitted.
- `browser_navigate` rejects non-http/https URLs and does not create a new CDP target.
- `browser_snapshot` returns stable temporary refs for common interactive elements.
- `browser_click`, `browser_fill`, `browser_type`, `browser_press`, `browser_scroll`, `browser_wait`, and `browser_get` work with CSS, snapshot refs, and semantic locators.
- `browser_screenshot` writes a real screenshot file under the workspace default when no output path is provided.
- Old snapshot refs fail with `stale_ref` after page navigation.
- CDP port selection retries when a candidate port is occupied.
- Packaged mac/Windows builds do not contain `agent-browser` binaries.
