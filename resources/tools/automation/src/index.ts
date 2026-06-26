import { randomUUID } from "node:crypto";
import { createSdkMcpServer, tool } from "../../runtime";
import { z } from "zod/v4";

type Operation = "list" | "get" | "create" | "pause" | "resume" | "delete";
type Response = { rpcId: string; ok: boolean; result?: unknown; error?: string };
type ToolServerContext = { requestId?: string };

export function createServer(context?: ToolServerContext) {
  const requestId = context?.requestId;
  return createSdkMcpServer({
    name: "automation",
    tools: [
      tool("automation_task_list", "查询全部自动化定时任务，不查询执行记录。", {}, async () => invoke(requestId, "list"), readAnnotations("定时任务 自动化 查询 列表")),
      tool("automation_task_get", "按稳定 task ID 查询单个自动化定时任务。", { id: z.number().int().min(1) }, async (args) => invoke(requestId, "get", args), readAnnotations("定时任务 自动化 查询 详情")),
      tool(
        "automation_task_create",
        "创建自动化定时任务。工作空间和账号自动继承当前 Agent Run；Skill 和附件仅使用显式传入的引用。",
        {
          name: z.string().min(1),
          description: z.string().min(1),
          scheduleType: z.enum(["once", "interval", "hourly", "daily", "weekday", "weekly", "monthly"]),
          runAt: z.string().optional(),
          intervalValue: z.number().int().min(1).optional(),
          intervalUnit: z.enum(["minute", "hour", "day"]).optional(),
          minute: z.number().int().min(0).max(59).optional(),
          hour: z.number().int().min(0).max(23).optional(),
          weekdays: z.array(z.number().int().min(1).max(7)).optional(),
          monthDays: z.array(z.number().int().min(1).max(31)).optional(),
          maxRetries: z.number().int().min(0).max(20).optional(),
          maxRuns: z.number().int().min(1).nullable().optional(),
          selectedSkills: z.array(z.string().min(1)).optional(),
          attachmentPaths: z.array(z.string().min(1)).optional()
        },
        async (args) => invoke(requestId, "create", args),
        writeAnnotations("定时任务 自动化 创建")
      ),
      tool("automation_task_pause", "按稳定 task ID 暂停自动化定时任务，仅阻止后续计划触发。", { id: z.number().int().min(1) }, async (args) => invoke(requestId, "pause", args), stateAnnotations("定时任务 自动化 暂停")),
      tool("automation_task_resume", "按稳定 task ID 重新开启自动化定时任务，并从当前时间重新计算下次执行时间。", { id: z.number().int().min(1) }, async (args) => invoke(requestId, "resume", args), stateAnnotations("定时任务 自动化 重新开启")),
      tool("automation_task_delete", "按稳定 task ID 删除自动化定时任务，保留已有执行记录。", { id: z.number().int().min(1) }, async (args) => invoke(requestId, "delete", args), deleteAnnotations("定时任务 自动化 删除"))
    ]
  });
}

async function invoke(requestId: string | undefined, operation: Operation, input?: unknown) {
  try {
    return jsonResult(await callMain(requestId, operation, input));
  } catch (error) {
    return jsonResult({ ok: false, error: error instanceof Error ? error.message : String(error) }, true);
  }
}

function callMain(requestId: string | undefined, operation: Operation, input?: unknown): Promise<unknown> {
  const parentPort = (process as NodeJS.Process & { parentPort?: { postMessage: (message: unknown) => void } }).parentPort;
  if (!requestId || !parentPort) throw new Error("Automation tool is unavailable outside a GrowthForce run");
  const rpcId = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      process.off("agentstudio:automationToolResponse", listener);
      reject(new Error("Automation tool request timed out"));
    }, 30_000);
    const listener = (response: Response) => {
      if (response.rpcId !== rpcId) return;
      clearTimeout(timeout);
      process.off("agentstudio:automationToolResponse", listener);
      if (response.ok) resolve(response.result);
      else reject(new Error(response.error || "Automation tool request failed"));
    };
    process.on("agentstudio:automationToolResponse", listener);
    parentPort.postMessage({ type: "automationToolRequest", payload: { rpcId, requestId, operation, input } });
  });
}

function jsonResult(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], isError };
}

function readAnnotations(searchHint: string) {
  return { searchHint, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
}

function writeAnnotations(searchHint: string) {
  return { searchHint, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } };
}

function stateAnnotations(searchHint: string) {
  return { searchHint, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
}

function deleteAnnotations(searchHint: string) {
  return { searchHint, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } };
}
