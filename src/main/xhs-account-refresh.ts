import type { AgentRunRequest, ConnectorAccount, XhsAccountRefreshReason } from "../shared/types";

export type XhsAccountRefreshInput = {
  reason: XhsAccountRefreshReason;
  actualAccountId?: string;
};

export type XhsAccountRefreshDependencies = {
  getAccount: (profileKey: string) => ConnectorAccount | null;
  deleteProfile: (profileKey: string) => unknown;
  markNeedsRefresh: (account: ConnectorAccount, reason: string, detail: Record<string, unknown>) => void;
};

export async function markRunXhsAccountNeedsRefresh(
  context: AgentRunRequest,
  input: XhsAccountRefreshInput,
  dependencies: XhsAccountRefreshDependencies
): Promise<{ ok: true; profileKey: string; status: "needs_refresh"; reason: XhsAccountRefreshReason }> {
  const runAccount = context.xhsConnector;
  if (!runAccount) throw new Error("当前 Agent Run 未绑定小红书账号，无法更新连接器状态");

  const account = dependencies.getAccount(runAccount.profileKey);
  if (!account) throw new Error("当前 Agent Run 绑定的小红书账号不存在");
  if (account.accountId !== runAccount.accountId) {
    throw new Error("小红书账号上下文已变化，拒绝更新其他账号的连接器状态");
  }

  const actualAccountId = input.actualAccountId?.trim() ?? "";
  if (input.reason === "account_mismatch") {
    if (!actualAccountId) throw new Error("账号串号时必须提供 check-session 返回的实际账号 ID");
    if (runAccount.accountId && actualAccountId === runAccount.accountId) {
      throw new Error("实际账号 ID 与当前账号一致，不能标记为账号串号");
    }
    dependencies.deleteProfile(account.profileKey);
  }

  dependencies.markNeedsRefresh(account, `agentTool:${input.reason}`, {
    source: "agentTool",
    requestId: context.requestId,
    actualAccountId: actualAccountId || null
  });
  return {
    ok: true,
    profileKey: account.profileKey,
    status: "needs_refresh",
    reason: input.reason
  };
}
