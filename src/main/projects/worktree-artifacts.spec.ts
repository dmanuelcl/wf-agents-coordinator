import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reuseWorktreeArtifacts } from "./worktree-artifacts";
import { createWorktree } from "./worktree-manager";

let repoDir: string;

function commitAll(): void {
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repoDir });
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "agent-coordinator-artifacts-"));
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "test\n", "utf8");
  writeFileSync(join(repoDir, ".gitignore"), "dist/\npackages/*/generated/\n", "utf8");
  commitAll();
  execFileSync("git", ["branch", "feature/reuse"], { cwd: repoDir });
});

afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

describe("reuseWorktreeArtifacts", () => {
  it("copies ignored dist/generated trees into a worktree", async () => {
    mkdirSync(join(repoDir, "dist"), { recursive: true });
    mkdirSync(join(repoDir, "packages", "api", "generated"), { recursive: true });
    writeFileSync(join(repoDir, "dist", "index.js"), "compiled\n", "utf8");
    writeFileSync(join(repoDir, "packages", "api", "generated", "schema.ts"), "generated\n", "utf8");
    const worktreePath = join(repoDir, ".worktrees", "reuse");
    await createWorktree({ projectRoot: repoDir, slug: "reuse", branch: "feature/reuse" });

    const result = await reuseWorktreeArtifacts({ projectRoot: repoDir, worktreePath });

    expect(result.directories.sort()).toEqual(["dist", join("packages", "api", "generated")].sort());
    expect(result.filesCopied).toBe(2);
    expect(readFileSync(join(worktreePath, "dist", "index.js"), "utf8")).toBe("compiled\n");
    expect(readFileSync(join(worktreePath, "packages", "api", "generated", "schema.ts"), "utf8")).toBe(
      "generated\n",
    );
  });

  it("refuses reuse when the repo root has tracked changes", async () => {
    mkdirSync(join(repoDir, "dist"), { recursive: true });
    writeFileSync(join(repoDir, "dist", "index.js"), "compiled\n", "utf8");
    writeFileSync(join(repoDir, "README.md"), "dirty\n", "utf8");
    const worktreePath = join(repoDir, ".worktrees", "reuse");
    await createWorktree({ projectRoot: repoDir, slug: "reuse", branch: "feature/reuse" });

    await expect(reuseWorktreeArtifacts({ projectRoot: repoDir, worktreePath })).rejects.toThrow(
      /uncommitted tracked changes/i,
    );
    expect(existsSync(join(worktreePath, "dist"))).toBe(false);
  });

  it("refuses to treat tracked generated source as reusable output", async () => {
    mkdirSync(join(repoDir, "src", "generated"), { recursive: true });
    writeFileSync(join(repoDir, "src", "generated", "tracked.ts"), "tracked\n", "utf8");
    commitAll();
    execFileSync("git", ["branch", "-f", "feature/reuse", "HEAD"], { cwd: repoDir });
    const worktreePath = join(repoDir, ".worktrees", "reuse");
    await createWorktree({ projectRoot: repoDir, slug: "reuse", branch: "feature/reuse" });

    await expect(reuseWorktreeArtifacts({ projectRoot: repoDir, worktreePath })).rejects.toThrow(
      /no ignored dist\/generated/i,
    );
  });
});
