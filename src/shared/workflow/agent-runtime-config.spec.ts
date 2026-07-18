import { describe, expect, it } from "vitest";
import { buildAgentLaunchCommand, createDefaultProjectRuntimeConfig } from "./agent-runtime-config";
import type { AgentRuntimeConfig } from "./agent-runtime-config";

function makeConfig(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    kind: "claude",
    model: "opus",
    effort: null,
    dangerous: false,
    ...overrides,
  };
}

describe("buildAgentLaunchCommand — claude", () => {
  it("builds a plain launch command with just the model", () => {
    const result = buildAgentLaunchCommand(makeConfig({ kind: "claude", model: "opus" }));
    expect(result.command).toBe("claude --model opus");
    expect(result.warnings).toEqual([]);
  });

  it("includes --dangerously-skip-permissions only when dangerous is true", () => {
    const dangerous = buildAgentLaunchCommand(makeConfig({ kind: "claude", dangerous: true }));
    expect(dangerous.command).toContain("--dangerously-skip-permissions");

    const safe = buildAgentLaunchCommand(makeConfig({ kind: "claude", dangerous: false }));
    expect(safe.command).not.toContain("--dangerously-skip-permissions");
  });

  it("passes effort as a launch flag so no slash command races the startup UI", () => {
    const result = buildAgentLaunchCommand(makeConfig({ kind: "claude", effort: "high" }));
    expect(result.command).toBe("claude --model opus --effort high");
  });
});

describe("buildAgentLaunchCommand — codex", () => {
  it("matches the ADE reference command exactly (model + -c effort + approval/sandbox + summary constants)", () => {
    const result = buildAgentLaunchCommand(
      makeConfig({ kind: "codex", model: "gpt-5.5", effort: "high", dangerous: true }),
    );
    expect(result.command).toBe(
      'codex --model gpt-5.5 -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true',
    );
    expect(result.warnings).toEqual([]);
  });

  it("omits the approval/sandbox flags when not dangerous but keeps the summary constants", () => {
    const result = buildAgentLaunchCommand(
      makeConfig({ kind: "codex", model: "gpt-5.5", effort: "high", dangerous: false }),
    );
    expect(result.command).toBe(
      'codex --model gpt-5.5 -c model_reasoning_effort="high" -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true',
    );
    expect(result.command).not.toContain("--ask-for-approval");
  });

  it("omits the -c model_reasoning_effort override when effort is not set", () => {
    const result = buildAgentLaunchCommand(makeConfig({ kind: "codex", model: "opus", effort: null }));
    expect(result.command).not.toContain("model_reasoning_effort");
    expect(result.command).toContain('-c model_reasoning_summary="detailed"');
  });
});

describe("buildAgentLaunchCommand — copilot", () => {
  it("adds --allow-all only when dangerous; does not apply the model (warns)", () => {
    expect(buildAgentLaunchCommand(makeConfig({ kind: "copilot", model: "", dangerous: true })).command).toBe(
      "copilot --allow-all",
    );

    const withModel = buildAgentLaunchCommand(makeConfig({ kind: "copilot", model: "some-model", dangerous: false }));
    expect(withModel.command).toBe("copilot");
    expect(withModel.warnings.some((w) => /model/i.test(w))).toBe(true);
  });
});

describe("buildAgentLaunchCommand — gemini", () => {
  it("adds --yolo when dangerous, with an optional --model", () => {
    expect(
      buildAgentLaunchCommand(makeConfig({ kind: "gemini", model: "gemini-2.5-pro", dangerous: true })).command,
    ).toBe("gemini --model gemini-2.5-pro --yolo");

    expect(buildAgentLaunchCommand(makeConfig({ kind: "gemini", model: "", dangerous: true })).command).toBe(
      "gemini --yolo",
    );
  });
});

describe("buildAgentLaunchCommand — opencode", () => {
  it("builds a plain launch command with just the model", () => {
    const result = buildAgentLaunchCommand(makeConfig({ kind: "opencode", model: "anthropic/claude-opus-4-8" }));
    expect(result.command).toBe("opencode --model anthropic/claude-opus-4-8");
    expect(result.warnings).toEqual([]);
  });

  it("does NOT invent a bypass flag when dangerous is true — warns instead", () => {
    const result = buildAgentLaunchCommand(makeConfig({ kind: "opencode", dangerous: true }));
    expect(result.command).toBe("opencode --model opus");
    expect(result.warnings.some((w) => /dangerous/i.test(w))).toBe(true);
  });

  it("does NOT invent a reasoning-effort flag when effort is set — warns instead", () => {
    const result = buildAgentLaunchCommand(makeConfig({ kind: "opencode", effort: "high" }));
    expect(result.command).toBe("opencode --model opus");
    expect(result.warnings.some((w) => /effort/i.test(w))).toBe(true);
  });
});

describe("buildAgentLaunchCommand — antigravity", () => {
  it("builds a command with the model and always warns the CLI is unverified", () => {
    const result = buildAgentLaunchCommand(makeConfig({ kind: "antigravity", model: "some-model" }));
    expect(result.command).toBe("agy --model some-model");
    expect(result.warnings.some((w) => /unverified/i.test(w))).toBe(true);
  });

  it("does NOT invent effort/dangerous flags — warns instead", () => {
    const result = buildAgentLaunchCommand(makeConfig({ kind: "antigravity", effort: "high", dangerous: true }));
    expect(result.command).toBe("agy --model opus");
    expect(result.warnings.some((w) => /effort/i.test(w))).toBe(true);
    expect(result.warnings.some((w) => /dangerous/i.test(w))).toBe(true);
  });
});

describe("createDefaultProjectRuntimeConfig", () => {
  it("gives the 3 workflow stages a conservative (non-dangerous) default config", () => {
    const config = createDefaultProjectRuntimeConfig();

    expect(Object.keys(config).sort()).toEqual(["architect", "implementer", "reviewer"]);
    for (const stage of Object.values(config)) {
      expect(stage.dangerous).toBe(false);
    }
  });

  it("gives each stage its own independent config object (no shared references)", () => {
    const config = createDefaultProjectRuntimeConfig();
    config.architect.model = "changed";
    expect(config.implementer.model).not.toBe("changed");
  });
});

describe("buildAgentLaunchCommand — session (resume-aware)", () => {
  const SID = "11111111-1111-4111-8111-111111111111";

  it("claude fresh injects --session-id right after claude, before --model", () => {
    const result = buildAgentLaunchCommand(makeConfig({ kind: "claude", model: "opus" }), { id: SID, mode: "fresh" });
    expect(result.command).toBe(`claude --session-id ${SID} --model opus`);
    expect(result.warnings).toEqual([]);
  });

  it("claude resume injects --resume right after claude, before --model", () => {
    const result = buildAgentLaunchCommand(makeConfig({ kind: "claude", model: "opus" }), { id: SID, mode: "resume" });
    expect(result.command).toBe(`claude --resume ${SID} --model opus`);
    expect(result.warnings).toEqual([]);
  });

  it("keeps claude behavior unchanged when no session is passed", () => {
    expect(buildAgentLaunchCommand(makeConfig({ kind: "claude", model: "opus" })).command).toBe("claude --model opus");
  });

  it("warns and does NOT inject the id for a non-claude kind (resume not wired)", () => {
    const result = buildAgentLaunchCommand(makeConfig({ kind: "codex", model: "gpt-5.5" }), { id: SID, mode: "resume" });
    expect(result.command).not.toContain(SID);
    expect(result.warnings.some((w) => /not wired/i.test(w))).toBe(true);
  });

  it("names the kind in the not-wired warning for each non-claude kind", () => {
    for (const kind of ["codex", "opencode", "copilot", "gemini"] as const) {
      const result = buildAgentLaunchCommand(makeConfig({ kind, model: "m" }), { id: SID, mode: "fresh" });
      expect(result.command).not.toContain(SID);
      expect(result.warnings.some((w) => w.includes(kind) && /not wired/i.test(w))).toBe(true);
    }
  });
});
