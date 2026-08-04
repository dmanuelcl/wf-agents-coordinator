import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWorktreeDiff } from "./worktree-diff";

let repoDir: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repoDir });
}

function commit(name: string, message: string): void {
  writeFileSync(join(repoDir, name), `${name}\n`, "utf8");
  git("add", ".");
  git("commit", "-q", "-m", message);
}

// main ── develop ── feature/auth
//          (dev.txt)   (feat.txt)
// Sessions branch off the repo root, which in practice is `develop`, so a diff
// resolved against `main` carries develop's delta as noise.
beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "agent-coordinator-diff-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  commit("README.md", "init");
  git("checkout", "-q", "-b", "develop");
  commit("dev.txt", "develop work");
  git("checkout", "-q", "-b", "feature/auth");
  commit("feat.txt", "feature work");
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe("getWorktreeDiff", () => {
  it("shows only the session's own work when given its real base branch", async () => {
    const diff = await getWorktreeDiff(repoDir, "develop");

    expect(diff).toContain("feat.txt");
    expect(diff).not.toContain("dev.txt");
  });

  it("falls back to main when no base branch is recorded", async () => {
    const diff = await getWorktreeDiff(repoDir);

    expect(diff).toContain("feat.txt");
    expect(diff).toContain("dev.txt");
  });

  it("falls back to main when the recorded base branch no longer resolves", async () => {
    const diff = await getWorktreeDiff(repoDir, "deleted-branch");

    expect(diff).toContain("feat.txt");
    expect(diff).toContain("dev.txt");
  });

  it("includes untracked files alongside the committed work", async () => {
    writeFileSync(join(repoDir, "scratch.txt"), "scratch\n", "utf8");

    const diff = await getWorktreeDiff(repoDir, "develop");

    expect(diff).toContain("scratch.txt");
  });
});
