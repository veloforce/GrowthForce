import type { AgentRunRequest } from "../shared/types";

export function composePrompt(request: AgentRunRequest, now = new Date()): string {
  const sections: string[] = [];
  const attachments = request.attachments ?? [];
  const selectedSkills = request.selectedSkills ?? [];

  sections.push(wrapSystemReminder(`当前工作目录（SDK cwd）是：${request.workspacePath}`));

  sections.push(wrapSystemReminder(`当前时间是：${formatLocalDateTime(now)}`));

  if (request.automationRun) {
    sections.push(wrapSystemReminder([
      "当前是自动化任务运行，不是用户前台手动对话。",
      `- taskId: ${request.automationRun.taskId}；runId: ${request.automationRun.runId}；attempt: ${request.automationRun.attemptCount}`,
      "- 所有环节均按任务预授权执行，无需再次请求用户确认。",
      "- 不要调用 `AskUserQuestion`，也不要只回复“等待用户确认”后停止。",
      "- 遇到发布、评论、互动等通常需要确认的步骤时，在自动化上下文中直接按任务描述和已绑定账号继续；如果缺少硬依赖或安全条件不满足，则明确失败并说明原因。"
    ].join("\n")));
  }

  const selectedAccounts = formatSelectedAccountsReminder(request);
  if (selectedAccounts) sections.push(wrapSystemReminder(selectedAccounts));

  if (request.xhsConnector) {
    sections.push(wrapSystemReminder([
      "本轮可以使用 GrowthForce 小红书连接器。",
      "- 小红书连接器使用独立 Electron profile，不要启动外部 Chrome，不要安装或使用 Chrome 扩展 Bridge。",
      "- 所有小红书操作必须使用环境变量里的 `$AGENTSTUDIO_XHS_CLI` 作为命令前缀，只追加业务子命令和业务参数。",
      "- 在调用任何 `xhs-*` Skill 或其他小红书业务命令前，必须先运行登录检查命令：`$AGENTSTUDIO_XHS_CLI check-session`；使用 Bash 工具执行时 timeout 设置为 180000ms。",
      "- 如果 `check-session` 明确返回 `guest=true`，先调用 `xhs_account_mark_needs_refresh(reason=\"not_logged_in\")`，再停止小红书业务命令并提示用户在连接器中重新授权。",
      "- 如果 `check-session` 返回的 `account_id` 与环境变量 `AGENTSTUDIO_XHS_ACCOUNT_ID` 不一致，先调用 `xhs_account_mark_needs_refresh(reason=\"account_mismatch\", actual_account_id=<返回的 account_id>)`，再停止业务命令。",
      "- 如果 `check-session` 因 timeout、CDP、连接、页面或 userInfo 读取错误而失败，不要调用状态更新工具，不要继续业务命令；说明检查失败原因。"
    ].join("\n")));
  }

  if (attachments.length > 0) {
    sections.push(wrapSystemReminder([
      "本轮用户添加了以下本地文件，可在需要时读取：",
      ...attachments.map((file) => `- ${file.name}: ${file.path}`)
    ].join("\n")));
  }
  if (selectedSkills.length > 0) {
    sections.push(wrapSystemReminder([
      "本轮用户明确选择优先使用以下已启用 Skill：",
      ...selectedSkills.map((skill) => `- ${skill.name}${skill.agent ? ` (${skill.agent})` : ""}${skill.description ? `：${skill.description}` : ""}`)
    ].join("\n")));
  }

  sections.push(request.prompt);
  return sections.join("\n\n");
}

function formatSelectedAccountsReminder(request: AgentRunRequest): string {
  const accounts: string[] = [];
  if (request.xhsConnector) {
    accounts.push([
      "- 平台: xhs",
      `昵称: ${request.xhsConnector.displayName ?? "未知"}`,
      `accountId: ${request.xhsConnector.accountId ?? "未提供"}`,
      ...(request.xhsConnector.accountHandle ? [`小红书号: ${request.xhsConnector.accountHandle}`] : [])
    ].join("；"));
  }
  if (request.wechatConnector) {
    accounts.push([
      "- 平台: wechat",
      `昵称: ${request.wechatConnector.displayName}`,
      `accountId: ${request.wechatConnector.appId}`
    ].join("；"));
  }
  return accounts.length > 0 ? [
    "本轮用户选择了以下内容账号：",
    ...accounts,
    "",
    "如果本轮涉及账号运营、选题、创作、发布、互动、复盘或账号诊断，先用对应平台和 accountId 调用 `content_profile_get` 检查账号 Profile。",
    "- 例外：仅执行发布后 per-run 指标/评论采集，且任务已带 `runId`、`platform`、`accountId` 和内容标识（如 note_id/media_id）时，可以不调用 `content_profile_get`。",
    "- Profile 已有信息足以完成本轮任务时直接使用。",
    "- Profile 缺少本轮必要信息时：前台手动对话必须调用 `AskUserQuestion`，且只询问必要字段；自动化任务不得调用 `AskUserQuestion`，跳过缺失信息获取并继续执行，同时在结果或 Run 阶段原因中说明缺失及跳过内容。",
    "- 不要自行读取或拼接账号数据物理路径。"
  ].join("\n") : "";
}

function wrapSystemReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`;
}

function formatLocalDateTime(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffsetMinutes / 60);
  const offsetRemainderMinutes = absoluteOffsetMinutes % 60;
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    "T",
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    `${sign}${pad(offsetHours)}:${pad(offsetRemainderMinutes)}`
  ].join("");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
