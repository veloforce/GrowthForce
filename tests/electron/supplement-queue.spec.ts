import { expect, test } from "@playwright/test";
import { composeSupplementPrompt } from "../../src/agent/supplement-flow";
import { claimNextSupplement, createSupplementQueue, revokePendingSupplement } from "../../src/main/supplement-queue";
import type { AgentSupplementQueueItem } from "../../src/shared/types";

test("supplement queue claims one item per resume and keeps prompts unmerged", () => {
  const queue = createSupplementQueue("101:run", 101);
  const first = makeSupplement("first", "第一条补充");
  const second = makeSupplement("second", "第二条补充");
  queue.items.push(first, second);

  const claimedFirst = claimNextSupplement(queue, new Date("2026-06-16T00:00:01.000Z"));
  expect(claimedFirst).toMatchObject({ id: "first", status: "consumed", consumedAt: "2026-06-16T00:00:01.000Z" });
  expect(composeSupplementPrompt(claimedFirst!)).toBe("第一条补充");
  expect(queue.items.map((item) => [item.id, item.status])).toEqual([
    ["first", "consumed"],
    ["second", "pending"]
  ]);

  const claimedSecond = claimNextSupplement(queue, new Date("2026-06-16T00:00:02.000Z"));
  expect(claimedSecond).toMatchObject({ id: "second", status: "consumed", consumedAt: "2026-06-16T00:00:02.000Z" });
  expect(composeSupplementPrompt(claimedSecond!)).toBe("第二条补充");
  expect(claimNextSupplement(queue)).toBeNull();
});

test("supplement queue makes claimed items non-revocable while later pending items remain revocable", () => {
  const queue = createSupplementQueue("101:run", 101);
  queue.items.push(makeSupplement("claimed", "已领取"), makeSupplement("pending", "仍待发送"));

  const claimed = claimNextSupplement(queue, new Date("2026-06-16T00:00:01.000Z"));
  expect(claimed?.id).toBe("claimed");

  expect(revokePendingSupplement(queue, "claimed")).toBe(false);
  expect(queue.items.some((item) => item.id === "claimed" && item.status === "consumed")).toBe(true);

  expect(revokePendingSupplement(queue, "pending")).toBe(true);
  expect(queue.items.map((item) => item.id)).toEqual(["claimed"]);
});

function makeSupplement(id: string, text: string): AgentSupplementQueueItem {
  return {
    id,
    requestId: "101:run",
    sessionId: 101,
    text,
    status: "pending",
    createdAt: "2026-06-16T00:00:00.000Z"
  };
}
