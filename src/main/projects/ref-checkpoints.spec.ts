import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRefCheckpoints, matchesCheckpointGlob } from "./ref-checkpoints";

const GLOBS = ["docs/workflow/checkpoints/*-checkpoint.md"];

describe("matchesCheckpointGlob", () => {
  it("matches a checkpoint in the configured directory", () => {
    expect(matchesCheckpointGlob("docs/workflow/checkpoints/auth-checkpoint.md", GLOBS[0] as string)).toBe(true);
  });

  it("rejects a file in the directory that is not a checkpoint", () => {
    expect(matchesCheckpointGlob("docs/workflow/checkpoints/README.md", GLOBS[0] as string)).toBe(false);
  });

  it("does not let a wildcard cross a directory boundary", () => {
    expect(matchesCheckpointGlob("docs/workflow/checkpoints/old/auth-checkpoint.md", GLOBS[0] as string)).toBe(false);
  });

  it("rejects a same-named checkpoint outside the configured directory", () => {
    expect(matchesCheckpointGlob("notes/auth-checkpoint.md", GLOBS[0] as string)).toBe(false);
  });
});

let repoDir: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repoDir });
}

function writeCheckpoint(name: string, feature: string, status: string): void {
  const dir = join(repoDir, "docs", "workflow", "checkpoints");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    ["---", `feature: ${feature}`, `slug: ${feature}`, `status: ${status}`, "---", "", `# ${feature}`, ""].join("\n"),
    "utf8",
  );
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "agent-coordinator-refcp-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repoDir, "README.md"), "test\n", "utf8");
  git("add", ".");
  git("commit", "-q", "-m", "init");

  git("checkout", "-q", "-b", "develop");
  writeCheckpoint("auth-checkpoint.md", "auth-rotation", "IN_PROGRESS");
  writeCheckpoint("billing-checkpoint.md", "billing-retry", "DONE");
  writeFileSync(join(repoDir, "docs", "workflow", "checkpoints", "README.md"), "not a checkpoint\n", "utf8");
  git("add", ".");
  git("commit", "-q", "-m", "architect writes the plans");
  git("checkout", "-q", "main");
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe("listRefCheckpoints", () => {
  it("reads a ref's checkpoints without checking it out", async () => {
    const found = await listRefCheckpoints({ projectRoot: repoDir, ref: "develop", globs: GLOBS });

    expect(found).toEqual([
      {
        path: "docs/workflow/checkpoints/auth-checkpoint.md",
        feature: "auth-rotation",
        slug: "auth-rotation",
        status: "IN_PROGRESS",
      },
      {
        path: "docs/workflow/checkpoints/billing-checkpoint.md",
        feature: "billing-retry",
        slug: "billing-retry",
        status: "DONE",
      },
    ]);
    // The working tree is still on main and untouched.
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir }).toString().trim()).toBe("main");
  });

  it("returns nothing for a ref that has no checkpoints", async () => {
    expect(await listRefCheckpoints({ projectRoot: repoDir, ref: "main", globs: GLOBS })).toEqual([]);
  });

  it("returns nothing for a ref that does not exist", async () => {
    expect(await listRefCheckpoints({ projectRoot: repoDir, ref: "no-such-branch", globs: GLOBS })).toEqual([]);
  });
});
