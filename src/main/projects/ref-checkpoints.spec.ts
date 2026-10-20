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

function plumb(args: string[], input?: string): string {
  return execFileSync("git", args, { cwd: repoDir, input, maxBuffer: 64 * 1024 * 1024 }).toString().trim();
}

/**
 * Commit develop's tree plus over 1 MiB of path names (and any extra root
 * entries) as `branch`, built with plumbing so no files touch the disk.
 */
function commitBigTree(branch: string, ...extraRootEntries: string[]): void {
  const blob = plumb(["hash-object", "-w", "--stdin"], "filler\n");
  const fillerEntries = Array.from(
    { length: 6000 },
    (_, index) => `100644 blob ${blob}\t${String(index).padStart(6, "0")}-${"x".repeat(200)}.txt`,
  );
  const filler = plumb(["mktree"], `${fillerEntries.join("\n")}\n`);
  const rootEntries = [plumb(["ls-tree", "develop"]), `040000 tree ${filler}\tfiller`, ...extraRootEntries];
  const commit = plumb(["commit-tree", plumb(["mktree"], `${rootEntries.join("\n")}\n`), "-p", "develop", "-m", "a big repo"]);
  plumb(["update-ref", `refs/heads/${branch}`, commit]);
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

  it("still finds the checkpoints when the ref's full tree listing is larger than execFile's default buffer", async () => {
    commitBigTree("big");

    const found = await listRefCheckpoints({ projectRoot: repoDir, ref: "big", globs: GLOBS });

    expect(found.map((checkpoint) => checkpoint.path)).toEqual([
      "docs/workflow/checkpoints/auth-checkpoint.md",
      "docs/workflow/checkpoints/billing-checkpoint.md",
    ]);
  });

  it("lists the whole tree, however large, when a glob has no fixed directory", async () => {
    const checkpoint = ["---", "feature: root-level", "slug: root-level", "status: DONE", "---", ""].join("\n");
    commitBigTree("big-root", `100644 blob ${plumb(["hash-object", "-w", "--stdin"], checkpoint)}\troot-checkpoint.md`);

    const found = await listRefCheckpoints({ projectRoot: repoDir, ref: "big-root", globs: ["*-checkpoint.md"] });

    expect(found).toEqual([{ path: "root-checkpoint.md", feature: "root-level", slug: "root-level", status: "DONE" }]);
  });

  it("returns nothing for a ref that does not exist", async () => {
    expect(await listRefCheckpoints({ projectRoot: repoDir, ref: "no-such-branch", globs: GLOBS })).toEqual([]);
  });
});
