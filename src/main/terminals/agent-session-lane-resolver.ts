import { randomUUID } from "node:crypto";
import type {
  AgentRuntimeConfig,
  AgentSessionLaunch,
} from "../../shared/workflow/agent-runtime-config";
import { isKimiSessionId } from "../../shared/workflow/kimi-session-id";
import type { CodexThreadAllocator } from "./codex-thread-allocator";
import type {
  AgentSessionBinding,
  SessionAgentUuidStore,
} from "./session-agent-uuid-store";

export interface AgentSessionLaneResolver {
  resolve(params: {
    sessionId: string;
    sessionLane: string;
    cwd: string;
    agentConfig: AgentRuntimeConfig;
    forceFresh: boolean;
  }): Promise<AgentSessionLaunch | undefined>;
}

function bindingMatchesAgent(
  binding: AgentSessionBinding | null,
  agentConfig: AgentRuntimeConfig,
): boolean {
  if (!binding) return false;
  if (binding.agentKind !== null) return binding.agentKind === agentConfig.kind;
  // Legacy records predate provider metadata. Old Codex launches stored a
  // random UUID without creating a resumable thread, so never feed one to
  // `codex resume`. Kimi ids are self-identifying; remaining legacy UUIDs came
  // from Claude's caller-minted sessions.
  if (agentConfig.kind === "kimi") return isKimiSessionId(binding.sessionUuid);
  if (agentConfig.kind === "claude") return !isKimiSessionId(binding.sessionUuid);
  return false;
}

export function createAgentSessionLaneResolver(params: {
  sessionAgentUuidStore: SessionAgentUuidStore;
  codexThreadAllocator: CodexThreadAllocator;
  createUuid?: () => string;
}): AgentSessionLaneResolver {
  const {
    sessionAgentUuidStore,
    codexThreadAllocator,
    createUuid = randomUUID,
  } = params;

  async function createLaneSession(input: {
    sessionId: string;
    sessionLane: string;
    cwd: string;
    agentConfig: AgentRuntimeConfig;
  }): Promise<AgentSessionLaunch | undefined> {
    const { sessionId, sessionLane, cwd, agentConfig } = input;
    let sessionUuid: string;
    let mode: AgentSessionLaunch["mode"] = "fresh";

    if (agentConfig.kind === "claude") {
      sessionUuid = createUuid();
    } else if (agentConfig.kind === "codex") {
      sessionUuid = await codexThreadAllocator.create({ cwd, model: agentConfig.model });
      // thread/start already created the durable Codex thread. The watchable
      // TUI attaches to that exact thread and submits the workflow prompt.
      mode = "resume";
    } else {
      // Kimi mints its id in the TUI and SessionTerminal records it afterward.
      // Other providers do not have a confirmed restore contract.
      return undefined;
    }

    await sessionAgentUuidStore.set({
      sessionId,
      lane: sessionLane,
      binding: { agentKind: agentConfig.kind, sessionUuid },
    });
    return { id: sessionUuid, mode };
  }

  return {
    async resolve({ sessionId, sessionLane, cwd, agentConfig, forceFresh }) {
      const stored = forceFresh
        ? null
        : await sessionAgentUuidStore.get({ sessionId, lane: sessionLane });
      if (bindingMatchesAgent(stored, agentConfig) && stored) {
        return { id: stored.sessionUuid, mode: "resume" };
      }
      return createLaneSession({ sessionId, sessionLane, cwd, agentConfig });
    },
  };
}
