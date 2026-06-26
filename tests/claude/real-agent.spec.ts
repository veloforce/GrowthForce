import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

interface StartTurnResult {
  requestId: string;
  session: { id: number; sdkSessionId: string | null };
}

test.describe.serial("real Claude agent flows", () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    assertClaudeConfig();
    app = await electron.launch({
      args: [path.resolve(__dirname, "../..")],
      env: {
        ...process.env,
        VITE_DEV_SERVER_URL: ""
      }
    });
    page = await app.firstWindow();
    await expect(page.getByText("小G")).toBeVisible();
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("streams, resumes context, and replays JSONL history", async () => {
    const token = `AGENTSTUDIO_E2E_${Date.now()}`;

    const first = await runTurn(page, {
      prompt: `Remember this exact token: ${token}. Reply exactly: STORED ${token}`
    });
    expect(first.text).toContain(token);
    expect(first.sawPartial || first.text.length > 0).toBeTruthy();
    expect(first.session.sdkSessionId).toBeTruthy();

    const second = await runTurn(page, {
      sessionId: first.session.id,
      prompt: "What exact token did I ask you to remember? Reply with only that token."
    });
    expect(second.text).toContain(token);
    expect(second.session.id).toBe(first.session.id);

    const detail = await page.evaluate(async (sessionId) => window.agentStudio.getSession(sessionId), first.session.id);
    const historyText = JSON.stringify(detail);
    expect(historyText).toContain(token);
  });

  test("cancels an in-flight request", async () => {
    const result = await page.evaluate(async () => {
      const events: Array<{ type: string; message?: string }> = [];
      const off = window.agentStudio.onAgentEvent((event) => {
        events.push({ type: event.type, message: "message" in event ? String(event.message) : undefined });
      });
      const started = await window.agentStudio.startTurn({
        prompt: "Count from 1 to 1000. Put each number on a new line and do not stop early."
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await window.agentStudio.cancelTurn(started.requestId);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      off();
      return { started, events };
    });

    expect(result.started.requestId).toBeTruthy();
    expect(result.events.some((event) => event.type === "error" && String(event.message).includes("任务已取消"))).toBeTruthy();
  });

  test("runs independent requests concurrently", async () => {
    const markerA = `CONCURRENT_A_${Date.now()}`;
    const markerB = `CONCURRENT_B_${Date.now()}`;
    const result = await page.evaluate(
      async ({ markerA, markerB }) => {
        const output = new Map<string, string>();
        const done = new Set<string>();
        const errors: string[] = [];
        const off = window.agentStudio.onAgentEvent((event) => {
          if (event.type === "message" || event.type === "partial") {
            output.set(event.requestId, `${output.get(event.requestId) ?? ""}${event.text}`);
          }
          if (event.type === "done") done.add(event.requestId);
          if (event.type === "error") {
            done.add(event.requestId);
            errors.push(event.message);
          }
        });

        const [first, second] = await Promise.all([
          window.agentStudio.startTurn({ prompt: `Reply exactly: ${markerA}` }),
          window.agentStudio.startTurn({ prompt: `Reply exactly: ${markerB}` })
        ]);

        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline && (!done.has(first.requestId) || !done.has(second.requestId))) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        off();

        return {
          first,
          second,
          firstText: output.get(first.requestId) ?? "",
          secondText: output.get(second.requestId) ?? "",
          errors
        };
      },
      { markerA, markerB }
    );

    expect(result.errors).toEqual([]);
    expect(result.firstText).toContain(markerA);
    expect(result.secondText).toContain(markerB);
    expect(result.first.session.id).not.toBe(result.second.session.id);
  });
});

async function runTurn(page: Page, input: { prompt: string; sessionId?: number }) {
  return page.evaluate(async ({ prompt, sessionId }) => {
    let started: StartTurnResult | null = null;
    let text = "";
    let sawPartial = false;
    const errors: string[] = [];

    const off = window.agentStudio.onAgentEvent((event) => {
      if (!started || event.requestId !== started.requestId) return;
      if (event.type === "partial") {
        sawPartial = true;
        text += event.text;
      }
      if (event.type === "message") text += event.text;
      if (event.type === "error") errors.push(event.message);
    });

    started = await window.agentStudio.startTurn({ prompt, sessionId });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (errors.length > 0) break;
      const session = (await window.agentStudio.getSession(started.session.id))?.session;
      if (session?.status === "completed" || session?.status === "failed" || session?.status === "cancelled") {
        started.session = session;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    off();

    if (errors.length > 0) throw new Error(errors.join("\n"));
    return { ...started, text, sawPartial };
  }, input);
}

function assertClaudeConfig(): void {
  const configPath = path.join(os.homedir(), ".agentstudio", "config.yml");
  const config = yaml.load(fs.readFileSync(configPath, "utf8")) as {
    provider?: { apiKey?: string; model?: string; baseUrl?: string };
  };
  if (!config.provider?.apiKey || !config.provider?.model) {
    throw new Error("test:claude requires provider.apiKey and provider.model in ~/.agentstudio/config.yml");
  }
}
