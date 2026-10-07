import { describe, expect, it, vi } from "vitest";
import { agentSessionContextTokens } from "./agent-context-usage";

describe("agentSessionContextTokens", () => {
  it("delegates to the provider's reader when one exists", async () => {
    const reader = vi.fn(async () => 456_000);
    const environment = { CLAUDE_CONFIG_DIR: "/Users/ada/.claude-biz" };
    expect(await agentSessionContextTokens("claude", "u-1", environment, { claude: reader })).toBe(456_000);
    expect(reader).toHaveBeenCalledWith("u-1", environment);
  });

  it("reads as unknown (null) for providers without a context source — reuse stays allowed", async () => {
    for (const kind of ["codex", "kimi", "opencode", "copilot", "gemini", "antigravity"] as const) {
      expect(await agentSessionContextTokens(kind, "u-1")).toBeNull();
    }
  });
});
