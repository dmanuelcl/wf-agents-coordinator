import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloneRepo, createEmptyRepo } from "./project-source";

let dir: string;

function initGitRepo(repoDir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "test\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-coordinator-project-source-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createEmptyRepo", () => {
  it("creates a real git repo at parentPath/name", async () => {
    const { rootPath } = await createEmptyRepo({ parentPath: dir, name: "my-project" });

    expect(rootPath).toBe(join(dir, "my-project"));
    expect(existsSync(join(rootPath, ".git"))).toBe(true);
  });

  it("succeeds when the target directory already exists but is empty", async () => {
    mkdirSync(join(dir, "empty-target"));

    const { rootPath } = await createEmptyRepo({ parentPath: dir, name: "empty-target" });

    expect(existsSync(join(rootPath, ".git"))).toBe(true);
  });

  it("rejects (no git call) when the target already exists and is non-empty", async () => {
    const targetPath = join(dir, "taken");
    mkdirSync(targetPath);
    writeFileSync(join(targetPath, "existing.txt"), "hi", "utf8");
    const execFileImpl = vi.fn();

    await expect(
      createEmptyRepo({ parentPath: dir, name: "taken", execFileImpl }),
    ).rejects.toThrow(/already exists/);
    expect(execFileImpl).not.toHaveBeenCalled();
  });
});

describe("cloneRepo", () => {
  it("clones a real repo, producing a working checkout at parentPath/name", async () => {
    const sourceDir = join(dir, "source");
    mkdirSync(sourceDir);
    initGitRepo(sourceDir);

    const targetParent = join(dir, "target-parent");
    mkdirSync(targetParent);

    const { rootPath } = await cloneRepo({ url: sourceDir, parentPath: targetParent, name: "cloned" });

    expect(rootPath).toBe(join(targetParent, "cloned"));
    expect(readFileSync(join(rootPath, "README.md"), "utf8")).toBe("test\n");
  });

  it("propagates a real git failure for a nonexistent source", async () => {
    const targetParent = join(dir, "target-parent");
    mkdirSync(targetParent);

    await expect(
      cloneRepo({ url: join(dir, "does-not-exist"), parentPath: targetParent, name: "cloned" }),
    ).rejects.toThrow();
    expect(existsSync(join(targetParent, "cloned"))).toBe(false);
  });
});
