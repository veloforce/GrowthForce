import type { AgentStudioApi } from "../../preload/preload";

declare global {
  interface Window {
    agentStudio: AgentStudioApi;
  }
}

export {};
