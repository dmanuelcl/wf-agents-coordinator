import type { AgentCoordinatorApi } from "../shared/ipc/contract";

declare global {
  interface Window {
    agentCoordinator: AgentCoordinatorApi;
  }
}

export {};
