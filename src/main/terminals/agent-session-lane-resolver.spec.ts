import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeConfig } from "../../shared/workflow/agent-runtime-config";
import { createAgentSessionLaneResolver } from "./agent-session-lane-resolver";
import type {
  AgentSessionBinding,
  SessionAgentUuidStore,
} from "./session-agent-uuid-store";

const CLAUDE: AgentRuntimeConfig = {
  kind: "claude",
  model: "opus",
  effort: "high",
  dangerous: false,
};
const CODEX: AgentRuntimeConfig = {
  kind: "codex",
  model: "gpt-5.5",
  effort: "high",
  dangerous: false,
};
const KIMI: AgentRuntimeConfig = {
  kind: "kimi",
  model: "kimi-k2",
  effort: "high",
  dangerous: false,
};

function harness(initial: AgentSessionBinding | null = null): {
  resolve: ReturnType<typeof createAgentSessionLaneResolver>["resolve"];
  getStored: () => AgentSessionBinding | null;
} {
  let stored = initial;
  const store: SessionAgentUuidStore = {
    get: vi.fn(async () => stored),
    set: vi.fn(async ({ binding }) => {
      stored = binding;
    }),
  };
  const resolver = createAgentSessionLaneResolver({
    sessionAgentUuidStore: store,
    createUuid: () => "claude-session-1",
  });
  return {
    resolve: resolver.resolve,
    getStored: () => stored,
  };
}

function input(agentConfig: AgentRuntimeConfig, forceFresh = false) {
  return {
    sessionId: "workflow-1",
    sessionLane: "plan-1/implementer",
    cwd: "/repo/.worktrees/feature",
    agentConfig,
    forceFresh,
  };
}

describe("createAgentSessionLaneResolver", () => {
  it("resumes an existing binding for the same provider and lane", async () => {
    const h = harness({ agentKind: "claude", sessionUuid: "existing" });

    await expect(h.resolve(input(CLAUDE))).resolves.toEqual({
      id: "existing",
      mode: "resume",
    });
  });

  it("creates and stores a fresh Claude conversation for a new lane", async () => {
    const h = harness();

    await expect(h.resolve(input(CLAUDE))).resolves.toEqual({
      id: "claude-session-1",
      mode: "fresh",
    });
    expect(h.getStored()).toEqual({
      agentKind: "claude",
      sessionUuid: "claude-session-1",
    });
  });

  it("starts Codex directly instead of resuming an app-server-preallocated thread", async () => {
    const h = harness();

    await expect(h.resolve(input(CODEX))).resolves.toBeUndefined();
    expect(h.getStored()).toBeNull();
  });

  it("replaces a lane binding when its configured provider changes", async () => {
    const h = harness({ agentKind: "claude", sessionUuid: "old-claude" });

    await expect(h.resolve(input(CODEX))).resolves.toBeUndefined();
    expect(h.getStored()).toEqual({
      agentKind: "claude",
      sessionUuid: "old-claude",
    });
  });

  it("ignores a provider-less legacy UUID for Codex", async () => {
    const h = harness({ agentKind: null, sessionUuid: "legacy-random-uuid" });

    await expect(h.resolve(input(CODEX))).resolves.toBeUndefined();
  });

  it("resumes a self-identifying legacy Kimi session", async () => {
    const h = harness({
      agentKind: null,
      sessionUuid: "session_12345678-1234-4123-8123-123456789abc",
    });

    await expect(h.resolve(input(KIMI))).resolves.toEqual({
      id: "session_12345678-1234-4123-8123-123456789abc",
      mode: "resume",
    });
  });
});
