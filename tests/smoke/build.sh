#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

required_files=(
  "dist/main/main.js"
  "dist/preload/preload.js"
  "dist/agent/agent.js"
  "dist/renderer/index.html"
  "build/icon.icns"
  "build/icon.ico"
  "resources/icons/app-icon.icns"
  "resources/icons/app-icon.ico"
  "resources/icons/app-icon.png"
  "resources/market/skills.yml"
  "resources/prompts/workbench-examples.json"
  "resources/agents/orchestrator.yml"
  "resources/tools/image/tool.json"
  "resources/tools/image/dist/index.js"
  "resources/tools/image/assets/fonts/JiangChengZhiYinTi-600W.ttf"
  "resources/tools/image/assets/fonts/JiangChengZhiYinTi-400W.ttf"
  "resources/tools/image/assets/fonts/OFL-1.1.txt"
  "resources/tools/content_ops_data/tool.json"
  "resources/tools/content_ops_data/dist/index.js"
  "resources/tools/content_research/tool.json"
  "resources/tools/content_research/dist/index.js"
  "resources/tools/content_analysis/tool.json"
  "resources/tools/content_analysis/dist/index.js"
  "resources/tools/wechat_ops/tool.json"
  "resources/tools/wechat_ops/dist/index.js"
  "scripts/verify-package.cjs"
)

for file in "${required_files[@]}"; do
  if [ ! -s "$file" ]; then
    echo "Missing required build artifact: $file" >&2
    exit 1
  fi
done

# dist 新鲜度守卫：防止改了 src/index.ts 忘记重建 dist/index.js
for src_file in \
  "resources/tools/browser/src/index.ts" \
  "resources/tools/image/src/index.ts" \
  "resources/tools/content_ops_data/src/index.ts" \
  "resources/tools/automation/src/index.ts" \
  "resources/tools/wechat_ops/src/index.ts"; do
  dist_file="${src_file/src\/index.ts/dist\/index.js}"
  src_mtime=$(node -e "process.stdout.write(String(Math.floor(require('fs').statSync('$src_file').mtimeMs)))")
  dist_mtime=$(node -e "process.stdout.write(String(Math.floor(require('fs').statSync('$dist_file').mtimeMs)))")
  if [ "$src_mtime" -gt "$dist_mtime" ]; then
    echo "dist 未重建：$src_file 比 $dist_file 更新，请先运行 npm run build:tools" >&2
    exit 1
  fi
done

node - <<'NODE'
const fs = require("fs");
const path = require("path");

const releaseWorkflow = fs.readFileSync(path.join(".github", "workflows", "release.yml"), "utf8");
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (packageJson.build.appId !== "com.growthforce.desktop") {
  throw new Error(`Expected GrowthForce appId com.growthforce.desktop, got ${packageJson.build.appId}`);
}
if (!releaseWorkflow.includes("runs-on: macos-15\n")) {
  throw new Error("Expected macOS arm64 release job to run on macos-15");
}
for (const command of [
  "npm run verify:package -- --platform darwin --arch x64",
  "npm run verify:package -- --platform darwin --arch arm64",
  "npm run verify:package -- --platform win32 --arch x64"
]) {
  if (!releaseWorkflow.includes(command)) {
    throw new Error(`Expected release workflow to verify package artifact with: ${command}`);
  }
}
const generateIconRuns = releaseWorkflow.match(/npm run generate:icons/g) || [];
if (generateIconRuns.length < 3) {
  throw new Error("Expected release workflow to generate icons before every platform package build");
}

const verifyPackageScript = fs.readFileSync(path.join("scripts", "verify-package.cjs"), "utf8");
for (const expected of [
  "CFBundleIdentifier",
  "CFBundleIconFile",
  "icon.icns",
  "assertFilesEqual(bundleIcon",
  "CFBundleShortVersionString",
  "CFBundleVersion",
  "LSMinimumSystemVersion",
  "dist/renderer/index.html",
  "market\", \"skills.yml",
  "prompts\", \"workbench-examples.json",
  "claude-agent-sdk-darwin-arm64",
  "resources\", \"connectors\", \"xhs\", \"bin\", \"darwin\", arch, \"xhs-cli\", \"xhs-cli",
  "JiangChengZhiYinTi-600W.ttf",
  "JiangChengZhiYinTi-400W.ttf",
  "OFL-1.1.txt",
  "function normalizeAsarEntry(entry)",
  "replace(/\\\\/g, \"/\")",
  "function summarizeEntries(entries, prefix)"
]) {
  if (!verifyPackageScript.includes(expected)) {
    throw new Error(`Expected package verification script to check ${expected}`);
  }
}

const buildScript = fs.readFileSync(path.join("scripts", "build.sh"), "utf8");
if (!buildScript.includes("npm run generate:icons") || buildScript.indexOf("npm run generate:icons") > buildScript.indexOf("npm run compile")) {
  throw new Error("Expected scripts/build.sh to generate icons before compiling and packaging");
}

const devScript = fs.readFileSync(path.join("scripts", "dev.sh"), "utf8");
if (!devScript.includes("AGENTSTUDIO_DEV_MODEL_HTTP_LOGS=dev.sh")) {
  throw new Error("Expected dev.sh --debug path to inject model HTTP logging env");
}
if (!devScript.includes("--debug") || !devScript.includes('MODEL_HTTP_LOG_ENV=""')) {
  throw new Error("Expected dev.sh to keep model HTTP logging disabled by default and enable it only via --debug");
}
if (devScript.includes("cross-env VITE_DEV_SERVER_URL=http://127.0.0.1:5173 AGENTSTUDIO_DEV_MODEL_HTTP_LOGS=dev.sh electron .")) {
  throw new Error("Expected dev.sh default command not to unconditionally enable model HTTP logging");
}

const mainSource = fs.readFileSync(path.join("src", "main", "main.ts"), "utf8");
const rendererSource = fs.readFileSync(path.join("src", "renderer", "src", "App.tsx"), "utf8");
const databaseSource = fs.readFileSync(path.join("src", "main", "database.ts"), "utf8");
const browserSessionSource = fs.readFileSync(path.join("src", "main", "browser-session.ts"), "utf8");
const browserFingerprintSource = fs.readFileSync(path.join("src", "main", "browser-fingerprint.ts"), "utf8");
for (const requiredPolicyCall of ["configureBrowserSessionFingerprint"]) {
  if (!browserSessionSource.includes(requiredPolicyCall)) {
    throw new Error(`Expected regular browser sessions to apply ${requiredPolicyCall}`);
  }
}
const { createBrowserFingerprintIdentity } = require(path.resolve("dist", "main", "browser-fingerprint.js"));
for (const scenario of [
  { platform: "darwin", arch: "arm64", expectedPlatform: "macOS", expectedUa: "Macintosh" },
  { platform: "win32", arch: "x64", expectedPlatform: "Windows", expectedUa: "Windows NT" },
  { platform: "linux", arch: "x64", expectedPlatform: "Linux", expectedUa: "Linux x86_64" }
]) {
  const identity = createBrowserFingerprintIdentity({
    chromeVersion: "144.2.3.4",
    locale: "zh-CN",
    platform: scenario.platform,
    arch: scenario.arch
  });
  if (!identity.userAgent.includes("Chrome/144.2.3.4") || !identity.userAgent.includes(scenario.expectedUa)) {
    throw new Error(`Unexpected browser fingerprint UA for ${scenario.platform}: ${identity.userAgent}`);
  }
  if (/Electron\/|agentstudio\/|growthforce\//i.test(identity.userAgent)) {
    throw new Error(`Browser fingerprint leaked app identity: ${identity.userAgent}`);
  }
  if (identity.userAgentMetadata.platform !== scenario.expectedPlatform) {
    throw new Error(`Unexpected Client Hints platform for ${scenario.platform}: ${identity.userAgentMetadata.platform}`);
  }
  if (identity.acceptLanguage !== "zh-CN,zh,en-US,en") {
    throw new Error(`Unexpected browser accept-language: ${identity.acceptLanguage}`);
  }
}
if (databaseSource.includes("auto_review_enabled") || databaseSource.includes("autoReviewEnabled: record")) {
  throw new Error("Expected connector auto-review enabled state not to be persisted in ops_state");
}
if (!mainSource.includes("autoReviewEnabled: Boolean(account.opsState.reviewTaskId && tasksById.get(account.opsState.reviewTaskId)?.enabled)")) {
  throw new Error("Expected connector auto-review switch state to be derived from linked automation task enabled state");
}
if (!mainSource.includes("function unlinkAccountReviewTask") || !mainSource.includes('db.updateConnectorAccountOpsState(account.platform, account.profileKey, { reviewTaskId: null })')) {
  throw new Error("Expected deleting an automation task to unlink connector review task state");
}
if (!rendererSource.includes("void refreshConnectorState();") || !rendererSource.includes('activeView !== "automation"')) {
  throw new Error("Expected renderer to refresh connector state from automation:changed without requiring automation view");
}
if (!mainSource.includes("function configurePackagedRendering()")) {
  throw new Error("Expected packaged rendering configuration to be explicit in main process");
}
if (!mainSource.includes("if (isDev) return") || !mainSource.includes("app.disableHardwareAcceleration()")) {
  throw new Error("Expected packaged runtime to disable hardware acceleration while leaving dev mode enabled");
}
for (const gpuSwitch of ['appendSwitch("disable-gpu")', 'appendSwitch("disable-gpu-compositing")']) {
  if (!mainSource.includes(gpuSwitch)) {
    throw new Error(`Expected packaged runtime to set Chromium GPU switch: ${gpuSwitch}`);
  }
}
const renderingConfigIndex = mainSource.indexOf("configurePackagedRendering();");
const bootstrapIndex = mainSource.indexOf("void bootstrapMain();");
if (renderingConfigIndex < 0 || bootstrapIndex < 0 || renderingConfigIndex > bootstrapIndex) {
  throw new Error("Expected packaged rendering configuration to run before bootstrapMain/app.whenReady");
}
if (!mainSource.includes("xhsContext = input.xhsProfileKey ? await ensureXhsContext(input.xhsProfileKey, request.requestId) : undefined")) {
  throw new Error("Expected XHS connector runtime to be driven by request xhsProfileKey");
}
if (mainSource.includes("function shouldUseXhsConnector") || mainSource.includes("shouldUseXhsConnector(selectedSkills)")) {
  throw new Error("Expected XHS connector runtime not to be driven by selected skill names");
}
if (!rendererSource.includes("xhsAuthorizingProfileKey") || !rendererSource.includes("setXhsAuthorizingProfileKey(profileKey)")) {
  throw new Error("Expected renderer to track the XHS account currently waiting for authorization");
}
if (!rendererSource.includes("if (connectorBusy)") || !rendererSource.includes("xhsAuthorizingProfileKey !== profileKey") || !rendererSource.includes("await window.agentStudio.startXhsLogin(profileKey);")) {
  throw new Error("Expected renderer to reopen the current XHS login window while wait-login is still pending");
}
if (!rendererSource.includes("connectorBusy && !isCurrentAuthorizing")) {
  throw new Error("Expected renderer to keep the current authorizing XHS account clickable while other connector actions remain busy");
}
const clearXhsSelectionMatch = rendererSource.match(/async function clearXhsAccountSelection\(\) \{[\s\S]*?\n  \}/);
if (!clearXhsSelectionMatch || clearXhsSelectionMatch[0].includes("isXhsPanelDisabled")) {
  throw new Error("Expected renderer to allow clearing the selected XHS account while the current session or account is locked");
}
if (!rendererSource.includes("locked && !isSelected")) {
  throw new Error("Expected renderer to keep locked unselected XHS accounts disabled while allowing the locked selected account to clear");
}
if (!rendererSource.includes('selectedConnectorCount > 1 ? "multi" : ""') || !rendererSource.includes("connectorPickerLogos")) {
  throw new Error("Expected connector picker to render a wider multi-logo state when multiple connector accounts are selected");
}
if (!rendererSource.includes("cancelled?: boolean") || !rendererSource.includes("if (login.cancelled) return")) {
  throw new Error("Expected renderer to treat cancelled XHS login waits as non-error cancellations");
}

const agentSource = fs.readFileSync(path.join("src", "agent", "agent.ts"), "utf8");
const agentPromptSource = fs.readFileSync(path.join("src", "agent", "prompt.ts"), "utf8");
for (const envName of ["AGENTSTUDIO_XHS_CLI", "AGENTSTUDIO_XHS_CDP_PORT", "AGENTSTUDIO_XHS_TARGET_ID", "AGENTSTUDIO_XHS_PROFILE_KEY"]) {
  if (!agentSource.includes(envName)) {
    throw new Error(`Expected agent env builder to inject ${envName}`);
  }
}
for (const envName of ["WECHAT_APPID", "WECHAT_SECRET", "WECHAT_AUTHOR"]) {
  if (!agentSource.includes(envName)) {
    throw new Error(`Expected agent scoped runtime env to include ${envName}`);
  }
}
if (!agentSource.includes('CLAUDE_CODE_DISABLE_CRON: "1"')) {
  throw new Error("Expected agent env builder to disable Claude Code scheduled tasks");
}
if (!agentSource.includes('toolConfig: { askUserQuestion: { previewFormat: "markdown" } }')) {
  throw new Error("Expected canUseTool AskUserQuestion preview to request markdown format");
}
if (!agentSource.includes('mode !== "allow" && mode !== "allow_remember"')) {
  throw new Error("Expected agent canUseTool to deny reject and suggest alternative modes");
}
if (!agentSource.includes("function mergeDisallowedTools") || !agentSource.includes("mergeDisallowedTools(defaultOptions.disallowedTools, request.disallowedTools)")) {
  throw new Error("Expected agent query options to merge request-level disallowed tools");
}
if (!mainSource.includes('permissionMode: "bypassPermissions"') || !mainSource.includes('disallowedTools: ["AskUserQuestion"]') || !mainSource.includes("automationRun: {")) {
  throw new Error("Expected automation agent requests to default to bypass permissions and disallow AskUserQuestion");
}
if (!mainSource.includes("function normalizeAgentPermissionResponseMode")) {
  throw new Error("Expected main process to normalize AgentPermissionResponse.mode");
}
for (const rendererExpected of [
  "允许本次",
  "始终允许",
  "拒绝原因",
  "替代方案",
  "MarkdownPreview",
  "getRememberPermissionSuggestions"
]) {
  if (!rendererSource.includes(rendererExpected)) {
    throw new Error(`Expected renderer canUseTool UI support for ${rendererExpected}`);
  }
}
if (rendererSource.includes("alwaysAllow")) {
  throw new Error("Expected renderer to replace remember checkbox state with explicit allow_remember mode");
}
if (!agentPromptSource.includes("本轮可以使用 GrowthForce 小红书连接器") || !agentPromptSource.includes("调用任何 `xhs-*` Skill") || !agentPromptSource.includes("check-session") || !agentPromptSource.includes("180000ms") || !agentPromptSource.includes("AGENTSTUDIO_XHS_ACCOUNT_ID")) {
  throw new Error("Expected XHS connector system reminder to require check-session before xhs-* skills and business commands");
}
for (const expected of ["当前是自动化任务运行", "所有环节均按任务预授权执行，无需再次请求用户确认", "不要调用 `AskUserQuestion`", "不要只回复“等待用户确认”后停止"]) {
  if (!agentPromptSource.includes(expected)) {
    throw new Error(`Expected automation system reminder to include ${expected}`);
  }
}

const xhsConnectorSource = fs.readFileSync(path.join("src", "main", "xhs-connector.ts"), "utf8");
if (!xhsConnectorSource.includes("configureBrowserSessionFingerprint(session)")) {
  throw new Error("Expected XHS browser runtime to apply the shared fingerprint policy");
}
if (!xhsConnectorSource.includes("if (command.args.length === 0) return command.file")) {
  throw new Error("Expected AGENTSTUDIO_XHS_CLI to use raw sidecar path without shell quotes");
}
if (!xhsConnectorSource.includes('path.join("resources", "connectors", "xhs", "bin", process.platform, process.arch, "xhs-cli", binaryName)')) {
  throw new Error("Expected XHS connector to resolve the PyInstaller onedir executable path");
}
if (xhsConnectorSource.includes('process.arch, binaryName)')) {
  throw new Error("Expected XHS connector not to resolve the legacy onefile sidecar path");
}
const xhsSidecarBuildSource = fs.readFileSync(path.join("scripts", "build-xhs-sidecar.cjs"), "utf8");
if (!xhsSidecarBuildSource.includes('"--onedir"') || xhsSidecarBuildSource.includes('"--onefile"')) {
  throw new Error("Expected XHS sidecar build to use PyInstaller onedir only");
}
const devScriptSource = fs.readFileSync(path.join("scripts", "dev.sh"), "utf8");
if (!devScriptSource.includes("resources/connectors/xhs/bin/darwin/x64/xhs-cli/xhs-cli") || !devScriptSource.includes("resources/connectors/xhs/bin/win32/x64/xhs-cli/xhs-cli.exe")) {
  throw new Error("Expected dev script to check the XHS onedir executable");
}
if (!devScriptSource.includes('npm run build:xhs-sidecar') || !devScriptSource.includes('if [ ! -x "$XHS_SIDECAR" ]; then')) {
  throw new Error("Expected dev script to build a missing XHS sidecar automatically and verify the executable");
}
if (!devScriptSource.includes('AGENTSTUDIO_XHS_ALLOW_SOURCE_CLI:-') || !devScriptSource.includes('Skipping automatic XHS sidecar build')) {
  throw new Error("Expected dev script to preserve the explicit Python source CLI escape hatch");
}
const releaseWorkflowSource = fs.readFileSync(path.join(".github", "workflows", "release.yml"), "utf8");
for (const action of ["actions/checkout@v6", "actions/setup-node@v6", "actions/setup-python@v6"]) {
  if (!releaseWorkflowSource.includes(action)) {
    throw new Error(`Expected release workflow to use ${action}`);
  }
}
for (const deprecatedAction of ["actions/checkout@v4", "actions/setup-node@v4", "actions/setup-python@v5"]) {
  if (releaseWorkflowSource.includes(deprecatedAction)) {
    throw new Error(`Expected release workflow not to use deprecated ${deprecatedAction}`);
  }
}
if (!releaseWorkflowSource.includes("node-version: 24") || !releaseWorkflowSource.includes('python-version: "3.11"')) {
  throw new Error("Expected release workflow to keep Node.js 24 and Python 3.11 build environments");
}
const afterPackSource = fs.readFileSync(path.join("scripts", "electron-builder-after-pack.cjs"), "utf8");
if (!afterPackSource.includes('path.join(binRoot, target.platform, target.arch, "xhs-cli", target.binary)')) {
  throw new Error("Expected afterPack to validate the XHS onedir executable");
}
if (!xhsConnectorSource.includes("const idleTimeoutMs = 2 * 60 * 60 * 1000")) {
  throw new Error("Expected XHS account runtime idle timeout to be 2 hours");
}
if (!xhsConnectorSource.includes("const idleDisposeGraceMs = 60 * 1000")) {
  throw new Error("Expected XHS account runtime idle dispose grace to be 1 minute");
}
if (!xhsConnectorSource.includes("lastReleaseTime?: number")) {
  throw new Error("Expected XHS runtime to track lastReleaseTime");
}
if (!xhsConnectorSource.includes("closingForDispose?: boolean")) {
  throw new Error("Expected XHS runtime to distinguish user close from dispose close");
}
if (!xhsConnectorSource.includes("idleDisposeThresholdMs - elapsedMs")) {
  throw new Error("Expected XHS idle timer to reschedule from lastReleaseTime remaining time");
}
if (!xhsConnectorSource.includes('window.on("close"') || !xhsConnectorSource.includes("event.preventDefault()") || !xhsConnectorSource.includes("window.hide()")) {
  throw new Error("Expected XHS login window user close to hide instead of destroying the runtime");
}
if (!xhsConnectorSource.includes("runtime.closingForDispose = true")) {
  throw new Error("Expected XHS dispose path to bypass login window close interception");
}
if (xhsConnectorSource.includes("userClosedLoginWindow") || xhsConnectorSource.includes("loginWindowHidden")) {
  throw new Error("Expected XHS login window close to keep pending wait-login running until success or timeout");
}
if (!xhsConnectorSource.includes("pendingLoginWaits") || !xhsConnectorSource.includes("cancelLoginWait(options.loginWaitProfileKey, \"superseded\")")) {
  throw new Error("Expected XHS superseded login waits to cancel the previous pending wait-login");
}
if (!xhsConnectorSource.includes("this.cancelLoginWait(profileKey, \"deleteProfile\")")) {
  throw new Error("Expected XHS profile deletion to cancel pending login waits before cleanup");
}
if (!xhsConnectorSource.includes("auth-cookies.enc") || !xhsConnectorSource.includes("safeStorage.encryptString") || !xhsConnectorSource.includes("safeStorage.decryptString")) {
  throw new Error("Expected XHS connector to persist auth cookies with encrypted safeStorage snapshot");
}
if (!xhsConnectorSource.includes("runtime.session.cookies.get({})") || !xhsConnectorSource.includes("session.cookies.set(details)") || !xhsConnectorSource.includes("runtime.session.cookies.flushStore()")) {
  throw new Error("Expected XHS connector to save, restore, and flush auth cookies");
}
if (!xhsConnectorSource.includes("const xhsProcessTimeoutGraceMs = 60_000") || !xhsConnectorSource.includes("const checkSessionBusinessTimeoutMs = 120_000")) {
  throw new Error("Expected XHS check-session to keep a 120 second business timeout and 60 second process grace");
}
if (!xhsConnectorSource.includes("timeout * 1000 + xhsProcessTimeoutGraceMs")) {
  throw new Error("Expected XHS wait-login process timeout to add the shared 60 second grace");
}
if (!mainSource.includes("const result = await xhsConnector.checkSession(profileKey);")) {
  throw new Error("Expected silent XHS auth check to use the connector default check-session timeout");
}
if (!mainSource.includes("main.ipc.xhs:loginWait:cancelled")) {
  throw new Error("Expected XHS login wait cancellation to be logged in main IPC");
}
for (const logScope of [
  "main.xhs.runtime:windowCloseIntercepted",
  "main.xhs.runtime:loginWaitCancelled",
  "main.xhs.runtime:windowClosed",
  "main.xhs.runtime:loginNavigateSucceeded",
  "main.xhs.runtime:loginNavigateFailed",
  "main.xhs.cdp:targetResolved",
  "main.xhs.cdp:targetsListed",
  "main.xhs.cli:success",
  "main.xhs.cli:failed"
]) {
  if (!xhsConnectorSource.includes(logScope)) {
    throw new Error(`Expected XHS connector diagnostic log scope ${logScope}`);
  }
}
if (xhsConnectorSource.includes("web_session") || xhsConnectorSource.includes("id_token")) {
  throw new Error("Expected XHS connector logs/source checks not to hard-code sensitive cookie names");
}
if (!mainSource.includes("await xhsConnector.saveAuthCookies(account.profileKey);")) {
  throw new Error("Expected XHS login success path to save encrypted auth cookies before marking account authorized");
}
for (const logScope of [
  "main.ipc.xhs:loginWait:result",
  "main.ipc.xhs:loginWait:incompleteAccountInfo",
  "main.ipc.xhs:loginWait:authorized",
  "main.xhs.authCheck:start",
  "main.xhs.authCheck:result",
  "main.xhs.authCheck:skip"
]) {
  if (!mainSource.includes(logScope)) {
    throw new Error(`Expected XHS auth diagnostic log scope ${logScope}`);
  }
}
for (const payloadField of ["guest", "failure_reason", "last_failure_reason", "account_id"]) {
  if (!xhsConnectorSource.includes(payloadField) || !mainSource.includes(payloadField)) {
    throw new Error(`Expected XHS diagnostic payload summaries to include ${payloadField}`);
  }
}

const xhsCliSource = fs.readFileSync(path.join("resources", "connectors", "xhs", "engine", "scripts", "cli.py"), "utf8");
if (xhsCliSource.includes("Bridge server 未运行") || xhsCliSource.includes("_ensure_bridge_ready") || xhsCliSource.includes("BridgePage(bridge_url)")) {
  throw new Error("Expected xhs CLI to fail on missing CDP env instead of starting Extension Bridge");
}
if (!xhsCliSource.includes("缺少 AGENTSTUDIO_XHS_CDP_PORT") || !xhsCliSource.includes("缺少 AGENTSTUDIO_XHS_TARGET_ID")) {
  throw new Error("Expected xhs CLI to keep explicit missing CDP env errors");
}
if (!xhsCliSource.includes('"failure_reason": "cdp_error"')) {
  throw new Error("Expected xhs check-session to return structured CDP failure reasons");
}
if (!xhsCliSource.includes("LIGHTWEIGHT_PREFLIGHT_COMMANDS") || !xhsCliSource.includes("validate_lightweight_preflight") || !xhsCliSource.includes("_connect_checked")) {
  throw new Error("Expected xhs CLI business commands to include lightweight login preflight protection");
}
for (const command of ["list-feeds", "search-feeds", "get-feed-detail", "post-comment", "publish-video", "long-article"]) {
  if (!xhsCliSource.includes(`"${command}"`)) {
    throw new Error(`Expected xhs lightweight login preflight command list to include ${command}`);
  }
}

const xhsLoginSource = fs.readFileSync(path.join("resources", "connectors", "xhs", "engine", "scripts", "xhs", "login.py"), "utf8");
if (!xhsLoginSource.includes("timeout=120.0") || !xhsLoginSource.includes("return_on_guest=True")) {
  throw new Error("Expected xhs check-session to wait up to 120 seconds for userInfo");
}
if (!xhsLoginSource.includes("return_on_guest=False")) {
  throw new Error("Expected xhs authorization wait to keep polling while userInfo is guest");
}
for (const reason of ["guest", "timeout", "no_user_info", "missing_account_id", "read_user_info_failed"]) {
  if (!xhsLoginSource.includes(`failure_reason`) || !xhsLoginSource.includes(reason)) {
    throw new Error(`Expected xhs check-session to expose failure reason: ${reason}`);
  }
}

for (const skillName of ["xhs-explore", "xhs-interact", "xhs-publish"]) {
  const skillSource = fs.readFileSync(path.join("resources", "skills", "orchestrator", skillName, "SKILL.md"), "utf8");
  if (!skillSource.includes("check-session")) {
    throw new Error(`Expected ${skillName} to allow check-session`);
  }
  if (!skillSource.includes("XHS 前置登录检查规则")) {
    throw new Error(`Expected ${skillName} to reference the shared XHS preflight rule`);
  }
  if (skillSource.includes("$AGENTSTUDIO_XHS_CLI check-session")) {
    throw new Error(`Expected ${skillName} not to duplicate full check-session command details`);
  }
}
const xhsExploreSkillSource = fs.readFileSync(path.join("resources", "skills", "orchestrator", "xhs-explore", "SKILL.md"), "utf8");
if (!xhsExploreSkillSource.includes("600000")) {
  throw new Error("Expected xhs-explore to document long detail/comment timeout");
}
for (const expected of [
  "search-feeds --keyword <关键词>",
  "get-feed-detail --feed-id <id> --xsec-token <xsecToken>",
  "user-profile --user-id <userId>",
  "同一条 `feeds[]`"
]) {
  if (!xhsExploreSkillSource.includes(expected)) {
    throw new Error(`Expected xhs-explore CLI contract: ${expected}`);
  }
}
const xhsPublishSkillSource = fs.readFileSync(path.join("resources", "skills", "orchestrator", "xhs-publish", "SKILL.md"), "utf8");
if (!xhsPublishSkillSource.includes("600000") || !xhsPublishSkillSource.includes("900000") || !xhsPublishSkillSource.includes("300000")) {
  throw new Error("Expected xhs-publish to document image, video, and long-article business timeouts");
}
const xhsCreateSkillSource = fs.readFileSync(path.join("resources", "skills", "orchestrator", "xhs-create", "SKILL.md"), "utf8");
for (const [source, expected] of [
  [xhsCreateSkillSource, ["不超过 800 字", "不超过 6 个", "1-6 张图片"]],
  [xhsPublishSkillSource, ["不超过 800 字", "不得超过 6 个", "1-6 张图片"]]
]) {
  for (const text of expected) {
    if (!source.includes(text)) throw new Error(`Expected XHS create/publish limit: ${text}`);
  }
}
const browserToolSource = fs.readFileSync(path.join("resources", "tools", "browser", "src", "index.ts"), "utf8");
if (!browserToolSource.includes("多个 web_search 必须顺序调用，不支持并行搜索")) {
  throw new Error("Expected web_search tool description to require sequential calls");
}

// content-lifecycle-ops 已解散：总原则上提 orchestrator.yml，执行细节下沉各阶段 Skill。
const dissolvedLifecycleDir = path.join("resources", "skills", "orchestrator", "content-lifecycle-ops");
if (fs.existsSync(dissolvedLifecycleDir)) {
  throw new Error("Expected dissolved content-lifecycle-ops skill to be removed");
}
const orchestratorAgentSource = fs.readFileSync(path.join("resources", "agents", "orchestrator.yml"), "utf8");
for (const expected of ["xhs-create -> xhs-publish", "不得只回复发布包就停止", "只生成发布包或不发布"]) {
  if (!orchestratorAgentSource.includes(expected)) {
    throw new Error(`Expected orchestrator prompt to document XHS create-to-publish handoff: ${expected}`);
  }
}
for (const expected of ["四阶段闭环", "三条铁律", "写收口、读分散", "单篇不转正", "不编造指标", "必备记录层", "create 阶段产出"]) {
  if (!orchestratorAgentSource.includes(expected)) {
    throw new Error(`Expected orchestrator world-view to include: ${expected}`);
  }
}
for (const movedRuntimeRule of ["小红书连接器使用规范", "$AGENTSTUDIO_XHS_CLI check-session", "Chrome 扩展 Bridge"]) {
  if (orchestratorAgentSource.includes(movedRuntimeRule)) {
    throw new Error(`Expected XHS connector runtime rule to move out of orchestrator.yml: ${movedRuntimeRule}`);
  }
}

for (const removedSkill of ["wewrite", "xhs-content-ops", "content-lifecycle-ops"]) {
  if (fs.existsSync(path.join("resources", "skills", "orchestrator", removedSkill))) {
    throw new Error(`Expected legacy composite skill to be removed: ${removedSkill}`);
  }
}
for (const skillName of [
  "account-profile-ops",
  "content-research-ops",
  "content-strategy-ops",
  "content-review-ops",
  "content-collect-ops",
  "wechat-create",
  "wechat-markdown-to-html",
  "wechat-publish",
  "xhs-create"
]) {
  const source = fs.readFileSync(path.join("resources", "skills", "orchestrator", skillName, "SKILL.md"), "utf8");
  if (!source.includes(`name: ${skillName}`)) {
    throw new Error(`Expected stage skill frontmatter name: ${skillName}`);
  }
}
// content-review-ops 是 playbook/history 的唯一写者，并承载转正/衰减纪律
const reviewSkillSource = fs.readFileSync(path.join("resources", "skills", "orchestrator", "content-review-ops", "SKILL.md"), "utf8");
for (const expected of ["content_playbook_write", "content_history_write", "唯一", "samples", "validated", "candidate"]) {
  if (!reviewSkillSource.includes(expected)) {
    throw new Error(`Expected content-review-ops aggregator discipline to include: ${expected}`);
  }
}
// content-collect-ops 是薄编排：只采集指标和评论数据，只写本 Run 隔离文件，不写长期数据
const collectSkillSource = fs.readFileSync(path.join("resources", "skills", "orchestrator", "content-collect-ops", "SKILL.md"), "utf8");
for (const expected of ["xhs-explore", "wechat_metrics_fetch", "content_run_record_collection_result", "不执行评论、回复、点赞、收藏"]) {
  if (!collectSkillSource.includes(expected)) {
    throw new Error(`Expected content-collect-ops to reuse existing capability: ${expected}`);
  }
}
for (const expected of [
  "AppID/Secret/access token invalid",
  "IP 白名单",
  "不得描述为指标为 0",
  "account-diagnosis-ops",
  "本 Skill 不调用 `wechat_published_articles_fetch`"
]) {
  if (!collectSkillSource.includes(expected)) {
    throw new Error(`Expected content-collect-ops WeChat failure/boundary rule: ${expected}`);
  }
}
for (const forbidden of ["content_playbook_write", "content_history_write"]) {
  if (collectSkillSource.includes(forbidden)) {
    throw new Error(`Expected content-collect-ops not to write long-term data: ${forbidden}`);
  }
}
const accountProfileSkillSource = fs.readFileSync(path.join("resources", "skills", "orchestrator", "account-profile-ops", "SKILL.md"), "utf8");
for (const expected of ["未选择内容账号时不要触发", "content_profile_get", "已有定位且足以完成本轮任务时直接使用", "公众号使用当前连接器 APPID", "AskUserQuestion", "自动化任务不得调用", "说明缺失及跳过内容"]) {
  if (!accountProfileSkillSource.includes(expected)) {
    throw new Error(`Expected account-profile-ops to own profile trigger/read behavior: ${expected}`);
  }
}
if (accountProfileSkillSource.includes('accountId: "default"')) {
  throw new Error("Expected account-profile-ops not to use the legacy default WeChat AccountRef");
}
const accountDiagnosisSkillSource = fs.readFileSync(path.join("resources", "skills", "orchestrator", "account-diagnosis-ops", "SKILL.md"), "utf8");
for (const expected of [
  "name: account-diagnosis-ops",
  "content_profile_get",
  "user-profile --user-id <accountId>",
  "wechat_published_articles_fetch",
  "wechat_metrics_fetch(days=7)",
  "数据覆盖率低于 60%",
  "当前无法完成相关任务",
  "不把失败或空数据解释为账号表现差"
]) {
  if (!accountDiagnosisSkillSource.includes(expected)) {
    throw new Error(`Expected account-diagnosis-ops contract to include: ${expected}`);
  }
}
for (const forbidden of ["content_profile_patch", "content_playbook_write", "content_history_write", "content_run_create"]) {
  if (accountDiagnosisSkillSource.includes(forbidden)) {
    throw new Error(`Expected account-diagnosis-ops to remain read-only: ${forbidden}`);
  }
}
const accountDiagnosisFramework = fs.readFileSync(path.join("resources", "skills", "orchestrator", "account-diagnosis-ops", "references", "framework.md"), "utf8");
for (const expected of ["定位与主页清晰度", "内容聚焦与一致性", "传播表现", "互动与受众共鸣", "运营稳定性", "可评分维度权重之和"]) {
  if (!accountDiagnosisFramework.includes(expected)) {
    throw new Error(`Expected account diagnosis framework to include: ${expected}`);
  }
}
// publish 现在写本 Run 的 run.md 并发起采集任务；但任何执行 skill 都不写长期 playbook/history
const publishSkillSources = ["wechat-publish", "xhs-publish"]
  .map((name) => fs.readFileSync(path.join("resources", "skills", "orchestrator", name, "SKILL.md"), "utf8"))
  .join("\n");
for (const expected of ["content_run_record_publish_result", "automation_task_create", "content-collect-ops"]) {
  if (!publishSkillSources.includes(expected)) {
    throw new Error(`Expected publish skills to wire run.md + per-run collect task: ${expected}`);
  }
}
for (const expected of [
  "PUBLISH_RESULT_UNKNOWN",
  "ACCOUNT_RESTRICTED",
  "stageReasons",
  "不得创建采集任务",
  "最终阶段总结"
]) {
  if (!xhsPublishSkillSource.includes(expected)) {
    throw new Error(`Expected xhs-publish failure contract: ${expected}`);
  }
}
const noLongTermWriteSkills = ["wechat-create", "wechat-markdown-to-html", "wechat-publish", "xhs-create", "xhs-publish", "xhs-interact", "content-collect-ops"]
  .map((name) => fs.readFileSync(path.join("resources", "skills", "orchestrator", name, "SKILL.md"), "utf8"))
  .join("\n");
for (const forbidden of ["content_playbook_write", "content_history_write"]) {
  if (noLongTermWriteSkills.includes(forbidden)) {
    throw new Error(`Expected non-review skills not to write long-term data: ${forbidden}`);
  }
}

const orchestratorSkillsDir = path.join("resources", "skills", "orchestrator");
if (fs.existsSync(orchestratorSkillsDir)) {
  for (const entry of fs.readdirSync(orchestratorSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(orchestratorSkillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) {
      throw new Error(`Missing SKILL.md for bundled orchestrator skill: ${skillFile}`);
    }
  }
}
NODE

node - <<'NODE'
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

(async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-model-http-"));
  process.env.HOME = tempHome;
  const { shouldEnableModelHttpLogging, startModelHttpLogger } = require("./dist/agent/model-http-logger.js");

  if (shouldEnableModelHttpLogging({ AGENTSTUDIO_DEV_MODEL_HTTP_LOGS: "dev.sh" }, false)) {
    throw new Error("Expected model HTTP logging to require VITE_DEV_SERVER_URL");
  }
  if (shouldEnableModelHttpLogging({ AGENTSTUDIO_DEV_MODEL_HTTP_LOGS: "1", VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" }, false)) {
    throw new Error("Expected model HTTP logging to reject generic boolean env values");
  }
  if (shouldEnableModelHttpLogging({ AGENTSTUDIO_DEV_MODEL_HTTP_LOGS: "dev.sh", VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" }, true)) {
    throw new Error("Expected model HTTP logging to be disabled in packaged runtime");
  }
  if (!shouldEnableModelHttpLogging({ AGENTSTUDIO_DEV_MODEL_HTTP_LOGS: "dev.sh", VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" }, false)) {
    throw new Error("Expected model HTTP logging to enable only for dev runtime");
  }

  let receivedBody = "";
  let receivedAuthorization = "";
  const upstream = http.createServer((request, response) => {
    receivedAuthorization = String(request.headers.authorization || "");
    request.on("data", (chunk) => {
      receivedBody += chunk.toString("utf8");
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json", "x-api-key": "response-secret" });
      response.end(JSON.stringify({ ok: true, thinking: "visible thinking from upstream" }));
    });
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });

  const upstreamAddress = upstream.address();
  const upstreamBaseUrl = `http://127.0.0.1:${upstreamAddress.port}/anthropic`;
  const logger = await startModelHttpLogger({
    upstreamBaseUrl,
    requestId: "model-http-smoke",
    sdkSessionId: "sdk-smoke",
    model: "claude-smoke",
    maxLogBytes: 1024
  });

  try {
    const response = await fetch(`${logger.baseUrl}/v1/messages?api_key=query-secret`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer request-secret",
        "x-api-key": "header-secret"
      },
      body: JSON.stringify({ model: "claude-smoke", messages: [{ role: "user", content: "hello" }] })
    });
    const payload = await response.json();
    if (!payload.ok || payload.thinking !== "visible thinking from upstream") {
      throw new Error(`Unexpected proxied response: ${JSON.stringify(payload)}`);
    }
    if (!receivedBody.includes('"hello"') || receivedAuthorization !== "Bearer request-secret") {
      throw new Error(`Expected upstream to receive original request, got body=${receivedBody} auth=${receivedAuthorization}`);
    }
  } finally {
    await logger.close();
    await new Promise((resolve) => upstream.close(resolve));
  }

  const logDir = path.join(tempHome, ".agentstudio", "logs");
  const logFile = fs.readdirSync(logDir).find((file) => file.startsWith("model-http-"));
  if (!logFile) {
    throw new Error("Expected model HTTP log file to be written");
  }
  const logText = fs.readFileSync(path.join(logDir, logFile), "utf8");
  for (const expected of [
    "---\nrequest:\n",
    "  requestId: model-http-smoke",
    "  method: POST",
    "  url: /v1/messages?api_key=%5BREDACTED%5D",
    "  upstreamUrl: http://127.0.0.1:",
    "  headers:",
    "  body: |",
    '        "content": "hello"',
    "---\nresponse:\n",
    '  status: "200 OK"',
    "  body: |",
    '    "thinking": "visible thinking from upstream"'
  ]) {
    if (!logText.includes(expected)) {
      throw new Error(`Expected model HTTP log to include ${JSON.stringify(expected)}, got:\n${logText}`);
    }
  }
  if (!logText.includes('    authorization: "[REDACTED]"') || !logText.includes('    x-api-key: "[REDACTED]"')) {
    throw new Error(`Expected sensitive headers to be redacted, got:\n${logText}`);
  }
  if (logText.includes("query-secret")) {
    throw new Error(`Expected sensitive query params to be redacted, got:\n${logText}`);
  }

  fs.rmSync(tempHome, { recursive: true, force: true });
})();
NODE

node - <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Arch } = require("builder-util");
const afterPack = require("./scripts/electron-builder-after-pack.cjs");

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-afterpack-"));
  try {
    const productFilename = "GrowthForce";
    const contentsDir = path.join(tempDir, `${productFilename}.app`, "Contents");
    const resourcesDir = path.join(contentsDir, "Resources");
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, "electron.icns"), "default electron icon", "utf8");
    fs.writeFileSync(path.join(contentsDir, "Info.plist"), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '\t<key>CFBundleIconFile</key>',
      '\t<string>electron.icns</string>',
      '</dict>',
      '</plist>'
    ].join("\n"), "utf8");

    const xhsBinDir = path.join(resourcesDir, "resources", "connectors", "xhs", "bin");
    for (const [platform, arch, binary] of [["darwin", "arm64", "xhs-cli"], ["darwin", "x64", "xhs-cli"], ["win32", "x64", "xhs-cli.exe"]]) {
      const targetDir = path.join(xhsBinDir, platform, arch, "xhs-cli");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, binary), binary, "utf8");
    }
    await afterPack({
      appOutDir: tempDir,
      arch: Arch.arm64,
      electronPlatformName: "darwin",
      packager: { appInfo: { productFilename } }
    });
    const removedX64 = path.join(xhsBinDir, "darwin", "x64");
    if (fs.existsSync(removedX64)) throw new Error(`Expected non-target XHS sidecar to be pruned: ${removedX64}`);
    const bundleIcon = path.join(resourcesDir, "icon.icns");
    if (!fs.readFileSync(path.join(contentsDir, "Info.plist"), "utf8").includes("<string>icon.icns</string>")) {
      throw new Error("Expected afterPack to set CFBundleIconFile to icon.icns");
    }
    if (!fs.existsSync(bundleIcon) || !fs.readFileSync(bundleIcon).equals(fs.readFileSync(path.join("build", "icon.icns")))) {
      throw new Error("Expected afterPack to copy build/icon.icns into the macOS bundle resources");
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})();
NODE

node - <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AppDatabase } = require("./dist/main/database.js");
const { resolveAutomationToolAttachments, resolveAutomationToolSkills, validateAutomationAttachments, validateAutomationSelectedSkills } = require("./dist/main/automation-tool.js");
const { calculateAutomationDispatchPlan, calculateNextRunAt, formatAutomationSchedule, formatAutomationStatus, normalizeAutomationTaskInput } = require("./dist/shared/automation.js");

(async () => {
  const file = path.join(os.tmpdir(), `agentstudio-build-smoke-${Date.now()}.sqlite`);
  const db = await AppDatabase.open(file);
  const availableSkills = [
    { name: "topic_strategy", agent: "orchestrator", description: "选题", sourceType: "builtin", sourcePath: "/tmp/topic_strategy", enabled: true, status: "enabled" },
    { name: "disabled_skill", agent: "orchestrator", description: "禁用", sourceType: "builtin", sourcePath: "/tmp/disabled_skill", enabled: false, status: "disabled" }
  ];
  const explicitSkills = resolveAutomationToolSkills(["topic_strategy", "topic_strategy"], availableSkills);
  if (explicitSkills.length !== 1 || explicitSkills[0].agent !== "orchestrator" || resolveAutomationToolSkills(undefined, availableSkills).length !== 0) {
    throw new Error(`Expected explicit automation tool skills without inherited defaults, got ${JSON.stringify(explicitSkills)}`);
  }
  for (const invalidSkills of [["missing_skill"], ["disabled_skill"]]) {
    try {
      resolveAutomationToolSkills(invalidSkills, availableSkills);
      throw new Error(`Expected invalid automation tool skills to fail: ${invalidSkills.join(",")}`);
    } catch (error) {
      if (!String(error.message).includes("Skill 不可用")) throw error;
    }
  }
  validateAutomationSelectedSkills(explicitSkills, availableSkills);
  const attachmentFile = path.join(os.tmpdir(), `agentstudio-automation-attachment-${Date.now()}.txt`);
  fs.writeFileSync(attachmentFile, "attachment", "utf8");
  const explicitAttachments = resolveAutomationToolAttachments([attachmentFile, attachmentFile]);
  if (explicitAttachments.length !== 1 || explicitAttachments[0].name !== path.basename(attachmentFile) || resolveAutomationToolAttachments(undefined).length !== 0) {
    throw new Error(`Expected explicit automation tool attachments without inherited defaults, got ${JSON.stringify(explicitAttachments)}`);
  }
  for (const invalidAttachment of ["relative.txt", `${attachmentFile}.missing`, os.tmpdir()]) {
    try {
      resolveAutomationToolAttachments([invalidAttachment]);
      throw new Error(`Expected invalid automation attachment to fail: ${invalidAttachment}`);
    } catch (error) {
      if (!String(error.message).includes("绝对路径") && !String(error.message).includes("文件不存在") && !String(error.message).includes("不是普通文件")) throw error;
    }
  }
  fs.unlinkSync(attachmentFile);
  try {
    validateAutomationAttachments(explicitAttachments);
    throw new Error("Expected moved automation attachment to fail trigger-time validation");
  } catch (error) {
    if (!String(error.message).includes("文件不存在")) throw error;
  }
  try {
    validateAutomationSelectedSkills(explicitSkills, availableSkills.map((skill) => skill.name === "topic_strategy" ? { ...skill, enabled: false, status: "disabled" } : skill));
    throw new Error("Expected disabled automation skill to fail trigger-time validation");
  } catch (error) {
    if (!String(error.message).includes("Skill 不可用")) throw error;
  }
  const session = db.createSession({ prompt: "build smoke", workspacePath: os.tmpdir() });
  if (!session.id || session.title !== "build smoke") {
    throw new Error(`Unexpected session result: ${JSON.stringify(session)}`);
  }
  if (session.workspacePath !== os.tmpdir()) {
    throw new Error(`Expected session workspace to be persisted, got ${session.workspacePath}`);
  }
  if (session.agentName !== "orchestrator") {
    throw new Error(`Expected default agent name to be orchestrator, got ${session.agentName}`);
  }
  const stored = db.getSession(session.id);
  if (!stored || stored.workspacePath !== os.tmpdir() || stored.agentName !== "orchestrator") {
    throw new Error(`Expected stored session workspace to round-trip, got ${JSON.stringify(stored)}`);
  }
  const writerSession = db.createSession({ prompt: "writer smoke", workspacePath: os.tmpdir(), agentName: "writer_agent" });
  if (writerSession.agentName !== "writer_agent") {
    throw new Error(`Expected explicit agent name to round-trip, got ${JSON.stringify(writerSession)}`);
  }
  const pendingXhs = db.upsertConnectorAccount({ platform: "xhs", profileKey: "xhs-local-a", status: "unauthorized" });
  const authorizedXhs = db.upsertConnectorAccount({ platform: "xhs", profileKey: "xhs-local-a", accountId: "xhs-real-a", accountHandle: "red-a", displayName: "小红书 A", status: "authorized" });
	  if (pendingXhs.id !== authorizedXhs.id || authorizedXhs.accountId !== "xhs-real-a" || authorizedXhs.accountHandle !== "red-a") {
	    throw new Error(`Expected connector account to dedupe by profile key, got ${JSON.stringify({ pendingXhs, authorizedXhs })}`);
	  }
	  if (Object.prototype.hasOwnProperty.call(authorizedXhs.opsState, "autoReviewEnabled") || authorizedXhs.opsState.reviewTaskId !== null) {
	    throw new Error(`Expected connector ops_state defaults, got ${JSON.stringify(authorizedXhs.opsState)}`);
	  }
	  const reviewEnabledXhs = db.updateConnectorAccountOpsState("xhs", "xhs-local-a", { reviewTaskId: 42 });
	  if (Object.prototype.hasOwnProperty.call(reviewEnabledXhs.opsState, "autoReviewEnabled") || reviewEnabledXhs.opsState.reviewTaskId !== 42) {
	    throw new Error(`Expected connector ops_state to round-trip, got ${JSON.stringify(reviewEnabledXhs.opsState)}`);
	  }
	  const refreshedXhs = db.upsertConnectorAccount({ platform: "xhs", profileKey: "xhs-local-a-refresh", accountId: "xhs-real-a", accountHandle: "red-a-plus", displayName: "小红书 A+", status: "authorized" });
	  if (refreshedXhs.id !== authorizedXhs.id || refreshedXhs.profileKey !== "xhs-local-a-refresh" || refreshedXhs.accountHandle !== "red-a-plus" || refreshedXhs.opsState.reviewTaskId !== 42) {
	    throw new Error(`Expected connector account to dedupe by platform account id, got ${JSON.stringify(refreshedXhs)}`);
	  }
  const douyinSameId = db.upsertConnectorAccount({ platform: "douyin", profileKey: "douyin-local-a", accountId: "xhs-real-a", status: "authorized" });
  if (douyinSameId.id === refreshedXhs.id || db.listConnectorAccounts("xhs").length !== 1 || db.listConnectorAccounts().length !== 2) {
    throw new Error("Expected connector account dedupe to be scoped to the same platform");
  }
  const wechat = db.upsertConnectorAccount({ platform: "wechat", profileKey: "wechat-local-a", accountId: "wx-app-a", displayName: "公众号 A", credentialSecret: "wx-secret-a", status: "authorized" });
  if (wechat.status !== "authorized" || wechat.accountId !== "wx-app-a" || wechat.displayName !== "公众号 A" || Object.prototype.hasOwnProperty.call(wechat, "credentialSecret")) {
    throw new Error(`Expected public WeChat connector account to omit secret, got ${JSON.stringify(wechat)}`);
  }
  if (db.getConnectorCredentialSecret("wechat", "wechat-local-a") !== "wx-secret-a") {
    throw new Error("Expected private WeChat connector secret to round-trip");
  }
  const automationInput = {
    name: "每两天运行",
    description: "执行固定上下文任务",
    workspacePath: os.tmpdir(),
    scheduleType: "interval",
    scheduleConfig: { intervalValue: 2, intervalUnit: "day" },
    maxRetries: 2,
    maxRuns: 3,
    connectorBindings: { wechat: { profileKey: "wechat-local-a", accountId: "wx-app-a", displayName: "公众号 A" } },
    selectedSkills: [{ name: "topic_strategy", agent: "orchestrator", description: "选题" }],
    attachments: [{ name: "agentstudio.sqlite", path: file }],
    enabled: true
  };
  const automationTask = db.createAutomationTask(automationInput, "2026-06-03T00:00:00.000Z");
  if (automationTask.maxRuns !== 3 || automationTask.runCount !== 0 || automationTask.scheduleConfig.intervalUnit !== "day" || automationTask.connectorBindings.wechat.profileKey !== "wechat-local-a" || automationTask.selectedSkills[0].name !== "topic_strategy" || automationTask.attachments[0].path !== file) {
    throw new Error(`Expected automation task context to round-trip, got ${JSON.stringify(automationTask)}`);
  }
  const waitingRun = db.createAutomationRun({ task: automationTask, scheduledAt: "2026-06-03T00:00:00.000Z", status: "waiting_resource" });
  db.scheduleAutomationRunResourceWait(waitingRun.id, { nextCheckAt: "2026-06-03T00:00:30.000Z", errorMessage: "账号忙" });
  db.appendAutomationRunExecutionHistory(waitingRun.id, { status: "waiting_resource", at: "2026-06-03T00:00:00.000Z", reason: "账号忙" });
  const dueContinuations = db.listDueAutomationRunContinuations("2026-06-03T00:00:31.000Z");
  if (!db.hasOpenAutomationRunForTask(automationTask.id) || dueContinuations[0]?.status !== "waiting_resource" || dueContinuations[0]?.attemptCount !== 0 || formatAutomationStatus("waiting_resource") !== "等待账号空闲") {
    throw new Error(`Expected waiting_resource automation run to be open and due without consuming attempts, got ${JSON.stringify(dueContinuations[0])}`);
  }
  const waitingHistory = db.getAutomationRun(waitingRun.id)?.executionHistory;
  if (!waitingHistory || waitingHistory.length !== 1 || waitingHistory[0].status !== "waiting_resource" || waitingHistory[0].reason !== "账号忙" || Object.prototype.hasOwnProperty.call(waitingHistory[0], "attemptCount")) {
    throw new Error(`Expected waiting_resource execution history without attemptCount, got ${JSON.stringify(waitingHistory)}`);
  }
  const missedResourceWaits = db.markOverdueAutomationResourceWaitsFailed("2026-06-03T00:00:31.000Z");
  const failedWaitingRun = db.getAutomationRun(waitingRun.id);
  if (missedResourceWaits !== 1 || failedWaitingRun?.status !== "failed" || failedWaitingRun.attemptCount !== 0 || failedWaitingRun.errorMessage !== "应用关闭期间错过账号资源等待") {
    throw new Error(`Expected overdue waiting_resource run to fail without attempts, got ${JSON.stringify(failedWaitingRun)}`);
  }
  const failedHistoryRun = db.createAutomationRun({ task: automationTask, scheduledAt: "2026-06-04T00:00:00.000Z" });
  db.startAutomationRunAttempt(failedHistoryRun.id, { sessionId: 1001, attemptCount: 1 });
  db.appendAutomationRunExecutionHistory(failedHistoryRun.id, { status: "failed", at: "2026-06-04T00:01:00.000Z", sessionId: 1001, reason: "执行失败" });
  db.scheduleAutomationRunRetry(failedHistoryRun.id, { nextRetryAt: "2026-06-04T00:02:00.000Z", errorMessage: "执行失败" });
  const succeededHistoryRun = db.createAutomationRun({ task: automationTask, scheduledAt: "2026-06-05T00:00:00.000Z" });
  db.startAutomationRunAttempt(succeededHistoryRun.id, { sessionId: 1002, attemptCount: 1 });
  db.appendAutomationRunExecutionHistory(succeededHistoryRun.id, { status: "succeeded", at: "2026-06-05T00:01:00.000Z", sessionId: 1002 });
  db.completeAutomationRun(succeededHistoryRun.id, "succeeded");
  const historyRun = db.getAutomationRun(failedHistoryRun.id);
  if (historyRun?.executionHistory.length !== 1 || historyRun.executionHistory[0].status !== "failed" || historyRun.executionHistory[0].sessionId !== 1001 || historyRun.executionHistory[0].reason !== "执行失败") {
    throw new Error(`Expected failed execution history to round-trip, got ${JSON.stringify(historyRun)}`);
  }
  const filteredRuns = db.listAutomationRunsFiltered({ taskId: automationTask.id, statuses: ["succeeded"], limit: 10, offset: 0 });
  if (filteredRuns.length !== 1 || filteredRuns[0].id !== succeededHistoryRun.id || filteredRuns[0].executionHistory[0]?.status !== "succeeded") {
    throw new Error(`Expected filtered automation runs to include succeeded history run, got ${JSON.stringify(filteredRuns)}`);
  }
  const firstDispatch = db.recordAutomationTaskDispatch(automationTask.id, "2026-06-05T00:00:00.000Z", true);
  const finalDispatch = db.recordAutomationTaskDispatch(automationTask.id, null, false);
  if (firstDispatch.runCount !== 1 || firstDispatch.nextRunAt !== "2026-06-05T00:00:00.000Z" || finalDispatch.runCount !== 2 || finalDispatch.enabled || finalDispatch.nextRunAt !== null) {
    throw new Error(`Expected automation dispatch count and stop state, got ${JSON.stringify(finalDispatch)}`);
  }
  const resumedTask = db.setAutomationTaskEnabled(automationTask.id, true, "2026-06-09T00:00:00.000Z");
  const pausedTask = db.setAutomationTaskEnabled(automationTask.id, false, null);
  if (!resumedTask.enabled || resumedTask.nextRunAt !== "2026-06-09T00:00:00.000Z" || pausedTask.enabled || pausedTask.nextRunAt !== null) {
    throw new Error(`Expected automation pause and resume state to round-trip, got ${JSON.stringify({ resumedTask, pausedTask })}`);
  }
  const intervalFrom = new Date("2026-06-01T00:00:00.000Z");
  if (calculateNextRunAt(automationInput, intervalFrom) !== "2026-06-03T00:00:00.000Z" || formatAutomationSchedule("interval", automationInput.scheduleConfig) !== "每 2 天") {
    throw new Error("Expected two-day interval calculation and formatting");
  }
  const runOnePlan = calculateAutomationDispatchPlan({ ...automationTask, runCount: 0 }, "2026-06-03T00:00:00.000Z");
  const runTwoPlan = calculateAutomationDispatchPlan({ ...automationTask, runCount: 1 }, "2026-06-05T00:00:00.000Z");
  const runThreePlan = calculateAutomationDispatchPlan({ ...automationTask, runCount: 2 }, "2026-06-07T00:00:00.000Z");
  if (runOnePlan.nextRunAt !== "2026-06-05T00:00:00.000Z" || runTwoPlan.nextRunAt !== "2026-06-07T00:00:00.000Z" || runThreePlan.enabled || runThreePlan.nextRunAt !== null) {
    throw new Error(`Expected bounded interval plans for days 3, 5, and 7, got ${JSON.stringify({ runOnePlan, runTwoPlan, runThreePlan })}`);
  }
  const legacyInterval = normalizeAutomationTaskInput({ ...automationInput, scheduleConfig: { intervalMinutes: 30 }, maxRuns: undefined });
  if (legacyInterval.scheduleConfig.intervalValue !== 30 || legacyInterval.scheduleConfig.intervalUnit !== "minute" || legacyInterval.maxRuns !== null) {
    throw new Error(`Expected legacy interval minutes compatibility, got ${JSON.stringify(legacyInterval)}`);
  }
  db.updateSdkSessionId(session.id, "sdk-build-smoke");
  const withSdkSession = db.getSession(session.id);
  if (!withSdkSession || withSdkSession.sdkSessionId !== "sdk-build-smoke" || withSdkSession.status !== "running") {
    throw new Error(`Expected sdk session id update to preserve running status, got ${JSON.stringify(withSdkSession)}`);
  }
  const jsonlPath = path.join(os.tmpdir(), "sdk-build-smoke.jsonl");
  db.updateJsonlPath(session.id, jsonlPath);
  const withJsonlPath = db.getSession(session.id);
  if (!withJsonlPath || withJsonlPath.jsonlPath !== jsonlPath || withJsonlPath.status !== "running") {
    throw new Error(`Expected jsonl path update to preserve running status, got ${JSON.stringify(withJsonlPath)}`);
  }
  const interrupted = db.markRunningSessionsFailed();
  const failed = db.getSession(session.id);
  if (interrupted !== 2 || !failed || failed.status !== "failed" || failed.sdkSessionId !== "sdk-build-smoke" || failed.jsonlPath !== jsonlPath) {
    throw new Error(`Expected running session to be marked failed with sdk id preserved, got count=${interrupted} session=${JSON.stringify(failed)}`);
  }
  fs.unlinkSync(file);
})();
NODE

node - <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ensureRuntimeLayout, getRuntimePaths, needsProviderOnboarding, readConfig, writeProviderConfig } = require("./dist/main/paths.js");
const { readSettings, updateRecentWorkspaceDirectories } = require("./dist/main/settings.js");
const { stripSystemReminders } = require("./dist/shared/prompt.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-settings-"));
try {
  process.env.HOME = tempDir;
  const runtimePaths = getRuntimePaths();
  const expectedAgentDir = path.join(tempDir, ".agentstudio", "agents", "orchestrator");
  if (runtimePaths.defaultAgent !== expectedAgentDir || runtimePaths.skills !== path.join(expectedAgentDir, "skills")) {
    throw new Error(`Expected per-agent runtime paths, got ${JSON.stringify(runtimePaths)}`);
  }
  const ensuredPaths = ensureRuntimeLayout();
  if (!fs.existsSync(ensuredPaths.skills)) {
    throw new Error(`Expected per-agent runtime skills directory to be created: ${ensuredPaths.skills}`);
  }
  if (!needsProviderOnboarding(readConfig())) {
    throw new Error("Expected default empty provider config to require onboarding");
  }
  fs.writeFileSync(ensuredPaths.config, [
    "provider:",
    "  baseUrl: https://api.example.com",
    "  apiKey: old-key",
    "  model: ''",
    "workspace:",
    "  defaultDir: /tmp/existing-workspace",
    "user:",
    "  name: Existing User",
    "  avatar: /tmp/avatar.png",
    ""
  ].join("\n"), "utf8");
  if (!needsProviderOnboarding(readConfig())) {
    throw new Error("Expected missing provider.model to require onboarding");
  }
  const savedConfig = writeProviderConfig(ensuredPaths.config, {
    id: " provider-test ",
    baseUrl: " https://api.anthropic.com ",
    apiKey: " sk-test ",
    model: " claude-test "
  });
  if (needsProviderOnboarding(savedConfig)) {
    throw new Error(`Expected complete provider config to skip onboarding, got ${JSON.stringify(savedConfig.provider)}`);
  }
  if (savedConfig.provider.baseUrl !== "https://api.anthropic.com" || savedConfig.provider.apiKey !== "sk-test" || savedConfig.provider.model !== "claude-test") {
    throw new Error(`Expected provider config to be trimmed, got ${JSON.stringify(savedConfig.provider)}`);
  }
  if (savedConfig.workspace.defaultDir !== "/tmp/existing-workspace" || savedConfig.user.name !== "Existing User" || savedConfig.user.avatar !== "/tmp/avatar.png") {
    throw new Error(`Expected provider update to preserve workspace/user config, got ${JSON.stringify(savedConfig)}`);
  }

  const settingsPath = path.join(tempDir, "settings.yml");
  const legacy = readSettings(settingsPath);
  if (!legacy.workspace || legacy.workspace.recentDirectories.length !== 0 || legacy.connector.wechat.selected_account !== "") {
    throw new Error(`Expected legacy settings to default recent directories, got ${JSON.stringify(legacy)}`);
  }

  const dirs = Array.from({ length: 6 }, (_, index) => path.join(tempDir, `workspace-${index}`));
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
  for (const dir of dirs) updateRecentWorkspaceDirectories(settingsPath, dir);
  updateRecentWorkspaceDirectories(settingsPath, dirs[2]);

  const settings = readSettings(settingsPath);
  const expected = [dirs[2], dirs[5], dirs[4], dirs[3], dirs[1]];
  if (JSON.stringify(settings.workspace.recentDirectories) !== JSON.stringify(expected)) {
    throw new Error(`Expected MRU recent directories ${JSON.stringify(expected)}, got ${JSON.stringify(settings.workspace.recentDirectories)}`);
  }

  const storedPrompt = [
    "<system-reminder>\n当前工作目录（SDK cwd）是：/tmp/workspace\n</system-reminder>",
    "<system-reminder>\n当前时间是：2026-06-01T12:34:56+08:00\n</system-reminder>",
    "用户原始输入"
  ].join("\n\n");
  const displayPrompt = stripSystemReminders(storedPrompt);
  if (displayPrompt !== "用户原始输入") {
    throw new Error(`Expected system reminders to be stripped from history user prompt, got ${JSON.stringify(displayPrompt)}`);
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
NODE

node - <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");
const { installToolRuntime } = require("./dist/agent/tool-registry.js");
installToolRuntime();
const imageTool = require("./resources/tools/image/dist/index.js");

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-image-template-"));
  try {
    const coverPath = path.join(tempDir, "cover.png");
    const contentPath = path.join(tempDir, "content.png");
    const xhsContentPath = path.join(tempDir, "xhs-content.png");
    const cover = await imageTool.generateTemplateImage({
      type: "gzh_cover",
      title: "主标题",
      subtitle: "字号不同的副标题",
      template: "wechat_minimal_magazine",
      outputPath: coverPath
    });
    const content = await imageTool.generateTemplateImage({
      type: "gzh_content",
      title: "核心结论",
      content: "第一行由调用方指定\n第二段内容会根据文本框宽度自动换行。",
      template: "article_key_takeaway",
      outputPath: contentPath
    });
    const xhsContent = await imageTool.generateTemplateImage({
      type: "xhs_content",
      title: "内容页标题",
      content: "这是一张小红书内容图，正文区域和封面标题区域不同。",
      template: "xhs_blue_grid_paper",
      outputPath: xhsContentPath
    });
    for (const [result, expectedWidth, expectedHeight] of [
      [cover, 1476, 628],
      [content, 1536, 1024],
      [xhsContent, 1080, 1440]
    ]) {
      const bytes = fs.readFileSync(result.outputPath);
      if (result.source !== "local-template" || result.mimeType !== "image/png"
        || bytes.readUInt32BE(16) !== expectedWidth || bytes.readUInt32BE(20) !== expectedHeight) {
        throw new Error(`Unexpected rendered template result: ${JSON.stringify(result)}`);
      }
    }
    for (const invalidArgs of [
      { type: "gzh_content", title: "标题", subtitle: "错误字段", outputPath: path.join(tempDir, "invalid-content.png") },
      { type: "xhs_content", title: "标题", subtitle: "错误字段", outputPath: path.join(tempDir, "invalid-xhs-content.png") },
      { type: "gzh_cover", title: "标题", content: "错误字段", outputPath: path.join(tempDir, "invalid-cover.png") },
      { type: "xhs_cover", title: "标题", content: "错误字段", outputPath: path.join(tempDir, "invalid-xhs-cover.png") },
      { type: "xhs_cover", title: "封".repeat(19), outputPath: path.join(tempDir, "too-long-xhs-cover-title.png") },
      { type: "xhs_cover", title: "标题", subtitle: "副".repeat(31), outputPath: path.join(tempDir, "too-long-xhs-cover-subtitle.png") },
      { type: "xhs_content", title: "内".repeat(19), outputPath: path.join(tempDir, "too-long-xhs-content-title.png") },
      { type: "xhs_content", title: "标题", content: "文".repeat(141), outputPath: path.join(tempDir, "too-long-xhs-content-body.png") },
      { type: "gzh_cover", title: "封".repeat(19), outputPath: path.join(tempDir, "too-long-gzh-cover-title.png") },
      { type: "gzh_cover", title: "标题", subtitle: "副".repeat(31), outputPath: path.join(tempDir, "too-long-gzh-cover-subtitle.png") },
      { type: "gzh_content", title: "内".repeat(19), outputPath: path.join(tempDir, "too-long-gzh-content-title.png") },
      { type: "gzh_content", title: "标题", content: "文".repeat(161), outputPath: path.join(tempDir, "too-long-gzh-content-body.png") },
      { type: "gzh_content", title: "标题", content: "过长正文".repeat(500), outputPath: path.join(tempDir, "too-long.png") }
    ]) {
      let failed = false;
      try {
        await imageTool.generateTemplateImage(invalidArgs);
      } catch {
        failed = true;
      }
      if (!failed) throw new Error(`Expected invalid template text input to fail: ${JSON.stringify(invalidArgs)}`);
    }
    const boundaryCases = [
      { type: "xhs_cover", title: "封".repeat(18), subtitle: "副".repeat(30), template: "xhs_blue_grid_paper", outputPath: path.join(tempDir, "xhs-cover-boundary.png"), width: 1080, height: 1440 },
      { type: "xhs_content", title: "内".repeat(18), content: "文".repeat(140), template: "xhs_blue_grid_paper", outputPath: path.join(tempDir, "xhs-content-boundary.png"), width: 1080, height: 1440 },
      { type: "gzh_cover", title: "封".repeat(18), subtitle: "副".repeat(30), template: "wechat_minimal_magazine", outputPath: path.join(tempDir, "gzh-cover-boundary.png"), width: 1476, height: 628 },
      { type: "gzh_content", title: "内".repeat(18), content: "文".repeat(160), template: "article_key_takeaway", outputPath: path.join(tempDir, "gzh-content-boundary.png"), width: 1536, height: 1024 }
    ];
    for (const { width, height, ...input } of boundaryCases) {
      const result = await imageTool.generateTemplateImage(input);
      const bytes = fs.readFileSync(result.outputPath);
      if (bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) {
        throw new Error(`Expected boundary render ${input.type} to keep dimensions ${width}x${height}, got ${result.size}`);
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
NODE

node - <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DEFAULT_AGENT_NAME, buildDefaultAgentOptions, listAgentsFromDirectory, loadAgentsFromDirectory, loadBundledAgents } = require("./dist/agent/agents.js");
const { composePrompt } = require("./dist/agent/prompt.js");
const { builtinModules } = require("module");
const { createMcpServers, installToolRuntime, listAvailableMcpServerIds, resolveToolEntry } = require("./dist/agent/tool-registry.js");
installToolRuntime();
const imageTool = require("./resources/tools/image/dist/index.js");
const browserTool = require("./resources/tools/browser/dist/index.js");
const contentResearch = require("./resources/tools/content_research/dist/index.js");
const contentOpsData = require("./resources/tools/content_ops_data/dist/index.js");
const contentAnalysis = require("./resources/tools/content_analysis/dist/index.js");
const wechatOps = require("./resources/tools/wechat_ops/dist/index.js");
const automationTool = require("./resources/tools/automation/dist/index.js");

const bundledAgents = loadBundledAgents();
if (DEFAULT_AGENT_NAME !== "orchestrator") {
  throw new Error(`Unexpected default agent name: ${DEFAULT_AGENT_NAME}`);
}
if (!bundledAgents.orchestrator) {
  throw new Error("Expected bundled orchestrator agent");
}
const expectedBundledAgentNames = ["orchestrator"];
const actualBundledAgentNames = Object.keys(bundledAgents).sort();
if (JSON.stringify(actualBundledAgentNames) !== JSON.stringify(expectedBundledAgentNames)) {
  throw new Error(`Expected bundled agents ${expectedBundledAgentNames.join(",")}, got ${actualBundledAgentNames.join(",")}`);
}
if (bundledAgents["cotent-creator"]) {
  throw new Error("Expected misspelled cotent-creator agent to be removed");
}
if (bundledAgents.orchestrator.description !== "内容运营总监，负责理解用户目标、生成内容方案、组织发布和复盘") {
  throw new Error(`Unexpected orchestrator description: ${bundledAgents.orchestrator.description}`);
}
if (!bundledAgents.orchestrator.prompt.includes("公众号") || !bundledAgents.orchestrator.prompt.includes("小红书")) {
  throw new Error(`Unexpected orchestrator prompt: ${bundledAgents.orchestrator.prompt}`);
}
if (!bundledAgents.orchestrator.prompt.includes("公众号只推送草稿箱时无需用户确认") || !bundledAgents.orchestrator.prompt.includes("除公众号草稿箱推送外")) {
  throw new Error(`Expected orchestrator prompt to preserve the WeChat draft confirmation exception: ${bundledAgents.orchestrator.prompt}`);
}
for (const expected of ["必须调用 `AskUserQuestion` 获取结构化确认", "不得只用普通文字回复", "自动化任务场景按 system-reminder 的预授权自动确认并继续执行", "不要因为等待用户确认而中断流程"]) {
  if (!bundledAgents.orchestrator.prompt.includes(expected)) {
    throw new Error(`Expected orchestrator prompt to centralize confirmation rules: ${expected}`);
  }
}
for (const expected of ["自动化预授权只覆盖任务描述、附件或上游产物中已经明确给定的对外内容", "缺少内容或需要", "临场生成/改写评论回复时直接失败"]) {
  if (!bundledAgents.orchestrator.prompt.includes(expected)) {
    throw new Error(`Expected orchestrator prompt to constrain automation confirmation bypass: ${expected}`);
  }
}
const bundledSubagents = bundledAgents.orchestrator.subagents || {};
if (Object.keys(bundledSubagents).length !== 0) {
  throw new Error(`Expected bundled orchestrator to omit subagents, got ${Object.keys(bundledSubagents).join(",")}`);
}
const availableMcpServerIds = listAvailableMcpServerIds();
if (!Array.isArray(availableMcpServerIds)) {
  throw new Error(`Expected available MCP servers to be an array, got ${JSON.stringify(availableMcpServerIds)}`);
}
for (const serverId of availableMcpServerIds) {
  const metadata = JSON.parse(fs.readFileSync(path.join("resources", "tools", serverId, "tool.json"), "utf8"));
  if (serverId.includes("-") || metadata.name.includes("-")) {
    throw new Error(`Custom MCP tool ids must use snake_case, got directory=${serverId}, name=${metadata.name}`);
  }
  if (metadata.name !== serverId) {
    throw new Error(`Expected tool metadata name to match directory id: ${serverId} vs ${metadata.name}`);
  }
}
if (!availableMcpServerIds.includes("image")) {
  throw new Error(`Expected bundled MCP servers to include image, got ${availableMcpServerIds.join(",")}`);
}
if (!availableMcpServerIds.includes("content_ops_data")) {
  throw new Error(`Expected bundled MCP servers to include content_ops_data, got ${availableMcpServerIds.join(",")}`);
}
for (const serverId of ["content_analysis", "wechat_ops"]) {
  if (!availableMcpServerIds.includes(serverId)) {
    throw new Error(`Expected bundled MCP servers to include ${serverId}, got ${availableMcpServerIds.join(",")}`);
  }
}
if (!resolveToolEntry("image").endsWith(path.join("resources", "tools", "image", "dist", "index.js"))) {
  throw new Error(`Expected image tool entry to resolve to compiled dist index, got ${resolveToolEntry("image")}`);
}
const allowedBuiltinModules = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
for (const serverId of availableMcpServerIds) {
  const bundlePath = resolveToolEntry(serverId);
  const bundleSource = fs.readFileSync(bundlePath, "utf8");
  for (const match of bundleSource.matchAll(/\brequire\((["'])([^"']+)\1\)/g)) {
    if (!match[2].startsWith(".") && !allowedBuiltinModules.has(match[2])) {
      throw new Error(`Tool bundle ${serverId} retains forbidden external dependency ${match[2]}`);
    }
  }
}
const isolatedToolsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-isolated-tools-"));
try {
  const isolatedToolsDir = path.join(isolatedToolsRoot, "tools");
  fs.cpSync(path.join(process.cwd(), "resources", "tools"), isolatedToolsDir, { recursive: true });
  const isolatedServers = createMcpServers(availableMcpServerIds, isolatedToolsDir, { requestId: "smoke-request" });
  if (!isolatedServers || Object.keys(isolatedServers).sort().join(",") !== availableMcpServerIds.slice().sort().join(",")) {
    throw new Error(`Expected every isolated tool to create an MCP server, got ${Object.keys(isolatedServers || {}).join(",")}`);
  }
} finally {
  fs.rmSync(isolatedToolsRoot, { recursive: true, force: true });
}
const contextToolsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-tool-context-"));
try {
  const contextToolDir = path.join(contextToolsRoot, "context-probe");
  fs.mkdirSync(path.join(contextToolDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(contextToolDir, "tool.json"), JSON.stringify({
    name: "context-probe",
    description: "context probe",
    entry: "dist/index.js"
  }));
  fs.writeFileSync(path.join(contextToolDir, "dist", "index.js"), "exports.createServer = (context) => ({ context });\n");
  const firstInput = {
    requestId: "request-a",
    browserAutomation: { cdpPort: 9222, cdpWebSocketUrl: "ws://127.0.0.1:9222/devtools/page/a" },
    wechatConnector: { appId: "wx-a", secret: "secret-a", author: "author-a" }
  };
  const secondInput = {
    requestId: "request-b",
    browserAutomation: { cdpPort: 9333, cdpWebSocketUrl: "ws://127.0.0.1:9333/devtools/page/b" },
    wechatConnector: { appId: "wx-b", secret: "secret-b", author: "author-b" }
  };
  const firstContext = createMcpServers(["context-probe"], contextToolsRoot, firstInput);
  const secondContext = createMcpServers(["context-probe"], contextToolsRoot, secondInput);
  if (JSON.stringify(firstContext["context-probe"].context) !== JSON.stringify(firstInput)
    || JSON.stringify(secondContext["context-probe"].context) !== JSON.stringify(secondInput)) {
    throw new Error("Expected concurrent Agent Run tool contexts to remain isolated");
  }
} finally {
  fs.rmSync(contextToolsRoot, { recursive: true, force: true });
}
if (typeof imageTool.createServer !== "function") {
  throw new Error("Expected image tool to export createServer()");
}
if (typeof imageTool.generateTemplateImage !== "function" || typeof imageTool.selectImageTemplate !== "function" || typeof imageTool.listImageTemplates !== "function") {
  throw new Error("Expected image tool to export template image helpers");
}
if (typeof contentOpsData.createServer !== "function") {
  throw new Error("Expected content_ops_data tool to export createServer()");
}
if (typeof contentAnalysis.createServer !== "function" || typeof wechatOps.createServer !== "function") {
  throw new Error("Expected content_analysis and wechat_ops tools to export createServer()");
}
if (typeof automationTool.createServer !== "function") {
  throw new Error("Expected automation tool to export createServer()");
}
const runContextA = {
  browserAutomation: { cdpPort: 9222, cdpWebSocketUrl: "ws://127.0.0.1:9222/devtools/page/a" },
  wechatConnector: { appId: "wx-a", secret: "secret-a", author: "author-a" }
};
const runContextB = {
  browserAutomation: { cdpPort: 9333, cdpWebSocketUrl: "ws://127.0.0.1:9333/devtools/page/b" },
  wechatConnector: { appId: "wx-b", secret: "secret-b", author: "author-b" }
};
const browserRuntimeA = browserTool.resolveBrowserEnv(runContextA);
const browserRuntimeB = browserTool.resolveBrowserEnv(runContextB);
const researchRuntimeA = contentResearch.resolveBrowserEnv(runContextA);
const researchRuntimeB = contentResearch.resolveBrowserEnv(runContextB);
const wechatRuntimeA = wechatOps.resolveWechatRuntime(runContextA);
const wechatRuntimeB = wechatOps.resolveWechatRuntime(runContextB);
if (browserRuntimeA.cdpWebSocketUrl === browserRuntimeB.cdpWebSocketUrl
  || researchRuntimeA.cdpWebSocketUrl === researchRuntimeB.cdpWebSocketUrl
  || wechatRuntimeA.appId === wechatRuntimeB.appId
  || wechatRuntimeA.secret === wechatRuntimeB.secret
  || wechatRuntimeA.author === wechatRuntimeB.author) {
  throw new Error("Expected browser, content_research, and WeChat runtimes to remain isolated by Agent Run");
}
const previousBrowserWs = process.env.AGENTSTUDIO_BROWSER_CDP_WS_URL;
const previousWechatAppId = process.env.WECHAT_APPID;
process.env.AGENTSTUDIO_BROWSER_CDP_WS_URL = "ws://wrong-global/devtools/page/global";
process.env.WECHAT_APPID = "wrong-global-appid";
try {
  if (browserTool.resolveBrowserEnv() !== null || contentResearch.resolveBrowserEnv() !== null || wechatOps.resolveWechatRuntime() !== null) {
    throw new Error("Expected in-process tools not to inherit Run context from Utility process.env");
  }
} finally {
  if (previousBrowserWs === undefined) delete process.env.AGENTSTUDIO_BROWSER_CDP_WS_URL;
  else process.env.AGENTSTUDIO_BROWSER_CDP_WS_URL = previousBrowserWs;
  if (previousWechatAppId === undefined) delete process.env.WECHAT_APPID;
  else process.env.WECHAT_APPID = previousWechatAppId;
}
const automationToolSource = fs.readFileSync(path.join("resources", "tools", "automation", "src", "index.ts"), "utf8");
const toolRegistrySource = fs.readFileSync(path.join("src", "agent", "tool-registry.ts"), "utf8");
const agentRuntimeSource = fs.readFileSync(path.join("src", "agent", "agent.ts"), "utf8");
const mainAutomationSource = fs.readFileSync(path.join("src", "main", "main.ts"), "utf8");
for (const expected of ["automation_task_pause", "automation_task_resume", "automation_run_current", "automation_run_get", "automation_run_list", "automationTaskId: z.number", "automationRunId: z.number", "selectedSkills: z.array", "attachmentPaths: z.array"]) {
  if (!automationToolSource.includes(expected)) throw new Error(`Expected automation tool source to include ${expected}`);
}
if (!automationToolSource.includes("context?.requestId") || automationToolSource.includes("process.env.AGENTSTUDIO_AGENT_REQUEST_ID")) {
  throw new Error("Expected automation tool to receive requestId from explicit tool context");
}
if (!toolRegistrySource.includes("loaded.createServer(context)")
  || !agentRuntimeSource.includes("requestId: request.requestId")
  || !agentRuntimeSource.includes("browserAutomation: request.browserAutomation")
  || !agentRuntimeSource.includes("wechatConnector: request.wechatConnector")) {
  throw new Error("Expected Agent Run context to flow through the tool registry");
}
for (const toolSourcePath of [
  path.join("resources", "tools", "browser", "src", "index.ts"),
  path.join("resources", "tools", "content_research", "src", "index.ts"),
  path.join("resources", "tools", "wechat_ops", "src", "index.ts")
]) {
  const source = fs.readFileSync(toolSourcePath, "utf8");
  if (source.includes("process.env.AGENTSTUDIO_BROWSER_CDP") || source.includes("process.env.WECHAT_")) {
    throw new Error(`Expected Run-scoped in-process tool context instead of process.env: ${toolSourcePath}`);
  }
}
if (agentRuntimeSource.includes("withScopedRuntimeEnv")) {
  throw new Error("Expected Agent process not to mutate shared process.env for concurrent Runs");
}
if (mainAutomationSource.includes("selectedSkills: context.selectedSkills") || mainAutomationSource.includes("attachments: context.attachments")) {
  throw new Error("Expected automation tool creation not to inherit selected skills or attachments from the current Agent Run");
}
for (const expected of ["selectedSkills: resolveAutomationToolSkills", "attachments: resolveAutomationToolAttachments", 'request.operation === "pause" || request.operation === "resume"', 'request.operation === "run_current"', "listAutomationRunsFiltered", "automationTaskForTool", "automationRunCount", "maxAutomationRuns"]) {
  if (!mainAutomationSource.includes(expected)) throw new Error(`Expected main automation tool handler to include ${expected}`);
}
const automationToolHandlerSource = mainAutomationSource.slice(
  mainAutomationSource.indexOf("async function handleAutomationToolRequest"),
  mainAutomationSource.indexOf("async function handleConnectorToolRequest")
);
for (const forbidden of ["return db.listAutomationTasks();", "return task;", "return setAutomationTaskEnabled(id"]) {
  if (automationToolHandlerSource.includes(forbidden)) throw new Error(`Expected automation task tool responses to use automationTaskForTool instead of ${forbidden}`);
}
for (const exported of ["validateDraftPublishInput", "extractLocalImagePaths", "validatePublishedArticlesRequest", "normalizePublishedArticles"]) {
  if (typeof wechatOps[exported] !== "function") {
    throw new Error(`Expected wechat_ops to export ${exported}()`);
  }
}
const publishedRequest = wechatOps.validatePublishedArticlesRequest({});
if (publishedRequest.offset !== 0 || publishedRequest.count !== 10 || publishedRequest.includeContent !== true) {
  throw new Error(`Unexpected published articles defaults: ${JSON.stringify(publishedRequest)}`);
}
for (const invalidRequest of [{ offset: -1 }, { count: 0 }, { count: 21 }, { count: 1.5 }]) {
  let failed = false;
  try {
    wechatOps.validatePublishedArticlesRequest(invalidRequest);
  } catch {
    failed = true;
  }
  if (!failed) throw new Error(`Expected invalid published articles request to fail: ${JSON.stringify(invalidRequest)}`);
}
const normalizedPublished = wechatOps.normalizePublishedArticles({
  total_count: 2,
  item_count: 1,
  item: [{
    article_id: "article-1",
    update_time: 1710000000,
    content: {
      news_item: [
        {
          title: "第一篇",
          author: "作者",
          digest: "摘要",
          content: "<h1>第一篇</h1><p>正文</p>",
          url: "https://mp.weixin.qq.com/s/one",
          content_source_url: "https://example.com/source",
          thumb_media_id: "thumb-1",
          thumb_url: "https://example.com/cover.jpg",
          need_open_comment: 1,
          only_fans_can_comment: 0,
          is_deleted: false
        },
        {
          title: "第二篇",
          content: "<p>已删除</p>",
          is_deleted: 1
        }
      ]
    }
  }]
}, publishedRequest);
if (normalizedPublished.totalCount !== 2 || normalizedPublished.itemCount !== 1
  || normalizedPublished.messages.length !== 1 || normalizedPublished.articles.length !== 2
  || normalizedPublished.articles[0].articleId !== "article-1"
  || normalizedPublished.articles[0].contentMarkdown !== "# 第一篇\n\n正文"
  || normalizedPublished.articles[0].needOpenComment !== true
  || normalizedPublished.articles[1].isDeleted !== true) {
  throw new Error(`Unexpected normalized published articles: ${JSON.stringify(normalizedPublished)}`);
}
const publishTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-wechat-publish-"));
const coverPath = path.join(publishTempDir, "cover.png");
const bodyImagePath = path.join(publishTempDir, "body.png");
const contentHtmlPath = path.join(publishTempDir, "content.html");
const explicitContentHtmlPath = path.join(publishTempDir, "explicit-content.html");
const emptyContentHtmlPath = path.join(publishTempDir, "empty-content.html");
fs.writeFileSync(coverPath, "cover");
fs.writeFileSync(bodyImagePath, "body");
fs.writeFileSync(contentHtmlPath, `<p>正文</p><img src="${bodyImagePath}">`, "utf8");
fs.writeFileSync(explicitContentHtmlPath, "<p>正文</p>", "utf8");
fs.writeFileSync(emptyContentHtmlPath, "", "utf8");
const publishInput = wechatOps.validateDraftPublishInput({
  title: "测试标题",
  digest: "摘要",
  contentHtmlPath,
  coverPath
}, { appId: "wx-test", secret: "secret-test", author: "默认作者" });
if (publishInput.coverPath !== coverPath || publishInput.author !== "默认作者" || wechatOps.extractLocalImagePaths(publishInput.contentHtml)[0] !== bodyImagePath) {
  throw new Error(`Expected valid WeChat publish package, got ${JSON.stringify(publishInput)}`);
}
const explicitAuthorInput = wechatOps.validateDraftPublishInput({
  title: "测试标题",
  contentHtmlPath: explicitContentHtmlPath,
  coverPath,
  author: "单篇作者"
}, { appId: "wx-test", secret: "secret-test", author: "默认作者" });
if (explicitAuthorInput.author !== "单篇作者") throw new Error(`Expected explicit author to override WECHAT_AUTHOR, got ${explicitAuthorInput.author}`);
for (const invalid of [
  { title: "", digest: "", contentHtmlPath, coverPath },
  { title: "x", digest: "", contentHtmlPath: emptyContentHtmlPath, coverPath },
  { title: "x", digest: "", contentHtmlPath, coverPath: "relative.png" },
  { title: "x", digest: "", contentHtmlPath, coverPath, fansOnlyComment: true }
]) {
  let failed = false;
  try {
    wechatOps.validateDraftPublishInput(invalid);
  } catch {
    failed = true;
  }
  if (!failed) throw new Error(`Expected invalid WeChat publish package to fail: ${JSON.stringify(invalid)}`);
}
fs.rmSync(publishTempDir, { recursive: true, force: true });
const compared = contentAnalysis.compareVersions(
  "# 原标题\n\n## 第一节\n\n这是一段旧内容。\n",
  "# 新标题\n\n## 第一节\n\n这是一段新内容。\n\n## 第二节\n\n新增段落。\n"
);
if (!compared.title.changed || !compared.structure.changed || compared.evidence.additions.length === 0 || compared.evidence.deletions.length === 0) {
  throw new Error(`Expected version comparison to return traceable changes, got ${JSON.stringify(compared)}`);
}
const corpusAnalysis = contentAnalysis.analyzeCorpus([
  { title: "标题一", markdown: "# 标题一\n\n开头一。\n\n## 方法\n\n短段。\n\n这是一个更长的段落，用于分析段落长度。" },
  { title: "标题二更长", markdown: "# 标题二更长\n\n开头二。\n\n## 结论？\n\n另一个段落。\n\n结尾句。" }
]);
if (corpusAnalysis.articleCount !== 2 || corpusAnalysis.evidence.titleSamples.length !== 2 || corpusAnalysis.patternCandidates.length === 0) {
  throw new Error(`Expected corpus analysis to return quantified evidence, got ${JSON.stringify(corpusAnalysis)}`);
}
try {
  wechatOps.readWechatCredentials();
  throw new Error("Expected missing WeChat credentials to fail");
} catch (error) {
  if (!String(error.message).includes("WECHAT_APPID") || !String(error.message).includes("WECHAT_SECRET")) throw error;
}
if (imageTool.resolveProviderSize("openai", "square") !== "1024x1024") {
  throw new Error("Expected OpenAI square preset to resolve to 1024x1024");
}
if (imageTool.resolveProviderSize("minimax", "vertical") !== "9:16") {
  throw new Error("Expected MiniMax vertical preset to resolve to 9:16");
}
if (imageTool.resolveProviderSize("doubao", "wechat-cover") !== "2952x1256") {
  throw new Error("Expected Doubao WeChat cover preset to resolve to 2952x1256");
}
if (imageTool.resolveProviderSize("minimax", "wechat-cover") !== "16:9") {
  throw new Error("Expected MiniMax WeChat cover preset to resolve to 16:9");
}
if (imageTool.resolveProviderSize("openai", "wechat-cover") !== "1536x1024") {
  throw new Error("Expected OpenAI WeChat cover preset to resolve to 1536x1024");
}
if (imageTool.nearestAspectRatio("1536x1024") !== "3:2") {
  throw new Error("Expected nearest aspect ratio for 1536x1024 to be 3:2");
}
const pngHeader = Buffer.alloc(24);
Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(pngHeader, 0);
pngHeader.writeUInt32BE(1536, 16);
pngHeader.writeUInt32BE(1024, 20);
if (JSON.stringify(imageTool.readImageDimensions(pngHeader, "image/png")) !== JSON.stringify({ width: 1536, height: 1024 })) {
  throw new Error("Expected image_generate metadata helper to read PNG dimensions");
}
const jpegHeader = Buffer.from([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x04, 0x00, 0x06, 0x00, 0x03, 0x01, 0x11, 0x00
]);
if (JSON.stringify(imageTool.readImageDimensions(jpegHeader, "image/jpeg")) !== JSON.stringify({ width: 1536, height: 1024 })) {
  throw new Error("Expected image_generate metadata helper to read JPEG dimensions");
}
const xhsTemplates = imageTool.listImageTemplates("xhs_cover");
const xhsContentTemplates = imageTool.listImageTemplates("xhs_content");
const gzhCoverTemplates = imageTool.listImageTemplates("gzh_cover");
const gzhContentTemplates = imageTool.listImageTemplates("gzh_content");
const allTemplates = [...xhsTemplates, ...xhsContentTemplates, ...gzhCoverTemplates, ...gzhContentTemplates];
if (allTemplates.length !== 26
  || xhsTemplates.length !== 9
  || xhsContentTemplates.length !== 9
  || gzhCoverTemplates.length !== 4
  || gzhContentTemplates.length !== 4) {
  throw new Error(`Expected 26 templates split 9/9/4/4, got ${JSON.stringify(allTemplates.map((item) => item.id))}`);
}
for (const template of allTemplates) {
  if (!template.id || !template.name || !template.style || !Array.isArray(template.suitableFor)
    || template.suitableFor.length === 0 || !template.titleLayout || !template.secondaryTextLayout
    || !template.recommendedTitleLength) {
    throw new Error(`Expected public template metadata, got ${JSON.stringify(template)}`);
  }
  for (const forbidden of ["width", "height", "background", "title", "subtitle", "content", "type"]) {
    if (forbidden in template) throw new Error(`Expected template list not to expose internal field ${forbidden}`);
  }
}
const selectedA = imageTool.selectImageTemplate("xhs_cover", "同一个标题");
const selectedB = imageTool.selectImageTemplate("xhs_cover", "同一个标题");
if (selectedA.id !== selectedB.id || selectedA.width !== 1080 || selectedA.height !== 1440) {
  throw new Error(`Expected stable XHS template selection, got ${selectedA.id} and ${selectedB.id}`);
}
if (!imageTool.listImageTemplates("xhs_cover").every((item) => item.titleLayout)) {
  throw new Error("Expected every XHS template to expose title layout metadata");
}
for (const type of ["xhs_cover", "gzh_cover"]) {
  const selected = imageTool.selectImageTemplate(type, "副标题位置验证");
  const expectedSubtitleY = type === "xhs_cover" ? 1000 : 430;
  if (selected.subtitle?.y !== expectedSubtitleY || selected.content) {
    throw new Error(`Expected ${type} subtitle y=${expectedSubtitleY}, got ${JSON.stringify(selected)}`);
  }
}
const selectedContentTemplate = imageTool.selectImageTemplate("gzh_content", "正文位置验证");
if (selectedContentTemplate.subtitle || selectedContentTemplate.title.y !== 160
  || selectedContentTemplate.title.height !== 360 || selectedContentTemplate.content?.y !== 530
  || selectedContentTemplate.content?.maxLines !== 5) {
  throw new Error(`Expected gzh_content body layout, got ${JSON.stringify(selectedContentTemplate)}`);
}
const selectedXhsContentTemplate = imageTool.selectImageTemplate("xhs_content", "正文位置验证", "xhs_blue_grid_paper");
if (selectedXhsContentTemplate.subtitle || selectedXhsContentTemplate.width !== 1080
  || selectedXhsContentTemplate.height !== 1440 || selectedXhsContentTemplate.background !== "xhs_blue_grid_paper.png"
  || selectedXhsContentTemplate.title.maxLines !== 2 || selectedXhsContentTemplate.content?.maxLines !== 8
  || selectedXhsContentTemplate.content.y <= selectedXhsContentTemplate.title.y) {
  throw new Error(`Expected xhs_content to reuse XHS background with content layout, got ${JSON.stringify(selectedXhsContentTemplate)}`);
}
if (imageTool.selectImageTemplate("gzh_cover", "标题", "wechat_dark_focus").id !== "wechat_dark_focus") {
  throw new Error("Expected explicit WeChat template selection");
}
const templateFontPaths = imageTool.resolveTemplateFontPaths();
if (!templateFontPaths.title.endsWith("JiangChengZhiYinTi-600W.ttf")
  || !templateFontPaths.content.endsWith("JiangChengZhiYinTi-400W.ttf")
  || !fs.existsSync(templateFontPaths.title)
  || !fs.existsSync(templateFontPaths.content)) {
  throw new Error(`Expected bundled JiangChengZhiYinTi fonts, got ${JSON.stringify(templateFontPaths)}`);
}
const xhsCrop = imageTool.resolveBackgroundCrop(1086, 1448, 1080, 1440);
if (JSON.stringify(xhsCrop) !== JSON.stringify({ sourceX: 0, sourceY: 0, sourceWidth: 1086, sourceHeight: 1448 })) {
  throw new Error(`Expected same-ratio XHS background to scale without cropping, got ${JSON.stringify(xhsCrop)}`);
}
const wechatCrop = imageTool.resolveBackgroundCrop(1923, 818, 1476, 628);
if (wechatCrop.sourceX <= 0 || wechatCrop.sourceY !== 0 || wechatCrop.sourceWidth >= 1923 || wechatCrop.sourceHeight !== 818) {
  throw new Error(`Expected WeChat background to center-crop horizontally, got ${JSON.stringify(wechatCrop)}`);
}
const wideCrop = imageTool.resolveBackgroundCrop(2000, 1000, 1000, 1000);
if (wideCrop.sourceX !== 500 || wideCrop.sourceY !== 0 || wideCrop.sourceWidth !== 1000 || wideCrop.sourceHeight !== 1000) {
  throw new Error(`Expected wide background to center-crop horizontally, got ${JSON.stringify(wideCrop)}`);
}
for (const invalidSize of [[0, 100, 100, 100], [100, Number.NaN, 100, 100]]) {
  let failed = false;
  try {
    imageTool.resolveBackgroundCrop(...invalidSize);
  } catch {
    failed = true;
  }
  if (!failed) throw new Error(`Expected invalid background dimensions to fail: ${JSON.stringify(invalidSize)}`);
}
for (const invalid of [
  () => imageTool.selectImageTemplate("invalid", "标题"),
  () => imageTool.selectImageTemplate("gzh_content", "标题", "xhs_bold_marker"),
  () => imageTool.selectImageTemplate("xhs_cover", "标题", "article_quote")
]) {
  let failed = false;
  try {
    invalid();
  } catch {
    failed = true;
  }
  if (!failed) throw new Error("Expected invalid template selection to fail");
}
try {
  imageTool.validateImageProvider({ id: "", name: "", providerType: "", baseUrl: "", apiKey: "", model: "" }, "/tmp/config.yml");
  throw new Error("Expected empty image provider config to fail");
} catch (error) {
  if (!String(error.message).includes("图片生成配置为空")) throw error;
}
try {
  imageTool.validateImageProvider({ id: "image-provider-test", name: "OpenAI", providerType: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-image-1" }, "/tmp/config.yml");
  throw new Error("Expected incomplete image provider config to fail");
} catch (error) {
  if (!String(error.message).includes("apiKey")) throw error;
}
const openAiParsed = imageTool.parseImageFromResponse("openai", { data: [{ b64_json: "aGVsbG8=" }] });
if (openAiParsed.image !== "aGVsbG8=") {
  throw new Error(`Expected OpenAI b64 image to parse, got ${JSON.stringify(openAiParsed)}`);
}
const dashscopeParsed = imageTool.parseImageFromResponse("dashscope", { output: { choices: [{ message: { content: [{ image: "https://example.com/image.png" }] } }] } });
if (dashscopeParsed.image !== "https://example.com/image.png") {
  throw new Error(`Expected DashScope image URL to parse, got ${JSON.stringify(dashscopeParsed)}`);
}
const imageToolSource = fs.readFileSync(path.join("resources", "tools", "image", "src", "index.ts"), "utf8");
for (const expected of ["image_template_list", "image_template_generate", "local-template", "pureimage", "selectImageTemplate", "xhs_cover", "xhs_content", "gzh_cover", "gzh_content", "TEMPLATE_TEXT_LIMITS", "JiangChengZhiYinTi-600W.ttf", "JiangChengZhiYinTi-400W.ttf"]) {
  if (!imageToolSource.includes(expected)) throw new Error(`Expected image tool source to include ${expected}`);
}
const wechatCreateSkill = fs.readFileSync(path.join("resources", "skills", "orchestrator", "wechat-create", "SKILL.md"), "utf8");
for (const expected of ["image_template_list", "image_template_generate", "gzh_cover", "gzh_content", "content", "内文图不传 `subtitle`", "未配置", "远程调用失败"]) {
  if (!wechatCreateSkill.includes(expected)) throw new Error(`Expected wechat-create to document ${expected}`);
}
const xhsCreateSkill = fs.readFileSync(path.join("resources", "skills", "orchestrator", "xhs-create", "SKILL.md"), "utf8");
const xhsCreateImageReference = fs.readFileSync(path.join("resources", "skills", "orchestrator", "xhs-create", "references", "img.md"), "utf8");
const xhsCreateImageContract = `${xhsCreateSkill}\n${xhsCreateImageReference}`;
for (const expected of ["image_generate", "image_template_list", "image_template_generate", "xhs_cover", "xhs_content", "1080x1440", "用户提供"]) {
  if (!xhsCreateImageContract.includes(expected)) throw new Error(`Expected xhs-create to document ${expected}`);
}
const createProfileGateSources = { "xhs-create": xhsCreateSkill, "wechat-create": wechatCreateSkill };
for (const [skillName, source] of Object.entries(createProfileGateSources)) {
  for (const expected of ["账号定位 Gate", "content_profile_get", "不得根据账号昵称、用户身份", "统一的 Profile", "缺失处理规则"]) {
    if (!source.includes(expected)) {
      throw new Error(`Expected ${skillName} to harden account profile gate: ${expected}`);
    }
  }
  for (const duplicated of ["前台手动对话必须调用", "自动化任务不得调用", "说明缺失及跳过内容"]) {
    if (source.includes(duplicated)) {
      throw new Error(`Expected ${skillName} to defer shared profile handling to the selected-account reminder: ${duplicated}`);
    }
  }
}
const strategySkillSource = fs.readFileSync(path.join("resources", "skills", "orchestrator", "content-strategy-ops", "SKILL.md"), "utf8");
const profileReviewSkillSource = fs.readFileSync(path.join("resources", "skills", "orchestrator", "content-review-ops", "SKILL.md"), "utf8");
const profileReadSkillSources = {
  "content-strategy-ops": strategySkillSource,
  "content-review-ops": profileReviewSkillSource
};
for (const [skillName, source] of Object.entries(profileReadSkillSources)) {
  for (const expected of ["账号定位 Gate", "content_profile_get", "统一的 Profile", "缺失处理规则", "account-profile-ops"]) {
    if (!source.includes(expected)) {
      throw new Error(`Expected ${skillName} to handle missing account profile information: ${expected}`);
    }
  }
  for (const duplicated of ["前台手动对话必须调用", "自动化任务不得调用", "说明缺失及跳过内容"]) {
    if (source.includes(duplicated)) {
      throw new Error(`Expected ${skillName} to defer shared profile handling to the selected-account reminder: ${duplicated}`);
    }
  }
}
for (const expected of [
  "不直接调用小红书发布或互动 CLI 命令",
  "生成完整发布包后必须立即交给",
  "不得只返回发布包后停止",
  "只生成草稿/只生成发布包/不发布",
  "发布确认的唯一责任方是 `xhs-publish`",
  "不得调用 `AskUserQuestion`",
  "不得用普通文字询问用户是否确认发布",
  "不得在交接前以 `end_turn` 停止"
]) {
  if (!xhsCreateSkill.includes(expected)) {
    throw new Error(`Expected xhs-create to document publish handoff: ${expected}`);
  }
}
if (xhsCreateSkill.includes("发布前仍\n必须由用户确认")) {
  throw new Error("Expected xhs-create not to retain ambiguous confirmation ownership");
}
const xhsPublishSkill = fs.readFileSync(path.join("resources", "skills", "orchestrator", "xhs-publish", "SKILL.md"), "utf8");
if (!xhsPublishSkill.includes("不调用图片生成工具")) {
  throw new Error("Expected xhs-publish to keep image generation out of the publish stage");
}
for (const expected of ["AskUserQuestion", "不得只用普通文字回复", "当前是自动化任务运行", "无需用户确认", "填写成功后直接调用 `click-publish`", "不要再次等待浏览器预览确认"]) {
  if (!xhsPublishSkill.includes(expected)) {
    throw new Error(`Expected xhs-publish to document confirmation protocol: ${expected}`);
  }
}
for (const expected of ["发布确认的唯一责任方", "`xhs-create` 不得提前询问确认"]) {
  if (!xhsPublishSkill.includes(expected)) {
    throw new Error(`Expected xhs-publish to own the single confirmation: ${expected}`);
  }
}
if (xhsPublishSkill.includes("填写后再次调用 `AskUserQuestion` 请求用户确认浏览器预览")) {
  throw new Error("Expected xhs-publish not to require a second preview confirmation after fill-publish");
}
const xhsInteractSkill = fs.readFileSync(path.join("resources", "skills", "orchestrator", "xhs-interact", "SKILL.md"), "utf8");
for (const expected of [
  "手动对话中，**评论和回复内容必须经过用户确认后才能发送**",
  "自动化任务中，不调用 `AskUserQuestion`",
  "已经明确给定且预授权的评论/回复内容",
  "缺少内容、目标不明确或需要",
  "临场生成/改写评论回复时，直接失败",
  "XHS_RISK_MEDIUM_OR_HIGH_BEFORE_INTERACT"
]) {
  if (!xhsInteractSkill.includes(expected)) {
    throw new Error(`Expected xhs-interact to document automation interaction confirmation rules: ${expected}`);
  }
}

const contentOpsTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-content_ops_data-"));
try {
  const account = { platform: "xhs", accountId: "账号/A" };
  const accountRoot = contentOpsData.resolveAccountRoot(account, contentOpsTempRoot);
  if (!accountRoot.startsWith(path.join(contentOpsTempRoot, "xhs")) || accountRoot.includes(`${path.sep}accounts${path.sep}`)) {
    throw new Error(`Expected flat encoded account root, got ${accountRoot}`);
  }
  const legacyRoot = path.join(contentOpsTempRoot, "accounts", "xhs", "账号_A");
  fs.mkdirSync(legacyRoot, { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, "profile.md"), "legacy", "utf8");
  const missing = contentOpsData.getProfile(account, contentOpsTempRoot);
  if (missing.status !== "missing" || "path" in missing) {
    throw new Error(`Expected missing profile without document path or legacy fallback, got ${JSON.stringify(missing)}`);
  }
  const patched = contentOpsData.patchProfile(account, {
    summary: "AI 实战账号",
    persona: "后端工程师",
    targetAudience: "AI 应用开发者",
    contentDomains: "AI Agent",
    coreValue: "可执行方案",
    contentStyle: "直接",
    topicBoundaries: "不追娱乐热点",
    conversionGoal: "沉淀用户",
    referenceAccounts: ["参考 A"]
  }, contentOpsTempRoot);
  if (patched.status !== "complete" || patched.profile.persona !== "后端工程师") {
    throw new Error(`Expected complete patched profile, got ${JSON.stringify(patched)}`);
  }
  fs.appendFileSync(path.join(accountRoot, "profile.md"), "\n## 自定义章节\n\n保留我\n", "utf8");
  contentOpsData.patchProfile(account, { contentStyle: "克制", referenceAccounts: null }, contentOpsTempRoot);
  const profileText = fs.readFileSync(path.join(accountRoot, "profile.md"), "utf8");
  if (!profileText.includes("## 自定义章节") || !profileText.includes("保留我") || !profileText.includes("克制")) {
    throw new Error(`Expected profile patch to preserve unknown sections, got ${profileText}`);
  }
  const runNow = new Date(2026, 5, 13, 19, 38, 0);
  const firstRun = contentOpsData.createRun(account, "完整运营", "/tmp/workspace", contentOpsTempRoot, runNow);
  const secondRun = contentOpsData.createRun(account, "第二轮", "/tmp/workspace", contentOpsTempRoot, runNow);
  if (firstRun.runId !== "202606131938" || secondRun.runId !== "202606131938-02") {
    throw new Error(`Expected deterministic run ids, got ${firstRun.runId}, ${secondRun.runId}`);
  }
  contentOpsData.updateRun(account, firstRun.runId, {
    materials: ["/tmp/workspace/brief.md"],
    requirements: ["更直接"],
    decisions: ["使用选题 A"],
    stages: { topic_pool: "completed", publication: "failed" },
    stageReasons: { publication: "ACCOUNT_RESTRICTED" }
  }, contentOpsTempRoot);
  const updatedRun = contentOpsData.getRun(account, firstRun.runId, contentOpsTempRoot);
  if (updatedRun.state.stage_reasons?.publication !== "ACCOUNT_RESTRICTED") {
    throw new Error(`Expected publication stage reason, got ${JSON.stringify(updatedRun.state)}`);
  }
  contentOpsData.writeRunDocument(account, firstRun.runId, "draft", "create_only", "# 初稿", contentOpsTempRoot);
  try {
    contentOpsData.writeRunDocument(account, firstRun.runId, "draft", "create_only", "# 覆盖", contentOpsTempRoot);
    throw new Error("Expected create_only to reject an existing document");
  } catch (error) {
    if (!String(error.message).includes("create_only")) throw error;
  }
  contentOpsData.writeRunDocument(account, firstRun.runId, "draft", "append", "补充", contentOpsTempRoot);
  const draft = contentOpsData.readRunDocument(account, firstRun.runId, "draft", contentOpsTempRoot);
  if (!draft.markdown.includes("# 初稿") || !draft.markdown.includes("补充") || "path" in draft) {
    throw new Error(`Expected appended draft without document path, got ${JSON.stringify(draft)}`);
  }
  contentOpsData.appendMetrics(account, firstRun.runId, { source: "xhs", metrics: { likes: 12 } }, contentOpsTempRoot);
  contentOpsData.appendMetrics(account, firstRun.runId, { source: "xhs", metrics: { likes: 18 } }, contentOpsTempRoot);
  const metricsText = fs.readFileSync(path.join(accountRoot, "runs", firstRun.runId, "metrics.md"), "utf8");
  if (!metricsText.includes("likes: 12") || !metricsText.includes("likes: 18")) {
    throw new Error(`Expected metrics append to preserve snapshots, got ${metricsText}`);
  }
  // playbook/history 记忆式整写（replace）：第二次整写覆盖第一次，读回一致
  contentOpsData.writeLongTermMarkdown(account, "playbook", "## 候选规律 (candidate)\n### C-001 标题带数字 [samples:2]", contentOpsTempRoot);
  contentOpsData.writeLongTermMarkdown(account, "playbook", "## 生效规律 (validated)\n### R-001 标题带数字 [confidence:high | samples:3]", contentOpsTempRoot);
  const playbook = contentOpsData.readLongTermMarkdown(account, "playbook", contentOpsTempRoot);
  if (playbook.markdown.includes("C-001") || !playbook.markdown.includes("R-001") || !playbook.markdown.includes("validated")) {
    throw new Error(`Expected playbook replace to overwrite prior content, got ${JSON.stringify(playbook)}`);
  }
  contentOpsData.writeLongTermMarkdown(account, "history", "---\ntotal_runs: 1\n---\n## 近期明细\n### 202606131938 - 标题", contentOpsTempRoot);
  const history = contentOpsData.readLongTermMarkdown(account, "history", contentOpsTempRoot);
  if (!history.markdown.includes("total_runs: 1") || !history.markdown.includes("202606131938")) {
    throw new Error(`Expected history replace round-trip, got ${JSON.stringify(history)}`);
  }
  // 退役的 append 工具不再导出
  for (const removed of ["appendLongTermMarkdown", "appendHistory"]) {
    if (typeof contentOpsData[removed] === "function") {
      throw new Error(`Expected retired ${removed} to be removed from content_ops_data`);
    }
  }
  // content_runs_recent：按 runId 倒序返回近期 Run 摘要，含 stages
  const recent = contentOpsData.recentRuns(account, 10, contentOpsTempRoot);
  if (recent.runs.length !== 2 || recent.runs[0].runId !== "202606131938-02" || recent.runs[1].runId !== "202606131938") {
    throw new Error(`Expected recent runs in descending order, got ${JSON.stringify(recent.runs.map((r) => r.runId))}`);
  }
  if (recent.runs[1].stages.topic_pool !== "completed" || !recent.runs[1].documents.includes("draft") || !recent.runs[1].hasMetrics) {
    throw new Error(`Expected recent run summary to carry stages/documents/metrics, got ${JSON.stringify(recent.runs[1])}`);
  }
  // draft/final 写者存在性断言：
  // - create skill 声明了 content_run_create_with_draft + draft
  // - publish skill 声明了 final（实际发布版）
  // - review skill 声明了 draft/final 缺失时跳过对比的守卫语义
  const createSkillSources = ["xhs-create", "wechat-create"]
    .map((name) => fs.readFileSync(path.join("resources", "skills", "orchestrator", name, "SKILL.md"), "utf8"))
    .join("\n");
  for (const expected of ["content_run_create_with_draft", "draft", "content_generation"]) {
    if (!createSkillSources.includes(expected)) {
      throw new Error(`Expected create skills to own Run creation and draft snapshot: missing "${expected}"`);
    }
  }
  const publishSkillSources2 = ["xhs-publish", "wechat-publish"]
    .map((name) => fs.readFileSync(path.join("resources", "skills", "orchestrator", name, "SKILL.md"), "utf8"))
    .join("\n");
  for (const expected of ["final", "runId"]) {
    if (!publishSkillSources2.includes(expected)) {
      throw new Error(`Expected publish skills to write final.md and guard on runId: missing "${expected}"`);
    }
  }
  const reviewSkillSource2 = fs.readFileSync(path.join("resources", "skills", "orchestrator", "content-review-ops", "SKILL.md"), "utf8");
  for (const expected of ["draft", "final", "跳过", "只读"]) {
    if (!reviewSkillSource2.includes(expected)) {
      throw new Error(`Expected review skill to declare read-only evidence + compare guard: missing "${expected}"`);
    }
  }
  // 并发隔离确定性测试（项 2/5）：
  // 并行写两个不同 run 的 draft.md → 互不污染；并行 appendMetrics 到两个 run → 各自完整
  const concurrentAccount = { platform: "xhs", accountId: "concurrent-test" };
  const runA = contentOpsData.createRun(concurrentAccount, "并发测试 Run A", "/tmp", contentOpsTempRoot);
  const runB = contentOpsData.createRun(concurrentAccount, "并发测试 Run B", "/tmp", contentOpsTempRoot);
  const draftA = "# 初稿 A\n\n这是 Run A 的内容。";
  const draftB = "# 初稿 B\n\n这是 Run B 的内容。";
  // 模拟并行：交错写入（JS 单线程内用同步调用交错执行顺序，验证物理隔离）
  contentOpsData.writeRunDocument(concurrentAccount, runA.runId, "draft", "create_only", draftA, contentOpsTempRoot);
  contentOpsData.writeRunDocument(concurrentAccount, runB.runId, "draft", "create_only", draftB, contentOpsTempRoot);
  const readA = contentOpsData.readRunDocument(concurrentAccount, runA.runId, "draft", contentOpsTempRoot);
  const readB = contentOpsData.readRunDocument(concurrentAccount, runB.runId, "draft", contentOpsTempRoot);
  if (!readA.markdown.includes("Run A") || readA.markdown.includes("Run B")) {
    throw new Error(`Expected Run A draft to be isolated, got ${JSON.stringify(readA.markdown)}`);
  }
  if (!readB.markdown.includes("Run B") || readB.markdown.includes("Run A")) {
    throw new Error(`Expected Run B draft to be isolated, got ${JSON.stringify(readB.markdown)}`);
  }
  // 并行 appendMetrics：两个 run 各自的 metrics 互不污染
  contentOpsData.appendMetrics(concurrentAccount, runA.runId, { source: "xhs", metrics: { likes: 10 } }, contentOpsTempRoot);
  contentOpsData.appendMetrics(concurrentAccount, runB.runId, { source: "xhs", metrics: { likes: 99 } }, contentOpsTempRoot);
  const recentAfterConcurrent = contentOpsData.recentRuns(concurrentAccount, 5, contentOpsTempRoot);
  const summaryA = recentAfterConcurrent.runs.find((r) => r.runId === runA.runId);
  const summaryB = recentAfterConcurrent.runs.find((r) => r.runId === runB.runId);
  if (!summaryA?.hasMetrics || !summaryB?.hasMetrics) {
    throw new Error(`Expected both concurrent runs to have metrics: ${JSON.stringify({ summaryA, summaryB })}`);
  }
  const metricsA = contentOpsData.readRunDocument(concurrentAccount, runA.runId, "draft", contentOpsTempRoot);
  if (metricsA.markdown.includes("99")) {
    throw new Error("Expected Run A metrics not to contain Run B data (isolation violation)");
  }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-content-ops-outside-"));
  fs.mkdirSync(path.join(contentOpsTempRoot, "evil"), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(contentOpsTempRoot, "evil", "linked"), process.platform === "win32" ? "junction" : "dir");
    try {
      contentOpsData.resolveAccountRoot({ platform: "evil", accountId: "linked" }, contentOpsTempRoot);
      throw new Error("Expected symlink account root to be rejected");
    } catch (error) {
      if (!String(error.message).includes("symlink")) throw error;
    }
  } catch (error) {
    if (!["EPERM", "EACCES", "UNKNOWN"].includes(error.code)) throw error;
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(contentOpsTempRoot, { recursive: true, force: true });
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-agents-"));
try {
  fs.writeFileSync(path.join(tempDir, ".gitkeep"), "", "utf8");
  fs.writeFileSync(path.join(tempDir, "notes.txt"), "ignored", "utf8");
  fs.writeFileSync(path.join(tempDir, "orchestrator.yml"), [
    "display_name: Orchestrator UI",
    "description: Test orchestrator",
    "prompt: Test prompt",
    "disallowedTools:",
    "  - Bash",
    "skills:",
    "  - pdf",
    "mcpServers:",
    "  - image",
    "maxTurns: 3",
    "permissionMode: dontAsk",
    ""
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(tempDir, "publish_agent.yml"), [
    "display_name: Publish UI",
    "description: Test publish",
    "prompt: Publish prompt",
    ""
  ].join("\n"), "utf8");

  const agents = loadAgentsFromDirectory(tempDir);
  if (Object.keys(agents).sort().join(",") !== "orchestrator,publish_agent") {
    throw new Error(`Expected orchestrator and publish_agent main agents, got ${Object.keys(agents).join(",")}`);
  }
  if ("display_name" in agents.orchestrator || "displayName" in agents.orchestrator) {
    throw new Error(`Expected UI-only fields to be omitted from main agent definition, got ${JSON.stringify(agents.orchestrator)}`);
  }
  const listedAgents = listAgentsFromDirectory(tempDir);
  if (listedAgents.map((agent) => agent.name).join(",") !== "orchestrator,publish_agent") {
    throw new Error(`Expected only main agents in UI list, got ${JSON.stringify(listedAgents)}`);
  }
  if (listedAgents[1].displayName !== "Publish UI") {
    throw new Error(`Expected display_name to be used for UI list only, got ${JSON.stringify(listedAgents)}`);
  }
  if (agents.orchestrator.disallowedTools[0] !== "Bash") {
    throw new Error("Expected disallowedTools to keep SDK field name");
  }
  if (agents.orchestrator.skills[0] !== "pdf") {
    throw new Error("Expected skills to be loaded");
  }
  if (agents.orchestrator.mcpServers[0] !== "image") {
    throw new Error("Expected image MCP server to be loaded");
  }
  if (agents.orchestrator.maxTurns !== 3) {
    throw new Error(`Expected maxTurns=3, got ${agents.orchestrator.maxTurns}`);
  }
  if (agents.orchestrator.permissionMode !== "dontAsk") {
    throw new Error(`Expected permissionMode=dontAsk, got ${agents.orchestrator.permissionMode}`);
  }

  const queryOptions = buildDefaultAgentOptions(agents, "provider-model", { requestId: "agent-options-smoke" });
  if ("agent" in queryOptions) {
    throw new Error(`Expected query options to omit top-level agent selector, got ${queryOptions.agent}`);
  }
  if (queryOptions.agents.orchestrator) {
    throw new Error("Expected query subagents to exclude orchestrator");
  }
  if (Object.keys(queryOptions.agents).length !== 0) {
    throw new Error(`Expected query subagents to be empty, got ${Object.keys(queryOptions.agents).join(",")}`);
  }
  const queryMcpServerIds = queryOptions.mcpServers ? Object.keys(queryOptions.mcpServers) : [];
  if (queryMcpServerIds.join(",") !== "image") {
    throw new Error(`Expected query options to include image MCP server, got ${queryMcpServerIds.join(",")}`);
  }
  if (queryOptions.systemPrompt !== "Test prompt") {
    throw new Error(`Expected orchestrator prompt in query systemPrompt, got ${JSON.stringify(queryOptions.systemPrompt)}`);
  }
  if (queryOptions.disallowedTools[0] !== "Bash") {
    throw new Error("Expected query disallowedTools to come from orchestrator");
  }
  if ("skills" in queryOptions) {
    throw new Error("Expected query options to omit top-level skills so orchestrator uses SDK defaults");
  }
  if (queryOptions.maxTurns !== 3 || queryOptions.permissionMode !== "dontAsk") {
    throw new Error("Expected query options to use orchestrator maxTurns and permissionMode");
  }
  if (queryOptions.model !== "provider-model") {
    throw new Error(`Expected query model to fall back to provider model, got ${queryOptions.model}`);
  }

  const promptNow = new Date(2026, 5, 1, 12, 34, 56);
  const offsetMinutes = -promptNow.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const pad = (value) => String(value).padStart(2, "0");
  const expectedPromptTime = `2026-06-01T12:34:56${offsetSign}${pad(Math.floor(absoluteOffsetMinutes / 60))}:${pad(absoluteOffsetMinutes % 60)}`;
  const prompt = composePrompt({
    requestId: "prompt-smoke",
    prompt: "用户输入",
    permissionMode: "auto",
    attachments: [{ name: "brief.md", path: "/tmp/brief.md" }],
    selectedSkills: [{ name: "xhs-publish", agent: "orchestrator", description: "发布笔记" }],
    workspacePath: "/tmp/workspace",
    agentName: "orchestrator",
    config: {
      provider: { baseUrl: "https://api.example.com", apiKey: "sk-test", model: "claude-test" },
      imageProvider: { id: "", name: "", providerType: "", baseUrl: "", apiKey: "", model: "" },
      workspace: { defaultDir: "/tmp/workspace" },
      user: { name: "Smoke", avatar: "" }
    },
    browserAutomation: { cdpPort: 9222, cdpWebSocketUrl: "ws://127.0.0.1:9222/devtools/page/1" },
    xhsConnector: {
      cliCommand: "/tmp/xhs-cli",
      cdpPort: 9333,
      targetId: "target-smoke",
      profileKey: "xhs-smoke",
      profilePath: "/tmp/xhs-profile",
      accountId: "xhs-real-a",
      accountHandle: "red-a",
      displayName: "小红书 A"
    },
    wechatConnector: {
      profileKey: "wechat-smoke",
      appId: "wx-app-a",
      secret: "wx-secret-must-not-appear",
      author: "公众号 A",
      displayName: "公众号 A"
    }
  }, promptNow);
  const expectedPrompt = [
    "<system-reminder>\n当前工作目录（SDK cwd）是：/tmp/workspace\n</system-reminder>",
    `<system-reminder>\n当前时间是：${expectedPromptTime}\n</system-reminder>`,
    "<system-reminder>\n本轮用户选择了以下内容账号：\n- 平台: xhs；昵称: 小红书 A；accountId: xhs-real-a；小红书号: red-a\n- 平台: wechat；昵称: 公众号 A；accountId: wx-app-a\n\n如果本轮涉及账号运营、选题、创作、发布、互动、复盘或账号诊断，先用对应平台和 accountId 调用 `content_profile_get` 检查账号 Profile。\n- 例外：仅执行发布后 per-run 指标/评论采集，且任务已带 `runId`、`platform`、`accountId` 和内容标识（如 note_id/media_id）时，可以不调用 `content_profile_get`。\n- Profile 已有信息足以完成本轮任务时直接使用。\n- Profile 缺少本轮必要信息时：前台手动对话必须调用 `AskUserQuestion`，且只询问必要字段；自动化任务不得调用 `AskUserQuestion`，跳过缺失信息获取并继续执行，同时在结果或 Run 阶段原因中说明缺失及跳过内容。\n- 不要自行读取或拼接账号数据物理路径。\n</system-reminder>",
    "<system-reminder>\n本轮可以使用 GrowthForce 小红书连接器。\n- 小红书连接器使用独立 Electron profile，不要启动外部 Chrome，不要安装或使用 Chrome 扩展 Bridge。\n- 所有小红书操作必须使用环境变量里的 `$AGENTSTUDIO_XHS_CLI` 作为命令前缀，只追加业务子命令和业务参数。\n- 在调用任何 `xhs-*` Skill 或其他小红书业务命令前，必须先运行登录检查命令：`$AGENTSTUDIO_XHS_CLI check-session`；使用 Bash 工具执行时 timeout 设置为 180000ms。\n- 如果 `check-session` 明确返回 `guest=true`，先调用 `xhs_account_mark_needs_refresh(reason=\"not_logged_in\")`，再停止小红书业务命令并提示用户在连接器中重新授权。\n- 如果 `check-session` 返回的 `account_id` 与环境变量 `AGENTSTUDIO_XHS_ACCOUNT_ID` 不一致，先调用 `xhs_account_mark_needs_refresh(reason=\"account_mismatch\", actual_account_id=<返回的 account_id>)`，再停止业务命令。\n- 如果 `check-session` 因 timeout、CDP、连接、页面或 userInfo 读取错误而失败，不要调用状态更新工具，不要继续业务命令；说明检查失败原因。\n</system-reminder>",
    "<system-reminder>\n本轮用户添加了以下本地文件，可在需要时读取：\n- brief.md: /tmp/brief.md\n</system-reminder>",
    "<system-reminder>\n本轮用户明确选择优先使用以下已启用 Skill：\n- xhs-publish (orchestrator)：发布笔记\n</system-reminder>",
    "用户输入"
  ].join("\n\n");
  if (prompt !== expectedPrompt) {
    throw new Error(`Unexpected composed prompt:\n${prompt}`);
  }
  for (const forbidden of ["agent-browser", "browser-smoke", "browser-target", "ws://127.0.0.1:9222", "--runtime", "--cdp-port", "--target-id", "--bridge-url", "xhs-profile", "user-data/", "账号定位文件:", "账号定位状态", "账号定位摘要", "缺失字段", "wx-secret-must-not-appear"]) {
    if (prompt.includes(forbidden)) {
      throw new Error(`Expected composed prompt to omit browser/xhs connector injection, found ${forbidden}: ${prompt}`);
    }
  }
  const promptWithoutAccount = composePrompt({
    requestId: "prompt-without-account",
    prompt: "普通问题",
    permissionMode: "auto",
    attachments: [],
    selectedSkills: [],
    workspacePath: "/tmp/workspace",
    agentName: "orchestrator",
    config: {
      provider: { baseUrl: "https://api.example.com", apiKey: "sk-test", model: "claude-test" },
      imageProvider: { id: "", name: "", providerType: "", baseUrl: "", apiKey: "", model: "" },
      workspace: { defaultDir: "/tmp/workspace" },
      user: { name: "Smoke", avatar: "" }
    }
  }, promptNow);
  if (promptWithoutAccount.includes("本轮用户选择了以下内容账号") || promptWithoutAccount.includes("本轮可以使用 GrowthForce 小红书连接器") || promptWithoutAccount.includes("要求用户补充账号定位")) {
    throw new Error(`Expected prompt without selected accounts not to inject account/profile instructions:\n${promptWithoutAccount}`);
  }
  if (promptWithoutAccount.includes("当前是自动化任务运行")) {
    throw new Error(`Expected manual prompt not to inject automation instructions:\n${promptWithoutAccount}`);
  }
  const automationPrompt = composePrompt({
    requestId: "automation-prompt-smoke",
    prompt: "自动化发布小红书笔记",
    permissionMode: "bypassPermissions",
    disallowedTools: ["AskUserQuestion"],
    attachments: [],
    selectedSkills: [{ name: "xhs-publish", agent: "orchestrator", description: "发布笔记" }],
    workspacePath: "/tmp/workspace",
    agentName: "orchestrator",
    config: {
      provider: { baseUrl: "https://api.example.com", apiKey: "sk-test", model: "claude-test" },
      imageProvider: { id: "", name: "", providerType: "", baseUrl: "", apiKey: "", model: "" },
      workspace: { defaultDir: "/tmp/workspace" },
      user: { name: "Smoke", avatar: "" }
    },
    automationRun: { automationTaskId: 12, automationTaskName: "自动发布任务", automationRunId: 34, automationAttemptCount: 2 }
  }, promptNow);
  for (const expected of ["当前是自动化任务运行", "automationTaskId: 12", "automationTaskName: 自动发布任务", "automationRunId: 34", "automationAttemptCount: 2", "这是同一 run 的第 2 次执行尝试", "所有环节均按任务预授权执行，无需再次请求用户确认", "不要调用 `AskUserQuestion`", "不要只回复“等待用户确认”后停止"]) {
    if (!automationPrompt.includes(expected)) {
      throw new Error(`Expected automation prompt to include ${expected}:\n${automationPrompt}`);
    }
  }
  for (const forbidden of ["automation_run_current", "automation_run_get", "automation_run_list", "自动化任务 taskId", "自动化 runId", "当前 attemptCount", "计划触发时间", "最大执行尝试次数"]) {
    if (automationPrompt.includes(forbidden)) {
      throw new Error(`Expected automation prompt not to include ${forbidden}:\n${automationPrompt}`);
    }
  }

  const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-agents-missing-"));
  try {
    fs.writeFileSync(path.join(missingDir, "reviewer.yml"), "description: Reviewer\nprompt: Review code\n", "utf8");
    try {
      loadAgentsFromDirectory(missingDir);
      throw new Error("Expected missing orchestrator configuration to fail");
    } catch (error) {
      if (!String(error.message).includes("Missing default agent configuration")) {
        throw error;
      }
    }
  } finally {
    fs.rmSync(missingDir, { recursive: true, force: true });
  }
  const noSubagentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-agents-empty-subagents-"));
  try {
    fs.writeFileSync(path.join(noSubagentsDir, "orchestrator.yml"), "description: Empty\nprompt: Empty prompt\n", "utf8");
    const options = buildDefaultAgentOptions(loadAgentsFromDirectory(noSubagentsDir));
    if (Object.keys(options.agents).length !== 0) {
      throw new Error(`Expected missing subagents to produce empty SDK subagents, got ${JSON.stringify(options.agents)}`);
    }
  } finally {
    fs.rmSync(noSubagentsDir, { recursive: true, force: true });
  }
  const invalidSubagentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-agents-invalid-subagents-"));
  try {
    fs.writeFileSync(path.join(invalidSubagentsDir, "orchestrator.yml"), [
      "description: Invalid",
      "prompt: Invalid prompt",
      "subagents:",
      "  - name: duplicate",
      "    description: First",
      "    prompt: First prompt",
      "  - name: duplicate",
      "    description: Second",
      "    prompt: Second prompt",
      ""
    ].join("\n"), "utf8");
    try {
      loadAgentsFromDirectory(invalidSubagentsDir);
      throw new Error("Expected duplicate embedded subagent to fail");
    } catch (error) {
      if (!String(error.message).includes("Duplicate subagent")) {
        throw error;
      }
    }
  } finally {
    fs.rmSync(invalidSubagentsDir, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
NODE

node - <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  listSkills,
  listMarketSkills,
  parseGitHubSkillSource,
  readSettings,
  setSkillDisabled,
  syncRuntimeSkills
} = require("./dist/agent/skills.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-skills-"));
const builtinDir = path.join(tempDir, "resources", "skills");
const userDir = path.join(tempDir, "user-resources", "skills");
const runtimeDir = path.join(tempDir, "agents", "orchestrator", "skills");
const settings = path.join(tempDir, "settings.yml");
const marketSkills = path.join(tempDir, "market-skills.yml");

function writeSkill(root, agent, dirName, frontmatterName, description = "Test skill", version = "") {
  const skillDir = path.join(root, agent, dirName);
  fs.mkdirSync(skillDir, { recursive: true });
  const lines = [
    "---",
    `name: ${frontmatterName}`,
    `agent: ${agent}`,
    `description: ${description}`,
    ...(version ? [`version: ${version}`] : []),
    "---",
    "",
    "## Instructions",
    "Return a concise result.",
    ""
  ];
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), lines.join("\n"), "utf8");
  return skillDir;
}

try {
  const writerSkill = writeSkill(builtinDir, "writer_agent", "gzh_content_gen", "gzh_content_gen", "Test skill", "1.2.3");
  writeSkill(builtinDir, "orchestrator", "full_publish", "full_publish");
  writeSkill(userDir, "strategy_agent", "topic_strategy", "topic_strategy");
  writeSkill(userDir, "writer_agent", "invalid_agent", "invalid_agent");
  fs.writeFileSync(path.join(userDir, "writer_agent", "invalid_agent", "SKILL.md"), [
    "---",
    "name: invalid_agent",
    "agent: strategy_agent",
    "description: Invalid because parent directory differs",
    "---",
    ""
  ].join("\n"), "utf8");

  const paths = {
    bundledSkills: builtinDir,
    userResourceSkills: userDir,
    runtimeSkills: runtimeDir,
    settings,
    marketSkills
  };

  let result = syncRuntimeSkills(paths);
  if (result.skills.length !== 3) {
    throw new Error(`Expected 3 valid skills, got ${result.skills.map((skill) => skill.name).join(",")}`);
  }
  if (!result.errors.some((error) => error.includes("invalid_agent"))) {
    throw new Error(`Expected invalid agent mismatch to be reported, got ${result.errors.join("\n")}`);
  }
  if (!fs.lstatSync(path.join(runtimeDir, "gzh_content_gen")).isSymbolicLink()) {
    throw new Error("Expected builtin writer skill copy to be linked into runtime skills");
  }
  const installedWriterSkill = path.join(userDir, "writer_agent", "gzh_content_gen");
  if (!fs.existsSync(installedWriterSkill)) {
    throw new Error("Expected builtin writer skill to be copied into user resources");
  }
  if (fs.realpathSync(path.join(runtimeDir, "gzh_content_gen")) !== fs.realpathSync(installedWriterSkill)) {
    throw new Error("Expected runtime link for builtin skill to point at writable user resource copy");
  }
  const initialSettings = readSettings(settings);
  if (!fs.existsSync(settings) || initialSettings.chat.permissionMode !== "bypassPermissions" || initialSettings.skills.disabled.length !== 0) {
    throw new Error(`Expected settings.yml defaults with full access permission and empty disabled list, got ${JSON.stringify(initialSettings)}`);
  }
  if (!initialSettings.skills.installed.gzh_content_gen || !initialSettings.skills.installed.topic_strategy) {
    throw new Error(`Expected source skills to be reconciled into settings installed map, got ${JSON.stringify(initialSettings)}`);
  }
  if (initialSettings.skills.installed.gzh_content_gen.source !== "builtin" || initialSettings.skills.installed.gzh_content_gen.version !== "1.2.3") {
    throw new Error(`Expected builtin installed metadata to include source and frontmatter version, got ${JSON.stringify(initialSettings.skills.installed.gzh_content_gen)}`);
  }
  fs.writeFileSync(path.join(installedWriterSkill, "LOCAL_STATE.txt"), "keep me", "utf8");
  fs.writeFileSync(path.join(writerSkill, "SKILL.md"), fs.readFileSync(path.join(writerSkill, "SKILL.md"), "utf8").replace("1.2.3", "9.9.9"), "utf8");
  result = syncRuntimeSkills(paths);
  if (fs.existsSync(path.join(installedWriterSkill, "LOCAL_STATE.txt")) || readSettings(settings).skills.installed.gzh_content_gen.version !== "9.9.9") {
    throw new Error("Expected existing builtin user-resource copy to be overwritten by bundled source on sync");
  }

  result = setSkillDisabled(paths, "gzh_content_gen", true);
  if (fs.existsSync(path.join(runtimeDir, "gzh_content_gen"))) {
    throw new Error("Expected disabled skill runtime link to be removed");
  }
  if (!fs.existsSync(installedWriterSkill)) {
    throw new Error("Expected disabling a builtin skill to keep the user-resource copy");
  }
  if (readSettings(settings).skills.disabled.join(",") !== "gzh_content_gen") {
    throw new Error(`Expected settings disabled list to include gzh_content_gen, got ${JSON.stringify(readSettings(settings))}`);
  }
  if (!readSettings(settings).skills.installed.gzh_content_gen) {
    throw new Error("Expected disabling a skill to preserve installed settings entry");
  }
  if (readSettings(settings).chat.permissionMode !== "bypassPermissions") {
    throw new Error("Expected disabling a skill to preserve chat permission setting");
  }
  let listed = listSkills(paths).skills.find((skill) => skill.name === "gzh_content_gen");
  if (!listed || listed.enabled || listed.status !== "disabled") {
    throw new Error(`Expected UI list state to show disabled skill, got ${JSON.stringify(listed)}`);
  }

  result = setSkillDisabled(paths, "gzh_content_gen", false);
  if (!fs.lstatSync(path.join(runtimeDir, "gzh_content_gen")).isSymbolicLink()) {
    throw new Error("Expected re-enabled skill runtime link to be restored");
  }
  if (fs.realpathSync(path.join(runtimeDir, "gzh_content_gen")) !== fs.realpathSync(installedWriterSkill)) {
    throw new Error("Expected re-enabled builtin skill runtime link to point at user-resource copy");
  }
  if (readSettings(settings).skills.disabled.length !== 0) {
    throw new Error("Expected re-enabled skill to be removed from disabled list");
  }

  fs.unlinkSync(path.join(runtimeDir, "full_publish"));
  fs.symlinkSync(path.join(builtinDir, "orchestrator", "full_publish"), path.join(runtimeDir, "full_publish"), process.platform === "win32" ? "junction" : "dir");
  fs.unlinkSync(path.join(runtimeDir, "topic_strategy"));
  fs.symlinkSync(path.join(tempDir, "missing-source"), path.join(runtimeDir, "stale_skill"), process.platform === "win32" ? "junction" : "dir");
  result = syncRuntimeSkills(paths);
  if (!result.removedStale.includes("stale_skill")) {
    throw new Error(`Expected stale runtime link to be removed, got ${JSON.stringify(result.removedStale)}`);
  }
  if (!fs.existsSync(path.join(runtimeDir, "topic_strategy"))) {
    throw new Error("Expected missing enabled runtime link to be repaired");
  }
  if (fs.realpathSync(path.join(runtimeDir, "full_publish")) !== fs.realpathSync(path.join(userDir, "orchestrator", "full_publish"))) {
    throw new Error("Expected stale builtin runtime link to be repaired to the user-resource copy");
  }

  writeSkill(builtinDir, "orchestrator", "new_builtin", "new_builtin", "New builtin skill", "0.1.0");
  result = syncRuntimeSkills(paths);
  if (!fs.existsSync(path.join(userDir, "orchestrator", "new_builtin")) || !readSettings(settings).skills.installed.new_builtin) {
    throw new Error("Expected newly bundled builtin skill to be copied into user resources and installed settings");
  }

  fs.writeFileSync(marketSkills, [
    "writer_agent:",
    "  - name: gzh_content_gen",
    "    description: Market writer skill",
    "    skillMdUrl: https://github.com/owner/repo/blob/main/skills/gzh_content_gen/SKILL.md",
    "strategy_agent:",
    "  - name: not_installed",
    "    description: Missing strategy skill",
    "    skillMdUrl: https://github.com/owner/repo/blob/main/skills/not_installed/SKILL.md",
    "  - name: root_skill",
    "    description: Root skill",
    "    skillMdUrl: https://github.com/owner/root-repo/blob/main/SKILL.md",
    ""
  ].join("\n"), "utf8");
  const market = listMarketSkills(paths);
  const marketInstalled = market.skills.find((skill) => skill.name === "gzh_content_gen");
  const marketMissing = market.skills.find((skill) => skill.name === "not_installed");
  if (!marketInstalled?.installed) {
    throw new Error(`Expected market installed state to use settings.yml installed map, got ${JSON.stringify(market.skills)}`);
  }
  if (marketMissing?.installed) {
    throw new Error(`Expected missing market skill to be uninstalled, got ${JSON.stringify(marketMissing)}`);
  }
  const marketRoot = market.skills.find((skill) => skill.name === "root_skill");
  if (marketRoot?.skillMdUrl !== "https://github.com/owner/root-repo/blob/main/SKILL.md") {
    throw new Error(`Expected root SKILL.md market URL to be accepted, got ${JSON.stringify(marketRoot)}`);
  }
  const currentSettings = readSettings(settings);
  currentSettings.skills.installed.not_installed_frontmatter = {
    agent: "strategy_agent",
    dirName: "not_installed",
    source: "market"
  };
  fs.writeFileSync(settings, [
    "skills:",
    "  installed:",
    ...Object.entries(currentSettings.skills.installed).flatMap(([name, item]) => [
      `    ${name}:`,
      `      agent: ${item.agent}`,
      `      dirName: ${item.dirName}`,
      `      source: ${item.source}`
    ]),
    "  disabled: []",
    ""
  ].join("\n"), "utf8");
  const marketWithoutNameMatch = listMarketSkills(paths).skills.find((skill) => skill.name === "not_installed");
  if (marketWithoutNameMatch?.installed) {
    throw new Error("Expected market installed state to ignore dirName-only fallback when settings key differs");
  }
  fs.mkdirSync(path.join(userDir, "strategy_agent", "not_installed"), { recursive: true });
  const marketWithoutSettings = listMarketSkills(paths).skills.find((skill) => skill.name === "not_installed");
  if (marketWithoutSettings?.installed) {
    throw new Error("Expected market installed state to ignore source directory until settings reconcile has a valid skill");
  }

  fs.writeFileSync(marketSkills, [
    "writer_agent:",
    "  - name: old_schema",
    "    description: Old schema skill",
    "    repo: owner/repo",
    "    path: skills/old_schema",
    "  - name: tree_url",
    "    description: Tree URL skill",
    "    skillMdUrl: https://github.com/owner/repo/tree/main/skills/tree_url",
    ""
  ].join("\n"), "utf8");
  const invalidMarket = listMarketSkills(paths);
  if (invalidMarket.skills.length !== 0 || invalidMarket.errors.length !== 2) {
    throw new Error(`Expected old market schema and tree URL to fail, got ${JSON.stringify(invalidMarket)}`);
  }

  const rootBlob = parseGitHubSkillSource({ url: "https://github.com/oaker-io/wewrite/blob/main/SKILL.md" });
  if (rootBlob.owner !== "oaker-io" || rootBlob.repoName !== "wewrite" || rootBlob.ref !== "main" || rootBlob.dirPath !== "") {
    throw new Error(`Expected root blob SKILL.md URL to resolve repo root, got ${JSON.stringify(rootBlob)}`);
  }
  const nestedBlob = parseGitHubSkillSource({ url: "https://github.com/JimLiu/baoyu-skills/blob/main/skills/baoyu-article-illustrator/SKILL.md" });
  if (nestedBlob.dirPath !== "skills/baoyu-article-illustrator") {
    throw new Error(`Expected nested blob SKILL.md URL to resolve containing directory, got ${JSON.stringify(nestedBlob)}`);
  }
  const treeFile = parseGitHubSkillSource({ url: "https://github.com/owner/repo/tree/main/example/SKILL.md" });
  if (treeFile.owner !== "owner" || treeFile.repoName !== "repo" || treeFile.ref !== "main" || treeFile.dirPath !== "example") {
    throw new Error(`Expected tree SKILL.md URL to resolve containing directory, got ${JSON.stringify(treeFile)}`);
  }
  const treeDir = parseGitHubSkillSource({ url: "https://github.com/owner/repo/tree/main/skills/example" });
  if (treeDir.dirPath !== "skills/example") {
    throw new Error(`Expected legacy tree directory URL to stay supported, got ${JSON.stringify(treeDir)}`);
  }
  for (const badInput of [
    { url: "https://example.com/owner/repo/blob/main/SKILL.md" },
    { url: "https://github.com/owner/repo/blob/main/README.md" },
    { url: "https://github.com/owner/repo/blob/main/../SKILL.md" }
  ]) {
    let failed = false;
    try {
      parseGitHubSkillSource(badInput);
    } catch {
      failed = true;
    }
    if (!failed) throw new Error(`Expected invalid GitHub skill source to fail: ${JSON.stringify(badInput)}`);
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
NODE

node - <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");
const { readSettings, updatePermissionMode, updateSettings, updateThemeMode } = require("./dist/main/settings.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-settings-"));
const settings = path.join(tempDir, "settings.yml");
try {
  let current = readSettings(settings);
  if (current.ui.themeMode !== "system" || current.chat.permissionMode !== "bypassPermissions" || Object.keys(current.skills.installed).length !== 0) {
    throw new Error(`Expected missing settings to use defaults, got ${JSON.stringify(current)}`);
  }

  fs.writeFileSync(settings, yaml.dump({
    skills: {
      installed: {
        topic_strategy: { agent: "strategy_agent", dirName: "topic_strategy", source: "user" }
      },
      disabled: ["topic_strategy"]
    }
  }), "utf8");
  current = readSettings(settings);
  if (current.ui.themeMode !== "system" || current.chat.permissionMode !== "bypassPermissions" || !current.skills.installed.topic_strategy) {
    throw new Error(`Expected old settings to merge chat defaults, got ${JSON.stringify(current)}`);
  }

  updatePermissionMode(settings, "bypassPermissions");
  current = readSettings(settings);
  if (current.ui.themeMode !== "system" || current.chat.permissionMode !== "bypassPermissions" || current.skills.disabled.join(",") !== "topic_strategy") {
    throw new Error(`Expected permission update to preserve skills, got ${JSON.stringify(current)}`);
  }

  updateThemeMode(settings, "dark");
  current = readSettings(settings);
  if (current.ui.themeMode !== "dark" || current.chat.permissionMode !== "bypassPermissions" || current.skills.disabled.join(",") !== "topic_strategy") {
    throw new Error(`Expected theme update to preserve chat and skills, got ${JSON.stringify(current)}`);
  }

  updateSettings(settings, (settingsValue) => ({
    ...settingsValue,
    skills: {
      ...settingsValue.skills,
      disabled: []
    }
  }));
  current = readSettings(settings);
  if (current.ui.themeMode !== "dark" || current.chat.permissionMode !== "bypassPermissions" || current.skills.disabled.length !== 0) {
    throw new Error(`Expected skills update to preserve chat settings, got ${JSON.stringify(current)}`);
  }

  fs.writeFileSync(settings, "ui:\n  themeMode: invalid\nchat:\n  permissionMode: invalid\n", "utf8");
  current = readSettings(settings);
  if (current.ui.themeMode !== "system" || current.chat.permissionMode !== "bypassPermissions") {
    throw new Error(`Expected invalid theme and permission modes to fall back to defaults, got ${JSON.stringify(current)}`);
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
NODE

LOG_HOME="$(mktemp -d)"
trap 'rm -rf "$LOG_HOME"' EXIT

HOME="$LOG_HOME" node - <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");
const { flushLogEvents, logEvent } = require("./dist/shared/log.js");

(async () => {
  const logDir = path.join(os.homedir(), ".agentstudio", "logs");
  const staleLog = path.join(logDir, "old.log");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(staleLog, "old", "utf8");
  const expired = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
  fs.utimesSync(staleLog, expired, expired);

  logEvent("build-smoke", {
    message: "hello",
    nested: { ok: true },
    provider: { apiKey: "secret-key" },
    token: "secret-token",
    largeResult: "x".repeat(3000)
  });
  logEvent("build-smoke-detail-hidden", { message: "hidden" }, { detail: true });
  await flushLogEvents();

  const logFiles = fs.readdirSync(logDir).filter((file) => file.endsWith(".log"));
  if (logFiles.length !== 1) {
    throw new Error(`Expected exactly one log file, got ${logFiles.join(", ")}`);
  }
  if (fs.existsSync(staleLog)) {
    throw new Error("Expected stale log to be removed");
  }

  const content = fs.readFileSync(path.join(logDir, logFiles[0]), "utf8");
  if (!content.includes('"scope":"build-smoke"')) {
    throw new Error(`Missing log entry in ${logFiles[0]}`);
  }
  if (content.includes("secret-key") || content.includes("secret-token")) {
    throw new Error("Expected secrets to be redacted from logs");
  }
  if (!content.includes("[REDACTED]")) {
    throw new Error("Expected redaction marker in logs");
  }
  if (!content.includes('"truncated":true') || !content.includes('"originalLength":3000')) {
    throw new Error("Expected large log values to be truncated");
  }
  if (content.includes("build-smoke-detail-hidden")) {
    throw new Error("Expected detail logs to be disabled by default");
  }
})();
NODE

HOME="$LOG_HOME" AGENTSTUDIO_DEBUG_LOGS=1 node - <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");
const { flushLogEvents, logEvent } = require("./dist/shared/log.js");

(async () => {
  logEvent("build-smoke-detail-visible", { message: "visible", password: "secret-password" }, { detail: true });
  await flushLogEvents();

  const logDir = path.join(os.homedir(), ".agentstudio", "logs");
  const content = fs.readdirSync(logDir)
    .filter((file) => file.endsWith(".log"))
    .map((file) => fs.readFileSync(path.join(logDir, file), "utf8"))
    .join("\n");
  if (!content.includes("build-smoke-detail-visible")) {
    throw new Error("Expected detail logs when AGENTSTUDIO_DEBUG_LOGS=1");
  }
  if (content.includes("secret-password")) {
    throw new Error("Expected detail logs to redact secrets");
  }
})();
NODE

cat > /tmp/agentstudio-agent-ipc-smoke.cjs <<'NODE'
const { app, utilityProcess } = require("electron");
const path = require("path");

app.whenReady().then(() => {
  const child = utilityProcess.fork(path.join(process.cwd(), "dist/agent/agent.js"), [], { stdio: "pipe" });
  const timer = setTimeout(() => {
    console.error("Timed out waiting for Agent process IPC response");
    child.kill();
    app.exit(2);
  }, 5000);

  child.on("message", (message) => {
    clearTimeout(timer);
    child.kill();
    if (message.type === "error" && String(message.message).includes("请先配置模型供应商")) {
      app.exit(0);
    } else {
      console.error(`Unexpected Agent process response: ${JSON.stringify(message)}`);
      app.exit(3);
    }
  });

  child.postMessage({
    type: "run",
    payload: {
      requestId: "build-smoke:1",
      prompt: "hello",
      workspacePath: process.cwd(),
      config: {
        provider: { baseUrl: "", apiKey: "", model: "" },
        workspace: { defaultDir: "~/.agentstudio/workspace" },
        user: { name: "默认用户", avatar: "" }
      }
    }
  });
});
NODE

env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_MODEL npx electron /tmp/agentstudio-agent-ipc-smoke.cjs
echo "Build smoke checks passed."
