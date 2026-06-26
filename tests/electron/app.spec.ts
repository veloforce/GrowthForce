import { _electron as electron, expect, test } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

function writeCompleteConfig(homeDir: string): void {
  const agentStudioDir = path.join(homeDir, ".agentstudio");
  fs.mkdirSync(agentStudioDir, { recursive: true });
  fs.writeFileSync(path.join(agentStudioDir, "config.yml"), [
    "provider:",
    "  id: test-provider",
    "  baseUrl: https://api.example.com",
    "  apiKey: test-key",
    "  model: test-model",
    "workspace:",
    "  defaultDir: ~/.agentstudio/workspace",
    "user:",
    "  name: Test User",
    "  avatar: \"\"",
    ""
  ].join("\n"), "utf8");
}

test("wechat connector adds, selects, clears, reselects, and deletes an account", async () => {
  test.setTimeout(60_000);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-wechat-connector-"));
  writeCompleteConfig(homeDir);
  const app = await electron.launch({
    args: [path.resolve(__dirname, "../..")],
    env: { ...process.env, HOME: homeDir, VITE_DEV_SERVER_URL: "" }
  });

  try {
    const page = await app.firstWindow();
    await expect(page.locator(".shell")).toBeVisible();
    await page.getByTitle("连接器").evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator(".connectorMenu")).toBeVisible();
    const wechatMenuItem = page.locator(".connectorMenuItem", { hasText: "公众号" });
    await expect(wechatMenuItem).toBeVisible();
    await wechatMenuItem.locator(".connectorSubmenu .connectorAccountAction").evaluate((button: HTMLButtonElement) => button.click());

    const dialog = page.getByRole("dialog", { name: "添加公众号账号" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    await dialog.getByLabel("公众号昵称").fill("测试公众号");
    await dialog.getByLabel("WECHAT_APPID").fill("wx-test-appid");
    await dialog.getByLabel("WECHAT_SECRET").fill("wx-test-secret");
    await dialog.getByLabel("WECHAT_SECRET").press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTitle("连接器：测试公众号", { exact: true })).toBeVisible();

    const settingsPath = path.join(homeDir, ".agentstudio", "settings.yml");
    await expect.poll(() => fs.readFileSync(settingsPath, "utf8")).toContain("selected_account: wechat_");

    await page.getByTitle("连接器：测试公众号", { exact: true }).click();
    await wechatMenuItem.hover();
    const accountRow = page.locator(".connectorAccountRow", { hasText: "测试公众号" });
    await expect(accountRow).toContainText("wx-test-appid");
    await expect(accountRow).not.toContainText("wx-test-secret");
    await expect(accountRow.getByTitle("删除账号")).toHaveCount(0);
    await expect(accountRow.locator(".connectorReviewSwitch")).toHaveCount(0);
    await accountRow.locator("button").first().evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.getByTitle("连接器", { exact: true })).toBeVisible();

    await wechatMenuItem.hover();
    await accountRow.locator("button").first().evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.getByTitle("连接器：测试公众号", { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByTitle("连接器：测试公众号", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "账号设置" }).click();
    const settingsDialog = page.getByRole("dialog", { name: "账号设置" });
    await settingsDialog.getByRole("button", { name: "连接器设置" }).click();
    await settingsDialog.getByRole("tab", { name: "公众号" }).click();
    const settingsRow = settingsDialog.locator(".connectorSettingsRow", { hasText: "测试公众号" });
    await expect(settingsRow).toContainText("wx-test-appid");
    await expect(settingsRow).toContainText("••••••••••••");
    await expect(settingsRow).not.toContainText("wx-test-secret");
    await settingsRow.getByRole("button", { name: "复制 测试公众号 APPID" }).click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe("wx-test-appid");
    await settingsRow.getByRole("button", { name: "复制 测试公众号 APPSECRET" }).click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe("wx-test-secret");
    await expect(settingsRow).not.toContainText("wx-test-secret");
    await settingsRow.getByRole("button", { name: "显示 测试公众号 APPSECRET" }).click();
    await expect(settingsRow).toContainText("wx-test-secret");
    await settingsRow.getByRole("button", { name: "隐藏 测试公众号 APPSECRET" }).click();
    await expect(settingsRow).not.toContainText("wx-test-secret");

    await settingsRow.getByRole("button", { name: "删除账号 测试公众号" }).click();
    const confirmDialog = page.getByRole("dialog", { name: "删除连接器账号" });
    await expect(confirmDialog).toContainText("登录信息和自动复盘任务将一并清除");
    await confirmDialog.getByRole("button", { name: "取消" }).click();
    await expect(confirmDialog).toHaveCount(0);
    await expect(settingsRow).toBeVisible();

    await settingsRow.getByRole("button", { name: "删除账号 测试公众号" }).click();
    await page.getByRole("dialog", { name: "删除连接器账号" }).getByRole("button", { name: "确认删除" }).click();
    await expect(settingsDialog.locator(".connectorSettingsRow", { hasText: "测试公众号" })).toHaveCount(0);
    await expect(settingsDialog.getByText("暂无账号，请从对话框连接器入口添加。")).toBeVisible();
    await expect.poll(() => fs.readFileSync(settingsPath, "utf8")).toMatch(/wechat:\s+selected_account: ['"]{2}/);
    await settingsDialog.locator(".secondaryButton", { hasText: "关闭" }).click();
    await page.getByTitle("连接器", { exact: true }).click();
    await wechatMenuItem.hover();
    await expect(page.locator(".connectorAccountRow", { hasText: "测试公众号" })).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("xhs connector deletion clears the last account from settings and composer", async () => {
  test.setTimeout(60_000);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-xhs-connector-delete-"));
  writeCompleteConfig(homeDir);
  const app = await electron.launch({
    args: [path.resolve(__dirname, "../..")],
    env: { ...process.env, HOME: homeDir, VITE_DEV_SERVER_URL: "" }
  });

  try {
    const page = await app.firstWindow();
    await expect(page.locator(".shell")).toBeVisible();
    const created = await page.evaluate(() => window.agentStudio.createXhsAccount());
    const profileKey = created.account.profileKey;
    const profilePath = path.join(homeDir, ".agentstudio", "user-profile", "connectors", "xhs", profileKey);
    fs.mkdirSync(profilePath, { recursive: true });
    fs.writeFileSync(path.join(profilePath, "delete-marker.txt"), "delete me", "utf8");

    await page.reload();
    await expect(page.locator(".shell")).toBeVisible();
    await page.getByRole("button", { name: "账号设置" }).click();
    const settingsDialog = page.getByRole("dialog", { name: "账号设置" });
    await settingsDialog.getByRole("button", { name: "连接器设置" }).click();
    const settingsRow = settingsDialog.locator(".connectorSettingsRow");
    await expect(settingsRow).toHaveCount(1);
    await expect(settingsRow).toContainText("授权中");

    await settingsRow.locator(".connectorSettingsDelete").click();
    await page.getByRole("dialog", { name: "删除连接器账号" }).getByRole("button", { name: "确认删除" }).click();
    await expect(settingsDialog.locator(".connectorSettingsRow")).toHaveCount(0);
    await expect(settingsDialog.getByText("暂无账号，请从对话框连接器入口添加。")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.agentStudio.getConnectorState())).toMatchObject({
      accounts: [],
      selected: { xhs: "" }
    });
    await expect.poll(() => fs.existsSync(profilePath)).toBe(false);

    await settingsDialog.locator(".secondaryButton", { hasText: "关闭" }).click();
    await page.getByTitle("连接器", { exact: true }).click();
    const xhsMenuItem = page.locator(".connectorMenuItem", { hasText: "小红书" });
    await xhsMenuItem.hover();
    await expect(xhsMenuItem.locator(".connectorAccountRow")).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("automation creates a bounded day interval with fixed full access", async () => {
  test.setTimeout(60_000);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-automation-"));
  writeCompleteConfig(homeDir);
  const app = await electron.launch({
    args: [path.resolve(__dirname, "../..")],
    env: { ...process.env, HOME: homeDir, VITE_DEV_SERVER_URL: "" }
  });

  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "自动化运营" }).click();
    await page.getByRole("button", { name: "创建首个自动化" }).click();
    const dialog = page.getByRole("dialog", { name: "创建自动化" });
    const dialogSkillGroup = dialog.locator(".automationContextGroup", { hasText: "使用 Skill" });
    await expect(dialogSkillGroup.getByText("暂无已启用 Skill")).toHaveCount(0);
    await expect(dialogSkillGroup.locator(".automationContextOptions button").first()).toBeVisible();
    await dialog.getByLabel("任务名称").fill("两天三次");
    await dialog.getByLabel("任务描述").fill("执行三次固定间隔任务");
    await dialog.getByLabel("计划时间").selectOption("interval");
    await dialog.getByLabel("间隔数值").fill("2");
    await dialog.getByLabel("间隔单位").selectOption("day");
    await dialog.getByLabel("最多运行次数（留空表示无限）").fill("3");
    await expect(dialog.getByText("定时任务始终使用完全访问权限")).toBeVisible();
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".automationTaskRow", { hasText: "两天三次" })).toContainText("每 2 天 · 0/3 次");
    await page.locator(".automationTaskRow", { hasText: "两天三次" }).click();
    const detailSkillGroup = page.locator(".rightPanel .automationContextGroup", { hasText: "使用 Skill" });
    await expect(detailSkillGroup.getByText("暂无已启用 Skill")).toHaveCount(0);
    await expect(detailSkillGroup.locator(".automationContextOptions button").first()).toBeVisible();
    await page.getByRole("switch", { name: "停用 两天三次" }).click();
    await expect(page.getByRole("switch", { name: "启用 两天三次" })).toHaveAttribute("aria-checked", "false");
    await page.getByRole("switch", { name: "启用 两天三次" }).click();
    await expect(page.getByRole("switch", { name: "停用 两天三次" })).toHaveAttribute("aria-checked", "true");
  } finally {
    await app.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("onboarding saves provider config after Anthropic-compatible HTTP check", async () => {
  test.setTimeout(60_000);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-onboarding-"));
  const requests: Array<{ url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 }
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local HTTP server port");

  const app = await electron.launch({
    args: [path.resolve(__dirname, "../..")],
    env: {
      ...process.env,
      HOME: homeDir,
      VITE_DEV_SERVER_URL: ""
    }
  });

  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { name: "连接你的模型服务" })).toBeVisible();
    await expect(page.locator(".shell")).toHaveCount(0);
    await page.getByLabel("Base URL").fill(`http://127.0.0.1:${address.port}`);
    await page.getByLabel("API Key").fill("test-key");
    await page.getByLabel("Model").fill("claude-test");
    await page.getByRole("button", { name: "保存" }).click();

    await expect(page.locator(".shell")).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/v1/messages");
    expect(requests[0].headers["x-api-key"]).toBe("test-key");
    expect(requests[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(requests[0].body)).toMatchObject({
      model: "claude-test",
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with OK only." }]
    });
    const configText = fs.readFileSync(path.join(homeDir, ".agentstudio", "config.yml"), "utf8");
    expect(configText).toContain("baseUrl: http://127.0.0.1");
    expect(configText).toContain("apiKey: test-key");
    expect(configText).toContain("model: claude-test");
    expect(configText).toMatch(/id: provider-[0-9a-f]{8}/);
    const modelProvidersText = fs.readFileSync(path.join(homeDir, ".agentstudio", "settings", "model-providers.yml"), "utf8");
    expect(modelProvidersText).toContain("name: 默认模型供应商");
    expect(modelProvidersText).toContain("baseUrl: http://127.0.0.1");
    expect(modelProvidersText).toContain("apiKey: test-key");
    expect(modelProvidersText).toContain("model: claude-test");
    expect(modelProvidersText).toMatch(/id: provider-[0-9a-f]{8}/);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("missing model provider on submit opens settings without consuming composer draft", async () => {
  test.setTimeout(60_000);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-submit-missing-provider-"));
  const agentStudioDir = path.join(homeDir, ".agentstudio");
  fs.mkdirSync(agentStudioDir, { recursive: true });
  fs.writeFileSync(path.join(agentStudioDir, "config.yml"), [
    "provider:",
    "  id: ''",
    "  baseUrl: https://api.example.com",
    "  apiKey: test-key",
    "  model: ''",
    "workspace:",
    "  defaultDir: ~/.agentstudio/workspace",
    "user:",
    "  name: Test User",
    "  avatar: \"\"",
    ""
  ].join("\n"), "utf8");

  const requests: Array<{ url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 }
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local HTTP server port");

  const app = await electron.launch({
    args: [path.resolve(__dirname, "../..")],
    env: {
      ...process.env,
      HOME: homeDir,
      VITE_DEV_SERVER_URL: ""
    }
  });

  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { name: "连接你的模型服务" })).toBeVisible();
    await page.getByRole("button", { name: "跳过" }).click();
    await expect(page.locator(".shell")).toBeVisible();

    const draft = "这是一段提交前还没有模型配置的长文本，保存模型后应该仍然留在输入框里。";
    await page.getByPlaceholder("尽管问").fill(draft);
    await page.getByTitle("发送").click();

    const settingsDialog = page.getByRole("dialog", { name: "账号设置" });
    await expect(settingsDialog).toBeVisible();
    const normalPanel = settingsDialog.getByRole("tabpanel", { name: "大模型供应商" });
    await expect(normalPanel).toBeVisible();
    await expect(normalPanel.getByRole("alert")).toContainText("请完整填写 Base URL、API Key 和 Model 后再提交。");
    await expect(page.getByPlaceholder("尽管问")).toHaveValue(draft);
    await expect(page.locator(".messageBubble", { hasText: draft })).toHaveCount(0);
    await expect(page.locator(".sessionItem", { hasText: draft })).toHaveCount(0);
    await expect(page.getByText("缺少模型配置")).toHaveCount(0);
    await expect(normalPanel.locator(".providerRow.selected")).toBeVisible();

    await normalPanel.getByLabel("供应商名称").fill("Submit Provider");
    await normalPanel.getByLabel("Base URL").fill(`http://127.0.0.1:${address.port}`);
    await normalPanel.getByPlaceholder("sk-...").fill("test-key");
    await normalPanel.getByLabel("模型", { exact: true }).fill("claude-test");
    await settingsDialog.getByRole("button", { name: "保存", exact: true }).click();

    await expect(settingsDialog).toHaveCount(0);
    await expect(page.getByPlaceholder("尽管问")).toHaveValue(draft);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0].body)).toMatchObject({ model: "claude-test" });
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("account settings saves model provider registry and tests selected provider first model", async () => {
  test.setTimeout(60_000);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-settings-"));
  const requests: Array<{ url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_settings",
        type: "message",
        role: "assistant",
        model: "settings-first",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 }
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local HTTP server port");

  const agentStudioDir = path.join(homeDir, ".agentstudio");
  const settingsDir = path.join(agentStudioDir, "settings");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentStudioDir, "config.yml"),
    [
      "provider:",
      "  id: selected-provider",
      `  baseUrl: http://127.0.0.1:${address.port}`,
      "  apiKey: selected-key",
      "  model: settings-first",
      "imageProvider:",
      "  id: selected-image",
      "  name: Image Provider",
      "  providerType: openai",
      "  baseUrl: https://api.openai.com/v1",
      "  apiKey: image-key",
      "  model: image-model",
      "workspace:",
      "  defaultDir: ~/.agentstudio/workspace",
      "user:",
      "  name: 默认用户",
      "  avatar: \"\"",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(settingsDir, "model-providers.yml"),
    [
      "providers:",
      "  - id: other-provider",
      "    name: Other Provider",
      "    baseUrl: http://127.0.0.1:9",
      "    apiKey: other-key",
      "    model: other-first,other-second",
      "  - id: selected-provider",
      "    name: Selected Provider",
      `    baseUrl: http://127.0.0.1:${address.port}`,
      "    apiKey: selected-key",
      "    model: settings-first,settings-second",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(settingsDir, "image-providers.yml"),
    [
      "imageProviders:",
      "  - id: selected-image",
      "    name: Image Provider",
      "    providerType: openai",
      "    baseUrl: https://api.openai.com/v1",
      "    apiKey: image-key",
      "    model: image-model",
      ""
    ].join("\n"),
    "utf8"
  );

  const app = await electron.launch({
    args: [path.resolve(__dirname, "../..")],
    env: {
      ...process.env,
      HOME: homeDir,
      VITE_DEV_SERVER_URL: ""
    }
  });

  try {
    const page = await app.firstWindow();
    await expect(page.locator(".shell")).toBeVisible();
    await expect(page.getByRole("button", { name: "账号设置" })).toBeVisible();
    await expect(page.getByText("默认用户")).toHaveCount(0);
    await expect(page.getByText("本机工作空间")).toHaveCount(0);

    await page.getByRole("button", { name: "账号设置" }).click();
    await expect(page.getByRole("dialog", { name: "账号设置" })).toBeVisible();
    await expect(page.getByRole("button", { name: "模型供应商" })).toBeVisible();
    await expect(page.getByText("仅支持 Claude Messages API 兼容协议")).toBeVisible();
    await expect(page.getByRole("tab", { name: "大模型" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "图片模型" })).toHaveAttribute("aria-selected", "false");

    const normalPanel = page.getByRole("tabpanel", { name: "大模型供应商" });
    const selectedProviderRow = normalPanel.locator(".providerRow.selected", { hasText: "Selected Provider" });
    await expect(normalPanel.locator(".providerListHeader")).toContainText("当前");
    await expect(normalPanel.locator(".providerListHeader")).toContainText("供应商");
    await expect(normalPanel.locator(".providerListHeader")).toContainText("模型");
    await expect(normalPanel.locator(".providerListHeader")).toContainText("Base URL");
    await expect(selectedProviderRow).toContainText("settings-first,settings-second");
    await expect(selectedProviderRow).toContainText(`http://127.0.0.1:${address.port}`);
    expect(await selectedProviderRow.evaluate((element) => getComputedStyle(element).boxShadow)).not.toContain("20px");
    await expect(normalPanel.getByRole("radio", { name: "选择供应商 Selected Provider" })).toBeChecked();
    await expect(normalPanel.locator(".providerToolbar").getByRole("button", { name: "新增" })).toBeVisible();
    await expect(normalPanel.locator(".providerToolbar").getByRole("button", { name: "新增" })).toHaveCSS("height", "40px");
    const modelApiKey = normalPanel.getByLabel("API Key", { exact: true });
    await expect(modelApiKey).toHaveAttribute("type", "password");
    await normalPanel.getByRole("button", { name: "显示 API Key" }).click();
    await expect(modelApiKey).toHaveAttribute("type", "text");
    await expect(modelApiKey).toHaveValue("selected-key");
    await normalPanel.getByRole("button", { name: "隐藏 API Key" }).click();
    await expect(modelApiKey).toHaveAttribute("type", "password");
    await expect(normalPanel.getByRole("button", { name: "删除供应商 Other Provider" })).toBeVisible();
    await normalPanel.getByRole("button", { name: "删除供应商 Other Provider" }).click();
    await expect(normalPanel.getByRole("button", { name: "Other Provider" })).toHaveCount(0);
    await normalPanel.getByLabel("模型", { exact: true }).fill("settings-first, settings-second, settings-first, ");
    await page.getByRole("dialog", { name: "账号设置" }).getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "账号设置" })).toHaveCount(0);

    await page.getByRole("button", { name: "账号设置" }).click();
    await page.getByRole("tab", { name: "图片模型" }).click();
    await expect(page.getByRole("tab", { name: "图片模型" })).toHaveAttribute("aria-selected", "true");
    const imagePanel = page.getByRole("tabpanel", { name: "图片模型供应商" });
    await expect(imagePanel.locator(".providerToolbar").getByRole("button", { name: "新增" })).toBeVisible();
    await expect(imagePanel.getByRole("radio", { name: "选择图片供应商 Image Provider" })).toBeChecked();
    const providerTypeSelect = imagePanel.getByLabel("供应商类型");
    await expect(providerTypeSelect).toHaveCSS("border-radius", "12px");
    await expect(providerTypeSelect).toHaveCSS("appearance", "none");
    await imagePanel.getByLabel("模型", { exact: true }).fill("image-model-updated");
    await page.getByRole("dialog", { name: "账号设置" }).getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "账号设置" })).toHaveCount(0);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/v1/messages");
    expect(requests[0].headers["x-api-key"]).toBe("selected-key");
    expect(JSON.parse(requests[0].body)).toMatchObject({
      model: "settings-first",
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with OK only." }]
    });

    const modelProvidersText = fs.readFileSync(path.join(settingsDir, "model-providers.yml"), "utf8");
    expect(modelProvidersText).toContain("providers:");
    expect(modelProvidersText).not.toContain("imageProviders:");
    expect(modelProvidersText).not.toContain("Other Provider");
    expect(modelProvidersText).toContain("model: settings-first,settings-second");
    const imageProvidersText = fs.readFileSync(path.join(settingsDir, "image-providers.yml"), "utf8");
    expect(imageProvidersText).toContain("imageProviders:");
    expect(imageProvidersText).toContain("providerType: openai");
    expect(imageProvidersText).toContain("baseUrl: https://api.openai.com/v1");
    expect(imageProvidersText).not.toContain("endpoint:");
    expect(imageProvidersText).toContain("model: image-model-updated");
    const configText = fs.readFileSync(path.join(agentStudioDir, "config.yml"), "utf8");
    expect(configText).toContain("id: selected-provider");
    expect(configText).toContain("model: settings-first");
    expect(configText).toContain("id: selected-image");
    expect(configText).toContain("model: image-model-updated");

    await page.getByRole("button", { name: "账号设置" }).click();
    await page.getByRole("tabpanel", { name: "大模型供应商" }).getByLabel("供应商名称").fill("Unsaved Provider");
    await page.locator(".modalBackdrop").click({ position: { x: 4, y: 4 } });
    await expect(page.getByRole("dialog", { name: "账号设置" })).toHaveCount(0);
    await page.getByRole("button", { name: "账号设置" }).click();
    await expect(page.getByRole("tabpanel", { name: "大模型供应商" }).getByLabel("供应商名称")).toHaveValue("Selected Provider");
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("account settings switches existing providers without connectivity test", async () => {
  test.setTimeout(60_000);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-provider-switch-"));
  const agentStudioDir = path.join(homeDir, ".agentstudio");
  const settingsDir = path.join(agentStudioDir, "settings");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentStudioDir, "config.yml"),
    [
      "provider:",
      "  id: provider-one",
      "  baseUrl: http://127.0.0.1:9",
      "  apiKey: key-one",
      "  model: model-one",
      "imageProvider:",
      "  id: image-one",
      "  name: Image One",
      "  providerType: openai",
      "  baseUrl: https://api.openai.com/v1",
      "  apiKey: image-key-one",
      "  model: image-model-one",
      "workspace:",
      "  defaultDir: ~/.agentstudio/workspace",
      "user:",
      "  name: 默认用户",
      "  avatar: \"\"",
      ""
    ].join("\n"),
    "utf8"
  );
  const modelProvidersPath = path.join(settingsDir, "model-providers.yml");
  const originalSettings = [
    "providers:",
    "  - id: provider-one",
    "    name: Provider One",
    "    baseUrl: http://127.0.0.1:9",
    "    apiKey: key-one",
    "    model: model-one",
    "  - id: provider-two",
    "    name: Provider Two",
    "    baseUrl: http://127.0.0.1:8",
    "    apiKey: key-two",
    "    model: model-two-first,model-two-second",
    ""
  ].join("\n");
  const imageProvidersPath = path.join(settingsDir, "image-providers.yml");
  const originalImageSettings = [
    "imageProviders:",
    "  - id: image-one",
    "    name: Image One",
    "    providerType: openai",
    "    baseUrl: https://api.openai.com/v1",
    "    apiKey: image-key-one",
    "    model: image-model-one",
    "  - id: image-two",
    "    name: Image Two",
    "    providerType: gemini",
    "    baseUrl: https://generativelanguage.googleapis.com/v1",
    "    apiKey: image-key-two",
    "    model: image-model-two",
    ""
  ].join("\n");
  fs.writeFileSync(modelProvidersPath, originalSettings, "utf8");
  fs.writeFileSync(imageProvidersPath, originalImageSettings, "utf8");

  const app = await electron.launch({
    args: [path.resolve(__dirname, "../..")],
    env: {
      ...process.env,
      HOME: homeDir,
      VITE_DEV_SERVER_URL: ""
    }
  });

  try {
    const page = await app.firstWindow();
    await expect(page.locator(".shell")).toBeVisible();
    await page.getByRole("button", { name: "账号设置" }).click();
    await page.getByRole("button", { name: "Provider Two", exact: true }).click();
    await page.getByRole("dialog", { name: "账号设置" }).getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "账号设置" })).toHaveCount(0);
    await page.getByRole("button", { name: "账号设置" }).click();
    await page.getByRole("tab", { name: "图片模型" }).click();
    await page.getByRole("button", { name: "Image Two", exact: true }).click();
    await page.getByRole("dialog", { name: "账号设置" }).getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "账号设置" })).toHaveCount(0);

    expect(fs.readFileSync(modelProvidersPath, "utf8")).toBe(originalSettings);
    expect(fs.readFileSync(imageProvidersPath, "utf8")).toBe(originalImageSettings);
    const configText = fs.readFileSync(path.join(agentStudioDir, "config.yml"), "utf8");
    expect(configText).toContain("id: provider-two");
    expect(configText).toContain("apiKey: key-two");
    expect(configText).toContain("model: model-two-first");
    expect(configText).toContain("id: image-two");
    expect(configText).toContain("providerType: gemini");
    expect(configText).toContain("baseUrl: https://generativelanguage.googleapis.com/v1");
    expect(configText).toContain("apiKey: image-key-two");
    expect(configText).toContain("model: image-model-two");
  } finally {
    await app.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("composer switches active model without rewriting provider registry", async () => {
  test.setTimeout(60_000);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-model-switch-"));
  const agentStudioDir = path.join(homeDir, ".agentstudio");
  const settingsDir = path.join(agentStudioDir, "settings");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentStudioDir, "config.yml"),
    [
      "provider:",
      "  id: provider-one",
      "  baseUrl: http://127.0.0.1:9",
      "  apiKey: key-one",
      "  model: model-one",
      "workspace:",
      "  defaultDir: ~/.agentstudio/workspace",
      "user:",
      "  name: 默认用户",
      "  avatar: \"\"",
      ""
    ].join("\n"),
    "utf8"
  );
  const modelProvidersPath = path.join(settingsDir, "model-providers.yml");
  const originalSettings = [
    "providers:",
    "  - id: provider-one",
    "    name: Provider One",
    "    baseUrl: http://127.0.0.1:9",
    "    apiKey: key-one",
    "    model: model-one,model-two",
    ""
  ].join("\n");
  fs.writeFileSync(modelProvidersPath, originalSettings, "utf8");

  const app = await electron.launch({
    args: [path.resolve(__dirname, "../..")],
    env: {
      ...process.env,
      HOME: homeDir,
      VITE_DEV_SERVER_URL: ""
    }
  });

  try {
    const page = await app.firstWindow();
    await expect(page.locator(".shell")).toBeVisible();
    await expect(page.locator(".modelCurrentLabel")).toHaveText("model-one");
    await page.locator(".modelPicker").click();
    await expect(page.locator(".modelMenu")).toBeVisible();
    await page.locator(".modelMenu button", { hasText: "model-two" }).click();
    await expect(page.locator(".modelMenu")).toHaveCount(0);
    await expect(page.locator(".modelCurrentLabel")).toHaveText("model-two");

    expect(fs.readFileSync(modelProvidersPath, "utf8")).toBe(originalSettings);
    const configText = fs.readFileSync(path.join(agentStudioDir, "config.yml"), "utf8");
    expect(configText).toContain("id: provider-one");
    expect(configText).toContain("apiKey: key-one");
    expect(configText).toContain("model: model-two");
  } finally {
    await app.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("legacy image endpoint settings are ignored", async () => {
  test.setTimeout(60_000);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-legacy-image-provider-"));
  const agentStudioDir = path.join(homeDir, ".agentstudio");
  const settingsDir = path.join(agentStudioDir, "settings");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentStudioDir, "config.yml"),
    [
      "provider:",
      "  id: provider-existing",
      "  baseUrl: http://127.0.0.1:9",
      "  apiKey: key-existing",
      "  model: model-existing",
      "imageProvider:",
      "  id: legacy-image",
      "  name: Legacy Image",
      "  endpoint: https://legacy.example.test/generate",
      "  apiKey: legacy-key",
      "  model: legacy-model",
      "workspace:",
      "  defaultDir: ~/.agentstudio/workspace",
      "user:",
      "  name: 默认用户",
      "  avatar: \"\"",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(settingsDir, "model-providers.yml"),
    [
      "providers:",
      "  - id: provider-existing",
      "    name: Provider Existing",
      "    baseUrl: http://127.0.0.1:9",
      "    apiKey: key-existing",
      "    model: model-existing",
      "imageProviders:",
      "  - id: legacy-image",
      "    name: Legacy Image",
      "    endpoint: https://legacy.example.test/generate",
      "    apiKey: legacy-key",
      "    model: legacy-model",
      ""
    ].join("\n"),
    "utf8"
  );

  const app = await electron.launch({
    args: [path.resolve(__dirname, "../..")],
    env: {
      ...process.env,
      HOME: homeDir,
      VITE_DEV_SERVER_URL: ""
    }
  });

  try {
    const page = await app.firstWindow();
    await expect(page.locator(".shell")).toBeVisible();
    await page.getByRole("button", { name: "账号设置" }).click();
    await page.getByRole("tab", { name: "图片模型" }).click();
    const imagePanel = page.getByRole("tabpanel", { name: "图片模型供应商" });
    await expect(imagePanel.getByText("暂无图片模型供应商。")).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("invalid model provider yaml is reported without being overwritten", async () => {
  test.setTimeout(60_000);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-invalid-providers-"));
  const agentStudioDir = path.join(homeDir, ".agentstudio");
  const settingsDir = path.join(agentStudioDir, "settings");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentStudioDir, "config.yml"),
    [
      "provider:",
      "  id: provider-existing",
      "  baseUrl: http://127.0.0.1:9",
      "  apiKey: existing-key",
      "  model: existing-model",
      "workspace:",
      "  defaultDir: ~/.agentstudio/workspace",
      "user:",
      "  name: 默认用户",
      "  avatar: \"\"",
      ""
    ].join("\n"),
    "utf8"
  );
  const modelProvidersPath = path.join(settingsDir, "model-providers.yml");
  const invalidYaml = "providers:\n  - id: broken\n    name: [unterminated\n";
  fs.writeFileSync(modelProvidersPath, invalidYaml, "utf8");

  const app = await electron.launch({
    args: [path.resolve(__dirname, "../..")],
    env: {
      ...process.env,
      HOME: homeDir,
      VITE_DEV_SERVER_URL: ""
    }
  });

  try {
    const page = await app.firstWindow();
    await expect(page.locator(".shell")).toBeVisible();
    await page.getByRole("button", { name: "账号设置" }).click();
    await expect(page.getByRole("alert")).toContainText("模型供应商配置解析失败");
    expect(fs.readFileSync(modelProvidersPath, "utf8")).toBe(invalidYaml);
  } finally {
    await app.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("existing config does not create model provider registry", async () => {
  test.setTimeout(60_000);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-no-provider-migration-"));
  const agentStudioDir = path.join(homeDir, ".agentstudio");
  fs.mkdirSync(agentStudioDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentStudioDir, "config.yml"),
    [
      "provider:",
      "  id: provider-existing",
      "  baseUrl: http://127.0.0.1:9",
      "  apiKey: existing-key",
      "  model: existing-model",
      "workspace:",
      "  defaultDir: ~/.agentstudio/workspace",
      "user:",
      "  name: 默认用户",
      "  avatar: \"\"",
      ""
    ].join("\n"),
    "utf8"
  );
  const modelProvidersPath = path.join(agentStudioDir, "settings", "model-providers.yml");

  const app = await electron.launch({
    args: [path.resolve(__dirname, "../..")],
    env: {
      ...process.env,
      HOME: homeDir,
      VITE_DEV_SERVER_URL: ""
    }
  });

  try {
    const page = await app.firstWindow();
    await expect(page.locator(".shell")).toBeVisible();
    expect(fs.existsSync(modelProvidersPath)).toBe(false);
    await page.getByRole("button", { name: "账号设置" }).click();
    await expect(page.getByText("暂无大模型供应商。")).toBeVisible();
    expect(fs.existsSync(modelProvidersPath)).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("background browser runtime stays detached while right panel is closed", async () => {
  test.setTimeout(60_000);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-browser-detached-"));
  fs.mkdirSync(path.join(homeDir, ".agentstudio"), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, ".agentstudio", "config.yml"),
    [
      "provider:",
      "  baseUrl: http://127.0.0.1:9",
      "  apiKey: test-key",
      "  model: claude-test",
      "workspace:",
      "  defaultDir: ~/.agentstudio/workspace",
      "user:",
      "  name: 默认用户",
      "  avatar: \"\"",
      ""
    ].join("\n"),
    "utf8"
  );

  const app = await electron.launch({
    args: [path.resolve(__dirname, "../..")],
    env: {
      ...process.env,
      HOME: homeDir,
      VITE_DEV_SERVER_URL: ""
    }
  });

  try {
    const page = await app.firstWindow();
    await expect(page.locator(".shell")).toBeVisible();
    await expect(page.locator(".rightPanel.open")).toHaveCount(0);

    await page.getByPlaceholder("尽管问").fill("后台 web search 不要遮挡界面");
    await page.getByTitle("发送").click();
    await expect(page.locator(".messageBubble", { hasText: "后台 web search 不要遮挡界面" })).toBeVisible();

    await expect.poll(async () => app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window?.contentView.children.length ?? 0;
    })).toBe(0);
    await expect(page.locator(".rightPanel.open")).toHaveCount(0);
    await expect(page.getByText("小G · GrowthForce")).toBeVisible();
    await expect(page.locator(".brand")).toHaveCount(0);
    await expect(page.getByPlaceholder("尽管问")).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("closing app during a submitted turn does not send IPC to destroyed webContents", async () => {
  test.setTimeout(60_000);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-close-during-turn-"));
  fs.mkdirSync(path.join(homeDir, ".agentstudio"), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, ".agentstudio", "config.yml"),
    [
      "provider:",
      "  baseUrl: http://127.0.0.1:9",
      "  apiKey: test-key",
      "  model: claude-test",
      "workspace:",
      "  defaultDir: ~/.agentstudio/workspace",
      "user:",
      "  name: 默认用户",
      "  avatar: \"\"",
      ""
    ].join("\n"),
    "utf8"
  );

  const app = await electron.launch({
    args: [path.resolve(__dirname, "../..")],
    env: {
      ...process.env,
      HOME: homeDir,
      VITE_DEV_SERVER_URL: ""
    }
  });
  const stderr: string[] = [];
  const appProcess = app.process();
  appProcess.stderr?.on("data", (chunk) => stderr.push(chunk.toString()));
  let closed = false;

  try {
    const page = await app.firstWindow();
    await expect(page.locator(".shell")).toBeVisible();
    await page.getByPlaceholder("尽管问").fill("关闭窗口生命周期测试");
    await page.getByTitle("发送").click();
    await expect(page.locator(".messageBubble", { hasText: "关闭窗口生命周期测试" })).toBeVisible();
    await app.close();
    closed = true;
    expect(stderr.join("\n")).not.toContain("Object has been destroyed");
  } finally {
    if (!closed && appProcess.exitCode === null) await app.close().catch(() => undefined);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("workbench navigation opens a new conversation while preserving history", async () => {
  test.setTimeout(60_000);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-workbench-nav-"));
  fs.mkdirSync(path.join(homeDir, ".agentstudio"), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, ".agentstudio", "config.yml"),
    [
      "provider:",
      "  baseUrl: http://127.0.0.1:9",
      "  apiKey: test-key",
      "  model: claude-test",
      "workspace:",
      "  defaultDir: ~/.agentstudio/workspace",
      "user:",
      "  name: 默认用户",
      "  avatar: \"\"",
      ""
    ].join("\n"),
    "utf8"
  );

  const app = await electron.launch({
    args: [path.resolve(__dirname, "../..")],
    env: {
      ...process.env,
      HOME: homeDir,
      VITE_DEV_SERVER_URL: ""
    }
  });

  try {
    const page = await app.firstWindow();
    await expect(page.locator(".shell")).toBeVisible();
    await page.getByPlaceholder("尽管问").fill("工作台导航测试");
    await page.getByTitle("发送").click();
    await expect(page.locator(".messageBubble", { hasText: "工作台导航测试" })).toBeVisible();

    const createdSession = page.locator(".sessionItem", { hasText: "工作台导航测试" }).first();
    await expect(createdSession).toBeVisible();
    await page.getByRole("button", { name: "插件和技能" }).click();
    await expect(page.getByRole("button", { name: "技能市场" })).toBeVisible();
    await page.getByRole("button", { name: "工作台", exact: true }).click();

    await expect(page.locator(".messageBubble", { hasText: "工作台导航测试" })).toHaveCount(0);
    await expect(page.getByPlaceholder("尽管问")).toHaveValue("");
    await expect(createdSession).toBeVisible();
    await expect(createdSession).not.toHaveClass(/selected/);
  } finally {
    await app.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("built Electron app opens workbench and handles a submitted turn", async () => {
  test.setTimeout(90_000);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentstudio-e2e-"));
  const recentWorkspaceOne = path.join(homeDir, "recent-one");
  const recentWorkspaceTwo = path.join(homeDir, "recent-two");
  fs.mkdirSync(recentWorkspaceOne, { recursive: true });
  fs.mkdirSync(recentWorkspaceTwo, { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".agentstudio"), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, ".agentstudio", "config.yml"),
    [
      "provider:",
      "  baseUrl: http://127.0.0.1:9",
      "  apiKey: test-key",
      "  model: claude-test",
      "workspace:",
      "  defaultDir: ~/.agentstudio/workspace",
      "user:",
      "  name: 默认用户",
      "  avatar: \"\"",
      ""
    ].join("\n"),
    "utf8"
  );
  const skillDir = path.join(homeDir, ".agentstudio", "user-resources", "skills", "orchestrator", "e2e-switch");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, ".agentstudio", "settings.yml"),
    [
      "workspace:",
      "  recentDirectories:",
      `    - ${JSON.stringify(recentWorkspaceOne)}`,
      `    - ${JSON.stringify(recentWorkspaceTwo)}`,
      ""
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: e2e-switch",
      "agent: orchestrator",
      "description: Electron switch smoke skill",
      "---",
      "",
      "Used by the Electron smoke test."
    ].join("\n"),
    "utf8"
  );

  const app = await electron.launch({
    args: [path.resolve(__dirname, "../..")],
    env: {
      ...process.env,
      HOME: homeDir,
      VITE_DEV_SERVER_URL: ""
    }
  });

  try {
    const page = await app.firstWindow();
    await expect(page.locator(".shell")).toHaveClass(/platform-/);
    await expect(page.getByRole("button", { name: "折叠左侧栏" })).toBeVisible();
    await expect(page.locator(".rightPanel.open")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "设置", exact: true })).toHaveCount(0);
    await expect(page.locator(".topActions").getByTitle("新会话")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "打开右侧面板" })).toBeVisible();
    await expect(page.getByText("小G")).toBeVisible();
    await expect(page.getByText("我是小G")).toBeVisible();
    await expect(page.getByPlaceholder("尽管问")).toBeVisible();
    await expect(page.getByTitle("添加")).toBeVisible();
    await expect(page.locator(".permissionPicker")).toBeVisible();
    await expect(page.locator(".quickGrid button")).toHaveCount(6);

    await page.getByRole("button", { name: "打开右侧面板" }).click();
    await expect(page.locator(".rightPanel.open")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "打开右侧面板" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "隐藏右侧面板" })).toBeVisible();
    await page.getByRole("button", { name: "隐藏右侧面板" }).click();
    await expect(page.locator(".rightPanel.open")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "打开右侧面板" })).toBeVisible();

    await page.locator(".workspacePicker").click();
    await expect(page.locator(".workspaceMenu")).toBeVisible();
    await expect(page.getByRole("button", { name: "选择目录" })).toBeVisible();
    await expect(page.locator(".workspaceMenuDivider")).toBeVisible();
    await expect(page.locator(".workspaceRecentItem")).toHaveCount(2);
    const workspaceButtonBox = await page.locator(".workspacePicker").boundingBox();
    const workspaceMenuBox = await page.locator(".workspaceMenu").boundingBox();
    const firstRecentBox = await page.locator(".workspaceRecentItem").first().boundingBox();
    const chooseDirectoryBox = await page.getByRole("button", { name: "选择目录" }).boundingBox();
    expect(workspaceButtonBox).not.toBeNull();
    expect(workspaceMenuBox).not.toBeNull();
    expect(firstRecentBox).not.toBeNull();
    expect(chooseDirectoryBox).not.toBeNull();
    expect(Math.abs(workspaceMenuBox!.x - workspaceButtonBox!.x)).toBeLessThanOrEqual(6);
    expect(firstRecentBox!.y).toBeLessThan(chooseDirectoryBox!.y);
    await expect(page.locator(".workspaceRecentItem", { hasText: "recent-one" })).toBeVisible();
    await expect(page.locator(".workspaceRecentItem", { hasText: recentWorkspaceOne })).toHaveCount(0);
    await expect(page.locator(".workspaceRecentItem", { hasText: "recent-one" })).toHaveAttribute("title", recentWorkspaceOne);
    await page.locator(".permissionPicker").click();
    await expect(page.locator(".workspaceMenu")).toHaveCount(0);
    await expect(page.locator(".permissionMenu")).toBeVisible();
    await page.locator(".workspacePicker").click();
    await expect(page.locator(".permissionMenu")).toHaveCount(0);
    await expect(page.locator(".workspaceMenu")).toBeVisible();
    await page.getByTitle("添加").click();
    await expect(page.locator(".workspaceMenu")).toHaveCount(0);
    await expect(page.locator(".composerMenu")).toBeVisible();
    await page.locator(".workspacePicker").click();
    await expect(page.locator(".composerMenu")).toHaveCount(0);
    await expect(page.locator(".workspaceMenu")).toBeVisible();
    await page.locator(".workspaceRecentItem", { hasText: "recent-two" }).click();
    await expect(page.locator(".workspaceMenu")).toHaveCount(0);
    await expect(page.locator(".workspacePicker")).toHaveText("");
    await expect(page.locator(".workspacePicker")).toHaveAttribute("aria-label", /recent-two/);
    const connectorPickerBox = await page.locator(".connectorPicker").boundingBox();
    const workspacePickerBox = await page.locator(".workspacePicker").boundingBox();
    const permissionPickerBox = await page.locator(".permissionPicker").boundingBox();
    expect(connectorPickerBox?.width).toBe(32);
    expect(workspacePickerBox?.width).toBe(32);
    expect(permissionPickerBox?.width).toBe(32);

    const expandedSidebarBox = await page.locator(".sidebar").boundingBox();
    const collapseButtonBox = await page.getByRole("button", { name: "折叠左侧栏" }).boundingBox();
    expect(expandedSidebarBox).not.toBeNull();
    expect(collapseButtonBox).not.toBeNull();
    expect(collapseButtonBox!.x + collapseButtonBox!.width).toBeLessThanOrEqual(expandedSidebarBox!.x + expandedSidebarBox!.width);
    expect(collapseButtonBox!.x).toBeGreaterThan(expandedSidebarBox!.x + expandedSidebarBox!.width - 80);

    await page.getByRole("button", { name: "折叠左侧栏" }).click();
    await expect(page.getByRole("button", { name: "展开左侧栏" })).toBeVisible();
    await page.waitForTimeout(250);
    const collapsedWorkspaceBox = await page.locator(".workspace").boundingBox();
    const expandButtonBox = await page.getByRole("button", { name: "展开左侧栏" }).boundingBox();
    expect(collapsedWorkspaceBox).not.toBeNull();
    expect(expandButtonBox).not.toBeNull();
    expect(expandButtonBox!.x).toBeGreaterThanOrEqual(collapsedWorkspaceBox!.x);
    expect(expandButtonBox!.x).toBeLessThan(collapsedWorkspaceBox!.x + 80);
    await page.getByRole("button", { name: "展开左侧栏" }).click();
    await expect(page.getByText("小G")).toBeVisible();

    await page.getByRole("button", { name: "插件和技能" }).click();
    await expect(page.locator(".rightPanel.open")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "隐藏右侧面板" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "最大化右侧面板" })).toHaveCount(0);
    await expect(page.locator(".topbar")).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
    await expect(page.getByRole("button", { name: "技能市场" })).toBeVisible();
    await expect(page.getByPlaceholder("搜索插件或技能")).toBeVisible();
    await expect(page.getByLabel("Agent")).toHaveCount(0);
    await expect(page.getByText("归属 Agent")).toHaveCount(0);
    await expect(page.getByText("baoyu-comic")).toBeVisible();

    await page.getByRole("button", { name: "已安装" }).click();
    expect(fs.existsSync(path.join(homeDir, ".agentstudio", "agents", "orchestrator", "skills", "e2e-switch"))).toBe(true);
    const skillSwitch = page.getByRole("switch", { name: "禁用 e2e-switch" });
    await expect(skillSwitch).toBeVisible();
    await expect(skillSwitch).toHaveAttribute("aria-checked", "true");
    await skillSwitch.click();
    await expect(page.getByRole("switch", { name: "启用 e2e-switch" })).toHaveAttribute("aria-checked", "false");
    await expect(page.locator(".rightPanel.open")).toHaveCount(0);
    await page.getByRole("button", { name: "技能市场" }).click();

    await page.getByRole("button", { name: /baoyu-comic/ }).click();
    await expect(page.getByRole("button", { name: "隐藏右侧面板" })).toBeVisible();
    await expect(page.getByRole("button", { name: "最大化右侧面板" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "元信息" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Frontmatter" })).toHaveCount(0);
    await expect(page.locator(".metadataTable")).toContainText("name");
    await expect(page.locator(".metadataTable")).not.toContainText("agent");

    const panel = page.locator(".rightPanel.open");
    await panel.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(page.getByRole("button", { name: "最大化右侧面板" })).toBeVisible();
    const stickyHeaderTop = await page.locator(".rightPanelChrome").evaluate((element) => element.getBoundingClientRect().top);
    const panelTop = await panel.evaluate((element) => element.getBoundingClientRect().top);
    expect(Math.abs(stickyHeaderTop - panelTop)).toBeLessThanOrEqual(1);
    await panel.evaluate((element) => {
      element.scrollTop = 0;
    });

    const handle = page.getByRole("separator", { name: "调整右侧面板宽度" });
    const before = await panel.boundingBox();
    const handleBox = await handle.boundingBox();
    expect(before).not.toBeNull();
    expect(handleBox).not.toBeNull();
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + 80);
    await page.mouse.down();
    await page.mouse.move(handleBox!.x + 90, handleBox!.y + 80);
    await page.mouse.up();
    await page.waitForTimeout(250);
    const after = await panel.boundingBox();
    const windowWidth = await page.evaluate(() => window.innerWidth);
    expect(after).not.toBeNull();
    expect(after!.width).toBeLessThan(before!.width - 40);
    expect(after!.width).toBeGreaterThanOrEqual(320);
    expect(after!.width).toBeLessThanOrEqual(windowWidth / 2);

    await page.getByRole("button", { name: "最大化右侧面板" }).click();
    await expect(page.getByRole("button", { name: "还原右侧面板" })).toBeVisible();
    const maximized = await panel.boundingBox();
    const workspace = await page.locator(".workspace").boundingBox();
    const panelPosition = await panel.evaluate((element) => getComputedStyle(element).position);
    expect(maximized).not.toBeNull();
    expect(maximized!.width).toBeGreaterThan(windowWidth / 2);
    expect(workspace).not.toBeNull();
    expect(workspace!.width).toBeLessThan(8);
    expect(panelPosition).not.toBe("absolute");
    await page.getByRole("button", { name: "还原右侧面板" }).click();
    await expect(page.getByRole("button", { name: "最大化右侧面板" })).toBeVisible();

    await page.getByPlaceholder("搜索插件或技能").click();
    await expect(page.locator(".rightPanel.open")).toHaveCount(1);
    const topbarBox = await page.locator(".topbar").boundingBox();
    expect(topbarBox).not.toBeNull();
    await page.mouse.click(topbarBox!.x + topbarBox!.width / 2, topbarBox!.y + topbarBox!.height / 2);
    await expect(page.locator(".rightPanel.open")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "隐藏右侧面板" })).toHaveCount(0);

    await page.getByRole("button", { name: /baoyu-comic/ }).click();
    await expect(page.locator(".rightPanel.open")).toHaveCount(1);

    await page.getByRole("button", { name: "创建" }).click();
    await expect(page.getByRole("dialog", { name: "通过 GitHub 安装 Skill" })).toBeVisible();
    await expect(page.locator(".shell")).toHaveClass(/modalOpen/);
    await expect(page.getByPlaceholder("https://github.com/owner/repo/tree/main/example/SKILL.md")).toHaveCSS("font-size", "14px");
    await expect(page.getByText("归属 Agent")).toHaveCount(0);
    await expect(page.locator(".rightPanelResizeHandle")).toHaveCSS("pointer-events", "none");
    await page.getByTitle("关闭").click();
    await expect(page.getByRole("dialog", { name: "通过 GitHub 安装 Skill" })).toHaveCount(0);

    await page.getByRole("button", { name: "自动化运营" }).click();
    await expect(page.locator(".rightPanel.open")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "创建首个自动化" })).toBeVisible();
    await expect(page.getByRole("button", { name: "内容日更" })).toBeVisible();
    await expect(page.getByRole("button", { name: "竞品号监控" })).toBeVisible();
    await expect(page.getByRole("button", { name: "数据监控" })).toBeVisible();
    await page.evaluate(() => {
      const target = window as Window & { __automationChangedCount?: number; __unsubscribeAutomationChanged?: () => void };
      target.__automationChangedCount = 0;
      target.__unsubscribeAutomationChanged = window.agentStudio.onAutomationChanged(() => {
        target.__automationChangedCount = (target.__automationChangedCount ?? 0) + 1;
      });
    });

    await page.getByRole("button", { name: "内容日更" }).click();
    await expect(page.getByRole("dialog", { name: "创建自动化" })).toBeVisible();
    await expect(page.getByLabel("任务名称")).toHaveValue("内容日更");
    await expect(page.getByLabel("任务描述")).toHaveValue(/生成今天适合发布的内容/);
    await expect(page.getByLabel("最大重试次数")).toHaveValue("0");
    await page.getByLabel("计划时间").selectOption("interval");
    await expect(page.getByLabel("间隔数值")).toHaveValue("1");
    await expect(page.getByLabel("间隔数值")).toHaveAttribute("type", "number");
    await expect(page.getByLabel("间隔数值")).toHaveAttribute("min", "1");
    await page.getByLabel("间隔数值").fill("2");
    await page.getByLabel("间隔单位").selectOption("day");
    await page.getByLabel("最多运行次数（留空表示无限）").fill("3");
    await expect(page.getByText("定时任务始终使用完全访问权限")).toBeVisible();
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByRole("dialog", { name: "创建自动化" })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as Window & { __automationChangedCount?: number }).__automationChangedCount ?? 0)).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: /内容日更/ })).toBeVisible();
    await expect(page.getByText(/每 2 天 · 0\/3 次/)).toBeVisible();

    await page.getByRole("button", { name: /内容日更/ }).click();
    await expect(page.getByRole("button", { name: "保存修改" })).toBeVisible();
    await page.getByLabel("任务描述").fill("更新后的自动化描述");
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(page.locator(".automationTaskRow", { hasText: "更新后的自动化描述" })).toBeVisible();

    const automationSwitch = page.getByRole("switch", { name: "停用 内容日更" });
    await expect(automationSwitch).toHaveAttribute("aria-checked", "true");
    await automationSwitch.click();
    await expect(page.getByRole("switch", { name: "启用 内容日更" })).toHaveAttribute("aria-checked", "false");
    await page.getByRole("switch", { name: "启用 内容日更" }).click();
    await expect(page.getByRole("switch", { name: "停用 内容日更" })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("switch", { name: "停用 内容日更" }).click();
    await expect(page.getByRole("switch", { name: "启用 内容日更" })).toHaveAttribute("aria-checked", "false");
    await page.getByTitle("删除").click();
    await expect(page.getByRole("dialog", { name: "删除自动化任务" })).toBeVisible();
    await page.getByRole("dialog", { name: "删除自动化任务" }).getByRole("button", { name: "删除" }).click();
    await expect(page.getByRole("button", { name: "创建首个自动化" })).toBeVisible();
    await page.evaluate(() => {
      const target = window as Window & { __unsubscribeAutomationChanged?: () => void };
      target.__unsubscribeAutomationChanged?.();
      target.__unsubscribeAutomationChanged = undefined;
    });

    await page.getByRole("button", { name: "工作台" }).click();
    await expect(page.locator(".rightPanel.open")).toHaveCount(0);

    await page.getByTitle("添加").click();
    await expect(page.getByText("添加文件")).toBeVisible();
    await expect(page.getByText("使用技能")).toBeVisible();
    await expect(page.getByText("使用插件")).toBeVisible();
    await page.getByText("使用技能").hover();
    const skillMenuItem = await page.locator(".composerMenuItem.hasSubmenu").boundingBox();
    const submenu = await page.locator(".composerSubmenu").boundingBox();
    expect(skillMenuItem).not.toBeNull();
    expect(submenu).not.toBeNull();
    expect(Math.abs(submenu!.y - skillMenuItem!.y)).toBeLessThanOrEqual(12);
    await page.getByTitle("添加").click();

    await page.getByPlaceholder("尽管问").fill("Electron smoke 测试");
    await page.getByTitle("发送").click();
    await expect(page.locator(".messageBubble", { hasText: "Electron smoke 测试" })).toBeVisible();
    await page.getByRole("button", { name: "工作台" }).click();
    await expect(page.locator(".messageBubble", { hasText: "Electron smoke 测试" })).toHaveCount(0);
    await expect(page.getByPlaceholder("尽管问")).toHaveValue("");

    const createdSession = page.locator(".sessionItem", { hasText: "Electron smoke 测试" }).first();
    await expect(createdSession).toBeVisible({ timeout: 60_000 });
    await createdSession.click();
    await expect(page.locator(".message.assistant .messageBubble").first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "插件和技能" }).click();
    await expect(page.getByRole("button", { name: "技能市场" })).toBeVisible();
    await createdSession.click();
    await expect(page.getByText("Electron smoke 测试")).toBeVisible();
    await expect(page.locator(".messageBubble").filter({ hasText: /^Electron smoke 测试$/ })).toBeVisible();

    await page.getByRole("button", { name: "自动化运营" }).click();
    await expect(page.getByRole("button", { name: "创建首个自动化" })).toBeVisible();
    await createdSession.click();
    await expect(page.getByText("Electron smoke 测试")).toBeVisible();
    await expect(page.locator(".messageBubble").filter({ hasText: /^Electron smoke 测试$/ })).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
