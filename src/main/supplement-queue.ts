import type { AgentSupplementQueueItem } from "../shared/types";

export interface SupplementQueueState {
  requestId: string;
  sessionId: number;
  closed: boolean;
  items: AgentSupplementQueueItem[];
}

export function createSupplementQueue(requestId: string, sessionId: number): SupplementQueueState {
  return {
    requestId,
    sessionId,
    closed: false,
    items: []
  };
}

export function claimNextSupplement(queue: SupplementQueueState, now = new Date()): AgentSupplementQueueItem | null {
  if (queue.closed) return null;
  const index = queue.items.findIndex((item) => item.status === "pending");
  if (index < 0) return null;
  const current = queue.items[index]!;
  const consumed: AgentSupplementQueueItem = {
    ...current,
    status: "consumed",
    consumedAt: now.toISOString()
  };
  queue.items[index] = consumed;
  return consumed;
}

export function revokePendingSupplement(queue: SupplementQueueState, itemId: string): boolean {
  const item = queue.items.find((candidate) => candidate.id === itemId);
  if (!item || item.status !== "pending") return false;
  queue.items = queue.items.filter((candidate) => candidate.id !== itemId);
  return true;
}
