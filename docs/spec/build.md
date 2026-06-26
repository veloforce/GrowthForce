  npm run build
    -> bash scripts/build.sh
        -> 根据 package-lock.json 哈希同步 node_modules
        -> npm run generate:icons
        -> npm run compile
            -> npm run typecheck
            -> npm run build:renderer
            -> npm run build:node
        -> 按当前机器平台执行 electron-builder
            mac: npx electron-builder --mac dmg --当前架构
            win: npx electron-builder --win nsis --x64
            linux/其他: 只 compile，不打安装包

  npm run build

  - 本地“一键构建 + 当前平台打包”入口。
  - 实际只是调用 scripts/build.sh。
  - 在 mac x64 上会产出 mac x64 DMG；在 mac arm64 上会产出 mac arm64 DMG；在
    Windows 上会产出 Windows x64 NSIS 安装包。

  scripts/build.sh

  - 是 npm run build 背后的真实脚本。
  - 做四件事：同步依赖、生成图标、编译、按当前平台打包。
  - 它不是跨平台矩阵构建，只打“当前机器对应平台/架构”。

## 本地依赖同步

- `scripts/sync-dependencies.sh` 是 `dev.sh` 和 `build.sh` 共用的依赖同步入口。
- 脚本计算当前 `package-lock.json` 的 SHA-256，并与
  `node_modules/.agentstudio-package-lock.sha256` 比较。
- `node_modules` 不存在、哈希记录不存在或哈希不一致时，执行
  `npm install --cache .npm-cache`；安装成功后才原子更新哈希记录。
- 哈希一致时跳过安装，避免每次开发启动都执行 npm 依赖解析。
- 安装失败时不更新哈希记录，并依靠调用方的 `set -e` 阻止后续构建或开发进程启动。
- 常规依赖同步后会额外验证 Electron 的 `path.txt` 和当前平台可执行文件；如果 npm 包存在但
  二进制不完整（例如之前使用过 `npm install --ignore-scripts`），自动执行
  `npm rebuild electron`，并在修复后再次验证。
- 如果 npm rebuild 返回成功但二进制仍不完整，则复用 `@electron/get` 的官方制品与缓存，
  使用当前系统的原生 ZIP 解压能力重建 `dist` 和 `path.txt`。该兜底用于规避部分 Node/npm
  组合下 Electron 安装脚本提前退出但返回成功的问题。
- Electron 自动修复失败或修复后仍缺少可执行文件时立即终止，避免进入 Vite/TypeScript
  watch 后才报告 Electron 安装错误。
- `scripts/dev.sh` 在当前平台的 XHS sidecar executable 不存在时，会自动执行
  `npm run build:xhs-sidecar`。构建脚本负责探测 Python 3.11+；未找到兼容解释器时输出安装
  或 `PYTHON` 配置提示并终止，构建完成后 `dev.sh` 会再次验证 executable，避免在 sidecar
  不完整时继续启动 Vite/Electron。
- 显式设置 `AGENTSTUDIO_XHS_ALLOW_SOURCE_CLI=1` 时跳过自动 sidecar 构建，保留 Python
  源码调试入口。

  平台打包脚本：

  - npm run package:mac
  - npm run package:mac:x64
  - npm run package:mac:arm64
  - npm run package:win

  这些是更明确的打包命令，调用关系是：

  npm run package:mac:x64
    -> npm run compile
    -> electron-builder --mac dmg --x64

  npm run package:mac:arm64
    -> npm run compile
    -> electron-builder --mac dmg --arm64

  npm run package:win
    -> npm run compile
    -> electron-builder --win nsis --x64

  GitHub 打包：

  - 配置在 .github/workflows/release.yml。
  - 只在 push tag v* 时触发。
  - 它不调用 npm run build，也不调用 scripts/build.sh。
  - 它自己显式执行：

  npm ci --include=optional
  检查对应平台 claude native binary 存在
  npm run generate:icons
  npm run compile
  npx electron-builder --对应平台
  上传 artifact
  发布 GitHub Release

  GitHub 这么写更适合发布，因为它分别在三种 runner 上打：

  - macos-15-intel -> mac x64 DMG
  - macos-15 -> mac arm64 DMG
  - windows-latest -> Windows x64 NSIS

  每个平台打包完成后会执行：

  npm run verify:package -- --platform <platform> --arch <arch>

  这个校验用于防止发布旧包、错架构包或缺资源包。macOS 包会检查 app bundle
  版本、可执行文件架构、LSMinimumSystemVersion、app.asar 入口文件，以及 bundled
  skills / market / prompts / native sidecar 资源；Windows 包会检查 unpacked app、
  app.asar 入口文件、bundled resources 和 win32 native sidecar 资源。

  简单说：

  - 本地快速打当前机器包：npm run build
  - 本地指定平台/架构：npm run package:*
  - 正式发布多平台包：push v* tag 触发 GitHub workflow
  - scripts/build.sh 是本地 npm run build 的实现，不是 GitHub release 的实现。

## Bundled tool dependency boundary

- Tool source remains under `resources/tools/<tool>/src`; tools are discovered from
  `tool.json` and are not compiled into the main-process `app.asar`.
- `scripts/build-tools.cjs` bundles every tool entry and all of its business JavaScript
  dependencies into `resources/tools/<tool>/dist/index.js`.
- Tool bundles may retain only Node.js built-in imports. Claude SDK MCP constructors are
  supplied by the main process through the shared tool runtime bridge, so bundles do not
  resolve packages from `app.asar/node_modules`.
- The build fails when a generated tool bundle contains any non-built-in bare import or
  require. This makes adding a tool dependency self-contained by default and prevents an
  installed app from depending on development-time `node_modules` lookup.
- Package verification checks every bundled tool entry and creates every declared MCP
  server from the packaged `Resources/resources/tools` directory.
