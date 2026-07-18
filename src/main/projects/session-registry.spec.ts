import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_NAME_MAX_LENGTH, SESSION_SLUG_MAX_LENGTH } from "../../shared/workflow/work-session";
import { createSessionRegistry, PR_CONTEXT_ARTIFACT } from "./session-registry";
import { removeWorktree } from "./worktree-manager";

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

  it("caps the worktree slug even when the valid display name is longer", async () => {
    initGitRepo(repoDir);
    const registry = createSessionRegistry({ storeFilePath });
    const name = "a".repeat(SESSION_NAME_MAX_LENGTH);

    const session = await registry.createSession({ projectId: "p1", projectRoot: repoDir, name, kind: "feature" });

    expect(session.name).toBe(name);
    expect(session.slug).toHaveLength(SESSION_SLUG_MAX_LENGTH);
    expect(session.worktreePath).toBe(join(repoDir, ".worktrees", "a".repeat(SESSION_SLUG_MAX_LENGTH)));
  });

  it("rejects an overlong session name before touching the worktree", async () => {
    initGitRepo(repoDir);
    const registry = createSessionRegistry({ storeFilePath });

    await expect(
      registry.createSession({
        projectId: "p1",
        projectRoot: repoDir,
        name: "a".repeat(SESSION_NAME_MAX_LENGTH + 1),
        kind: "feature",
      }),
    ).rejects.toThrow(/cannot exceed 100/i);

    expect(existsSync(join(repoDir, ".worktrees"))).toBe(false);
  });

  it("recreates a deleted session on its preserved branch", async () => {
    initGitRepo(repoDir);
    const registry = createSessionRegistry({ storeFilePath });
    const first = await registry.createSession({
      projectId: "p1",
      projectRoot: repoDir,
      name: "My Feature",
      kind: "feature",
    });

    await removeWorktree({ projectRoot: repoDir, worktreePath: first.worktreePath });
    await registry.removeSession({ sessionId: first.id });

    const recreated = await registry.createSession({
      projectId: "p1",
      projectRoot: repoDir,
      name: "My Feature",
      kind: "feature",
    });

    expect(recreated.slug).toBe("my-feature");
    expect(recreated.branch).toBe("feature/my-feature");
    expect(existsSync(recreated.worktreePath)).toBe(true);
  });

  it("allocates a clean suffix instead of colliding with an unrelated directory", async () => {
    initGitRepo(repoDir);
    mkdirSync(join(repoDir, ".worktrees", "my-feature"), { recursive: true });
    const registry = createSessionRegistry({ storeFilePath });

    const session = await registry.createSession({
      projectId: "p1",
      projectRoot: repoDir,
      name: "My Feature",
      kind: "feature",
    });

    expect(session.slug).toBe("my-feature-2");
    expect(session.branch).toBe("feature/my-feature-2");
    expect(existsSync(session.worktreePath)).toBe(true);
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
    expect(() => execFileSync("git", ["check-ignore", "-q", PR_CONTEXT_ARTIFACT], { cwd: session.worktreePath })).not.toThrow();
    // Detached: the review branch is NOT "checked out" as a worktree branch.
    expect(branchExists(repoDir, "feature/to-review")).toBe(true);
  });

  it("createReviewSession accepts a worktree that matches the PR head SHA", async () => {
    initGitRepo(repoDir);
    execFileSync("git", ["branch", "feature/to-review"], { cwd: repoDir });
    const headSha = execFileSync("git", ["rev-parse", "feature/to-review"], { cwd: repoDir }).toString().trim();
    const registry = createSessionRegistry({ storeFilePath });

    const session = await registry.createReviewSession({
      projectId: "p1",
      projectRoot: repoDir,
      name: "Review fresh",
      reviewBranch: "feature/to-review",
      baseBranch: "main",
      expectedHeadSha: headSha,
    });

    expect(existsSync(session.worktreePath)).toBe(true);
  });

  it("createReviewSession refuses & rolls back a stale worktree when HEAD != PR head SHA", async () => {
    initGitRepo(repoDir);
    execFileSync("git", ["branch", "feature/to-review"], { cwd: repoDir });
    const registry = createSessionRegistry({ storeFilePath });

    await expect(
      registry.createReviewSession({
        projectId: "p1",
        projectRoot: repoDir,
        name: "Review stale",
        reviewBranch: "feature/to-review",
        baseBranch: "main",
        expectedHeadSha: "0".repeat(40), // not the branch's real tip
      }),
    ).rejects.toThrow(/latest commit|stale/i);

    // Rolled back: no worktree left behind and nothing persisted.
    expect(existsSync(join(repoDir, ".worktrees", "review-stale"))).toBe(false);
    await expect(registry.listSessions({ projectId: "p1" })).resolves.toEqual([]);
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
    expect(() => execFileSync("git", ["check-ignore", "-q", PR_CONTEXT_ARTIFACT], { cwd: session.worktreePath })).not.toThrow();
    // On the branch (writable), not a detached HEAD.
    const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: session.worktreePath })
      .toString()
      .trim();
    expect(head).toBe("feature/fixme");
  });

  it("markSetupDone flips setupDone (so setup runs once per worktree)", async () => {
    initGitRepo(repoDir);
    const registry = createSessionRegistry({ storeFilePath });
    const session = await registry.createSession({ projectId: "p1", projectRoot: repoDir, name: "Feat", kind: "feature" });
    expect(session.setupDone).toBe(false);

    await registry.markSetupDone({ sessionId: session.id });

    const reloaded = await registry.getSession({ sessionId: session.id });
    expect(reloaded?.setupDone).toBe(true);
  });

  it("reuses ignored build output and skips setup for a compatible worktree", async () => {
    initGitRepo(repoDir);
    writeFileSync(join(repoDir, ".gitignore"), "dist/\npackages/*/generated/\n", "utf8");
    execFileSync("git", ["add", ".gitignore"], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "ignore build output"], { cwd: repoDir });
    mkdirSync(join(repoDir, "dist"), { recursive: true });
    mkdirSync(join(repoDir, "packages", "api", "generated"), { recursive: true });
    writeFileSync(join(repoDir, "dist", "index.js"), "compiled\n", "utf8");
    writeFileSync(join(repoDir, "packages", "api", "generated", "schema.ts"), "generated\n", "utf8");
    const registry = createSessionRegistry({ storeFilePath });

    const session = await registry.createSession({
      projectId: "p1",
      projectRoot: repoDir,
      name: "Warm worktree",
      kind: "feature",
      reuseBuildArtifacts: true,
    });

    expect(session.setupDone).toBe(true);
    expect(readFileSync(join(session.worktreePath, "dist", "index.js"), "utf8")).toBe("compiled\n");
    expect(readFileSync(join(session.worktreePath, "packages", "api", "generated", "schema.ts"), "utf8")).toBe(
      "generated\n",
    );
  });

  it("rolls back the session when artifact reuse cannot be proven safe", async () => {
    initGitRepo(repoDir);
    writeFileSync(join(repoDir, ".gitignore"), "dist/\n", "utf8");
    execFileSync("git", ["add", ".gitignore"], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "ignore build output"], { cwd: repoDir });
    mkdirSync(join(repoDir, "dist"), { recursive: true });
    writeFileSync(join(repoDir, "dist", "index.js"), "compiled\n", "utf8");
    writeFileSync(join(repoDir, "README.md"), "dirty\n", "utf8");
    const registry = createSessionRegistry({ storeFilePath });

    await expect(
      registry.createSession({
        projectId: "p1",
        projectRoot: repoDir,
        name: "Unsafe warm worktree",
        kind: "feature",
        reuseBuildArtifacts: true,
      }),
    ).rejects.toThrow(/uncommitted tracked changes/i);

    expect(existsSync(join(repoDir, ".worktrees", "unsafe-warm-worktree"))).toBe(false);
    await expect(registry.listSessions({ projectId: "p1" })).resolves.toEqual([]);
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

  it("persists concurrent session creations without losing either record", async () => {
    initGitRepo(repoDir);
    const registry = createSessionRegistry({ storeFilePath });

    await Promise.all([
      registry.createSession({ projectId: "p1", projectRoot: repoDir, name: "One", kind: "feature" }),
      registry.createSession({ projectId: "p1", projectRoot: repoDir, name: "Two", kind: "feature" }),
    ]);

    const sessions = await registry.listSessions({ projectId: "p1" });
    expect(sessions.map((session) => session.name).sort()).toEqual(["One", "Two"]);
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

  it("does not let a late checkpoint update resurrect a concurrently deleted session", async () => {
    initGitRepo(repoDir);
    const registry = createSessionRegistry({ storeFilePath });
    const session = await registry.createSession({
      projectId: "p1",
      projectRoot: repoDir,
      name: "Race",
      kind: "feature",
    });

    const results = await Promise.allSettled([
      registry.removeSession({ sessionId: session.id }),
      registry.updateSessionCheckpoint({
        sessionId: session.id,
        checkpointPath: "docs/workflow/checkpoints/race-checkpoint.md",
      }),
    ]);

    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("rejected");
    await expect(registry.listSessions({ projectId: "p1" })).resolves.toEqual([]);
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
