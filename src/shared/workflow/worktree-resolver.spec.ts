import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkflowCwd } from "./worktree-resolver";

describe("resolveWorkflowCwd", () => {
  it("resolves '.' to the project root", () => {
    const result = resolveWorkflowCwd({
      projectRoot: "/repo",
      nextCwd: ".",
      frontmatterWorktree: null,
    });

    expect(result.cwd).toBe("/repo");
    expect(result.outsideProjectRoot).toBe(false);
  });

  it("resolves a relative worktree path under the project root", () => {
    const result = resolveWorkflowCwd({
      projectRoot: "/repo",
      nextCwd: ".worktrees/x",
      frontmatterWorktree: null,
    });

    expect(result.cwd).toBe("/repo/.worktrees/x");
    expect(result.source).toBe("next");
    expect(result.outsideProjectRoot).toBe(false);
  });

  it("prefers NEXT cwd over the frontmatter worktree", () => {
    const result = resolveWorkflowCwd({
      projectRoot: "/repo",
      nextCwd: ".worktrees/example",
      frontmatterWorktree: ".worktrees/other",
    });

    expect(result.source).toBe("next");
    expect(result.cwd).toBe("/repo/.worktrees/example");
  });

  it("warns when NEXT cwd and frontmatter worktree conflict", () => {
    const result = resolveWorkflowCwd({
      projectRoot: "/repo",
      nextCwd: ".worktrees/example",
      frontmatterWorktree: ".worktrees/other",
    });

    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("falls back to the frontmatter worktree when NEXT cwd is absent", () => {
    const result = resolveWorkflowCwd({
      projectRoot: "/repo",
      nextCwd: null,
      frontmatterWorktree: ".worktrees/example",
    });

    expect(result.source).toBe("frontmatter");
    expect(result.cwd).toBe("/repo/.worktrees/example");
    expect(result.warnings).toHaveLength(0);
  });

  it("falls back to the project root when both are absent", () => {
    const result = resolveWorkflowCwd({
      projectRoot: "/repo",
      nextCwd: null,
      frontmatterWorktree: null,
    });

    expect(result.source).toBe("project-root");
    expect(result.cwd).toBe("/repo");
  });

  it("marks an absolute path outside the project root", () => {
    const result = resolveWorkflowCwd({
      projectRoot: "/repo",
      nextCwd: "/etc/elsewhere",
      frontmatterWorktree: null,
    });

    expect(result.outsideProjectRoot).toBe(true);
    expect(result.cwd).toBe("/etc/elsewhere");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("resolves Windows-style paths using the win32 path module", () => {
    const result = resolveWorkflowCwd({
      projectRoot: "C:\\repo",
      nextCwd: ".worktrees/example",
      frontmatterWorktree: null,
      pathModule: win32,
    });

    expect(result.cwd).toBe("C:\\repo\\.worktrees\\example");
    expect(result.outsideProjectRoot).toBe(false);
  });
});
