import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorktreeCreatePlan, createWorktree, detectWorktree } from "./worktree-manager";

let dir: string;

function initGitRepo(repoDir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "test\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
  execFileSync("git", ["branch", "feature/example"], { cwd: repoDir });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-coordinator-worktree-manager-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("detectWorktree", () => {
  it("reports exists: false when the worktree directory is not present", () => {
    const result = detectWorktree({ projectRoot: dir, slug: "example" });
    expect(result.exists).toBe(false);
    expect(result.path).toBe(join(dir, ".worktrees", "example"));
  });

  it("reports exists: true once the worktree directory is present", async () => {
    initGitRepo(dir);
    await createWorktree({ projectRoot: dir, slug: "example", branch: "feature/example" });

    const result = detectWorktree({ projectRoot: dir, slug: "example" });
    expect(result.exists).toBe(true);
  });
});

describe("buildWorktreeCreatePlan", () => {
  it("shows the exact git worktree add command and a rollback line", () => {
    const plan = buildWorktreeCreatePlan({ projectRoot: dir, slug: "example", branch: "feature/example" });
    const expectedPath = join(dir, ".worktrees", "example");

    expect(plan.command).toBe(`git worktree add ${expectedPath} feature/example`);
    expect(plan.rollbackCommand).toBe(`git worktree remove ${expectedPath}`);
    expect(plan.safe).toBe(true);
  });

  it("marks a slug that resolves outside the project root as unsafe", () => {
    const plan = buildWorktreeCreatePlan({ projectRoot: dir, slug: "../../etc/evil", branch: "feature/example" });
    expect(plan.safe).toBe(false);
  });
});

describe("createWorktree", () => {
  it("creates a real worktree at .worktrees/<slug>", async () => {
    initGitRepo(dir);
    await createWorktree({ projectRoot: dir, slug: "example", branch: "feature/example" });

    expect(existsSync(join(dir, ".worktrees", "example"))).toBe(true);
  });

  it("rejects a path that resolves outside the project root before any git call", async () => {
    initGitRepo(dir);
    const execFileImpl = vi.fn();

    await expect(
      createWorktree({ projectRoot: dir, slug: "../../etc/evil", branch: "feature/example", execFileImpl }),
    ).rejects.toThrow(/outside the project root/);

    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it("creates a brand-new branch alongside the worktree when createBranch is true", async () => {
    initGitRepo(dir);

    await createWorktree({ projectRoot: dir, slug: "fresh", branch: "feature/brand-new", createBranch: true });

    expect(existsSync(join(dir, ".worktrees", "fresh"))).toBe(true);
    const branches = execFileSync("git", ["branch", "--list", "feature/brand-new"], { cwd: dir }).toString();
    expect(branches).toContain("feature/brand-new");
  });
});
