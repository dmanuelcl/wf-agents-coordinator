import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addWorktreeExclude } from "./worktree-exclude";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-coordinator-exclude-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@e.co"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "x\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("addWorktreeExclude", () => {
  it("appends the pattern to .git/info/exclude (dir .git)", async () => {
    await addWorktreeExclude(dir, ".agent-review.md");
    const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".agent-review.md");
  });

  it("is idempotent", async () => {
    await addWorktreeExclude(dir, ".agent-review.md");
    await addWorktreeExclude(dir, ".agent-review.md");
    const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
    expect(exclude.match(/\.agent-review\.md/g)).toHaveLength(1);
  });

  it("resolves a linked worktree's common gitdir and creates an effective exclude", async () => {
    const wt = join(dir, "wt");
    execFileSync("git", ["worktree", "add", "--detach", wt], { cwd: dir });
    await addWorktreeExclude(wt, ".agent-review.md");
    const excludePath = join(dir, ".git", "info", "exclude");
    expect(readFileSync(excludePath, "utf8")).toContain(".agent-review.md");
    expect(() => execFileSync("git", ["check-ignore", "-q", ".agent-review.md"], { cwd: wt })).not.toThrow();
  });
});
