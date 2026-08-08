import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkpointCommitState } from "./checkpoint-commit-gate";

const CHECKPOINT = "docs/workflow/checkpoints/auth-checkpoint.md";

let repoDir: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repoDir });
}

function writeCheckpoint(next: string): void {
  mkdirSync(join(repoDir, "docs", "workflow", "checkpoints"), { recursive: true });
  writeFileSync(join(repoDir, CHECKPOINT), `# ▶ NEXT\n- **Rol:** ${next}\n`, "utf8");
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "agent-coordinator-commit-gate-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repoDir, "README.md"), "init\n", "utf8");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe("checkpointCommitState", () => {
  it("reports a checkpoint the agent wrote but has not committed yet", async () => {
    writeCheckpoint("implementer");

    expect(await checkpointCommitState({ worktreePath: repoDir, checkpointPath: CHECKPOINT })).toBe("uncommitted");
  });

  it("reports a staged-but-uncommitted checkpoint as uncommitted", async () => {
    writeCheckpoint("implementer");
    git("add", CHECKPOINT);

    expect(await checkpointCommitState({ worktreePath: repoDir, checkpointPath: CHECKPOINT })).toBe("uncommitted");
  });

  it("reports the hand-off as committed once the agent commits it", async () => {
    writeCheckpoint("implementer");
    git("add", CHECKPOINT);
    git("commit", "-q", "-m", "hand off to implementer");

    expect(await checkpointCommitState({ worktreePath: repoDir, checkpointPath: CHECKPOINT })).toBe("committed");
  });

  it("goes back to uncommitted when the agent edits NEXT again after committing", async () => {
    writeCheckpoint("implementer");
    git("add", CHECKPOINT);
    git("commit", "-q", "-m", "hand off to implementer");
    writeCheckpoint("reviewer");

    expect(await checkpointCommitState({ worktreePath: repoDir, checkpointPath: CHECKPOINT })).toBe("uncommitted");
  });

  // `git status` says nothing about an ignored file, which would read as clean.
  // Trackedness is checked separately so an ignored checkpoint cannot open the gate.
  it("reports an untracked checkpoint as uncommitted even when git ignores it", async () => {
    writeFileSync(join(repoDir, ".gitignore"), "docs/workflow/checkpoints/\n", "utf8");
    git("add", ".gitignore");
    git("commit", "-q", "-m", "ignore checkpoints");
    writeCheckpoint("implementer");

    expect(await checkpointCommitState({ worktreePath: repoDir, checkpointPath: CHECKPOINT })).toBe("uncommitted");
  });

  it("reports unknown when the worktree is not a git repository", async () => {
    const plainDir = mkdtempSync(join(tmpdir(), "agent-coordinator-not-a-repo-"));
    try {
      expect(await checkpointCommitState({ worktreePath: plainDir, checkpointPath: CHECKPOINT })).toBe("unknown");
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });
});
