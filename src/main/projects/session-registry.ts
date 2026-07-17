import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { slugifySessionName } from "../../shared/workflow/work-session";
import type { PrLink, WorkSession, WorkSessionKind } from "../../shared/workflow/work-session";
import { buildWorktreeCreatePlan, createWorktree, removeWorktree } from "./worktree-manager";
import { addWorktreeExclude } from "./worktree-exclude";

// The gitignored review artifact a PR-review reviewer writes; posted to the PR.
export const REVIEW_ARTIFACT = ".agent-review.md";
// Complete PR conversation read by review/fix agents instead of embedding it in a prompt.
export const PR_CONTEXT_ARTIFACT = ".agent-pr-context.md";

export interface SessionRegistry {
  listSessions(params: { projectId: string }): Promise<WorkSession[]>;
  getSession(params: { sessionId: string }): Promise<WorkSession | null>;
  createSession(params: {
    projectId: string;
    projectRoot: string;
    name: string;
    kind: WorkSessionKind;
    copyEnv?: boolean;
  }): Promise<WorkSession>;
  createReviewSession(params: {
    projectId: string;
    projectRoot: string;
    name: string;
    reviewBranch: string;
    baseBranch: string;
    pr?: PrLink | null;
    // Fetch remotes before creating the worktree (PR-link reviews check out a remote ref).
    fetchFirst?: boolean;
    // The PR's head commit SHA (from the host API). When set, creation verifies the
    // worktree actually landed on it and fails loudly instead of yielding a stale checkout.
    expectedHeadSha?: string;
  }): Promise<WorkSession>;
  createFixSession(params: {
    projectId: string;
    projectRoot: string;
    name: string;
    branch: string; // the PR source branch (writable checkout)
    baseBranch: string; // diff context (e.g. origin/<target>)
    pr: PrLink;
    // The PR's head commit SHA (from the host API); verified after checkout — see above.
    expectedHeadSha?: string;
  }): Promise<WorkSession>;
  updateSessionCheckpoint(params: { sessionId: string; checkpointPath: string }): Promise<void>;
  setReviewedSha(params: { sessionId: string; sha: string }): Promise<void>;
  markSetupDone(params: { sessionId: string }): Promise<void>;
  removeSession(params: { sessionId: string }): Promise<void>;
}

const ENV_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".worktrees",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
]);

function isEnvFile(name: string): boolean {
  return /^\.env(\.|$)/.test(name) && !/\.(example|sample|template)$/i.test(name);
}

// Copy the project's gitignored env files into the new worktree so it can run —
// a fresh checkout has none. Walks recursively so monorepos with per-package
// `.env` (packages/api/.env, apps/web/.env.local, …) are covered, mirroring the
// relative path. Heavy/ignored dirs are skipped, depth is bounded, committed
// examples are skipped, and failures are best-effort (never block creation).
async function copyEnvFiles(projectRoot: string, worktreePath: string, dir = projectRoot, depth = 0): Promise<void> {
  if (depth > 6) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ENV_SKIP_DIRS.has(entry.name)) {
        await copyEnvFiles(projectRoot, worktreePath, full, depth + 1);
      }
      continue;
    }
    if (!entry.isFile() || !isEnvFile(entry.name)) continue;
    const target = join(worktreePath, relative(projectRoot, full));
    try {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(full, target);
    } catch {
      // a locked/missing file must not fail session creation
    }
  }
}

// Fetch all remotes so a PR's source ref is current before we check it out.
// Returns the error message on failure instead of throwing, so the caller can
// decide what to do — a failed fetch usually means the checkout would be stale,
// which we surface via the head-SHA guard below rather than swallowing silently.
async function fetchRemotes(projectRoot: string): Promise<string | null> {
  try {
    await execFileAsync("git", ["fetch", "--all", "--prune"], { cwd: projectRoot });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Same commit? Tolerates short-vs-full hashes so a host's abbreviated SHA still matches. */
function sameCommit(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

async function worktreeHeadSha(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function localBranchExists(projectRoot: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: projectRoot });
    return true;
  } catch {
    return false;
  }
}

/** Error for "the worktree isn't on the PR's latest commit" — names the likely cause. */
function staleWorktreeError(label: string, headSha: string, expectedHeadSha: string, fetchError: string | null): Error {
  const short = (sha: string) => (sha ? sha.slice(0, 9) : "an unknown commit");
  const cause = fetchError
    ? `Fetching the latest changes from the remote failed:\n${fetchError}`
    : "The local copy of the branch is behind the PR — check your git access to the remote, or retry in a moment if it was just pushed.";
  return new Error(
    `Won't create a stale worktree for "${label}": it landed on ${short(headSha)} but the PR's latest commit is ${short(expectedHeadSha)}. ${cause}`,
  );
}

/**
 * Persists WorkSessions for every project in a single JSON store, mirroring the
 * project-registry pattern (JSON now, SQLite later). One session = one worktree
 * on its own `<kind>/<slug>` branch, created at session creation.
 */
export function createSessionRegistry(params: { storeFilePath: string }): SessionRegistry {
  const { storeFilePath } = params;

  async function readAll(): Promise<WorkSession[]> {
    try {
      const raw = await readFile(storeFilePath, "utf8");
      return JSON.parse(raw) as WorkSession[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async function writeAll(records: WorkSession[]): Promise<void> {
    await mkdir(dirname(storeFilePath), { recursive: true });
    await writeFile(storeFilePath, JSON.stringify(records, null, 2), "utf8");
  }

  return {
    async listSessions({ projectId }) {
      const records = await readAll();
      return records.filter((record) => record.projectId === projectId);
    },

    async getSession({ sessionId }) {
      const records = await readAll();
      return records.find((record) => record.id === sessionId) ?? null;
    },

    async createSession({ projectId, projectRoot, name, kind, copyEnv }) {
      const slug = slugifySessionName(name);
      if (!slug) {
        throw new Error("Session name cannot be empty");
      }

      const branch = `${kind === "fix" ? "fix" : "feature"}/${slug}`;
      const worktreePath = buildWorktreeCreatePlan({ projectRoot, slug, branch }).path;

      await createWorktree({ projectRoot, slug, branch, createBranch: true });

      if (copyEnv) {
        await copyEnvFiles(projectRoot, worktreePath);
      }

      const records = await readAll();
      const record: WorkSession = {
        id: randomUUID(),
        projectId,
        name,
        kind,
        slug,
        branch,
        baseBranch: null,
        pr: null,
        worktreePath,
        checkpointPath: null,
        setupDone: false,
        createdAtEpochMs: Date.now(),
      };

      records.push(record);
      await writeAll(records);
      return record;
    },

    async createReviewSession({ projectId, projectRoot, name, reviewBranch, baseBranch, pr, fetchFirst, expectedHeadSha }) {
      const slug = slugifySessionName(name);
      if (!slug) {
        throw new Error("Session name cannot be empty");
      }

      // A PR-link review checks out a remote ref (origin/…) — make it current.
      // We capture (never swallow) the fetch error so a failed fetch surfaces via
      // the head-SHA guard below instead of silently reviewing out-of-date code.
      const fetchError = fetchFirst ? await fetchRemotes(projectRoot) : null;

      const worktreePath = buildWorktreeCreatePlan({ projectRoot, slug, branch: reviewBranch }).path;
      // Detached at the ref under review (works for local and `origin/…` remote
      // branches); non-destructive and never conflicts with a branch checked out
      // elsewhere.
      await createWorktree({ projectRoot, slug, branch: reviewBranch, detach: true });

      // Freshness guard: if the host reported the PR's head commit, the detached
      // worktree must be sitting on it. If not (e.g. the fetch failed), roll back
      // and fail loudly rather than hand back the "worktree is missing the last
      // commit" symptom. A detached checkout leaves no branch, so removal is clean.
      if (expectedHeadSha) {
        const head = await worktreeHeadSha(worktreePath);
        if (!sameCommit(head, expectedHeadSha)) {
          await removeWorktree({ projectRoot, worktreePath }).catch(() => {});
          throw staleWorktreeError(name, head, expectedHeadSha, fetchError);
        }
      }
      // Keep local agent artifacts out of git status/diffs without touching the
      // tracked .gitignore on the branch (best-effort).
      await addWorktreeExclude(worktreePath, REVIEW_ARTIFACT).catch(() => {});
      await addWorktreeExclude(worktreePath, PR_CONTEXT_ARTIFACT).catch(() => {});

      const records = await readAll();
      const record: WorkSession = {
        id: randomUUID(),
        projectId,
        name,
        kind: "review",
        slug,
        branch: reviewBranch,
        baseBranch,
        pr: pr ?? null,
        worktreePath,
        checkpointPath: null,
        setupDone: false,
        createdAtEpochMs: Date.now(),
      };

      records.push(record);
      await writeAll(records);
      return record;
    },

    async createFixSession({ projectId, projectRoot, name, branch, baseBranch, pr, expectedHeadSha }) {
      const slug = slugifySessionName(name);
      if (!slug) {
        throw new Error("Session name cannot be empty");
      }

      // Make origin/<branch> current, then a WRITABLE checkout of the branch. Git
      // DWIMs a tracking branch from origin when the local branch doesn't exist,
      // so a later `git push` updates the PR. (Detach is only for read-only review.)
      // Capture the fetch error rather than swallow it — surfaced via the guard below.
      const fetchError = await fetchRemotes(projectRoot);
      const branchPreexisted = await localBranchExists(projectRoot, branch);
      const worktreePath = buildWorktreeCreatePlan({ projectRoot, slug, branch }).path;
      await createWorktree({ projectRoot, slug, branch });

      // Freshness guard (see createReviewSession). On a stale result, remove the
      // worktree and drop the branch we just DWIM-created so a retry starts clean
      // (a pre-existing branch is left alone).
      if (expectedHeadSha) {
        const head = await worktreeHeadSha(worktreePath);
        if (!sameCommit(head, expectedHeadSha)) {
          await removeWorktree({ projectRoot, worktreePath }).catch(() => {});
          if (!branchPreexisted) {
            await execFileAsync("git", ["branch", "-D", branch], { cwd: projectRoot }).catch(() => {});
          }
          throw staleWorktreeError(name, head, expectedHeadSha, fetchError);
        }
      }

      await addWorktreeExclude(worktreePath, PR_CONTEXT_ARTIFACT).catch(() => {});

      const records = await readAll();
      const record: WorkSession = {
        id: randomUUID(),
        projectId,
        name,
        kind: "pr-fix",
        slug,
        branch,
        baseBranch,
        pr,
        worktreePath,
        checkpointPath: null,
        setupDone: false,
        createdAtEpochMs: Date.now(),
      };

      records.push(record);
      await writeAll(records);
      return record;
    },

    async updateSessionCheckpoint({ sessionId, checkpointPath }) {
      const records = await readAll();
      const index = records.findIndex((record) => record.id === sessionId);
      if (index === -1) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const current = records[index] as WorkSession;
      records[index] = { ...current, checkpointPath };
      await writeAll(records);
    },

    async setReviewedSha({ sessionId, sha }) {
      const records = await readAll();
      const index = records.findIndex((record) => record.id === sessionId);
      if (index === -1) throw new Error(`Session not found: ${sessionId}`);
      const current = records[index] as WorkSession;
      if (!current.pr) throw new Error("Session has no PR to update.");
      records[index] = { ...current, pr: { ...current.pr, lastReviewedSha: sha } };
      await writeAll(records);
    },

    async markSetupDone({ sessionId }) {
      const records = await readAll();
      const index = records.findIndex((record) => record.id === sessionId);
      if (index === -1) throw new Error(`Session not found: ${sessionId}`);
      const current = records[index] as WorkSession;
      records[index] = { ...current, setupDone: true };
      await writeAll(records);
    },

    async removeSession({ sessionId }) {
      const records = await readAll();
      const filtered = records.filter((record) => record.id !== sessionId);
      await writeAll(filtered);
    },
  };
}
