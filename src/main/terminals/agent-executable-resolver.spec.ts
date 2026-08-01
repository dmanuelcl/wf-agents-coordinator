import { describe, expect, it } from "vitest";
import { resolveAgentExecutable } from "./agent-executable-resolver";

describe("resolveAgentExecutable", () => {
  it("uses an executable already present in the app process PATH", () => {
    const result = resolveAgentExecutable("claude", {
      platform: "darwin",
      environment: { PATH: "/app/bin:/usr/bin" },
      checkExecutable: (path) => path === "/app/bin/claude",
      probeLoginShell: () => null,
    });

    expect(result).toEqual({ executable: "/app/bin/claude", path: "/app/bin:/usr/bin" });
  });

  it("recovers the executable and full PATH from the user's login shell", () => {
    const result = resolveAgentExecutable("codex", {
      platform: "darwin",
      environment: { PATH: "/usr/bin:/bin" },
      checkExecutable: () => false,
      probeLoginShell: ({ executable, environment }) => {
        expect(executable).toBe("codex");
        expect(environment.PATH).toBe("/usr/bin:/bin");
        return {
          executable: "/Users/ada/.local/bin/codex",
          path: "/Users/ada/.local/bin:/Users/ada/.nvm/current/bin:/usr/bin:/bin",
        };
      },
    });

    expect(result).toEqual({
      executable: "/Users/ada/.local/bin/codex",
      path: "/Users/ada/.local/bin:/Users/ada/.nvm/current/bin:/usr/bin:/bin",
    });
  });

  it("falls back to common user-level install directories", () => {
    const result = resolveAgentExecutable("kimi", {
      platform: "darwin",
      environment: { PATH: "/usr/bin:/bin" },
      homeDirectory: "/Users/ada",
      checkExecutable: (path) => path === "/Users/ada/.local/bin/kimi",
      probeLoginShell: () => null,
    });

    expect(result).toEqual({
      executable: "/Users/ada/.local/bin/kimi",
      path: "/Users/ada/.local/bin:/usr/bin:/bin",
    });
  });

  it("returns null when the configured CLI is unavailable", () => {
    const result = resolveAgentExecutable("gemini", {
      platform: "darwin",
      environment: { PATH: "/usr/bin:/bin" },
      homeDirectory: "/Users/ada",
      checkExecutable: () => false,
      probeLoginShell: () => null,
    });

    expect(result).toBeNull();
  });
});
