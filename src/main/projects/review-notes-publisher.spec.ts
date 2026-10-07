import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishReviewNotes, REVIEW_NOTES_DIR, reviewedCommitOf } from "./review-notes-publisher";

const BRANCH = "feature/x";
const NOTES = `${REVIEW_NOTES_DIR}/feature-x.md`;
const PR_LABEL = "PR #7";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

function write(dir: string, path: string, content: string): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
}

/**
 * A bare `origin` (fast-forward only, so a force push cannot pass) holding `feature/x`, and the review
 * worktree the way createReviewSession leaves it: a linked worktree detached at `origin/feature/x`.
 * `teammate` pushes to the branch from another clone, the way the PR author would.
 */
function reviewFixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-coordinator-review-notes-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const author = join(root, "author");
  const clone = join(root, "clone");
  const review = join(root, "review");

  run(root, "init", "-q", "--bare", "-b", "develop", origin);
  run(origin, "config", "receive.denyNonFastForwards", "true");

  run(root, "clone", "-q", origin, author);
  run(author, "config", "user.email", "author@example.test");
  run(author, "config", "user.name", "author");
  write(author, "src/app.ts", "export const app = 1;\n");
  run(author, "add", ".");
  run(author, "commit", "-q", "-m", "base");
  run(author, "push", "-q", "origin", "HEAD:refs/heads/develop");
  run(author, "checkout", "-q", "-b", BRANCH);
  write(author, "src/work.ts", "export const work = 1;\n");
  run(author, "add", ".");
  run(author, "commit", "-q", "-m", "work");
  run(author, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);

  run(root, "clone", "-q", origin, clone);
  run(clone, "config", "user.email", "reviewer@example.test");
  run(clone, "config", "user.name", "reviewer");
  run(clone, "worktree", "add", "-q", "--detach", review, `origin/${BRANCH}`);

  return {
    origin,
    review,
    reviewedSha: run(review, "rev-parse", "HEAD"),
    remoteHead: (): string => run(origin, "rev-parse", `refs/heads/${BRANCH}`),
    status: (): string[] =>
      execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: review, encoding: "utf8" })
        .split("\n")
        .filter(Boolean),
    teammate(path: string, content: string): string {
      write(author, path, content);
      run(author, "add", ".");
      run(author, "commit", "-q", "-m", `teammate: ${path}`);
      run(author, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
      return run(author, "rev-parse", "HEAD");
    },
    denyPushes(): void {
      const hook = join(origin, "hooks", "pre-receive");
      writeFileSync(hook, "#!/bin/sh\necho 'denied by the test hook' >&2\nexit 1\n");
      chmodSync(hook, 0o755);
    },
    allowPushes(): void {
      rmSync(join(origin, "hooks", "pre-receive"), { force: true });
    },
  };
}

const publish = (cwd: string) => publishReviewNotes({ cwd, sourceBranch: BRANCH, prLabel: PR_LABEL });
const filesOf = (cwd: string, sha: string): string[] =>
  run(cwd, "show", "--name-only", "--format=", sha).split("\n").filter(Boolean);
const rebaseInProgress = (cwd: string): boolean =>
  ["rebase-merge", "rebase-apply"].some((name) => existsSync(resolve(cwd, run(cwd, "rev-parse", "--git-path", name))));

describe("publishReviewNotes", () => {
  it("does nothing when the review left no notes, even with other files dirty", async () => {
    const fx = reviewFixture();
    write(fx.review, "src/app.ts", "export const app = 2;\n");
    const remoteBefore = fx.remoteHead();

    expect(await publish(fx.review)).toEqual({ committed: false });

    expect(run(fx.review, "rev-parse", "HEAD")).toBe(fx.reviewedSha);
    expect(fx.remoteHead()).toBe(remoteBefore);
    expect(fx.status()).toEqual([" M src/app.ts"]);
  });

  it("commits only the notes and fast-forwards the PR branch to that commit", async () => {
    const fx = reviewFixture();
    write(fx.review, NOTES, "# Notas\n- 🔵 una nota\n");
    write(fx.review, "src/app.ts", "export const app = 2;\n");
    write(fx.review, "scratch.txt", "not a note\n");

    const result = await publish(fx.review);

    expect(result.committed).toBe(true);
    if (!result.committed) return;
    expect(fx.remoteHead()).toBe(result.sha);
    expect(filesOf(fx.review, result.sha)).toEqual([NOTES]);
    expect(run(fx.review, "rev-parse", `${result.sha}^`)).toBe(fx.reviewedSha);
    expect(run(fx.review, "log", "-1", "--format=%s", result.sha)).toBe(`docs(review-notes): notas del review de ${PR_LABEL}`);
    expect(fx.status()).toEqual([" M src/app.ts", "?? scratch.txt"]);
  });

  it("replays the notes commit on top of a branch that advanced meanwhile, without forcing", async () => {
    const fx = reviewFixture();
    const pushedMeanwhile = fx.teammate("src/later.ts", "export const later = 1;\n");
    write(fx.review, NOTES, "# Notas\n- 🔵 una nota\n");
    write(fx.review, "src/app.ts", "export const app = 2;\n");

    const result = await publish(fx.review);

    expect(result.committed).toBe(true);
    if (!result.committed) return;
    expect(fx.remoteHead()).toBe(result.sha);
    expect(run(fx.review, "rev-parse", `${result.sha}^`)).toBe(pushedMeanwhile);
    expect(filesOf(fx.review, result.sha)).toEqual([NOTES]);
    expect(rebaseInProgress(fx.review)).toBe(false);
    // The unrelated local edit survives the replay.
    expect(fx.status()).toEqual([" M src/app.ts"]);
  });

  it("fails without posting when the branch changed the same notes file, and leaves the worktree ready to retry", async () => {
    const fx = reviewFixture();
    const pushedMeanwhile = fx.teammate(NOTES, "# Notas\n- otra nota\n");
    write(fx.review, NOTES, "# Notas\n- 🔵 una nota\n");

    const failure = await publish(fx.review).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toMatch(/could not push the review notes/i);
    expect(message).toContain(BRANCH);
    expect(message).toMatch(/NOT posted/);
    expect(message).toMatch(/CONFLICT|conflict/);
    expect(fx.remoteHead()).toBe(pushedMeanwhile);
    expect(rebaseInProgress(fx.review)).toBe(false);
    expect(run(fx.review, "rev-parse", "HEAD")).toBe(fx.reviewedSha);
    expect(fx.status()).toEqual([`A  ${NOTES}`]);
  });

  it("undoes the notes commit when the push is refused, so pressing Post again publishes them", async () => {
    const fx = reviewFixture();
    const remoteBefore = fx.remoteHead();
    write(fx.review, NOTES, "# Notas\n- 🔵 una nota\n");
    fx.denyPushes();

    await expect(publish(fx.review)).rejects.toThrow(/denied by the test hook/);

    expect(fx.remoteHead()).toBe(remoteBefore);
    expect(run(fx.review, "rev-parse", "HEAD")).toBe(fx.reviewedSha);
    expect(fx.status()).toEqual([`A  ${NOTES}`]);

    fx.allowPushes();
    const retry = await publish(fx.review);
    expect(retry.committed).toBe(true);
    if (!retry.committed) return;
    expect(fx.remoteHead()).toBe(retry.sha);
    expect(filesOf(fx.review, retry.sha)).toEqual([NOTES]);
  });

  it("puts the reviewed code back when the push after the replay is refused", async () => {
    const fx = reviewFixture();
    const pushedMeanwhile = fx.teammate("src/later.ts", "export const later = 1;\n");
    write(fx.review, NOTES, "# Notas\n- 🔵 una nota\n");
    fx.denyPushes();

    await expect(publish(fx.review)).rejects.toThrow(/NOT posted/);

    expect(fx.remoteHead()).toBe(pushedMeanwhile);
    expect(run(fx.review, "rev-parse", "HEAD")).toBe(fx.reviewedSha);
    expect(existsSync(join(fx.review, "src/later.ts"))).toBe(false);
    expect(fx.status()).toEqual([`A  ${NOTES}`]);
  });
});

describe("reviewedCommitOf", () => {
  const trailerOf = (cwd: string): string =>
    run(cwd, "log", "-1", "--format=%(trailers:key=Reviewed-Commit,valueonly)", "HEAD");

  it("resolves a published notes commit to the commit the review covered", async () => {
    const fx = reviewFixture();
    write(fx.review, NOTES, "# Notas\n- 🔵 una nota\n");
    await publish(fx.review);

    expect(trailerOf(fx.review)).toBe(fx.reviewedSha);
    expect(await reviewedCommitOf(fx.review)).toBe(fx.reviewedSha);
  });

  it("still resolves to the reviewed commit after a replay, where HEAD~1 is a commit nobody reviewed", async () => {
    const fx = reviewFixture();
    const pushedMeanwhile = fx.teammate("src/later.ts", "export const later = 1;\n");
    write(fx.review, NOTES, "# Notas\n- 🔵 una nota\n");
    await publish(fx.review);

    expect(run(fx.review, "rev-parse", "HEAD~1")).toBe(pushedMeanwhile);
    expect(await reviewedCommitOf(fx.review)).toBe(fx.reviewedSha);
  });

  it("keeps naming the reviewed commit when a later Post commits more notes on top", async () => {
    const fx = reviewFixture();
    fx.teammate("src/later.ts", "export const later = 1;\n");
    write(fx.review, NOTES, "# Notas\n- 🔵 una nota\n");
    await publish(fx.review);
    write(fx.review, NOTES, "# Notas\n- 🔵 una nota\n- 🔵 otra nota\n");
    await publish(fx.review);

    expect(trailerOf(fx.review)).toBe(fx.reviewedSha);
    expect(await reviewedCommitOf(fx.review)).toBe(fx.reviewedSha);
  });

  it("is HEAD for a commit without the trailer, even one that only touches the notes", async () => {
    const fx = reviewFixture();
    write(fx.review, NOTES, "# Notas\n");
    run(fx.review, "add", "--", NOTES);
    run(fx.review, "commit", "-q", "-m", "docs: notas a mano");

    expect(await reviewedCommitOf(fx.review)).toBe(run(fx.review, "rev-parse", "HEAD"));
  });

  it("is HEAD for a commit with the trailer that also touches another path", async () => {
    const fx = reviewFixture();
    write(fx.review, NOTES, "# Notas\n");
    write(fx.review, "src/app.ts", "export const app = 2;\n");
    run(fx.review, "add", "--", NOTES, "src/app.ts");
    run(fx.review, "commit", "-q", "-m", "docs(review-notes): notas", "-m", `Reviewed-Commit: ${fx.reviewedSha}`);

    expect(trailerOf(fx.review)).toBe(fx.reviewedSha);
    expect(await reviewedCommitOf(fx.review)).toBe(run(fx.review, "rev-parse", "HEAD"));
  });

  it("is HEAD on the commit the review session started from", async () => {
    const fx = reviewFixture();
    expect(await reviewedCommitOf(fx.review)).toBe(fx.reviewedSha);
  });
});
