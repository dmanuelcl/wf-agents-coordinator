import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionRegistry } from "./session-registry";

let repoDir: string;
let storeDir: string;
let storeFilePath: string;

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "test\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

function branchExists(dir: string, branch: string): boolean {
  return execFileSync("git", ["branch", "--list", branch], { cwd: dir }).toString().includes(branch);
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "agent-coordinator-session-repo-"));
  storeDir = mkdtempSync(join(tmpdir(), "agent-coordinator-session-store-"));
  storeFilePath = join(storeDir, "sessions.json");
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(storeDir, { recursive: true, force: true });
});

describe("SessionRegistry", () => {
  it("lists nothing for a project with no sessions", async () => {
    const registry = createSessionRegistry({ storeFilePath });
    await expect(registry.listSessions({ projectId: "p1" })).resolves.toEqual([]);
  });

  it("createSession creates a worktree + new branch and persists a WorkSession", async () => {
    initGitRepo(repoDir);
    const registry = createSessionRegistry({ storeFilePath });

    const session = await registry.createSession({
      projectId: "p1",
      projectRoot: repoDir,
      name: "My Feature",
      kind: "feature",
    });

    expect(session.projectId).toBe("p1");
    expect(session.name).toBe("My Feature");
    expect(session.kind).toBe("feature");
    expect(session.slug).toBe("my-feature");
    expect(session.branch).toBe("feature/my-feature");
    expect(session.worktreePath).toBe(join(repoDir, ".worktrees", "my-feature"));
    expect(session.checkpointPath).toBeNull();
    expect(typeof session.id).toBe("string");
    expect(session.createdAtEpochMs).toBeGreaterThan(0);

    expect(existsSync(join(repoDir, ".worktrees", "my-feature"))).toBe(true);
    expect(branchExists(repoDir, "feature/my-feature")).toBe(true);

    const reloaded = createSessionRegistry({ storeFilePath });
    const listed = await reloaded.listSessions({ projectId: "p1" });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(session.id);
  });

  it("uses the fix/ branch prefix for a fix session", async () => {
    initGitRepo(repoDir);
    const registry = createSessionRegistry({ storeFilePath });

    const session = await registry.createSession({
      projectId: "p1",
      projectRoot: repoDir,
      name: "Broken login",
      kind: "fix",
    });

    expect(session.branch).toBe("fix/broken-login");
    expect(branchExists(repoDir, "fix/broken-login")).toBe(true);
  });

  it("createReviewSession detaches a worktree at the branch and stores baseBranch", async () => {
    initGitRepo(repoDir);
    execFileSync("git", ["branch", "feature/to-review"], { cwd: repoDir });
    const registry = createSessionRegistry({ storeFilePath });

    const session = await registry.createReviewSession({
      projectId: "p1",
      projectRoot: repoDir,
      name: "Review to-review",
      reviewBranch: "feature/to-review",
      baseBranch: "develop",
    });

    expect(session.kind).toBe("review");
    expect(session.branch).toBe("feature/to-review");
    expect(session.baseBranch).toBe("develop");
    expect(session.checkpointPath).toBeNull();
    expect(existsSync(session.worktreePath)).toBe(true);
    // Detached: the review branch is NOT "checked out" as a worktree branch.
    expect(branchExists(repoDir, "feature/to-review")).toBe(true);
  });

  it("setReviewedSha updates a PR review session's lastReviewedSha", async () => {
    initGitRepo(repoDir);
    execFileSync("git", ["branch", "feature/pr"], { cwd: repoDir });
    const registry = createSessionRegistry({ storeFilePath });
    const session = await registry.createReviewSession({
      projectId: "p1",
      projectRoot: repoDir,
      name: "PR review",
      reviewBranch: "feature/pr",
      baseBranch: "main",
      pr: { host: "bitbucket", workspace: "a", repo: "b", prId: "1", url: "u", lastReviewedSha: null },
    });

    await registry.setReviewedSha({ sessionId: session.id, sha: "deadbeef" });

    const reloaded = await registry.getSession({ sessionId: session.id });
    expect(reloaded?.pr?.lastReviewedSha).toBe("deadbeef");
  });

  it("createFixSession checks out a WRITABLE branch worktree (not detached)", async () => {
    initGitRepo(repoDir);
    execFileSync("git", ["branch", "feature/fixme"], { cwd: repoDir });
    const registry = createSessionRegistry({ storeFilePath });
    const session = await registry.createFixSession({
      projectId: "p1",
      projectRoot: repoDir,
      name: "Fix fixme",
      branch: "feature/fixme",
      baseBranch: "main",
      pr: { host: "bitbucket", workspace: "a", repo: "b", prId: "1", url: "u", lastReviewedSha: null },
    });

    expect(session.kind).toBe("pr-fix");
    expect(session.branch).toBe("feature/fixme");
    expect(existsSync(session.worktreePath)).toBe(true);
    // On the branch (writable), not a detached HEAD.
    const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: session.worktreePath })
      .toString()
      .trim();
    expect(head).toBe("feature/fixme");
  });

  it("rejects a blank / punctuation-only name before creating anything", async () => {
    initGitRepo(repoDir);
    const registry = createSessionRegistry({ storeFilePath });

    await expect(
      registry.createSession({ projectId: "p1", projectRoot: repoDir, name: "  !!!  ", kind: "feature" }),
    ).rejects.toThrow(/cannot be empty/i);

    expect(existsSync(join(repoDir, ".worktrees"))).toBe(false);
    await expect(registry.listSessions({ projectId: "p1" })).resolves.toEqual([]);
  });

  it("listSessions returns only the requested project's sessions", async () => {
    initGitRepo(repoDir);
    const registry = createSessionRegistry({ storeFilePath });

    await registry.createSession({ projectId: "p1", projectRoot: repoDir, name: "One", kind: "feature" });
    await registry.createSession({ projectId: "p2", projectRoot: repoDir, name: "Two", kind: "feature" });

    const p1 = await registry.listSessions({ projectId: "p1" });
    const p2 = await registry.listSessions({ projectId: "p2" });
    expect(p1).toHaveLength(1);
    expect(p2).toHaveLength(1);
    expect(p1[0]?.name).toBe("One");
    expect(p2[0]?.name).toBe("Two");
  });

  it("updateSessionCheckpoint sets checkpointPath and persists it", async () => {
    initGitRepo(repoDir);
    const registry = createSessionRegistry({ storeFilePath });
    const session = await registry.createSession({ projectId: "p1", projectRoot: repoDir, name: "One", kind: "feature" });

    await registry.updateSessionCheckpoint({
      sessionId: session.id,
      checkpointPath: "docs/workflow/checkpoints/one-checkpoint.md",
    });

    const reloaded = createSessionRegistry({ storeFilePath });
    const [listed] = await reloaded.listSessions({ projectId: "p1" });
    expect(listed?.checkpointPath).toBe("docs/workflow/checkpoints/one-checkpoint.md");
  });

  it("updateSessionCheckpoint rejects an unknown sessionId", async () => {
    const registry = createSessionRegistry({ storeFilePath });
    await expect(
      registry.updateSessionCheckpoint({ sessionId: "missing", checkpointPath: "x.md" }),
    ).rejects.toThrow(/not found/i);
  });

  it("removeSession drops the record but leaves the worktree on disk", async () => {
    initGitRepo(repoDir);
    const registry = createSessionRegistry({ storeFilePath });
    const session = await registry.createSession({ projectId: "p1", projectRoot: repoDir, name: "One", kind: "feature" });

    expect(existsSync(session.worktreePath)).toBe(true);

    await registry.removeSession({ sessionId: session.id });

    await expect(registry.listSessions({ projectId: "p1" })).resolves.toEqual([]);
    expect(existsSync(session.worktreePath)).toBe(true);
  });
});
