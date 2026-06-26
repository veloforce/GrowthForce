import type { AgentSupplementQueueItem } from "../shared/types";

export function composeSupplementPrompt(item: AgentSupplementQueueItem): string {
  return item.text;
}
