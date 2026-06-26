import { randomUUID } from "node:crypto";
import { createSdkMcpServer, tool } from "../../runtime";
import { z } from "zod/v4";

type Response = { rpcId: string; ok: boolean; result?: unknown; error?: string };
type ToolServerContext = { requestId?: string };
type Reason = "not_logged_in" | "account_mismatch";

export function createServer(context?: ToolServerContext) {
  const requestId = context?.requestId;
  return createSdkMcpServer({
    name: "connector_ops",
    tools: [
      tool(
        "xhs_account_mark_needs_refresh",
        "仅在 check-session 明确返回 guest=true 或明确读到其他 account_id 时调用。将当前 Run 绑定的小红书账号标记为需要重新授权；不要用于 timeout、CDP 错误或页面读取失败。",
        {
          reason: z.enum(["not_logged_in", "account_mismatch"]),
          actual_account_id: z.string().min(1).optional()
        },
        async (args) => invoke(requestId, args.reason, args.actual_account_id),
        {
          searchHint: "小红书 登录失效 账号串号 重新授权",
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
          }
        }
      )
    ]
  });
}

async function invoke(requestId: string | undefined, reason: Reason, actualAccountId?: string) {
  try {
    return jsonResult(await callMain(requestId, reason, actualAccountId));
  } catch (error) {
    return jsonResult({ ok: false, error: error instanceof Error ? error.message : String(error) }, true);
  }
}

function callMain(requestId: string | undefined, reason: Reason, actualAccountId?: string): Promise<unknown> {
  const parentPort = (process as NodeJS.Process & { parentPort?: { postMessage: (message: unknown) => void } }).parentPort;
  if (!requestId || !parentPort) throw new Error("连接器状态工具只能在 GrowthForce Run 中使用");
  if (reason === "account_mismatch" && !actualAccountId?.trim()) {
    throw new Error("账号串号时必须传入 check-session 返回的 actual_account_id");
  }
  const rpcId = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      process.off("agentstudio:connectorToolResponse", listener);
      reject(new Error("连接器状态更新超时"));
    }, 30_000);
    const listener = (response: Response) => {
      if (response.rpcId !== rpcId) return;
      clearTimeout(timeout);
      process.off("agentstudio:connectorToolResponse", listener);
      if (response.ok) resolve(response.result);
      else reject(new Error(response.error || "连接器状态更新失败"));
    };
    process.on("agentstudio:connectorToolResponse", listener);
    parentPort.postMessage({
      type: "connectorToolRequest",
      payload: {
        rpcId,
        requestId,
        operation: "xhs_account_mark_needs_refresh",
        input: { reason, actualAccountId: actualAccountId?.trim() || undefined }
      }
    });
  });
}

function jsonResult(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], isError };
}
