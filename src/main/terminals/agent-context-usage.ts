import type { AgentKind } from "../../shared/workflow/agent-runtime-config";
import { claudeSessionContextTokens } from "./claude-session-store";

/**
 * Per-provider readers for "how full is the session we are about to RESUME".
 * The context ceiling (SKILL.md → el contexto es un PRESUPUESTO) is
 * provider-NEUTRAL policy; only the reading is provider-specific. A provider
 * with no known transcript/usage source reads as `null` — unknown means "reuse
 * is allowed", never a forced fresh launch: punishing what we cannot measure
 * would break every non-Claude lane for no evidence.
 *
 * Extend per provider as a source becomes known (e.g. Codex keeps rollout
 * files under ~/.codex/sessions/ — unverified format, so not read yet).
 */
export type AgentContextReader = (sessionUuid: string) => Promise<number | null>;

const READERS: Partial<Record<AgentKind, AgentContextReader>> = {
  claude: (sessionUuid) => claudeSessionContextTokens(sessionUuid),
};

export async function agentSessionContextTokens(
  kind: AgentKind,
  sessionUuid: string,
  readers: Partial<Record<AgentKind, AgentContextReader>> = READERS,
): Promise<number | null> {
  const reader = readers[kind];
  return reader ? reader(sessionUuid) : null;
}
