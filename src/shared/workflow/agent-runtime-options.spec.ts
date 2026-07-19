import { describe, expect, it } from "vitest";
import { AGENT_RUNTIME_OPTION_CATALOG } from "./agent-runtime-options";

describe("AGENT_RUNTIME_OPTION_CATALOG", () => {
  it("offers the effort values supported by the Claude and Codex launchers", () => {
    expect(AGENT_RUNTIME_OPTION_CATALOG.claude.effortOptions).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(AGENT_RUNTIME_OPTION_CATALOG.codex.effortOptions).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("does not offer controls that the launch command cannot apply", () => {
    expect(AGENT_RUNTIME_OPTION_CATALOG.kimi.effortOptions).toEqual([]);
    expect(AGENT_RUNTIME_OPTION_CATALOG.copilot.modelSupported).toBe(false);
    expect(AGENT_RUNTIME_OPTION_CATALOG.copilot.effortOptions).toEqual([]);
  });

  it("provides provider-specific model suggestions without pretending they are exhaustive", () => {
    expect(AGENT_RUNTIME_OPTION_CATALOG.kimi.modelSuggestions).toContain("kimi-code/kimi-for-coding");
    expect(AGENT_RUNTIME_OPTION_CATALOG.gemini.modelSuggestions).toContain("auto");
    expect(AGENT_RUNTIME_OPTION_CATALOG.opencode.modelSuggestions[0]).toMatch(/^anthropic\//);
  });
});
