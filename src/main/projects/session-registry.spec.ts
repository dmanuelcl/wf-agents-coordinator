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
      diagnoseFirst: true,
    });

    expect(session.kind).toBe("pr-fix");
    expect(session.prFixDiagnoseFirst).toBe(true);
    expect(session.branch).toBe("feature/fixme");
    expect(existsSync(session.worktreePath)).toBe(true);
    expect(() => execFileSync("git", ["check-ignore", "-q", PR_CONTEXT_ARTIFACT], { cwd: session.worktreePath })).not.toThrow();
    // On the branch (writable), not a detached HEAD.
    const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: session.worktreePath })
      .toString()
      .trim();
    expect(head).toBe("feature/fixme");

    const reloaded = await registry.getSession({ sessionId: session.id });
    expect(reloaded?.prFixDiagnoseFirst).toBe(true);
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

// A session that picks up work someone else started: another dev's branch, or
// a base branch on which a global architect committed the specs and plan.
describe("SessionRegistry · startFrom", () => {
  let remoteDir: string;

  function currentBranch(dir: string): string {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir }).toString().trim();
  }

  function commitFile(dir: string, name: string, message: string): void {
    writeFileSync(join(dir, name), `${name}\n`, "utf8");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
  }

  function writeCheckpoint(dir: string, name: string, slug: string): string {
    const relative = join("docs", "workflow", "checkpoints", name);
    mkdirSync(join(dir, "docs", "workflow", "checkpoints"), { recursive: true });
    writeFileSync(join(dir, relative), `---\nfeature: ${slug}\nslug: ${slug}\nstatus: IN_PROGRESS\n---\n`, "utf8");
    return relative;
  }

  /** Give `repoDir` a bare origin and publish its starting branch. */
  function addRemote(): string {
    remoteDir = mkdtempSync(join(tmpdir(), "agent-coordinator-remote-"));
    execFileSync("git", ["init", "-q", "--bare"], { cwd: remoteDir });
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
    execFileSync("git", ["push", "-q", "-u", "origin", currentBranch(repoDir)], { cwd: repoDir });
    return remoteDir;
  }

  /** A teammate pushing to `branch` from their own checkout. */
  function advanceRemote(branch: string, fileName: string): void {
    const clone = mkdtempSync(join(tmpdir(), "agent-coordinator-clone-"));
    execFileSync("git", ["clone", "-q", remoteDir, clone]);
    execFileSync("git", ["config", "user.email", "other@example.com"], { cwd: clone });
    execFileSync("git", ["config", "user.name", "Other"], { cwd: clone });
    execFileSync("git", ["checkout", "-q", branch], { cwd: clone });
    commitFile(clone, fileName, `teammate ${fileName}`);
    execFileSync("git", ["push", "-q", "origin", branch], { cwd: clone });
    rmSync(clone, { recursive: true, force: true });
  }

  afterEach(() => {
    if (remoteDir) rmSync(remoteDir, { recursive: true, force: true });
  });

  it("continue checks out the chosen branch writable, keeping the session kind", async () => {
    initGitRepo(repoDir);
    execFileSync("git", ["branch", "feature/auth"], { cwd: repoDir });
    const registry = createSessionRegistry({ storeFilePath });

    const session = await registry.createSession({
      projectId: "p1",
      projectRoot: repoDir,
      name: "Continue auth",
      kind: "feature",
      startFrom: { mode: "continue", ref: "feature/auth" },
    });

    expect(session.kind).toBe("feature");
    expect(session.branch).toBe("feature/auth");
    expect(existsSync(session.worktreePath)).toBe(true);
    // Writable, not detached: the worktree is ON the branch, so commits land there.
    expect(currentBranch(session.worktreePath)).toBe("feature/auth");
  });

  it("continue adopts the chosen checkpoint so the workflow gate opens at creation", async () => {
    initGitRepo(repoDir);
    execFileSync("git", ["checkout", "-q", "-b", "feature/auth"], { cwd: repoDir });
    const checkpoint = writeCheckpoint(repoDir, "auth-checkpoint.md", "auth");
    commitFile(repoDir, "impl.txt", "architect hands off");
    execFileSync("git", ["checkout", "-q", "-"], { cwd: repoDir });
    const registry = createSessionRegistry({ storeFilePath });

    const session = await registry.createSession({
      projectId: "p1",
      projectRoot: repoDir,
      name: "Continue auth",
      kind: "feature",
      startFrom: { mode: "continue", ref: "feature/auth", checkpointPath: checkpoint },
    });

    expect(session.checkpointPath).toBe(checkpoint);
    expect(existsSync(join(session.worktreePath, checkpoint))).toBe(true);
  });

  it("continue fast-forwards a branch that is behind its remote", async () => {
    initGitRepo(repoDir);
    addRemote();
    execFileSync("git", ["push", "-q", "-u", "origin", `${currentBranch(repoDir)}:feature/auth`], { cwd: repoDir });
    execFileSync("git", ["branch", "feature/auth", `origin/feature/auth`], { cwd: repoDir });
    advanceRemote("feature/auth", "teammate.txt");
    const registry = createSessionRegistry({ storeFilePath });

    const session = await registry.createSession({
      projectId: "p1",
      projectRoot: repoDir,
      name: "Continue auth",
      kind: "feature",
      startFrom: { mode: "continue", ref: "feature/auth" },
    });

    expect(existsSync(join(session.worktreePath, "teammate.txt"))).toBe(true);
  });

  it("continue refuses & rolls back when the branch diverged from its remote", async () => {
    initGitRepo(repoDir);
    addRemote();
    execFileSync("git", ["push", "-q", "origin", `${currentBranch(repoDir)}:feature/auth`], { cwd: repoDir });
    execFileSync("git", ["fetch", "-q", "origin"], { cwd: repoDir });
    execFileSync("git", ["branch", "feature/auth", "origin/feature/auth"], { cwd: repoDir });
    advanceRemote("feature/auth", "teammate.txt");
    // Our own commit on the same branch, made without their work.
    execFileSync("git", ["checkout", "-q", "feature/auth"], { cwd: repoDir });
    commitFile(repoDir, "mine.txt", "my work");
    execFileSync("git", ["checkout", "-q", "-"], { cwd: repoDir });
    const registry = createSessionRegistry({ storeFilePath });

    await expect(
      registry.createSession({
        projectId: "p1",
        projectRoot: repoDir,
        name: "Continue auth",
        kind: "feature",
        startFrom: { mode: "continue", ref: "feature/auth" },
      }),
    ).rejects.toThrow(/diverged/i);

    expect(existsSync(join(repoDir, ".worktrees", "continue-auth"))).toBe(false);
    await expect(registry.listSessions({ projectId: "p1" })).resolves.toEqual([]);
    // Their branch is not ours to delete on rollback.
    expect(branchExists(repoDir, "feature/auth")).toBe(true);
  });

  it("continue refuses a branch that is already checked out elsewhere", async () => {
    initGitRepo(repoDir);
    const root = currentBranch(repoDir);
    const registry = createSessionRegistry({ storeFilePath });

    await expect(
      registry.createSession({
        projectId: "p1",
        projectRoot: repoDir,
        name: "Continue root",
        kind: "feature",
        startFrom: { mode: "continue", ref: root },
      }),
    ).rejects.toThrow(/already checked out/i);
  });

  it("names the session already holding a branch instead of only its worktree path", async () => {
    initGitRepo(repoDir);
    execFileSync("git", ["branch", "feature/auth"], { cwd: repoDir });
    const registry = createSessionRegistry({ storeFilePath });
    await registry.createSession({
      projectId: "p1",
      projectRoot: repoDir,
      name: "Auth work",
      kind: "feature",
      startFrom: { mode: "continue", ref: "feature/auth" },
    });

    await expect(
      registry.createSession({
        projectId: "p1",
        projectRoot: repoDir,
        name: "Auth again",
        kind: "feature",
        startFrom: { mode: "continue", ref: "feature/auth" },
      }),
    ).rejects.toThrow(/Auth work/);
  });

  it("continue creates a local tracking branch for a remote-only branch", async () => {
    initGitRepo(repoDir);
    addRemote();
    execFileSync("git", ["push", "-q", "origin", `${currentBranch(repoDir)}:feature/theirs`], { cwd: repoDir });
    execFileSync("git", ["fetch", "-q", "origin"], { cwd: repoDir });
    expect(branchExists(repoDir, "feature/theirs")).toBe(false);
    const registry = createSessionRegistry({ storeFilePath });

    const session = await registry.createSession({
      projectId: "p1",
      projectRoot: repoDir,
      name: "Continue theirs",
      kind: "feature",
      startFrom: { mode: "continue", ref: "feature/theirs" },
    });

    expect(session.branch).toBe("feature/theirs");
    expect(currentBranch(session.worktreePath)).toBe("feature/theirs");
  });

  it("continue accepts a remote-qualified ref and still checks out a writable branch", async () => {
    initGitRepo(repoDir);
    addRemote();
    execFileSync("git", ["push", "-q", "origin", `${currentBranch(repoDir)}:feature/theirs`], { cwd: repoDir });
    execFileSync("git", ["fetch", "-q", "origin"], { cwd: repoDir });
    const registry = createSessionRegistry({ storeFilePath });

    const session = await registry.createSession({
      projectId: "p1",
      projectRoot: repoDir,
      name: "Continue qualified",
      kind: "feature",
      startFrom: { mode: "continue", ref: "origin/feature/theirs" },
    });

    expect(session.branch).toBe("feature/theirs");
    expect(currentBranch(session.worktreePath)).toBe("feature/theirs");
  });

  it("fork branches off the published base and records it as the session's base", async () => {
    initGitRepo(repoDir);
    execFileSync("git", ["checkout", "-q", "-b", "develop"], { cwd: repoDir });
    const checkpoint = writeCheckpoint(repoDir, "auth-checkpoint.md", "auth");
    commitFile(repoDir, "spec.txt", "architect writes the specs");
    execFileSync("git", ["checkout", "-q", "-"], { cwd: repoDir });
    const registry = createSessionRegistry({ storeFilePath });

    const session = await registry.createSession({
      projectId: "p1",
      projectRoot: repoDir,
      name: "Auth rotation",
      kind: "feature",
      startFrom: { mode: "fork", ref: "develop", checkpointPath: checkpoint },
    });

    expect(session.branch).toBe("feature/auth-rotation");
    expect(session.baseBranch).toBe("develop");
    expect(session.checkpointPath).toBe(checkpoint);
    // It inherited the architect's work even though the root was not on develop.
    expect(existsSync(join(session.worktreePath, "spec.txt"))).toBe(true);
    expect(existsSync(join(session.worktreePath, checkpoint))).toBe(true);
  });

  it("records the repo root's current branch as the base of an ordinary session", async () => {
    initGitRepo(repoDir);
    execFileSync("git", ["checkout", "-q", "-b", "develop"], { cwd: repoDir });
    commitFile(repoDir, "dev.txt", "develop work");
    const registry = createSessionRegistry({ storeFilePath });

    const session = await registry.createSession({
      projectId: "p1",
      projectRoot: repoDir,
      name: "Plain",
      kind: "feature",
    });

    expect(session.baseBranch).toBe("develop");
    expect(session.checkpointPath).toBeNull();
  });
});
