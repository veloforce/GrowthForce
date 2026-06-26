import { expect, test } from "@playwright/test";

const mockPaths = {
  root: "/tmp/agentstudio-test",
  agents: "/tmp/agentstudio-test/agents",
  defaultAgent: "/tmp/agentstudio-test/agents/orchestrator",
  config: "/tmp/agentstudio-test/config.yml",
  settings: "/tmp/agentstudio-test/settings.yml",
  settingsDir: "/tmp/agentstudio-test/settings",
  modelProviders: "/tmp/agentstudio-test/settings/model-providers.yml",
  imageProviders: "/tmp/agentstudio-test/settings/image-providers.yml",
  database: "/tmp/agentstudio-test/agentstudio.sqlite",
  workspace: "/tmp/agentstudio-test/workspace",
  skills: "/tmp/agentstudio-test/agents/orchestrator/skills",
  userResourceSkills: "/tmp/agentstudio-test/user-resources/skills",
  userProfile: "/tmp/agentstudio-test/user-profile"
};

const completeConfig = {
  provider: { id: "provider-default", baseUrl: "https://api.anthropic.com", apiKey: "sk-test", model: "claude-sonnet-test" },
  imageProvider: { id: "", name: "", providerType: "", baseUrl: "", apiKey: "", model: "" },
  workspace: { defaultDir: "/tmp/agentstudio-test/workspace" },
  user: { name: "默认用户", avatar: "" }
};

test("renderer workbench shows Electron-only notice in a browser", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("小G");
  await expect(page.getByText("小G · GrowthForce")).toBeVisible();
  await expect(page.locator(".brand")).toHaveCount(0);
  await expect(page.getByText("我是小G")).toBeVisible();
  await expect(page.locator(".quickGrid button")).toHaveCount(4);
  await expect(page.getByRole("button", { name: /热点选题/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /小红书笔记/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /内容复盘/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /账号诊断/ })).toBeVisible();
  const quickPromptButtons = page.locator(".quickGrid button");
  const quickPromptHeights = await quickPromptButtons.evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().height)));
  expect(Math.max(...quickPromptHeights)).toBeLessThanOrEqual(44);
  expect(Math.min(...quickPromptHeights)).toBeGreaterThanOrEqual(38);
  const quickPromptIcons = await quickPromptButtons.locator("svg").evaluateAll((icons) => icons.map((icon) => icon.innerHTML));
  expect(new Set(quickPromptIcons).size).toBe(4);
  await expect(page.getByText("候选选题、推荐理由")).toHaveCount(0);
  await expect(page.getByPlaceholder("尽管问")).toBeVisible();
  await expect(page.getByRole("button", { name: "设置", exact: true })).toHaveCount(0);
  await expect(page.locator(".topActions").getByTitle("新会话")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "打开右侧面板" })).toBeVisible();

  await page.getByRole("button", { name: "打开右侧面板" }).click();
  await expect(page.locator(".rightPanel.open")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "打开右侧面板" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "隐藏右侧面板" })).toBeVisible();
  await page.getByRole("button", { name: "隐藏右侧面板" }).click();
  await expect(page.locator(".rightPanel.open")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "打开右侧面板" })).toBeVisible();

  await expect(page.getByText("当前页面未运行在 Electron 环境，无法连接桌面端能力。")).toBeVisible();

  await page.getByRole("button", { name: "自动化运营" }).click();
  await expect(page.getByRole("button", { name: "创建首个自动化" })).toBeVisible();
  await expect(page.getByRole("button", { name: "内容日更" })).toBeVisible();
  await expect(page.getByRole("button", { name: "竞品号监控" })).toBeVisible();
  await expect(page.getByRole("button", { name: "数据监控" })).toBeVisible();
  await expect(page.locator(".animatedClock")).toBeVisible();
  await expect(page.locator(".minuteHand")).toHaveCSS("animation-duration", "3s");
  await expect(page.locator(".minuteHand")).toHaveCSS("animation-iteration-count", "1");
  await expect(page.locator(".hourHand")).toHaveCSS("animation-name", "none");
  const staticHourTransform = await page.locator(".hourHand").evaluate((hand) => getComputedStyle(hand).transform);
  await page.waitForTimeout(3200);
  await expect.poll(async () => page.locator(".minuteHand").evaluate((hand) => hand.getAnimations()[0]?.playState)).toBe("finished");
  await expect(page.locator(".hourHand")).toHaveCSS("transform", staticHourTransform);
  await page.getByRole("button", { name: "工作台" }).click();
  await page.getByRole("button", { name: "自动化运营" }).click();
  await expect(page.locator(".animatedClock")).toBeVisible();
  const restartedClockAnimation = await page.locator(".minuteHand").evaluate((hand) => {
    const animation = hand.getAnimations()[0];
    return {
      currentTime: typeof animation?.currentTime === "number" ? animation.currentTime : 0,
      playState: animation?.playState
    };
  });
  expect(restartedClockAnimation.currentTime).toBeLessThan(1000);
  expect(["running", "pending"]).toContain(restartedClockAnimation.playState);
});

test("renderer handles normal tool permission actions", async ({ page }) => {
  await page.addInitScript(({ completeConfig, mockPaths }) => {
    const permissionListeners: Array<(request: unknown) => void> = [];
    const responses: unknown[] = [];
    (window as Window & { __emitPermission?: (request: unknown) => void; __permissionResponses?: unknown[] }).__emitPermission = (request: unknown) => {
      for (const listener of permissionListeners) listener(request);
    };
    (window as Window & { __permissionResponses?: unknown[] }).__permissionResponses = responses;
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: mockPaths,
        config: completeConfig,
        needsOnboarding: false,
        modelProviderSettings: { providers: [] },
        imageProviderSettings: { imageProviders: [] },
        settings: { chat: { permissionMode: "auto" }, connector: { xhs: { selected_account: "" } }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } },
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [] },
        workspace: { currentPath: mockPaths.workspace, defaultPath: mockPaths.workspace, recentDirectories: [] },
        sessions: []
      }),
      listSessions: async () => [],
      getSession: async () => null,
      getConnectorState: async () => ({ accounts: [], selected: { xhs: "", wechat: "" }, locked: { xhs: {} } }),
      updateBrowserSurface: async () => null,
      onAutomationChanged: () => () => undefined,
      onAgentEvent: () => () => undefined,
      onAgentPermissionRequest: (callback: (request: unknown) => void) => {
        permissionListeners.push(callback);
        return () => undefined;
      },
      respondAgentPermission: async (response: unknown) => {
        responses.push(response);
        return { ok: true };
      }
    };
  }, { completeConfig, mockPaths });

  await page.goto("/");
  const emitToolRequest = async (request: Record<string, unknown>) => {
    await page.evaluate((request) => (window as Window & { __emitPermission?: (request: unknown) => void }).__emitPermission?.({
      rpcId: request.rpcId,
      requestId: "permission-test",
      toolUseId: "tool-use",
      toolName: "Write",
      title: "写入文件",
      displayName: "Write",
      input: { file_path: "/tmp/example.md", content: "hello" },
      ...request
    }), request);
  };

  await emitToolRequest({ rpcId: "allow-once" });
  await expect(page.getByRole("button", { name: "允许本次" })).toBeVisible();
  await expect(page.getByRole("button", { name: "始终允许" })).toHaveCount(0);
  await page.getByRole("button", { name: "允许本次" }).click();

  await emitToolRequest({
    rpcId: "allow-remember",
    suggestions: [
      { type: "addRules", rules: [{ toolName: "Write" }], behavior: "allow", destination: "session" },
      { type: "addRules", rules: [{ toolName: "Write" }], behavior: "allow", destination: "localSettings" }
    ]
  });
  await page.getByRole("button", { name: "始终允许" }).click();

  await emitToolRequest({ rpcId: "reject" });
  await page.getByRole("button", { name: "拒绝" }).click();
  await expect(page.getByRole("button", { name: "提交" })).toBeDisabled();
  await page.getByPlaceholder("说明为什么拒绝本次操作").fill("路径不正确");
  await page.getByRole("button", { name: "提交" }).click();

  await emitToolRequest({ rpcId: "alternative" });
  await page.getByRole("button", { name: "替代方案" }).click();
  await expect(page.getByRole("button", { name: "提交" })).toBeDisabled();
  await page.getByPlaceholder("说明你希望小G改用什么做法").fill("先读取文件再决定是否写入");
  await page.getByRole("button", { name: "提交" }).click();

  await expect.poll(() => page.evaluate(() => (window as Window & { __permissionResponses?: unknown[] }).__permissionResponses)).toEqual([
    expect.objectContaining({ rpcId: "allow-once", action: "allow", mode: "allow", updatedInput: { file_path: "/tmp/example.md", content: "hello" } }),
    expect.objectContaining({ rpcId: "allow-remember", action: "allow", mode: "allow_remember", updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Write" }], behavior: "allow", destination: "localSettings" }] }),
    expect.objectContaining({ rpcId: "reject", action: "deny", mode: "deny", message: "路径不正确" }),
    expect.objectContaining({ rpcId: "alternative", action: "deny", mode: "suggest_alternative", message: "先读取文件再决定是否写入" })
  ]);
});

test("renderer answers AskUserQuestion with options free text and markdown preview", async ({ page }) => {
  await page.addInitScript(({ completeConfig, mockPaths }) => {
    const permissionListeners: Array<(request: unknown) => void> = [];
    const responses: unknown[] = [];
    (window as Window & { __emitPermission?: (request: unknown) => void; __permissionResponses?: unknown[] }).__emitPermission = (request: unknown) => {
      for (const listener of permissionListeners) listener(request);
    };
    (window as Window & { __permissionResponses?: unknown[] }).__permissionResponses = responses;
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: mockPaths,
        config: completeConfig,
        needsOnboarding: false,
        modelProviderSettings: { providers: [] },
        imageProviderSettings: { imageProviders: [] },
        settings: { chat: { permissionMode: "auto" }, connector: { xhs: { selected_account: "" } }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } },
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [] },
        workspace: { currentPath: mockPaths.workspace, defaultPath: mockPaths.workspace, recentDirectories: [] },
        sessions: []
      }),
      listSessions: async () => [],
      getSession: async () => null,
      getConnectorState: async () => ({ accounts: [], selected: { xhs: "", wechat: "" }, locked: { xhs: {} } }),
      updateBrowserSurface: async () => null,
      onAutomationChanged: () => () => undefined,
      onAgentEvent: () => () => undefined,
      onAgentPermissionRequest: (callback: (request: unknown) => void) => {
        permissionListeners.push(callback);
        return () => undefined;
      },
      respondAgentPermission: async (response: unknown) => {
        responses.push(response);
        return { ok: true };
      }
    };
  }, { completeConfig, mockPaths });

  await page.goto("/");
  await page.evaluate(() => (window as Window & { __emitPermission?: (request: unknown) => void }).__emitPermission?.({
    rpcId: "ask",
    requestId: "permission-test",
    toolUseId: "ask-use",
    toolName: "AskUserQuestion",
    input: {
      questions: [
        {
          header: "方向",
          question: "选择方案",
          options: [
            { label: "方案 A", description: "保守", preview: "### 预览\n- 第一项" },
            { label: "方案 B", description: "激进" }
          ]
        },
        {
          header: "渠道",
          question: "选择渠道",
          multiSelect: true,
          options: [
            { label: "小红书", description: "种草" },
            { label: "公众号", description: "长文" }
          ]
        }
      ]
    }
  }));

  await expect(page.getByRole("heading", { name: "预览" })).toBeVisible();
  await page.locator(".questionOptions button", { hasText: "方案 B" }).click();
  await page.locator(".questionOptions button", { hasText: "小红书" }).click();
  await page.locator(".questionOptions button", { hasText: "公众号" }).click();
  await page.getByPlaceholder("其他答案").nth(1).fill("视频号");
  await page.getByPlaceholder("或者直接输入一段回复").fill("优先周五发布");
  await page.getByRole("button", { name: "提交答案" }).click();

  await expect.poll(() => page.evaluate(() => (window as Window & { __permissionResponses?: unknown[] }).__permissionResponses?.[0])).toEqual(expect.objectContaining({
    rpcId: "ask",
    action: "allow",
    mode: "allow",
    updatedInput: expect.objectContaining({
      response: "优先周五发布"
    })
  }));
});

test("renderer queues revokes consumes and restores running supplements", async ({ page }) => {
  await page.addInitScript(({ completeConfig, mockPaths }) => {
    const eventListeners: Array<(event: unknown) => void> = [];
    const startTurnCalls: unknown[] = [];
    const enqueueCalls: unknown[] = [];
    const revokeCalls: unknown[] = [];
    const sessionOne = {
      id: 101,
      title: "运行中会话",
      workspacePath: "/tmp/agentstudio-test/workspace",
      status: "running",
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:00.000Z"
    };
    const sessionTwo = {
      id: 202,
      title: "另一个会话",
      workspacePath: "/tmp/agentstudio-test/workspace",
      status: "completed",
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:00.000Z"
    };
    (window as Window & {
      __emitAgentEvent?: (event: unknown) => void;
      __startTurnCalls?: unknown[];
      __enqueueCalls?: unknown[];
      __revokeCalls?: unknown[];
    }).__emitAgentEvent = (event: unknown) => {
      for (const listener of eventListeners) listener(event);
    };
    (window as Window & { __startTurnCalls?: unknown[] }).__startTurnCalls = startTurnCalls;
    (window as Window & { __enqueueCalls?: unknown[] }).__enqueueCalls = enqueueCalls;
    (window as Window & { __revokeCalls?: unknown[] }).__revokeCalls = revokeCalls;
    const settings = {
      chat: { permissionMode: "auto" },
      connector: { xhs: { selected_account: "" }, wechat: { selected_account: "" } },
      workspace: { recentDirectories: [] },
      skills: { installed: {}, disabled: [] }
    };
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: mockPaths,
        config: completeConfig,
        needsOnboarding: false,
        modelProviderSettings: { providers: [] },
        imageProviderSettings: { imageProviders: [] },
        settings,
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [] },
        workspace: { currentPath: mockPaths.workspace, defaultPath: mockPaths.workspace, recentDirectories: [] },
        sessions: []
      }),
      listSessions: async () => [sessionOne, sessionTwo],
      getSession: async (id: number) => id === 101
        ? {
            session: sessionOne,
            runningRequestId: "101:run",
            messages: [
              { kind: "text", id: "user:101:run", role: "user", text: "开始任务" },
              { kind: "text", id: "supplement:consumed-1", role: "user", text: "已消费补充" },
              { kind: "supplement", id: "pending-restore", requestId: "101:run", role: "user", text: "切换后仍待发送", status: "pending", createdAt: "2026-06-16T00:00:00.000Z" }
            ]
          }
        : { session: sessionTwo, messages: [{ kind: "text", id: "other-message", role: "user", text: "其他会话内容" }] },
      getConnectorState: async () => ({ accounts: [], selected: { xhs: "", wechat: "" }, locked: { xhs: {} } }),
      updateBrowserSurface: async () => null,
      onAutomationChanged: () => () => undefined,
      onAgentEvent: (callback: (event: unknown) => void) => {
        eventListeners.push(callback);
        return () => undefined;
      },
      onAgentPermissionRequest: () => () => undefined,
      startTurn: async (input: unknown) => {
        startTurnCalls.push(input);
        return { requestId: "101:run", session: sessionOne };
      },
      enqueueSupplement: async (input: { text: string }) => {
        enqueueCalls.push(input);
        const item = {
          id: `item-${enqueueCalls.length}`,
          requestId: "101:run",
          sessionId: 101,
          text: input.text,
          status: "pending",
          createdAt: "2026-06-16T00:00:00.000Z"
        };
        for (const listener of eventListeners) listener({ type: "supplementQueued", requestId: "101:run", sessionId: 101, item });
        return { item };
      },
      revokeSupplement: async (input: { itemId: string }) => {
        revokeCalls.push(input);
        for (const listener of eventListeners) listener({ type: "supplementRevoked", requestId: "101:run", sessionId: 101, itemId: input.itemId });
        return { ok: true, itemId: input.itemId };
      },
      getSupplementQueue: async () => ({ items: [] }),
      cancelTurn: async () => null,
      respondAgentPermission: async () => ({ ok: true })
    };
  }, { completeConfig, mockPaths });

  await page.goto("/");
  await page.getByPlaceholder("尽管问").fill("开始任务");
  await page.getByTitle("发送").click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __startTurnCalls?: unknown[] }).__startTurnCalls?.length)).toBe(1);

  await page.getByPlaceholder("继续提问...").fill("可撤销补充");
  await page.keyboard.press("Enter");
  await expect(page.locator(".supplementQueue", { hasText: "可撤销补充" })).toBeVisible();
  await expect(page.locator(".messageList", { hasText: "可撤销补充" })).toHaveCount(0);
  await page.getByRole("button", { name: "撤销" }).click();
  await expect(page.getByText("可撤销补充")).toHaveCount(0);

  await page.evaluate(() => {
    (window as Window & { __emitAgentEvent?: (event: unknown) => void }).__emitAgentEvent?.({
      type: "partial",
      requestId: "101:run",
      sessionId: 101,
      text: "上一轮结果前半"
    });
  });
  await page.getByPlaceholder("继续提问...").fill("已消费补充");
  await page.keyboard.press("Enter");
  await expect(page.locator(".supplementQueue", { hasText: "已消费补充" })).toBeVisible();
  await page.evaluate(() => {
    const emit = (window as Window & { __emitAgentEvent?: (event: unknown) => void }).__emitAgentEvent;
    emit?.({
      type: "partial",
      requestId: "101:run",
      sessionId: 101,
      text: "，后一半"
    });
    emit?.({
      type: "message",
      requestId: "101:run",
      sessionId: 101,
      role: "assistant",
      text: "上一轮结果前半，后一半"
    });
  });
  await page.evaluate(() => {
    (window as Window & { __emitAgentEvent?: (event: unknown) => void }).__emitAgentEvent?.({
      type: "supplementConsumed",
      requestId: "101:run",
      sessionId: 101,
      item: {
        id: "item-2",
        requestId: "101:run",
        sessionId: 101,
        text: "已消费补充",
        status: "consumed",
        createdAt: "2026-06-16T00:00:00.000Z",
        consumedAt: "2026-06-16T00:00:01.000Z"
      }
    });
  });
  await expect(page.locator(".supplementQueue", { hasText: "已消费补充" })).toHaveCount(0);
  await expect(page.locator(".message.user", { hasText: "已消费补充" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const messages = Array.from(document.querySelectorAll(".messageList .message")).map((element) => element.textContent ?? "");
    const assistantIndex = messages.findIndex((text) => text.includes("上一轮结果前半，后一半"));
    const supplementIndex = messages.findIndex((text) => text.includes("已消费补充"));
    return assistantIndex >= 0 && supplementIndex > assistantIndex;
  })).toBe(true);

  await page.locator(".sessionItem", { hasText: "另一个会话" }).click();
  await expect(page.getByText("其他会话内容")).toBeVisible();
  await page.locator(".sessionItem", { hasText: "运行中会话" }).click();
  await expect(page.locator(".supplementQueue", { hasText: "切换后仍待发送" })).toBeVisible();
  await page.getByPlaceholder("继续提问...").fill("恢复后补充");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as Window & { __enqueueCalls?: unknown[] }).__enqueueCalls?.length)).toBe(3);
  await page.evaluate(() => {
    (window as Window & { __emitAgentEvent?: (event: unknown) => void }).__emitAgentEvent?.({
      type: "supplementCleared",
      requestId: "101:run",
      sessionId: 101,
      itemIds: ["pending-restore"]
    });
  });
  await expect(page.getByText("切换后仍待发送")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as Window & { __revokeCalls?: unknown[] }).__revokeCalls?.length)).toBe(1);
});

test("workbench navigation always opens a new conversation", async ({ page }) => {
  await page.addInitScript(({ completeConfig, mockPaths }) => {
    const oldSession = {
      id: 71,
      title: "历史创作记录",
      workspacePath: "/tmp/agentstudio-test/history",
      status: "completed",
      createdAt: "2026-06-13T00:00:00.000Z",
      updatedAt: "2026-06-13T00:00:00.000Z"
    };
    const newSession = {
      ...oldSession,
      id: 72,
      title: "全新创作",
      workspacePath: "/tmp/agentstudio-test/workspace",
      status: "running"
    };
    const startTurnCalls: unknown[] = [];
    (window as Window & { __startTurnCalls?: unknown[] }).__startTurnCalls = startTurnCalls;
    const settings = {
      chat: { permissionMode: "auto" },
      connector: { xhs: { selected_account: "" } },
      workspace: { recentDirectories: [] },
      skills: { installed: {}, disabled: [] }
    };
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: mockPaths,
        config: completeConfig,
        needsOnboarding: false,
        modelProviderSettings: { providers: [] },
        imageProviderSettings: { imageProviders: [] },
        settings,
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [{ title: "新对话提示", prompt: "填入后再发送的新对话提示" }] },
        workspace: { currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] },
        sessions: [oldSession]
      }),
      listSessions: async () => [oldSession, newSession],
      getSession: async () => ({
        session: oldSession,
        messages: [{ id: "old-message", kind: "text", role: "user", text: "历史消息内容" }]
      }),
      listSkills: async () => ({ skills: [], errors: [], conflicts: [] }),
      listMarketSkills: async () => ({ skills: [], errors: [] }),
      getConnectorState: async () => ({ accounts: [], selected: { xhs: "" }, locked: { xhs: {} } }),
      updateBrowserSurface: async () => null,
      onAutomationChanged: () => () => undefined,
      startTurn: async (input: unknown) => {
        startTurnCalls.push(input);
        return { requestId: "72:new", session: newSession };
      },
      cancelTurn: async () => null,
      onAgentEvent: () => () => undefined
    };
  }, { completeConfig, mockPaths });

  await page.goto("/");
  const history = page.locator(".sessionItem", { hasText: "历史创作记录" });
  await expect(page.locator(".agentName")).toHaveText("小G · GrowthForce");
  await history.click();
  await expect(page.locator(".agentName")).toHaveText("历史创作记录");
  await expect(page.getByText("历史消息内容")).toBeVisible();
  await page.getByPlaceholder("继续提问...").fill("不应保留的草稿");

  await page.getByRole("button", { name: "工作台" }).click();
  await expect(page.locator(".agentName")).toHaveText("小G · GrowthForce");
  await expect(page.getByText("历史消息内容")).toHaveCount(0);
  await expect(page.getByPlaceholder("尽管问")).toHaveValue("");
  await expect(history).not.toHaveClass(/selected/);

  await history.click();
  await page.getByRole("button", { name: "插件和技能" }).click();
  await expect(page.getByRole("button", { name: "技能市场" })).toBeVisible();
  await page.getByRole("button", { name: "工作台" }).click();
  await expect(page.getByText("历史消息内容")).toHaveCount(0);
  await expect(history).toBeVisible();
  await page.getByRole("button", { name: /新对话提示/ }).click();
  await expect(page.getByPlaceholder("尽管问")).toHaveValue("填入后再发送的新对话提示");
  await expect.poll(() => page.evaluate(() => (window as Window & { __startTurnCalls?: Array<{ prompt?: string; sessionId?: number }> }).__startTurnCalls)).toEqual([]);

  await page.getByPlaceholder("尽管问").fill("全新创作");
  await page.getByTitle("发送").click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __startTurnCalls?: Array<{ prompt?: string; sessionId?: number }> }).__startTurnCalls)).toEqual([
    expect.objectContaining({ prompt: "全新创作", sessionId: undefined })
  ]);
});

test("renderer keeps browser surface offscreen until user opens right panel", async ({ page }) => {
  await page.addInitScript(({ completeConfig, mockPaths }) => {
    const session = {
      id: 404,
      title: "后台浏览器会话",
      workspacePath: "/tmp/agentstudio-test/workspace",
      status: "running",
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:00.000Z"
    };
    const surfaceCalls: unknown[] = [];
    const startTurnCalls: unknown[] = [];
    (window as Window & { __surfaceCalls?: unknown[]; __startTurnCalls?: unknown[] }).__surfaceCalls = surfaceCalls;
    (window as Window & { __startTurnCalls?: unknown[] }).__startTurnCalls = startTurnCalls;
    const settings = {
      chat: { permissionMode: "auto" },
      connector: { xhs: { selected_account: "" } },
      workspace: { recentDirectories: [] },
      skills: { installed: {}, disabled: [] }
    };
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: mockPaths,
        config: completeConfig,
        needsOnboarding: false,
        modelProviderSettings: { providers: [] },
        imageProviderSettings: { imageProviders: [] },
        settings,
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [{ title: "黄金走势", prompt: "黄金走势" }] },
        workspace: { currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] },
        sessions: []
      }),
      saveProviderConfig: async () => ({ config: completeConfig, modelProviderSettings: { providers: [] }, needsOnboarding: false }),
      getModelProviderSettings: async () => ({ settings: { providers: [] }, config: completeConfig }),
      getImageProviderSettings: async () => ({ settings: { imageProviders: [] }, config: completeConfig }),
      saveModelProviderSettings: async () => ({ settings: { providers: [] }, config: completeConfig, needsOnboarding: false }),
      saveImageProviderSettings: async () => ({ settings: { imageProviders: [] }, config: completeConfig, needsOnboarding: false }),
      listSessions: async () => [session],
      getSession: async () => ({ session, messages: [] }),
      getWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      setWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      chooseWorkspace: async () => null,
      chooseFiles: async () => [],
      readArtifactFile: async () => null,
      updatePermissionMode: async () => settings,
      updateThemeMode: async () => ({ settings, theme: { mode: "system", resolved: "light" } }),
      listAgents: async () => [],
      listSkills: async () => ({ skills: [], errors: [], conflicts: [] }),
      enableSkill: async () => ({ skills: [], errors: [], conflicts: [] }),
      disableSkill: async () => ({ skills: [], errors: [], conflicts: [] }),
      listMarketSkills: async () => ({ skills: [], errors: [] }),
      getSkillContent: async () => null,
      installGithubSkill: async () => null,
      listAutomationTasks: async () => [],
      getAutomationTask: async () => null,
      createAutomationTask: async () => null,
      updateAutomationTask: async () => null,
      setAutomationTaskEnabled: async () => null,
      deleteAutomationTask: async () => null,
      listAutomationRuns: async () => [],
      getAutomationRunSession: async () => null,
      chooseAutomationWorkspace: async () => null,
      getConnectorState: async () => ({ accounts: [], selected: { xhs: "" }, locked: { xhs: {} } }),
      createXhsAccount: async () => {
        throw new Error("should not create XHS account in browser surface test");
      },
      selectXhsAccount: async () => ({ state: { accounts: [], selected: { xhs: "" }, locked: { xhs: {} } }, valid: true }),
      clearXhsAccountSelection: async () => ({ accounts: [], selected: { xhs: "" }, locked: { xhs: {} } }),
      deleteXhsAccount: async () => ({ accounts: [], selected: { xhs: "" }, locked: { xhs: {} } }),
      startXhsLogin: async () => null,
      waitXhsLogin: async () => null,
      logoutXhs: async () => null,
      updateBrowserSurface: async (input: unknown) => {
        surfaceCalls.push(input);
        return { ok: true };
      },
      onAutomationChanged: () => () => undefined,
      startTurn: async (input: unknown) => {
        startTurnCalls.push(input);
        return { requestId: "404:browser", session };
      },
      cancelTurn: async () => null,
      onAgentEvent: () => () => undefined
    };
  }, { completeConfig, mockPaths });

  await page.goto("/");
  await page.getByPlaceholder("尽管问").fill("搜索黄金走势");
  await page.getByTitle("发送").click();

  await expect(page.locator(".rightPanel.open")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as Window & { __startTurnCalls?: Array<{ useBrowserAutomation?: boolean }> }).__startTurnCalls)).toEqual([
    expect.objectContaining({ useBrowserAutomation: true })
  ]);
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as Window & { __surfaceCalls?: Array<{ visible?: boolean }> }).__surfaceCalls ?? [];
    return calls.some((call) => call.visible === true);
  })).toBe(false);

  await page.getByRole("button", { name: "打开右侧面板" }).click();

  await expect(page.locator(".rightPanel.open")).toHaveCount(1);
  await page.waitForTimeout(250);
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as Window & { __surfaceCalls?: Array<{ sessionId?: number; visible?: boolean; bounds?: { x: number; y: number; width: number; height: number } }> }).__surfaceCalls ?? [];
    const visibleCall = calls.filter((call) => call.visible === true).at(-1);
    return visibleCall ? {
      sessionId: visibleCall.sessionId,
      x: Math.round(visibleCall.bounds?.x ?? 0),
      y: Math.round(visibleCall.bounds?.y ?? 0),
      width: Math.round(visibleCall.bounds?.width ?? 0),
      height: Math.round(visibleCall.bounds?.height ?? 0)
    } : null;
  })).toEqual(expect.objectContaining({
    sessionId: 404,
    x: expect.any(Number),
    y: expect.any(Number),
    width: expect.any(Number),
    height: expect.any(Number)
  }));
  const visibleBounds = await page.evaluate(() => {
    const calls = (window as Window & { __surfaceCalls?: Array<{ visible?: boolean; bounds?: { x: number; y: number; width: number; height: number } }> }).__surfaceCalls ?? [];
    return calls.filter((call) => call.visible === true).at(-1)?.bounds;
  });
  expect(visibleBounds?.x).toBeGreaterThan(0);
  expect(visibleBounds?.y).toBeGreaterThanOrEqual(0);
  expect(visibleBounds?.width).toBeGreaterThanOrEqual(320);
  expect(visibleBounds?.width).toBeLessThanOrEqual(640);
  expect(visibleBounds?.height).toBeGreaterThan(200);

  await page.getByRole("button", { name: "隐藏右侧面板" }).click();
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as Window & { __surfaceCalls?: Array<{ sessionId?: number; visible?: boolean }> }).__surfaceCalls ?? [];
    return calls.at(-1);
  })).toEqual({ sessionId: 404, visible: false });
});

test("renderer keeps compact composer pickers and popover widths stable", async ({ page }) => {
  await page.addInitScript(({ completeConfig, mockPaths }) => {
    const longAccount = {
      id: 1,
      platform: "xhs",
      profileKey: "xhs_long_profile",
      accountId: "answerbook",
      accountHandle: "answerbook",
      displayName: "这个世界有问题但是名字非常非常长",
      avatarUrl: null,
      status: "authorized",
      opsState: { reviewTaskId: null },
      autoReviewEnabled: false,
      createdAt: "2026-06-05T00:00:00.000Z",
      updatedAt: "2026-06-05T00:00:00.000Z",
      lastAuthorizedAt: "2026-06-05T00:00:00.000Z"
    };
    const shortWorkspace = "/tmp/agentstudio-test/英语";
    const longWorkspace = "/tmp/agentstudio-test/skills-for-context-engineering";
    const overflowAccounts = Array.from({ length: 8 }, (_, index) => ({
      ...longAccount,
      id: index + 2,
      profileKey: `xhs_overflow_${index}`,
      displayName: `滚动账号 ${index + 1}`,
      accountId: `overflow-${index + 1}`,
      accountHandle: `overflow-${index + 1}`,
      createdAt: `2026-06-0${4 - Math.floor(index / 3)}T0${index}:00:00.000Z`
    }));
    let workspaceState = { currentPath: shortWorkspace, defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [longWorkspace, shortWorkspace] };
    let permissionMode = "auto";
    let connectorState = { accounts: [longAccount, ...overflowAccounts], selected: { xhs: "xhs_long_profile", wechat: "" }, locked: { xhs: {} } };
    const settings = () => ({
      chat: { permissionMode },
      ui: { themeMode: "system" },
      connector: { xhs: { selected_account: connectorState.selected.xhs }, wechat: { selected_account: connectorState.selected.wechat } },
      workspace: { recentDirectories: workspaceState.recentDirectories },
      skills: { installed: {}, disabled: [] }
    });
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: mockPaths,
        config: completeConfig,
        needsOnboarding: false,
        modelProviderSettings: { providers: [] },
        imageProviderSettings: { imageProviders: [] },
        settings: settings(),
        theme: { themeMode: "system", resolved: "light" },
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [{ title: "固定宽度测试", prompt: "固定宽度测试" }] },
        connectorState,
        workspace: workspaceState,
        sessions: []
      }),
      saveProviderConfig: async () => ({ config: completeConfig, modelProviderSettings: { providers: [] }, needsOnboarding: false }),
      getModelProviderSettings: async () => ({ settings: { providers: [] }, config: completeConfig }),
      getImageProviderSettings: async () => ({ settings: { imageProviders: [] }, config: completeConfig }),
      saveModelProviderSettings: async () => ({ settings: { providers: [] }, config: completeConfig, needsOnboarding: false }),
      saveImageProviderSettings: async () => ({ settings: { imageProviders: [] }, config: completeConfig, needsOnboarding: false }),
      listSessions: async () => [],
      getSession: async () => null,
      getWorkspace: async () => workspaceState,
      setWorkspace: async (workspacePath: string) => {
        workspaceState = { ...workspaceState, currentPath: workspacePath };
        return workspaceState;
      },
      chooseWorkspace: async () => null,
      chooseFiles: async () => [],
      readArtifactFile: async () => null,
      updatePermissionMode: async (nextMode: string) => {
        permissionMode = nextMode;
        return settings();
      },
      updateThemeMode: async () => ({ settings: settings(), theme: { mode: "system", resolved: "light" } }),
      onThemeChanged: () => () => undefined,
      listAgents: async () => [],
      listSkills: async () => ({ skills: [], errors: [], conflicts: [] }),
      enableSkill: async () => ({ skills: [], errors: [], conflicts: [] }),
      disableSkill: async () => ({ skills: [], errors: [], conflicts: [] }),
      listMarketSkills: async () => ({ skills: [], errors: [] }),
      getSkillContent: async () => null,
      installGithubSkill: async () => null,
      listAutomationTasks: async () => [],
      getAutomationTask: async () => null,
      createAutomationTask: async () => null,
      updateAutomationTask: async () => null,
      setAutomationTaskEnabled: async () => null,
      deleteAutomationTask: async () => null,
      listAutomationRuns: async () => [],
      getAutomationRunSession: async () => null,
      chooseAutomationWorkspace: async () => null,
      getConnectorState: async () => connectorState,
      createXhsAccount: async () => {
        throw new Error("should not create in width test");
      },
      selectXhsAccount: async () => ({ state: connectorState, valid: true }),
      clearXhsAccountSelection: async () => {
        connectorState = { ...connectorState, selected: { ...connectorState.selected, xhs: "" } };
        return connectorState;
      },
      deleteXhsAccount: async () => connectorState,
      setConnectorAccountAutoReview: async () => connectorState,
      startXhsLogin: async () => null,
      waitXhsLogin: async () => ({ state: connectorState }),
      logoutXhs: async () => null,
      updateBrowserSurface: async () => null,
      onAutomationChanged: () => () => undefined,
      startTurn: async () => null,
      cancelTurn: async () => null,
      onAgentEvent: () => () => undefined
    };
  }, { completeConfig, mockPaths });

  await page.goto("/");
  const widthOf = async (selector: string) => page.locator(selector).evaluate((element) => Math.round(element.getBoundingClientRect().width));
  await page.locator(".composer textarea").focus();
  await expect.poll(() => page.locator(".composer textarea").evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");

  const connectorWidth = await widthOf(".connectorPicker");
  const workspaceWidth = await widthOf(".workspacePicker");
  const permissionWidth = await widthOf(".permissionPicker");
  expect(connectorWidth).toBe(32);
  expect(workspaceWidth).toBeGreaterThan(connectorWidth);
  expect(permissionWidth).toBe(connectorWidth);
  await expect(page.locator(".connectorPicker")).toHaveText("");
  await expect(page.locator(".workspacePicker")).toHaveText("英语");
  await expect(page.locator(".permissionPicker")).toHaveText("");
  await expect(page.locator(".connectorPicker")).toHaveAttribute("aria-label", /这个世界有问题但是名字非常非常长/);
  await expect(page.locator(".connectorPicker img")).toHaveCount(1);
  await expect(page.locator(".workspacePicker")).toHaveAttribute("aria-label", "项目目录：/tmp/agentstudio-test/英语");
  await expect(page.locator(".workspacePicker")).toHaveAttribute("title", "/tmp/agentstudio-test/英语");
  await expect(page.locator(".permissionPicker")).toHaveAttribute("aria-label", "权限：自动决策");
  const initialWorkspaceBox = await page.locator(".workspacePicker").boundingBox();
  const initialConnectorBox = await page.locator(".connectorPicker").boundingBox();
  expect(initialWorkspaceBox?.x ?? 0).toBeLessThan(initialConnectorBox?.x ?? 0);

  await page.locator(".connectorPicker").click();
  const xhsMenuItem = page.locator(".connectorMenuItem", { hasText: "小红书" });
  await xhsMenuItem.hover();
  const connectorAddAccount = xhsMenuItem.locator(".connectorAccountAction");
  const connectorAddBackground = await connectorAddAccount.evaluate((element) => getComputedStyle(element).backgroundColor);
  await connectorAddAccount.hover();
  await page.waitForTimeout(200);
  const connectorAddHoverBackground = await connectorAddAccount.evaluate((element) => getComputedStyle(element).backgroundColor);
  const connectorMenuWidth = await widthOf(".connectorMenu");
  const connectorSubmenuWidth = await xhsMenuItem.locator(".connectorSubmenu").evaluate((element) => Math.round(element.getBoundingClientRect().width));
  expect(connectorSubmenuWidth).toBeLessThanOrEqual(232);
  await expect.poll(() => connectorAddAccount.evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBeLessThanOrEqual(34);
  await expect.poll(() => xhsMenuItem.locator(".connectorAccountRow > button").first().evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBeLessThanOrEqual(46);
  await expect.poll(() => xhsMenuItem.locator(".connectorAccountRow > button").first().evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect.poll(() => xhsMenuItem.locator(".connectorAccountList").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(xhsMenuItem.locator(".connectorStatusDot")).toHaveCount(0);
  await expect(xhsMenuItem.locator(".connectorDeleteButton")).toHaveCount(0);
  await expect(xhsMenuItem.locator(".connectorReviewSwitch")).toHaveCount(0);
  await page.locator(".connectorAccountRow", { hasText: "这个世界有问题" }).getByRole("button").first().click();
  await expect(page.locator(".connectorPicker")).toHaveAttribute("aria-label", "连接器");
  await expect(page.locator(".connectorPicker img")).toHaveCount(0);
  await expect.poll(() => widthOf(".connectorPicker")).toBe(connectorWidth);
  await expect.poll(() => widthOf(".connectorMenu")).toBe(connectorMenuWidth);
  await expect.poll(() => xhsMenuItem.locator(".connectorSubmenu").evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(connectorSubmenuWidth);

  await page.mouse.move(0, 0);
  const pickerStyle = async (selector: string) => page.locator(selector).evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, shadow: style.boxShadow };
  });
  const defaultPickerStyle = await pickerStyle(".workspacePicker");
  await expect.poll(() => pickerStyle(".connectorPicker")).toEqual(defaultPickerStyle);
  await expect.poll(() => pickerStyle(".permissionPicker")).toEqual(defaultPickerStyle);
  await expect.poll(() => pickerStyle(".modelPicker")).toEqual(defaultPickerStyle);
  for (const selector of [".workspacePicker", ".connectorPicker", ".permissionPicker", ".modelPicker"]) {
    await page.locator(selector).hover();
    await expect.poll(() => pickerStyle(selector)).toEqual(expect.objectContaining({ background: defaultPickerStyle.background }));
    await expect.poll(() => pickerStyle(selector).then((style) => style.shadow)).not.toBe(defaultPickerStyle.shadow);
    await page.mouse.move(0, 0);
  }

  await page.locator(".workspacePicker").click();
  const workspaceMenuWidth = await widthOf(".workspaceMenu");
  const workspaceChoose = page.locator(".workspaceMenuChoose");
  await expect.poll(() => workspaceChoose.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(connectorAddBackground);
  await workspaceChoose.hover();
  await expect.poll(() => workspaceChoose.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(connectorAddHoverBackground);
  await page.locator(".workspaceRecentItem", { hasText: "skills-for-context-engineering" }).click();
  await expect(page.locator(".workspacePicker")).toHaveAttribute("aria-label", "项目目录：/tmp/agentstudio-test/skills-for-context-engineering");
  await expect(page.locator(".workspacePicker")).toHaveAttribute("title", "/tmp/agentstudio-test/skills-for-context-engineering");
  await expect(page.locator(".workspacePicker")).toHaveText("skills-for-context-engineering");
  await expect.poll(() => widthOf(".workspacePicker")).toBeLessThanOrEqual(220);
  await page.locator(".workspacePicker").click();
  await expect.poll(() => widthOf(".workspaceMenu")).toBe(workspaceMenuWidth);

  await page.locator(".permissionPicker").click();
  const permissionMenuWidth = await widthOf(".permissionMenu");
  await page.locator(".permissionMenu button", { hasText: "完全访问" }).click();
  await expect(page.locator(".permissionPicker")).toHaveAttribute("aria-label", "权限：完全访问");
  await expect.poll(() => widthOf(".permissionPicker")).toBe(permissionWidth);
  await page.locator(".permissionPicker").click();
  await expect.poll(() => widthOf(".permissionMenu")).toBe(permissionMenuWidth);

  await page.getByRole("button", { name: "账号设置" }).click();
  const settingsDialog = page.getByRole("dialog", { name: "账号设置" });
  await settingsDialog.getByRole("button", { name: "连接器设置" }).click();
  const settingsRows = settingsDialog.locator(".connectorSettingsRow");
  await expect(settingsRows.first()).toContainText("这个世界有问题但是名字非常非常长");
  await expect(settingsRows.first().locator(".connectorSettingsDetails strong")).toHaveText("已授权");
  await expect(settingsRows.first().locator(".connectorSettingsDetails")).not.toContainText("answerbook");
  await expect.poll(() => settingsDialog.locator(".connectorSettingsList").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
});

test("renderer refreshes connector review switch from automation changed events", async ({ page }) => {
  await page.addInitScript(({ completeConfig, mockPaths }) => {
    const automationListeners: Array<() => void> = [];
    const account = {
      id: 1,
      platform: "wechat",
      profileKey: "wechat_review_profile",
      accountId: "wx-review-appid",
      accountHandle: null,
      displayName: "复盘公众号",
      avatarUrl: null,
      status: "authorized",
      opsState: { reviewTaskId: 12 },
      autoReviewEnabled: true,
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
      lastAuthorizedAt: "2026-06-18T00:00:00.000Z"
    };
    (window as Window & { __connectorAccount?: typeof account; __emitAutomationChanged?: () => void }).__connectorAccount = account;
    (window as Window & { __emitAutomationChanged?: () => void }).__emitAutomationChanged = () => {
      for (const listener of automationListeners) listener();
    };
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: mockPaths,
        config: completeConfig,
        needsOnboarding: false,
        modelProviderSettings: { providers: [] },
        imageProviderSettings: { imageProviders: [] },
        settings: { chat: { permissionMode: "auto" }, connector: { xhs: { selected_account: "" }, wechat: { selected_account: "wechat_review_profile" } }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } },
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [] },
        workspace: { currentPath: mockPaths.workspace, defaultPath: mockPaths.workspace, recentDirectories: [] },
        sessions: [],
        connectorState: { accounts: [account], selected: { xhs: "", wechat: "wechat_review_profile" }, locked: { xhs: {} } }
      }),
      listSessions: async () => [],
      getSession: async () => null,
      getConnectorState: async () => {
        const current = (window as Window & { __connectorAccount?: typeof account }).__connectorAccount ?? account;
        return { accounts: [current], selected: { xhs: "", wechat: "wechat_review_profile" }, locked: { xhs: {} } };
      },
      updateBrowserSurface: async () => null,
      onAutomationChanged: (callback: () => void) => {
        automationListeners.push(callback);
        return () => undefined;
      },
      setConnectorAccountAutoReview: async () => null,
      getWechatCredential: async () => ({ secret: "wx-secret" }),
      deleteWechatAccount: async () => ({ accounts: [], selected: { xhs: "", wechat: "" }, locked: { xhs: {} } }),
      onAgentEvent: () => () => undefined
    };
  }, { completeConfig, mockPaths });

  await page.goto("/");
  await page.getByRole("button", { name: "账号设置" }).click();
  const settingsDialog = page.getByRole("dialog", { name: "账号设置" });
  await settingsDialog.getByRole("button", { name: "连接器设置" }).click();
  await settingsDialog.getByRole("tab", { name: "公众号" }).click();
  const switchButton = settingsDialog.getByRole("switch", { name: /自动复盘 复盘公众号/ });
  await expect(switchButton).toHaveAttribute("aria-checked", "true");

  await page.evaluate(() => {
    const target = window as Window & { __connectorAccount?: { autoReviewEnabled?: boolean }; __emitAutomationChanged?: () => void };
    if (target.__connectorAccount) target.__connectorAccount = { ...target.__connectorAccount, autoReviewEnabled: false };
    target.__emitAutomationChanged?.();
  });

  await expect(switchButton).toHaveAttribute("aria-checked", "false");
});

test("renderer switches composer model globally and keeps running supplements on the active request", async ({ page }) => {
  await page.addInitScript(({ completeConfig, mockPaths }) => {
    const startTurnCalls: unknown[] = [];
    const supplementCalls: unknown[] = [];
    const selectedModels: string[] = [];
    const session = {
      id: 909,
      title: "模型切换会话",
      workspacePath: "/tmp/agentstudio-test/workspace",
      status: "running",
      createdAt: "2026-06-17T00:00:00.000Z",
      updatedAt: "2026-06-17T00:00:00.000Z"
    };
    let config = {
      ...completeConfig,
      provider: { ...completeConfig.provider, id: "provider-default", model: "model-a" }
    };
    const modelProviderSettings = {
      providers: [{
        id: "provider-default",
        name: "Default Provider",
        baseUrl: completeConfig.provider.baseUrl,
        apiKey: completeConfig.provider.apiKey,
        model: "model-a,model-b,this-is-a-very-long-model-name-for-layout"
      }]
    };
    (window as Window & { __startTurnCalls?: unknown[]; __supplementCalls?: unknown[]; __selectedModels?: string[] }).__startTurnCalls = startTurnCalls;
    (window as Window & { __supplementCalls?: unknown[] }).__supplementCalls = supplementCalls;
    (window as Window & { __selectedModels?: string[] }).__selectedModels = selectedModels;
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: mockPaths,
        config,
        needsOnboarding: false,
        modelProviderSettings,
        imageProviderSettings: { imageProviders: [] },
        settings: { chat: { permissionMode: "auto" }, connector: { xhs: { selected_account: "" }, wechat: { selected_account: "" } }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } },
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [{ title: "模型切换", prompt: "模型切换" }] },
        workspace: { currentPath: mockPaths.workspace, defaultPath: mockPaths.workspace, recentDirectories: [] },
        sessions: []
      }),
      setActiveModel: async (model: string) => {
        selectedModels.push(model);
        config = { ...config, provider: { ...config.provider, model } };
        return { settings: modelProviderSettings, config, needsOnboarding: false };
      },
      listSessions: async () => [session],
      getSession: async () => null,
      getConnectorState: async () => ({ accounts: [], selected: { xhs: "", wechat: "" }, locked: { xhs: {} } }),
      updateBrowserSurface: async () => null,
      onAutomationChanged: () => () => undefined,
      startTurn: async (input: unknown) => {
        startTurnCalls.push(input);
        return { requestId: "909:running", session };
      },
      enqueueSupplement: async (input: unknown) => {
        supplementCalls.push(input);
        return { ok: true };
      },
      cancelTurn: async () => null,
      onAgentEvent: () => () => undefined
    };
  }, { completeConfig, mockPaths });

  await page.goto("/");
  await expect(page.locator(".modelCurrentLabel")).toHaveText("model-a");
  await page.locator(".modelPicker").click();
  await expect(page.locator(".modelMenu")).toBeVisible();
  await page.locator(".modelMenu button", { hasText: "model-b" }).click();
  await expect(page.locator(".modelMenu")).toHaveCount(0);
  await expect(page.locator(".modelCurrentLabel")).toHaveText("model-b");
  await expect.poll(() => page.evaluate(() => (window as Window & { __selectedModels?: string[] }).__selectedModels)).toEqual(["model-b"]);

  await page.getByPlaceholder("尽管问").fill("第一轮");
  await page.getByTitle("发送").click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __startTurnCalls?: Array<{ prompt?: string }> }).__startTurnCalls)).toEqual([
    expect.objectContaining({ prompt: "第一轮" })
  ]);

  await page.locator(".modelPicker").click();
  await page.locator(".modelMenu button", { hasText: "this-is-a-very-long-model-name-for-layout" }).click();
  await expect(page.locator(".modelCurrentLabel")).toHaveText("this-is-a-very-long-model-name-for-layout");
  const labelBox = await page.locator(".modelCurrentLabel").boundingBox();
  expect(labelBox?.width).toBeLessThanOrEqual(212);

  const runningComposer = page.getByPlaceholder("继续提问...");
  await runningComposer.fill("补充消息");
  await runningComposer.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as Window & { __supplementCalls?: Array<{ text?: string; requestId?: string }> }).__supplementCalls)).toEqual([
    expect.objectContaining({ text: "补充消息", requestId: "909:running" })
  ]);
});

test("renderer shows standalone onboarding when provider config is incomplete", async ({ page }) => {
  await page.addInitScript(() => {
    const config = {
      provider: { id: "", baseUrl: "https://api.example.com", apiKey: "sk-existing", model: "" },
      imageProvider: { id: "", name: "", providerType: "", baseUrl: "", apiKey: "", model: "" },
      workspace: { defaultDir: "/tmp/agentstudio-test/workspace" },
      user: { name: "默认用户", avatar: "" }
    };
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: {
          root: "/tmp/agentstudio-test",
          agents: "/tmp/agentstudio-test/agents",
          defaultAgent: "/tmp/agentstudio-test/agents/orchestrator",
          config: "/tmp/agentstudio-test/config.yml",
          settings: "/tmp/agentstudio-test/settings.yml",
          settingsDir: "/tmp/agentstudio-test/settings",
          modelProviders: "/tmp/agentstudio-test/settings/model-providers.yml",
          imageProviders: "/tmp/agentstudio-test/settings/image-providers.yml",
          database: "/tmp/agentstudio-test/agentstudio.sqlite",
          workspace: "/tmp/agentstudio-test/workspace",
          skills: "/tmp/agentstudio-test/agents/orchestrator/skills",
          userResourceSkills: "/tmp/agentstudio-test/user-resources/skills",
          userProfile: "/tmp/agentstudio-test/user-profile"
        },
        config,
        modelProviderSettings: { providers: [] },
        imageProviderSettings: { imageProviders: [] },
        needsOnboarding: true,
        settings: { chat: { permissionMode: "auto" }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } },
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [{ title: "延迟回复测试", prompt: "延迟回复测试" }] },
        workspace: { currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] },
        sessions: []
      }),
      saveProviderConfig: async () => {
        throw new Error("should not save in this test");
      },
      getModelProviderSettings: async () => ({ settings: { providers: [] }, config }),
      getImageProviderSettings: async () => ({ settings: { imageProviders: [] }, config }),
      saveModelProviderSettings: async () => {
        throw new Error("should not save model providers in this test");
      },
      saveImageProviderSettings: async () => {
        throw new Error("should not save image providers in this test");
      },
      listSessions: async () => [],
      getSession: async () => null,
      getWorkspace: async () => null,
      setWorkspace: async () => null,
      chooseWorkspace: async () => null,
      chooseFiles: async () => [],
      readArtifactFile: async () => null,
      updatePermissionMode: async () => null,
      listAgents: async () => [],
      listSkills: async () => [],
      enableSkill: async () => [],
      disableSkill: async () => [],
      listMarketSkills: async () => [],
      getSkillContent: async () => null,
      installGithubSkill: async () => null,
      listAutomationTasks: async () => [],
      getAutomationTask: async () => null,
      createAutomationTask: async () => null,
      updateAutomationTask: async () => null,
      setAutomationTaskEnabled: async () => null,
      deleteAutomationTask: async () => null,
      listAutomationRuns: async () => [],
      getAutomationRunSession: async () => null,
      chooseAutomationWorkspace: async () => null,
      updateBrowserSurface: async () => null,
      onAutomationChanged: () => () => undefined,
      startTurn: async () => null,
      cancelTurn: async () => null,
      onAgentEvent: () => () => undefined
    };
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "连接你的模型服务" })).toBeVisible();
  await expect(page.locator(".shell")).toHaveCount(0);
  await expect(page.getByLabel("Base URL")).toHaveValue("https://api.example.com");
  await expect(page.getByLabel("API Key")).toHaveValue("sk-existing");
  await expect(page.getByLabel("Model")).toHaveValue("");

  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("alert")).toContainText("请完整填写");
  await page.getByRole("button", { name: "跳过" }).click();
  await expect(page.locator(".shell")).toBeVisible();
  await expect(page.getByPlaceholder("尽管问")).toBeVisible();
});

test("renderer saves provider config from onboarding before entering workbench", async ({ page }) => {
  await page.addInitScript(({ completeConfig }) => {
    const savedProviders: unknown[] = [];
    (window as Window & { __savedProviders?: unknown[] }).__savedProviders = savedProviders;
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: {
          root: "/tmp/agentstudio-test",
          agents: "/tmp/agentstudio-test/agents",
          defaultAgent: "/tmp/agentstudio-test/agents/orchestrator",
          config: "/tmp/agentstudio-test/config.yml",
          settings: "/tmp/agentstudio-test/settings.yml",
          settingsDir: "/tmp/agentstudio-test/settings",
          modelProviders: "/tmp/agentstudio-test/settings/model-providers.yml",
          imageProviders: "/tmp/agentstudio-test/settings/image-providers.yml",
          database: "/tmp/agentstudio-test/agentstudio.sqlite",
          workspace: "/tmp/agentstudio-test/workspace",
          skills: "/tmp/agentstudio-test/agents/orchestrator/skills",
          userResourceSkills: "/tmp/agentstudio-test/user-resources/skills",
          userProfile: "/tmp/agentstudio-test/user-profile"
        },
        config: {
          provider: { id: "", baseUrl: "", apiKey: "", model: "" },
          imageProvider: { id: "", name: "", providerType: "", baseUrl: "", apiKey: "", model: "" },
          workspace: { defaultDir: "/tmp/agentstudio-test/workspace" },
          user: { name: "默认用户", avatar: "" }
        },
        needsOnboarding: true,
        modelProviderSettings: { providers: [] },
        imageProviderSettings: { imageProviders: [] },
        settings: { chat: { permissionMode: "auto" }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } },
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [{ title: "延迟回复测试", prompt: "延迟回复测试" }] },
        workspace: { currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] },
        sessions: []
      }),
      saveProviderConfig: async (provider: unknown) => {
        savedProviders.push(provider);
        return {
          config: { ...completeConfig, provider },
          modelProviderSettings: { providers: [] },
          needsOnboarding: false
        };
      },
      getModelProviderSettings: async () => ({ settings: { providers: [] }, config: completeConfig }),
      getImageProviderSettings: async () => ({ settings: { imageProviders: [] }, config: completeConfig }),
      saveModelProviderSettings: async () => ({ settings: { providers: [] }, config: completeConfig, needsOnboarding: false }),
      saveImageProviderSettings: async () => ({ settings: { imageProviders: [] }, config: completeConfig, needsOnboarding: false }),
      listSessions: async () => [],
      getSession: async () => null,
      getWorkspace: async () => null,
      setWorkspace: async () => null,
      chooseWorkspace: async () => null,
      chooseFiles: async () => [],
      readArtifactFile: async () => null,
      updatePermissionMode: async () => null,
      listAgents: async () => [],
      listSkills: async () => [],
      enableSkill: async () => [],
      disableSkill: async () => [],
      listMarketSkills: async () => [],
      getSkillContent: async () => null,
      installGithubSkill: async () => null,
      listAutomationTasks: async () => [],
      getAutomationTask: async () => null,
      createAutomationTask: async () => null,
      updateAutomationTask: async () => null,
      setAutomationTaskEnabled: async () => null,
      deleteAutomationTask: async () => null,
      listAutomationRuns: async () => [],
      getAutomationRunSession: async () => null,
      chooseAutomationWorkspace: async () => null,
      updateBrowserSurface: async () => null,
      onAutomationChanged: () => () => undefined,
      startTurn: async () => null,
      cancelTurn: async () => null,
      onAgentEvent: () => () => undefined
    };
  }, { completeConfig });

  await page.goto("/");
  await page.getByLabel("Base URL").fill(" https://api.anthropic.com ");
  await page.getByLabel("API Key").fill(" sk-ant-test ");
  await page.getByLabel("Model").fill(" claude-sonnet-test ");
  await page.getByRole("button", { name: "保存" }).click();

  await expect(page.locator(".shell")).toBeVisible();
  await expect(page.getByPlaceholder("尽管问")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as Window & { __savedProviders?: unknown[] }).__savedProviders)).toEqual([
    { id: "", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-test", model: "claude-sonnet-test" }
  ]);
});

test("renderer starts XHS login window when creating an account", async ({ page }) => {
  await page.addInitScript(({ completeConfig, mockPaths }) => {
    const calls: Array<{ name: string; input?: unknown }> = [];
    (window as Window & { __xhsCalls?: Array<{ name: string; input?: unknown }>; __resolveXhsWait?: (value: unknown) => void }).__xhsCalls = calls;
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: mockPaths,
        config: completeConfig,
        needsOnboarding: false,
        settings: {
          chat: { permissionMode: "auto" },
          connector: { xhs: { selected_account: "" } },
          workspace: { recentDirectories: [] },
          skills: { installed: {}, disabled: [] }
        },
        modelProviderSettings: { providers: [] },
        imageProviderSettings: { imageProviders: [] },
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [{ title: "新建小红书账号", prompt: "新建小红书账号" }] },
        workspace: { currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] },
        sessions: []
      }),
      saveProviderConfig: async () => ({ config: completeConfig, needsOnboarding: false }),
      getModelProviderSettings: async () => ({ settings: { providers: [] }, config: completeConfig }),
      getImageProviderSettings: async () => ({ settings: { imageProviders: [] }, config: completeConfig }),
      saveModelProviderSettings: async () => ({ settings: { providers: [] }, config: completeConfig, needsOnboarding: false }),
      saveImageProviderSettings: async () => ({ settings: { imageProviders: [] }, config: completeConfig, needsOnboarding: false }),
      listSessions: async () => [],
      getSession: async () => null,
      getWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      setWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      chooseWorkspace: async () => null,
      chooseFiles: async () => [],
      readArtifactFile: async () => null,
      updatePermissionMode: async () => ({ chat: { permissionMode: "auto" }, connector: { xhs: { selected_account: "" } }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } }),
      listAgents: async () => [],
      listSkills: async () => [],
      enableSkill: async () => [],
      disableSkill: async () => [],
      listMarketSkills: async () => [],
      getSkillContent: async () => null,
      installGithubSkill: async () => null,
      listAutomationTasks: async () => [],
      getAutomationTask: async () => null,
      createAutomationTask: async () => null,
      updateAutomationTask: async () => null,
      setAutomationTaskEnabled: async () => null,
      deleteAutomationTask: async () => null,
      listAutomationRuns: async () => [],
      getAutomationRunSession: async () => null,
      chooseAutomationWorkspace: async () => null,
      getConnectorState: async () => ({ accounts: [], selected: { xhs: "" } }),
      createXhsAccount: async () => {
        calls.push({ name: "createXhsAccount" });
        const account = {
          id: 1,
          platform: "xhs",
          profileKey: "xhs_new_profile",
          accountId: null,
          accountHandle: null,
          displayName: null,
          avatarUrl: null,
          status: "authorizing",
          createdAt: "2026-05-31T00:00:00.000Z",
          updatedAt: "2026-05-31T00:00:00.000Z",
          lastAuthorizedAt: null
        };
        return { account, state: { accounts: [account], selected: { xhs: "" } } };
      },
      selectXhsAccount: async () => ({ state: { accounts: [], selected: { xhs: "" } } }),
      deleteXhsAccount: async () => ({ accounts: [], selected: { xhs: "" } }),
      startXhsLogin: async (profileKey?: string) => {
        calls.push({ name: "startXhsLogin", input: profileKey });
        return { success: true };
      },
      waitXhsLogin: async (input?: unknown) => {
        calls.push({ name: "waitXhsLogin", input });
        return await new Promise((resolve) => {
          (window as Window & { __resolveXhsWait?: (value: unknown) => void }).__resolveXhsWait = resolve;
        });
      },
      logoutXhs: async () => null,
      updateBrowserSurface: async (input: unknown) => {
        calls.push({ name: "updateBrowserSurface", input });
        return { ok: true };
      },
      onAutomationChanged: () => () => undefined,
      startTurn: async () => null,
      cancelTurn: async () => null,
      onAgentEvent: () => () => undefined
    };
  }, { completeConfig, mockPaths });

  await page.goto("/");
  await page.getByTitle("连接器").click();
  await page.locator(".connectorMenuItem", { hasText: "小红书" }).hover();
  await page.getByRole("button", { name: /添加账号/ }).click();

  await expect(page.locator(".rightPanel.open")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as Window & { __xhsCalls?: Array<{ name: string; input?: unknown }> }).__xhsCalls)).toEqual(
    expect.arrayContaining([
      { name: "createXhsAccount" },
      { name: "startXhsLogin", input: "xhs_new_profile" },
      { name: "waitXhsLogin", input: { profileKey: "xhs_new_profile", timeout: 120 } }
    ])
  );

  await page.evaluate(() => {
    (window as Window & { __resolveXhsWait?: (value: unknown) => void }).__resolveXhsWait?.({
      state: {
        accounts: [],
        selected: { xhs: "xhs_new_profile" }
      }
    });
  }, { completeConfig, mockPaths });
});

test("renderer restarts XHS login window for authorizing account", async ({ page }) => {
  await page.addInitScript(({ completeConfig, mockPaths }) => {
    const calls: Array<{ name: string; input?: unknown }> = [];
    (window as Window & {
      __xhsCalls?: Array<{ name: string; input?: unknown }>;
      __rejectXhsWait?: (error: Error) => void;
      __resolveXhsWait?: (value: unknown) => void;
    }).__xhsCalls = calls;
    const authorizingAccount = {
      id: 2,
      platform: "xhs",
      profileKey: "xhs_xr45authorizing_profile",
      accountId: null,
      accountHandle: null,
      displayName: null,
      avatarUrl: null,
      status: "authorizing",
      createdAt: "2026-05-31T00:00:00.000Z",
      updatedAt: "2026-05-31T00:00:00.000Z",
      lastAuthorizedAt: null
    };
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: mockPaths,
        config: completeConfig,
        needsOnboarding: false,
        settings: {
          chat: { permissionMode: "auto" },
          connector: { xhs: { selected_account: "" } },
          workspace: { recentDirectories: [] },
          skills: { installed: {}, disabled: [] }
        },
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [{ title: "继续授权小红书账号", prompt: "继续授权小红书账号" }] },
        workspace: { currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] },
        sessions: []
      }),
      saveProviderConfig: async () => ({ config: completeConfig, needsOnboarding: false }),
      listSessions: async () => [],
      getSession: async () => null,
      getWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      setWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      chooseWorkspace: async () => null,
      chooseFiles: async () => [],
      readArtifactFile: async () => null,
      updatePermissionMode: async () => ({ chat: { permissionMode: "auto" }, connector: { xhs: { selected_account: "" } }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } }),
      listAgents: async () => [],
      listSkills: async () => [],
      enableSkill: async () => [],
      disableSkill: async () => [],
      listMarketSkills: async () => [],
      getSkillContent: async () => null,
      installGithubSkill: async () => null,
      listAutomationTasks: async () => [],
      getAutomationTask: async () => null,
      createAutomationTask: async () => null,
      updateAutomationTask: async () => null,
      setAutomationTaskEnabled: async () => null,
      deleteAutomationTask: async () => null,
      listAutomationRuns: async () => [],
      getAutomationRunSession: async () => null,
      chooseAutomationWorkspace: async () => null,
      getConnectorState: async () => ({ accounts: [authorizingAccount], selected: { xhs: "" } }),
      createXhsAccount: async () => ({ account: authorizingAccount, state: { accounts: [authorizingAccount], selected: { xhs: "" } } }),
      selectXhsAccount: async () => ({ state: { accounts: [authorizingAccount], selected: { xhs: "" } } }),
      deleteXhsAccount: async () => ({ accounts: [], selected: { xhs: "" } }),
      startXhsLogin: async (profileKey?: string) => {
        calls.push({ name: "startXhsLogin", input: profileKey });
        return { success: true };
      },
      waitXhsLogin: async (input?: unknown) => {
        calls.push({ name: "waitXhsLogin", input });
        return await new Promise((resolve, reject) => {
          (window as Window & { __resolveXhsWait?: (value: unknown) => void }).__resolveXhsWait = resolve;
          (window as Window & { __rejectXhsWait?: (error: Error) => void }).__rejectXhsWait = (error) => {
            reject(error);
          };
        });
      },
      logoutXhs: async () => null,
      updateBrowserSurface: async (input: unknown) => {
        calls.push({ name: "updateBrowserSurface", input });
        return { ok: true };
      },
      onAutomationChanged: () => () => undefined,
      startTurn: async () => null,
      cancelTurn: async () => null,
      onAgentEvent: () => () => undefined
    };
  }, { completeConfig, mockPaths });

  await page.goto("/");
  await page.getByTitle("连接器").click();
  await page.locator(".connectorMenuItem", { hasText: "小红书" }).hover();
  await expect(page.getByText("xhs_xr45", { exact: true })).toBeVisible();
  await expect(page.getByText("xhs_xr45authorizing_profile", { exact: true })).toHaveCount(0);
  await expect(page.getByText("授权中，点击继续")).toBeVisible();
  await page.locator(".connectorAccountRow", { hasText: "授权中，点击继续" }).getByRole("button").first().click();

  await expect(page.locator(".rightPanel.open")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as Window & { __xhsCalls?: Array<{ name: string; input?: unknown }> }).__xhsCalls)).toEqual(
    expect.arrayContaining([
      { name: "startXhsLogin", input: "xhs_xr45authorizing_profile" },
      { name: "waitXhsLogin", input: { profileKey: "xhs_xr45authorizing_profile", timeout: 120 } }
    ])
  );

  const authorizingButton = page.locator(".connectorAccountRow", { hasText: "授权中，点击继续" }).getByRole("button").first();
  await expect(authorizingButton).toBeEnabled();
  await authorizingButton.click();
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as Window & { __xhsCalls?: Array<{ name: string; input?: unknown }> }).__xhsCalls ?? [];
    return {
      startCount: calls.filter((call) => call.name === "startXhsLogin").length,
      waitCount: calls.filter((call) => call.name === "waitXhsLogin").length
    };
  })).toEqual({ startCount: 2, waitCount: 1 });

  await page.evaluate(() => {
    (window as Window & { __resolveXhsWait?: (value: unknown) => void }).__resolveXhsWait?.({
      success: false,
      cancelled: true,
      state: { accounts: [{
        id: 2,
        platform: "xhs",
        profileKey: "xhs_xr45authorizing_profile",
        accountId: null,
        accountHandle: null,
        displayName: null,
        avatarUrl: null,
        status: "authorizing",
        createdAt: "2026-05-31T00:00:00.000Z",
        updatedAt: "2026-05-31T00:00:00.000Z",
        lastAuthorizedAt: null
      }], selected: { xhs: "" } }
    });
  });
  await expect(page.getByRole("button", { name: /添加账号/ })).toBeEnabled();
  await expect(authorizingButton).toBeEnabled();
  await expect(page.locator(".connectorAccountRow", { hasText: "授权中，点击继续" }).getByTitle("删除账号")).toHaveCount(0);

  await authorizingButton.click();
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as Window & { __xhsCalls?: Array<{ name: string; input?: unknown }> }).__xhsCalls ?? [];
    return {
      startCount: calls.filter((call) => call.name === "startXhsLogin").length,
      waitCount: calls.filter((call) => call.name === "waitXhsLogin").length
    };
  })).toEqual({ startCount: 3, waitCount: 2 });
});

test("renderer keeps XHS account status after login wait is cancelled", async ({ page }) => {
  await page.addInitScript(({ completeConfig, mockPaths }) => {
    const account = {
      id: 22,
      platform: "xhs",
      profileKey: "xhs_needs_refresh_profile",
      accountId: "account-22",
      accountHandle: "needs_refresh_user",
      displayName: "待刷新账号",
      avatarUrl: null,
      status: "needs_refresh",
      createdAt: "2026-05-31T00:00:00.000Z",
      updatedAt: "2026-05-31T00:00:00.000Z",
      lastAuthorizedAt: null
    };
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: mockPaths,
        config: completeConfig,
        needsOnboarding: false,
        settings: { chat: { permissionMode: "auto" }, connector: { xhs: { selected_account: "" } }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } },
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [{ title: "重新授权", prompt: "重新授权" }] },
        workspace: { currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] },
        sessions: []
      }),
      saveProviderConfig: async () => ({ config: completeConfig, needsOnboarding: false }),
      listSessions: async () => [],
      getSession: async () => null,
      getWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      setWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      chooseWorkspace: async () => null,
      chooseFiles: async () => [],
      readArtifactFile: async () => null,
      updatePermissionMode: async () => ({ chat: { permissionMode: "auto" }, connector: { xhs: { selected_account: "" } }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } }),
      listAgents: async () => [],
      listSkills: async () => [],
      enableSkill: async () => [],
      disableSkill: async () => [],
      listMarketSkills: async () => [],
      getSkillContent: async () => null,
      installGithubSkill: async () => null,
      listAutomationTasks: async () => [],
      getAutomationTask: async () => null,
      createAutomationTask: async () => null,
      updateAutomationTask: async () => null,
      setAutomationTaskEnabled: async () => null,
      deleteAutomationTask: async () => null,
      listAutomationRuns: async () => [],
      getAutomationRunSession: async () => null,
      chooseAutomationWorkspace: async () => null,
      getConnectorState: async () => ({ accounts: [account], selected: { xhs: "" } }),
      createXhsAccount: async () => ({ account, state: { accounts: [account], selected: { xhs: "" } } }),
      selectXhsAccount: async () => ({ state: { accounts: [account], selected: { xhs: "" } } }),
      deleteXhsAccount: async () => ({ accounts: [], selected: { xhs: "" } }),
      startXhsLogin: async () => ({ success: true }),
      waitXhsLogin: async () => ({ success: false, cancelled: true, state: { accounts: [account], selected: { xhs: "" } } }),
      logoutXhs: async () => null,
      updateBrowserSurface: async () => ({ ok: true }),
      onAutomationChanged: () => () => undefined,
      startTurn: async () => null,
      cancelTurn: async () => null,
      onAgentEvent: () => () => undefined
    };
  }, { completeConfig, mockPaths });

  await page.goto("/");
  await page.getByTitle("连接器").click();
  await page.locator(".connectorMenuItem", { hasText: "小红书" }).hover();
  await page.locator(".connectorAccountRow", { hasText: "需要重新授权" }).getByRole("button").first().click();
  await expect(page.getByText("需要重新授权")).toBeVisible();
});

test("renderer disables XHS connector panel while current session is running", async ({ page }) => {
  await page.addInitScript(({ completeConfig, mockPaths }) => {
    const account = {
      id: 3,
      platform: "xhs",
      profileKey: "xhs_ready_profile",
      accountId: "account-3",
      accountHandle: "ready_user",
      displayName: "可用账号",
      avatarUrl: null,
      status: "authorized",
      createdAt: "2026-06-03T00:00:00.000Z",
      updatedAt: "2026-06-03T00:00:00.000Z",
      lastAuthorizedAt: "2026-06-03T00:00:00.000Z"
    };
    const session = {
      id: 3030,
      sdkSessionId: null,
      agentName: "orchestrator",
      title: "运行中会话",
      workspacePath: "/tmp/agentstudio-test",
      jsonlPath: null,
      status: "running",
      origin: "manual",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString()
    };
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: mockPaths,
        config: completeConfig,
        needsOnboarding: false,
        settings: { chat: { permissionMode: "auto" }, connector: { xhs: { selected_account: "" } }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } },
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [{ title: "运行中会话", prompt: "运行中会话" }] },
        workspace: { currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] },
        sessions: []
      }),
      saveProviderConfig: async () => ({ config: completeConfig, needsOnboarding: false }),
      listSessions: async () => [],
      getSession: async () => null,
      getWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      setWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      chooseWorkspace: async () => null,
      chooseFiles: async () => [],
      readArtifactFile: async () => null,
      updatePermissionMode: async () => ({ chat: { permissionMode: "auto" }, connector: { xhs: { selected_account: "" } }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } }),
      listAgents: async () => [],
      listSkills: async () => [],
      enableSkill: async () => [],
      disableSkill: async () => [],
      listMarketSkills: async () => [],
      getSkillContent: async () => null,
      installGithubSkill: async () => null,
      listAutomationTasks: async () => [],
      getAutomationTask: async () => null,
      createAutomationTask: async () => null,
      updateAutomationTask: async () => null,
      setAutomationTaskEnabled: async () => null,
      deleteAutomationTask: async () => null,
      listAutomationRuns: async () => [],
      getAutomationRunSession: async () => null,
      chooseAutomationWorkspace: async () => null,
      getConnectorState: async () => ({ accounts: [account], selected: { xhs: "" }, locked: { xhs: {} } }),
      createXhsAccount: async () => {
        throw new Error("should not create while current session runs");
      },
      selectXhsAccount: async () => {
        throw new Error("should not select while current session runs");
      },
      deleteXhsAccount: async () => {
        throw new Error("should not delete while current session runs");
      },
      startXhsLogin: async () => null,
      waitXhsLogin: async () => null,
      logoutXhs: async () => null,
      updateBrowserSurface: async () => null,
      onAutomationChanged: () => () => undefined,
      startTurn: async () => ({ requestId: "3030:running", session }),
      cancelTurn: async () => null,
      onAgentEvent: () => () => undefined
    };
  }, { completeConfig, mockPaths });

  await page.goto("/");
  await page.getByPlaceholder("尽管问").fill("运行中会话");
  await page.getByTitle("发送").click();
  await page.getByTitle("连接器").click();
  const xhsMenuItem = page.locator(".connectorMenuItem", { hasText: "小红书" });
  await xhsMenuItem.hover();

  await expect(xhsMenuItem.locator(".connectorSubmenu")).toHaveClass(/disabled/);
  await expect(xhsMenuItem.getByRole("button", { name: /添加账号/ })).toBeDisabled();
  await expect(page.locator(".connectorAccountRow", { hasText: "可用账号" }).getByRole("button").first()).toBeDisabled();
});

test("renderer disables only locked XHS accounts when current session is idle", async ({ page }) => {
  await page.addInitScript(({ completeConfig, mockPaths }) => {
    const calls: Array<{ name: string; input?: unknown }> = [];
    (window as Window & { __xhsCalls?: Array<{ name: string; input?: unknown }> }).__xhsCalls = calls;
    const lockedAccount = {
      id: 4,
      platform: "xhs",
      profileKey: "xhs_locked_profile",
      accountId: "account-4",
      accountHandle: "locked_user",
      displayName: "锁定账号",
      avatarUrl: null,
      status: "authorized",
      createdAt: "2026-06-03T00:00:00.000Z",
      updatedAt: "2026-06-03T00:00:00.000Z",
      lastAuthorizedAt: "2026-06-03T00:00:00.000Z"
    };
    const unlockedAccount = {
      ...lockedAccount,
      id: 5,
      profileKey: "xhs_unlocked_profile",
      accountId: "account-5",
      accountHandle: "unlocked_user",
      displayName: "可切账号"
    };
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: mockPaths,
        config: completeConfig,
        needsOnboarding: false,
        settings: { chat: { permissionMode: "auto" }, connector: { xhs: { selected_account: "" } }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } },
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [{ title: "账号锁测试", prompt: "账号锁测试" }] },
        workspace: { currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] },
        sessions: []
      }),
      saveProviderConfig: async () => ({ config: completeConfig, needsOnboarding: false }),
      listSessions: async () => [],
      getSession: async () => null,
      getWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      setWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      chooseWorkspace: async () => null,
      chooseFiles: async () => [],
      readArtifactFile: async () => null,
      updatePermissionMode: async () => ({ chat: { permissionMode: "auto" }, connector: { xhs: { selected_account: "" } }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } }),
      listAgents: async () => [],
      listSkills: async () => [],
      enableSkill: async () => [],
      disableSkill: async () => [],
      listMarketSkills: async () => [],
      getSkillContent: async () => null,
      installGithubSkill: async () => null,
      listAutomationTasks: async () => [],
      getAutomationTask: async () => null,
      createAutomationTask: async () => null,
      updateAutomationTask: async () => null,
      setAutomationTaskEnabled: async () => null,
      deleteAutomationTask: async () => null,
      listAutomationRuns: async () => [],
      getAutomationRunSession: async () => null,
      chooseAutomationWorkspace: async () => null,
      getConnectorState: async () => ({ accounts: [lockedAccount, unlockedAccount], selected: { xhs: "" }, locked: { xhs: { xhs_locked_profile: true } } }),
      createXhsAccount: async () => ({ account: unlockedAccount, state: { accounts: [lockedAccount, unlockedAccount], selected: { xhs: "" }, locked: { xhs: { xhs_locked_profile: true } } } }),
      selectXhsAccount: async (profileKey: string) => {
        calls.push({ name: "selectXhsAccount", input: profileKey });
        return { state: { accounts: [lockedAccount, unlockedAccount], selected: { xhs: profileKey }, locked: { xhs: { xhs_locked_profile: true } } } };
      },
      deleteXhsAccount: async () => ({ accounts: [lockedAccount, unlockedAccount], selected: { xhs: "" }, locked: { xhs: { xhs_locked_profile: true } } }),
      startXhsLogin: async () => null,
      waitXhsLogin: async () => null,
      logoutXhs: async () => null,
      updateBrowserSurface: async () => null,
      onAutomationChanged: () => () => undefined,
      startTurn: async () => null,
      cancelTurn: async () => null,
      onAgentEvent: () => () => undefined
    };
  }, { completeConfig, mockPaths });

  await page.goto("/");
  await page.getByTitle("连接器").click();
  await page.locator(".connectorMenuItem", { hasText: "小红书" }).hover();

  const lockedRow = page.locator(".connectorAccountRow", { hasText: "锁定账号" });
  await expect(lockedRow.getByRole("button").first()).toBeDisabled();
  await expect(lockedRow).toHaveAttribute("title", "其他任务正在运行");

  await page.locator(".connectorAccountRow", { hasText: "可切账号" }).getByRole("button").first().click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __xhsCalls?: Array<{ name: string; input?: unknown }> }).__xhsCalls)).toEqual([
    { name: "selectXhsAccount", input: "xhs_unlocked_profile" }
  ]);
});

test("composer ignores Enter while IME composition is active", async ({ page }) => {
  await page.addInitScript(({ completeConfig, mockPaths }) => {
    const turns: unknown[] = [];
    (window as Window & { __turns?: unknown[] }).__turns = turns;
    const session = {
      id: 202,
      sdkSessionId: null,
      agentName: "orchestrator",
      title: "输入法测试",
      workspacePath: "/tmp/agentstudio-test",
      jsonlPath: null,
      status: "running",
      origin: "manual",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString()
    };
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: mockPaths,
        config: completeConfig,
        needsOnboarding: false,
        settings: { chat: { permissionMode: "auto" }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } },
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [{ title: "输入法测试", prompt: "输入法测试" }] },
        workspace: { currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] },
        sessions: []
      }),
      saveProviderConfig: async () => ({ config: completeConfig, needsOnboarding: false }),
      listSessions: async () => [],
      getSession: async () => ({ session: { ...session, status: "completed", sdkSessionId: "sdk-test" }, messages: [] }),
      getWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      setWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      chooseWorkspace: async () => null,
      chooseFiles: async () => [],
      readArtifactFile: async () => null,
      updatePermissionMode: async () => ({ chat: { permissionMode: "auto" }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } }),
      listAgents: async () => [],
      listSkills: async () => [],
      enableSkill: async () => [],
      disableSkill: async () => [],
      listMarketSkills: async () => [],
      getSkillContent: async () => null,
      installGithubSkill: async () => null,
      listAutomationTasks: async () => [],
      getAutomationTask: async () => null,
      createAutomationTask: async () => null,
      updateAutomationTask: async () => null,
      setAutomationTaskEnabled: async () => null,
      deleteAutomationTask: async () => null,
      listAutomationRuns: async () => [],
      getAutomationRunSession: async () => null,
      chooseAutomationWorkspace: async () => null,
      updateBrowserSurface: async () => null,
      onAutomationChanged: () => () => undefined,
      startTurn: async (input: unknown) => {
        turns.push(input);
        return { requestId: "202:ime", session };
      },
      cancelTurn: async () => null,
      onAgentEvent: () => () => undefined
    };
  }, { completeConfig, mockPaths });

  await page.goto("/");
  const composer = page.getByPlaceholder("尽管问");
  await composer.fill("输入法测试");
  await composer.dispatchEvent("compositionstart", { data: "shu ru fa" });
  await composer.dispatchEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, isComposing: true });

  await expect.poll(() => page.evaluate(() => (window as Window & { __turns?: unknown[] }).__turns?.length)).toBe(0);
  await expect(composer).toHaveValue("输入法测试");

  await composer.dispatchEvent("compositionend", { data: "输入法测试" });
  await composer.press("Enter");

  await expect.poll(() => page.evaluate(() => (window as Window & { __turns?: Array<{ prompt?: string }> }).__turns)).toEqual([
    expect.objectContaining({ prompt: "输入法测试" })
  ]);
});

test("renderer renders assistant markdown without exposing raw markdown or html", async ({ page }) => {
  await page.addInitScript(({ completeConfig, mockPaths }) => {
    const session = {
      id: 304,
      sdkSessionId: "sdk-markdown",
      agentName: "orchestrator",
      title: "Markdown 渲染测试",
      workspacePath: "/tmp/agentstudio-test",
      jsonlPath: null,
      status: "completed",
      origin: "manual",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString()
    };
    const messages = [
      { kind: "text", id: "user-markdown", role: "user", text: "# 用户原文 **不渲染**" },
      {
        kind: "assistantTurn",
        id: "assistant-markdown",
        blocks: [{
          kind: "text",
          id: "assistant-markdown-text",
          text: "# 一级标题\n\n这是一段 **加粗** 和 `code`。\n\n- 第一项\n- 第二项\n\n```js\n<script>alert(1)</script>\n```"
        }]
      }
    ];
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: mockPaths,
        config: completeConfig,
        needsOnboarding: false,
        settings: { chat: { permissionMode: "auto" }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } },
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [{ title: "Markdown 渲染测试", prompt: "Markdown 渲染测试" }] },
        workspace: { currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] },
        sessions: [session]
      }),
      saveProviderConfig: async () => ({ config: completeConfig, needsOnboarding: false }),
      listSessions: async () => [session],
      getSession: async () => ({ session, messages }),
      getWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      setWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      chooseWorkspace: async () => null,
      chooseFiles: async () => [],
      readArtifactFile: async () => null,
      updatePermissionMode: async () => ({ chat: { permissionMode: "auto" }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } }),
      listAgents: async () => [],
      listSkills: async () => [],
      enableSkill: async () => [],
      disableSkill: async () => [],
      listMarketSkills: async () => [],
      getSkillContent: async () => null,
      installGithubSkill: async () => null,
      listAutomationTasks: async () => [],
      getAutomationTask: async () => null,
      createAutomationTask: async () => null,
      updateAutomationTask: async () => null,
      setAutomationTaskEnabled: async () => null,
      deleteAutomationTask: async () => null,
      listAutomationRuns: async () => [],
      getAutomationRunSession: async () => null,
      chooseAutomationWorkspace: async () => null,
      updateBrowserSurface: async () => ({ ok: true }),
      onAutomationChanged: () => () => undefined,
      startTurn: async () => null,
      cancelTurn: async () => null,
      onAgentEvent: () => () => undefined
    };
  }, { completeConfig, mockPaths });

  await page.goto("/");
  await page.locator(".sessionItem", { hasText: "Markdown 渲染测试" }).click();

  await expect(page.locator(".message.assistant h1", { hasText: "一级标题" })).toBeVisible();
  await expect(page.locator(".message.assistant strong", { hasText: "加粗" })).toBeVisible();
  await expect(page.locator(".message.assistant li", { hasText: "第一项" })).toBeVisible();
  await expect(page.locator(".message.assistant code", { hasText: "<script>alert(1)</script>" })).toBeVisible();
  await expect(page.locator(".message.assistant script")).toHaveCount(0);
  await expect(page.locator(".message.user .messageBubble")).toHaveText("# 用户原文 **不渲染**");
});

test("renderer keeps thinking and tool details collapsed with lightweight summaries", async ({ page }) => {
  await page.addInitScript(({ completeConfig, mockPaths }) => {
    const session = {
      id: 404,
      sdkSessionId: "sdk-collapse",
      agentName: "orchestrator",
      title: "折叠态测试",
      workspacePath: "/tmp/agentstudio-test",
      jsonlPath: null,
      status: "completed",
      origin: "manual",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString()
    };
    const messages = [
      { kind: "text", id: "user-collapse", role: "user", text: "检查折叠态" },
      {
        kind: "assistantTurn",
        id: "assistant-collapse",
        blocks: [
          { kind: "thinking", id: "thinking-collapse", text: "这里是模型的详细思考内容" },
          {
            kind: "toolGroup",
            id: "tool-collapse",
            tools: [{
              id: "tool-collapse-1",
              toolUseId: "tool-collapse-1",
              name: "Read",
              input: { file_path: "/tmp/example.md" },
              result: "读取完成",
              status: "completed",
              durationMs: 128
            }]
          }
        ]
      }
    ];
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: mockPaths,
        config: completeConfig,
        needsOnboarding: false,
        modelProviderSettings: { providers: [] },
        imageProviderSettings: { imageProviders: [] },
        settings: { chat: { permissionMode: "auto" }, connector: { xhs: { selected_account: "" }, wechat: { selected_account: "" } }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } },
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [{ title: "折叠态测试", prompt: "折叠态测试" }] },
        workspace: { currentPath: mockPaths.workspace, defaultPath: mockPaths.workspace, recentDirectories: [] },
        sessions: [session]
      }),
      listSessions: async () => [session],
      getSession: async () => ({ session, messages }),
      getConnectorState: async () => ({ accounts: [], selected: { xhs: "", wechat: "" }, locked: { xhs: {} } }),
      updateBrowserSurface: async () => null,
      onAutomationChanged: () => () => undefined,
      startTurn: async () => null,
      cancelTurn: async () => null,
      onAgentEvent: () => () => undefined
    };
  }, { completeConfig, mockPaths });

  await page.goto("/");
  await page.locator(".sessionItem", { hasText: "折叠态测试" }).click();

  const thinkingGroup = page.locator("details.thinkingGroup");
  const toolGroup = page.locator("details.toolGroup");
  await expect(thinkingGroup.locator("summary")).toContainText("模型思考");
  await expect(toolGroup.locator("summary")).toContainText("工具调用");
  await expect(toolGroup.locator("summary")).toContainText("1/1 已完成");
  await expect(thinkingGroup).toHaveJSProperty("open", false);
  await expect(toolGroup).toHaveJSProperty("open", false);
  await expect(page.getByText("这里是模型的详细思考内容")).toBeHidden();
  await expect(page.getByText("读取完成")).toBeHidden();

  await expect(thinkingGroup.locator("summary")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(thinkingGroup.locator("summary")).toHaveCSS("box-shadow", "none");
  await expect(toolGroup.locator("summary")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(toolGroup.locator("summary")).toHaveCSS("box-shadow", "none");

  await thinkingGroup.locator("summary").click();
  await expect(thinkingGroup).toHaveJSProperty("open", true);
  await expect(page.getByText("这里是模型的详细思考内容")).toBeVisible();
  await thinkingGroup.locator("summary").click();
  await expect(thinkingGroup).toHaveJSProperty("open", false);

  await toolGroup.locator("summary").click();
  await expect(toolGroup).toHaveJSProperty("open", true);
  await expect(page.locator(".toolItem", { hasText: "Read" })).toBeVisible();
  await expect(page.locator(".toolItem", { hasText: "Read" })).toContainText("Read · 128ms");
  await expect(page.getByText("读取完成")).toBeVisible();
});

test("renderer computes and shows duration for live tool events", async ({ page }) => {
  await page.addInitScript(({ completeConfig, mockPaths }) => {
    const eventListeners: Array<(event: unknown) => void> = [];
    const session = {
      id: 505,
      sdkSessionId: "sdk-live-tool-duration",
      agentName: "orchestrator",
      title: "实时工具耗时",
      workspacePath: "/tmp/agentstudio-test",
      jsonlPath: null,
      status: "running",
      origin: "manual",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString()
    };
    (window as Window & { __emitAgentEvent?: (event: unknown) => void }).__emitAgentEvent = (event: unknown) => {
      for (const listener of eventListeners) listener(event);
    };
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: mockPaths,
        config: completeConfig,
        needsOnboarding: false,
        modelProviderSettings: { providers: [] },
        imageProviderSettings: { imageProviders: [] },
        settings: { chat: { permissionMode: "auto" }, connector: { xhs: { selected_account: "" }, wechat: { selected_account: "" } }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } },
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [{ title: "实时工具耗时", prompt: "实时工具耗时" }] },
        workspace: { currentPath: mockPaths.workspace, defaultPath: mockPaths.workspace, recentDirectories: [] },
        sessions: [session]
      }),
      listSessions: async () => [session],
      getSession: async () => ({ session, messages: [], runningRequestId: "505:live" }),
      getConnectorState: async () => ({ accounts: [], selected: { xhs: "", wechat: "" }, locked: { xhs: {} } }),
      updateBrowserSurface: async () => null,
      onAutomationChanged: () => () => undefined,
      startTurn: async () => null,
      cancelTurn: async () => null,
      onAgentEvent: (callback: (event: unknown) => void) => {
        eventListeners.push(callback);
        return () => undefined;
      }
    };
  }, { completeConfig, mockPaths });

  await page.goto("/");
  await page.locator(".sessionItem", { hasText: "实时工具耗时" }).click();
  await page.evaluate(() => (window as Window & { __emitAgentEvent?: (event: unknown) => void }).__emitAgentEvent?.({
    type: "tool",
    requestId: "505:live",
    sessionId: 505,
    toolUseId: "live-tool-1",
    name: "browser_open",
    input: { url: "https://example.com" },
    status: "pending",
    startedAt: "2026-06-24T03:00:00.000Z"
  }));

  await page.locator("details.toolGroup summary").click();
  await expect(page.locator(".toolItem", { hasText: "browser_open" })).toBeVisible();
  await expect(page.locator(".toolItem", { hasText: "browser_open" })).not.toContainText(" · ");

  await page.evaluate(() => (window as Window & { __emitAgentEvent?: (event: unknown) => void }).__emitAgentEvent?.({
    type: "tool",
    requestId: "505:live",
    sessionId: 505,
    toolUseId: "live-tool-1",
    name: "工具调用",
    result: "打开完成",
    status: "completed",
    completedAt: "2026-06-24T03:00:01.500Z"
  }));

  await expect(page.locator(".toolItem", { hasText: "browser_open" })).toContainText("browser_open · 1.5s");
  await expect(page.locator(".toolItem", { hasText: "browser_open" })).toContainText("打开完成");
});

test("renderer anchors artifact cards only for frontend write tools", async ({ page }) => {
  await page.addInitScript(({ completeConfig, mockPaths }) => {
    const surfaceCalls: unknown[] = [];
    (window as Window & { __artifactSurfaceCalls?: unknown[] }).__artifactSurfaceCalls = surfaceCalls;
    const session = {
      id: 303,
      sdkSessionId: "sdk-artifacts",
      agentName: "orchestrator",
      title: "产物位置测试",
      workspacePath: "/tmp/agentstudio-test",
      jsonlPath: null,
      status: "completed",
      origin: "manual",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString()
    };
    const messages = [
      { kind: "text", id: "user-artifacts", role: "user", text: "生成两个文件" },
      {
        kind: "assistantTurn",
        id: "assistant-artifacts",
        blocks: [
          {
            kind: "toolGroup",
            id: "tool-block-first",
            tools: [{
              id: "tool-1",
              toolUseId: "tool-1",
              name: "Write",
              input: { file_path: "/tmp/agentstudio-test/first.md", content: "# First" },
              result: "created",
              status: "completed"
            }]
          },
          {
            kind: "toolGroup",
            id: "tool-block-second",
            tools: [{
              id: "tool-2",
              toolUseId: "tool-2",
              name: "browser_fetch",
              input: { url: "https://example.com" },
              result: { markdownPath: "/tmp/agentstudio-test/fetched.md" },
              status: "completed"
            }]
          },
          {
            kind: "toolGroup",
            id: "tool-block-third",
            tools: [{
              id: "tool-3",
              toolUseId: "tool-3",
              name: "content_run_document_write",
              input: { runId: "202606160001", document: "final", markdown: "# Final" },
              result: { ok: true, accountRoot: "/tmp/agentstudio-test/user-data/xhs/demo", runId: "202606160001", document: "final" },
              status: "completed"
            }]
          },
          {
            kind: "toolGroup",
            id: "tool-block-fourth",
            tools: [{
              id: "tool-4",
              toolUseId: "tool-4",
              name: "MultiEdit",
              input: { filePath: "/tmp/agentstudio-test/final.html", edits: [] },
              result: "updated",
              status: "completed"
            }]
          },
          { kind: "text", id: "text-block-final", text: "最终文件 /tmp/agentstudio-test/text-only.html" }
        ]
      }
    ];
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: mockPaths,
        config: completeConfig,
        needsOnboarding: false,
        settings: { chat: { permissionMode: "auto" }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } },
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [{ title: "产物位置测试", prompt: "产物位置测试" }] },
        workspace: { currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] },
        sessions: [session]
      }),
      saveProviderConfig: async () => ({ config: completeConfig, needsOnboarding: false }),
      listSessions: async () => [session],
      getSession: async () => ({ session, messages }),
      getWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      setWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      chooseWorkspace: async () => null,
      chooseFiles: async () => [],
      readArtifactFile: async (input: { filePath: string }) => ({
        path: input.filePath,
        name: input.filePath.split("/").at(-1) ?? "artifact.md",
        kind: input.filePath.endsWith(".html") ? "html" : "markdown",
        content: input.filePath.endsWith(".html") ? "<h1>HTML Preview</h1>" : "# Markdown Preview"
      }),
      updatePermissionMode: async () => ({ chat: { permissionMode: "auto" }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } }),
      listAgents: async () => [],
      listSkills: async () => [],
      enableSkill: async () => [],
      disableSkill: async () => [],
      listMarketSkills: async () => [],
      getSkillContent: async () => null,
      installGithubSkill: async () => null,
      listAutomationTasks: async () => [],
      getAutomationTask: async () => null,
      createAutomationTask: async () => null,
      updateAutomationTask: async () => null,
      setAutomationTaskEnabled: async () => null,
      deleteAutomationTask: async () => null,
      listAutomationRuns: async () => [],
      getAutomationRunSession: async () => null,
      chooseAutomationWorkspace: async () => null,
      updateBrowserSurface: async (input: unknown) => {
        surfaceCalls.push(input);
        return { ok: true };
      },
      onAutomationChanged: () => () => undefined,
      startTurn: async () => null,
      cancelTurn: async () => null,
      onAgentEvent: () => () => undefined
    };
  }, { completeConfig, mockPaths });

  await page.goto("/");
  await page.locator(".sessionItem", { hasText: "产物位置测试" }).click();
  await expect(page.getByRole("button", { name: "first.md Markdown" })).toBeVisible();
  await expect(page.getByRole("button", { name: "final.html HTML" })).toBeVisible();
  await expect(page.getByRole("button", { name: "fetched.md Markdown" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "text-only.html HTML" })).toHaveCount(0);

  await expect.poll(() => page.locator(".assistantBlocks > .assistantBlock").evaluateAll((blocks) => blocks.map((block) => ({
    hasArtifact: Boolean(block.querySelector(".artifactStrip")),
    text: block.textContent ?? ""
  })))).toEqual([
    expect.objectContaining({ hasArtifact: true, text: expect.stringContaining("first.md") }),
    expect.objectContaining({ hasArtifact: false, text: expect.stringContaining("browser_fetch") }),
    expect.objectContaining({ hasArtifact: false, text: expect.stringContaining("content_run_document_write") }),
    expect.objectContaining({ hasArtifact: true, text: expect.stringContaining("final.html") }),
    expect.objectContaining({ hasArtifact: false, text: expect.stringContaining("text-only.html") })
  ]);

  await page.getByRole("button", { name: "first.md Markdown" }).click();
  await expect(page.locator(".rightPanel.open")).toHaveCount(1);
  await expect(page.getByText("Markdown Preview")).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const calls = (window as Window & { __artifactSurfaceCalls?: Array<{ visible?: boolean }> }).__artifactSurfaceCalls ?? [];
    return calls.some((call) => call.visible === true);
  })).toBe(false);
});

test("renderer shows mock thinking until first real agent content", async ({ page }) => {
  await page.addInitScript(({ completeConfig, mockPaths }) => {
    const listeners: Array<(event: unknown) => void> = [];
    const session = {
      id: 101,
      sdkSessionId: null,
      agentName: "orchestrator",
      title: "延迟回复测试",
      workspacePath: "/tmp/agentstudio-test",
      jsonlPath: null,
      status: "running",
      origin: "manual",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString()
    };
    // @ts-ignore Browser smoke test provides the Electron preload surface.
    window.agentStudio = {
      bootstrap: async () => ({
        paths: mockPaths,
        config: completeConfig,
        needsOnboarding: false,
        settings: { chat: { permissionMode: "auto" }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } },
        workbenchPrompts: { typingPrompts: ["我是小G"], quickPrompts: [{ title: "延迟回复测试", prompt: "延迟回复测试" }] },
        workspace: { currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] },
        sessions: []
      }),
      saveProviderConfig: async () => ({ config: completeConfig, needsOnboarding: false }),
      listSessions: async () => [],
      getSession: async () => ({ session: { ...session, status: "completed", sdkSessionId: "sdk-test" }, messages: [] }),
      getWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      setWorkspace: async () => ({ currentPath: "/tmp/agentstudio-test/workspace", defaultPath: "/tmp/agentstudio-test/workspace", recentDirectories: [] }),
      chooseWorkspace: async () => null,
      chooseFiles: async () => [],
      readArtifactFile: async () => null,
      updatePermissionMode: async () => ({ chat: { permissionMode: "auto" }, workspace: { recentDirectories: [] }, skills: { installed: {}, disabled: [] } }),
      listAgents: async () => [],
      listSkills: async () => [],
      enableSkill: async () => [],
      disableSkill: async () => [],
      listMarketSkills: async () => [],
      getSkillContent: async () => null,
      installGithubSkill: async () => null,
      listAutomationTasks: async () => [],
      getAutomationTask: async () => null,
      createAutomationTask: async () => null,
      updateAutomationTask: async () => null,
      setAutomationTaskEnabled: async () => null,
      deleteAutomationTask: async () => null,
      listAutomationRuns: async () => [],
      getAutomationRunSession: async () => null,
      chooseAutomationWorkspace: async () => null,
      updateBrowserSurface: async () => null,
      onAutomationChanged: () => () => undefined,
      startTurn: async () => {
        window.setTimeout(() => {
          for (const listener of listeners) listener({ type: "partial", requestId: "101:mock", sessionId: 101, text: "真实回复" });
        }, 1800);
        window.setTimeout(() => {
          for (const listener of listeners) listener({ type: "message", requestId: "101:mock", sessionId: 101, role: "system", text: "隐藏系统提示" });
        }, 2000);
        return { requestId: "101:mock", session };
      },
      cancelTurn: async () => null,
      onAgentEvent: (callback: (event: unknown) => void) => {
        listeners.push(callback);
        return () => {
          const index = listeners.indexOf(callback);
          if (index >= 0) listeners.splice(index, 1);
        };
      }
    };
  }, { completeConfig, mockPaths });

  await page.goto("/");
  await page.getByPlaceholder("尽管问").fill("延迟回复测试");
  await page.getByTitle("发送").click();

  await expect(page.locator(".mockThinkingLine")).toBeVisible({ timeout: 1500 });
  await expect(page.locator(".mockThinkingLine .thinkingDots")).toBeVisible();
  await expect(page.getByText("模型思考")).toBeHidden();
  await expect(page.locator(".mockThinkingLine")).toBeHidden({ timeout: 2500 });
  await expect(page.locator(".message.assistant .messageBubble", { hasText: "真实回复" })).toBeVisible();
  await expect(page.getByText("隐藏系统提示")).toBeHidden();
});
