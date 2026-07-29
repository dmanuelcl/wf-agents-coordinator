import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeConfig } from "../../shared/workflow/agent-runtime-config";
import { createAgentSessionLaneResolver } from "./agent-session-lane-resolver";
import type { CodexThreadAllocator } from "./codex-thread-allocator";
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
  allocateCodex: ReturnType<typeof vi.fn>;
} {
  let stored = initial;
  const store: SessionAgentUuidStore = {
    get: vi.fn(async () => stored),
    set: vi.fn(async ({ binding }) => {
      stored = binding;
    }),
  };
  const allocateCodex = vi.fn(async () => "codex-thread-1");
  const allocator: CodexThreadAllocator = { create: allocateCodex };
  const resolver = createAgentSessionLaneResolver({
    sessionAgentUuidStore: store,
    codexThreadAllocator: allocator,
    createUuid: () => "claude-session-1",
  });
  return {
    resolve: resolver.resolve,
    getStored: () => stored,
    allocateCodex,
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

  it("preallocates and stores an exact Codex thread, then attaches by resume", async () => {
    const h = harness();

    await expect(h.resolve(input(CODEX))).resolves.toEqual({
      id: "codex-thread-1",
      mode: "resume",
    });
    expect(h.allocateCodex).toHaveBeenCalledWith({
      cwd: "/repo/.worktrees/feature",
      model: "gpt-5.5",
    });
    expect(h.getStored()).toEqual({
      agentKind: "codex",
      sessionUuid: "codex-thread-1",
    });
  });

  it("replaces a lane binding when its configured provider changes", async () => {
    const h = harness({ agentKind: "claude", sessionUuid: "old-claude" });

    await h.resolve(input(CODEX));
    expect(h.getStored()).toEqual({
      agentKind: "codex",
      sessionUuid: "codex-thread-1",
    });
  });

  it("does not treat a provider-less legacy UUID as a resumable Codex thread", async () => {
    const h = harness({ agentKind: null, sessionUuid: "legacy-random-uuid" });

    await expect(h.resolve(input(CODEX))).resolves.toEqual({
      id: "codex-thread-1",
      mode: "resume",
    });
    expect(h.allocateCodex).toHaveBeenCalledOnce();
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
