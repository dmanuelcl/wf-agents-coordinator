import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { slugifySessionName } from "../../shared/workflow/work-session";
import type { PrLink, WorkSession, WorkSessionKind } from "../../shared/workflow/work-session";
import { buildWorktreeCreatePlan, createWorktree } from "./worktree-manager";
import { addWorktreeExclude } from "./worktree-exclude";

// The gitignored review artifact a PR-review reviewer writes; posted to the PR.
export const REVIEW_ARTIFACT = ".agent-review.md";

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
  }): Promise<WorkSession>;
  createFixSession(params: {
    projectId: string;
    projectRoot: string;
    name: string;
    branch: string; // the PR source branch (writable checkout)
    baseBranch: string; // diff context (e.g. origin/<target>)
    pr: PrLink;
  }): Promise<WorkSession>;
  updateSessionCheckpoint(params: { sessionId: string; checkpointPath: string }): Promise<void>;
  setReviewedSha(params: { sessionId: string; sha: string }): Promise<void>;
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
        createdAtEpochMs: Date.now(),
      };

      records.push(record);
      await writeAll(records);
      return record;
    },

    async createReviewSession({ projectId, projectRoot, name, reviewBranch, baseBranch, pr, fetchFirst }) {
      const slug = slugifySessionName(name);
      if (!slug) {
        throw new Error("Session name cannot be empty");
      }

      if (fetchFirst) {
        // A PR-link review checks out a remote ref (origin/…) — make it current.
        await execFileAsync("git", ["fetch", "--all", "--prune"], { cwd: projectRoot }).catch(() => {});
      }

      const worktreePath = buildWorktreeCreatePlan({ projectRoot, slug, branch: reviewBranch }).path;
      // Detached at the ref under review (works for local and `origin/…` remote
      // branches); non-destructive and never conflicts with a branch checked out
      // elsewhere. The branch was already fetched by the dialog's listBranches.
      await createWorktree({ projectRoot, slug, branch: reviewBranch, detach: true });
      // Keep the review artifact out of git status/diffs without touching the
      // tracked .gitignore on the branch (best-effort).
      await addWorktreeExclude(worktreePath, REVIEW_ARTIFACT).catch(() => {});

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
        createdAtEpochMs: Date.now(),
      };

      records.push(record);
      await writeAll(records);
      return record;
    },

    async createFixSession({ projectId, projectRoot, name, branch, baseBranch, pr }) {
      const slug = slugifySessionName(name);
      if (!slug) {
        throw new Error("Session name cannot be empty");
      }

      // Make origin/<branch> current, then a WRITABLE checkout of the branch. Git
      // DWIMs a tracking branch from origin when the local branch doesn't exist,
      // so a later `git push` updates the PR. (Detach is only for read-only review.)
      await execFileAsync("git", ["fetch", "--all", "--prune"], { cwd: projectRoot }).catch(() => {});
      const worktreePath = buildWorktreeCreatePlan({ projectRoot, slug, branch }).path;
      await createWorktree({ projectRoot, slug, branch });

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

    async removeSession({ sessionId }) {
      const records = await readAll();
      const filtered = records.filter((record) => record.id !== sessionId);
      await writeAll(filtered);
    },
  };
}
