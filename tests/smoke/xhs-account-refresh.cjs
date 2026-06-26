const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "../..");
const { markRunXhsAccountNeedsRefresh } = require(path.join(
  rootDir,
  "dist",
  "main",
  "xhs-account-refresh.js"
));

function account(profileKey = "profile-a", accountId = "account-a", status = "authorized") {
  return {
    platform: "xhs",
    profileKey,
    accountId,
    accountHandle: "red-a",
    displayName: "账号 A",
    avatarUrl: null,
    status,
    lastAuthorizedAt: null,
    opsState: {}
  };
}

function context(boundAccount = account()) {
  return {
    requestId: "1:request",
    xhsConnector: {
      profileKey: boundAccount.profileKey,
      accountId: boundAccount.accountId
    }
  };
}

async function main() {
  await assert.rejects(
    () => markRunXhsAccountNeedsRefresh({ requestId: "no-xhs" }, { reason: "not_logged_in" }, dependencies()),
    /未绑定小红书账号/
  );

  const staleAccount = account("profile-a", "new-account");
  await assert.rejects(
    () => markRunXhsAccountNeedsRefresh(context(), { reason: "not_logged_in" }, dependencies(staleAccount)),
    /账号上下文已变化/
  );

  const notLoggedIn = dependencies();
  const first = await markRunXhsAccountNeedsRefresh(
    context(),
    { reason: "not_logged_in" },
    notLoggedIn
  );
  assert.equal(first.status, "needs_refresh");
  assert.deepEqual(notLoggedIn.deletedProfiles, []);
  assert.equal(notLoggedIn.transitions.length, 1);
  assert.equal(notLoggedIn.transitions[0].reason, "agentTool:not_logged_in");

  const mismatch = dependencies();
  await assert.rejects(
    () => markRunXhsAccountNeedsRefresh(
      context(),
      { reason: "account_mismatch", actualAccountId: "account-a" },
      mismatch
    ),
    /实际账号 ID 与当前账号一致/
  );
  const mismatchResult = await markRunXhsAccountNeedsRefresh(
    context(),
    { reason: "account_mismatch", actualAccountId: "account-b" },
    mismatch
  );
  assert.equal(mismatchResult.status, "needs_refresh");
  assert.deepEqual(mismatch.deletedProfiles, ["profile-a"]);
  assert.equal(mismatch.transitions[0].detail.actualAccountId, "account-b");

  const idempotent = dependencies(account("profile-a", "account-a", "needs_refresh"));
  await markRunXhsAccountNeedsRefresh(context(), { reason: "not_logged_in" }, idempotent);
  assert.equal(idempotent.transitions.length, 1);

  const toolMetadata = JSON.parse(fs.readFileSync(
    path.join(rootDir, "resources", "tools", "connector_ops", "tool.json"),
    "utf8"
  ));
  assert.equal(toolMetadata.name, "connector_ops");
  const toolSource = fs.readFileSync(
    path.join(rootDir, "resources", "tools", "connector_ops", "src", "index.ts"),
    "utf8"
  );
  for (const expected of [
    "xhs_account_mark_needs_refresh",
    "not_logged_in",
    "account_mismatch",
    "idempotentHint: true"
  ]) {
    assert.ok(toolSource.includes(expected), `Missing connector tool contract: ${expected}`);
  }
  assert.ok(!toolSource.includes("profileKey:"), "Connector tool must not accept a profileKey argument");

  const promptSource = fs.readFileSync(path.join(rootDir, "src", "agent", "prompt.ts"), "utf8");
  assert.ok(promptSource.includes('reason=\\"not_logged_in\\"'));
  assert.ok(promptSource.includes('reason=\\"account_mismatch\\"'));
  assert.ok(promptSource.includes("不要调用状态更新工具"));

  console.log("XHS account refresh tool smoke test passed.");
}

function dependencies(storedAccount = account()) {
  const deletedProfiles = [];
  const transitions = [];
  return {
    deletedProfiles,
    transitions,
    getAccount: (profileKey) => profileKey === storedAccount.profileKey ? storedAccount : null,
    deleteProfile: (profileKey) => {
      deletedProfiles.push(profileKey);
    },
    markNeedsRefresh: (target, reason, detail) => {
      transitions.push({ target, reason, detail });
    }
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
