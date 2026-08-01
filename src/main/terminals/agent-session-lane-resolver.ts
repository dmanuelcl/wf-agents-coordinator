import { randomUUID } from "node:crypto";
import type {
  AgentRuntimeConfig,
  AgentSessionLaunch,
} from "../../shared/workflow/agent-runtime-config";
import { isKimiSessionId } from "../../shared/workflow/kimi-session-id";
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
  createUuid?: () => string;
}): AgentSessionLaneResolver {
  const { sessionAgentUuidStore, createUuid = randomUUID } = params;

  async function createLaneSession(input: {
    sessionId: string;
    sessionLane: string;
    agentConfig: AgentRuntimeConfig;
  }): Promise<AgentSessionLaunch | undefined> {
    const { sessionId, sessionLane, agentConfig } = input;
    let sessionUuid: string;
    let mode: AgentSessionLaunch["mode"] = "fresh";

    if (agentConfig.kind === "claude") {
      sessionUuid = createUuid();
    } else {
      // Codex's interactive TUI cannot reliably resume a blank thread created
      // by a separate app-server process: it can report "No saved session
      // found". Let the TUI create its own conversation instead. Kimi mints
      // its id in the TUI and SessionTerminal records it afterward; other
      // providers do not have a confirmed restore contract either.
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
    async resolve({ sessionId, sessionLane, agentConfig, forceFresh }) {
      // Ignore old app-server IDs too. They may not exist in this Codex CLI's
      // interactive session store.
      if (agentConfig.kind === "codex") return undefined;
      const stored = forceFresh
        ? null
        : await sessionAgentUuidStore.get({ sessionId, lane: sessionLane });
      if (bindingMatchesAgent(stored, agentConfig) && stored) {
        return { id: stored.sessionUuid, mode: "resume" };
      }
      return createLaneSession({ sessionId, sessionLane, agentConfig });
    },
  };
}
