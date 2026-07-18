import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import {
  normalizeSessionName,
  sessionSlugWithSuffix,
  slugifySessionName,
} from "../../shared/workflow/work-session";
import type { PrLink, WorkSession, WorkSessionKind } from "../../shared/workflow/work-session";
import { buildWorktreeCreatePlan, createWorktree, pruneWorktrees, removeWorktree } from "./worktree-manager";
import { reuseWorktreeArtifacts } from "./worktree-artifacts";
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
    reuseBuildArtifacts?: boolean;
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

function sessionIdentity(name: string): { sessionName: string; baseSlug: string } {
  const sessionName = normalizeSessionName(name);
  const baseSlug = slugifySessionName(sessionName);
  if (!baseSlug) throw new Error("Session name cannot be empty or punctuation-only");
  return { sessionName, baseSlug };
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

async function checkedOutBranches(projectRoot: string): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: projectRoot });
    const branches = new Set<string>();
    for (const line of stdout.split("\n")) {
      if (line.startsWith("branch refs/heads/")) {
        branches.add(line.slice("branch refs/heads/".length).trim());
      }
    }
    return branches;
  } catch {
    return new Set();
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
  // Every mutating operation is ordered through one queue. Without this, a
  // checkpoint callback and a deletion can both read the same JSON snapshot;
  // whichever writes last can resurrect the deleted session.
  let mutationTail: Promise<void> = Promise.resolve();

  function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

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
    // Rename a complete sibling file into place so a crash cannot leave a
    // truncated sessions.json that makes every session disappear on restart.
    const tempFilePath = `${storeFilePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempFilePath, JSON.stringify(records, null, 2), "utf8");
      await rename(tempFilePath, storeFilePath);
    } catch (error) {
      await rm(tempFilePath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function appendRecord(record: WorkSession): Promise<void> {
    const records = await readAll();
    records.push(record);
    await writeAll(records);
  }

  async function allocateSlug(params: {
    projectRoot: string;
    baseSlug: string;
    branchForSlug?: (slug: string) => string;
  }): Promise<string> {
    // Clear invisible registrations before deciding which names are occupied.
    await pruneWorktrees({ projectRoot: params.projectRoot });
    const records = await readAll();
    const checkedOut = params.branchForSlug ? await checkedOutBranches(params.projectRoot) : new Set<string>();

    for (let suffix = 1; suffix < 10_000; suffix += 1) {
      const candidate = sessionSlugWithSuffix(params.baseSlug, suffix);
      const path = buildWorktreeCreatePlan({
        projectRoot: params.projectRoot,
        slug: candidate,
        branch: params.branchForSlug?.(candidate) ?? candidate,
      }).path;
      const pathOccupied = existsSync(path) || records.some((record) => record.worktreePath === path);
      const branchOccupied = params.branchForSlug ? checkedOut.has(params.branchForSlug(candidate)) : false;
      if (!pathOccupied && !branchOccupied) return candidate;
    }

    throw new Error(`Could not allocate a worktree name for "${params.baseSlug}".`);
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

    createSession({ projectId, projectRoot, name, kind, copyEnv, reuseBuildArtifacts }) {
      return runExclusive(async () => {
        const { sessionName, baseSlug } = sessionIdentity(name);

        const branchForSlug = (slug: string): string => `${kind === "fix" ? "fix" : "feature"}/${slug}`;
        const slug = await allocateSlug({ projectRoot, baseSlug, branchForSlug });
        const branch = branchForSlug(slug);
        const worktreePath = buildWorktreeCreatePlan({ projectRoot, slug, branch }).path;
        // A deleted session intentionally leaves its branch behind. Recreating
        // the same name should reopen that branch, not fail because `-b` sees it.
        const branchPreexisted = await localBranchExists(projectRoot, branch);
        let worktreeCreated = false;

        try {
          await createWorktree({ projectRoot, slug, branch, createBranch: !branchPreexisted });
          worktreeCreated = true;

          const record: WorkSession = {
            id: randomUUID(),
            projectId,
            name: sessionName,
            kind,
            slug,
            branch,
            baseBranch: null,
            pr: null,
            worktreePath,
            checkpointPath: null,
            setupDone: false,
            // Git has finished checking out inherited files before this value is
            // captured. The checkpoint watcher uses the boundary to ignore them.
            createdAtEpochMs: Date.now(),
          };

          if (copyEnv) {
            await copyEnvFiles(projectRoot, worktreePath);
          }
          if (reuseBuildArtifacts) {
            await reuseWorktreeArtifacts({ projectRoot, worktreePath });
            record.setupDone = true;
          }
          await appendRecord(record);
          return record;
        } catch (error) {
          // Never strand an invisible worktree/branch when persistence fails.
          if (worktreeCreated) {
            await removeWorktree({ projectRoot, worktreePath }).catch(() => {});
          }
          if (!branchPreexisted) {
            await execFileAsync("git", ["branch", "-D", branch], { cwd: projectRoot }).catch(() => {});
          }
          throw error;
        }
      });
    },

    createReviewSession({ projectId, projectRoot, name, reviewBranch, baseBranch, pr, fetchFirst, expectedHeadSha }) {
      return runExclusive(async () => {
        const { sessionName, baseSlug } = sessionIdentity(name);
        const slug = await allocateSlug({ projectRoot, baseSlug });

        // A PR-link review checks out a remote ref (origin/…) — make it current.
        // We capture (never swallow) the fetch error so a failed fetch surfaces via
        // the head-SHA guard below instead of silently reviewing out-of-date code.
        const fetchError = fetchFirst ? await fetchRemotes(projectRoot) : null;
        const worktreePath = buildWorktreeCreatePlan({ projectRoot, slug, branch: reviewBranch }).path;
        let worktreeCreated = false;

        try {
          // Detached at the ref under review (works for local and `origin/…` remote
          // branches); non-destructive and never conflicts with a branch checked out
          // elsewhere.
          await createWorktree({ projectRoot, slug, branch: reviewBranch, detach: true });
          worktreeCreated = true;

          // Freshness guard: if the host reported the PR's head commit, the detached
          // worktree must be sitting on it. If not (e.g. the fetch failed), fail
          // rather than reviewing stale code; the catch below owns the rollback.
          if (expectedHeadSha) {
            const head = await worktreeHeadSha(worktreePath);
            if (!sameCommit(head, expectedHeadSha)) {
              throw staleWorktreeError(sessionName, head, expectedHeadSha, fetchError);
            }
          }
          await addWorktreeExclude(worktreePath, REVIEW_ARTIFACT).catch(() => {});
          await addWorktreeExclude(worktreePath, PR_CONTEXT_ARTIFACT).catch(() => {});

          const record: WorkSession = {
            id: randomUUID(),
            projectId,
            name: sessionName,
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

          await appendRecord(record);
          return record;
        } catch (error) {
          if (worktreeCreated) {
            await removeWorktree({ projectRoot, worktreePath }).catch(() => {});
          }
          throw error;
        }
      });
    },

    createFixSession({ projectId, projectRoot, name, branch, baseBranch, pr, expectedHeadSha }) {
      return runExclusive(async () => {
        const { sessionName, baseSlug } = sessionIdentity(name);

        const records = await readAll();
        const existing = records.find(
          (record) =>
            record.projectId === projectId &&
            record.kind === "pr-fix" &&
            record.branch === branch &&
            existsSync(record.worktreePath),
        );
        // A writable branch cannot safely be checked out twice. Treat a repeated
        // create request for the same PR as idempotent and reopen its session.
        if (existing) {
          if (expectedHeadSha) {
            const head = await worktreeHeadSha(existing.worktreePath);
            if (!sameCommit(head, expectedHeadSha)) {
              throw new Error(
                `A fix session for this PR already exists at ${existing.worktreePath}, but it is not on the PR's latest commit. Open or remove that session before creating another one.`,
              );
            }
          }
          return existing;
        }

        const slug = await allocateSlug({ projectRoot, baseSlug });

        // Make origin/<branch> current, then a WRITABLE checkout of the branch. Git
        // DWIMs a tracking branch from origin when the local branch doesn't exist,
        // so a later `git push` updates the PR. (Detach is only for read-only review.)
        const fetchError = await fetchRemotes(projectRoot);
        const branchPreexisted = await localBranchExists(projectRoot, branch);
        const worktreePath = buildWorktreeCreatePlan({ projectRoot, slug, branch }).path;
        let worktreeCreated = false;

        try {
          await createWorktree({ projectRoot, slug, branch });
          worktreeCreated = true;

          if (expectedHeadSha) {
            const head = await worktreeHeadSha(worktreePath);
            if (!sameCommit(head, expectedHeadSha)) {
              throw staleWorktreeError(sessionName, head, expectedHeadSha, fetchError);
            }
          }

          await addWorktreeExclude(worktreePath, PR_CONTEXT_ARTIFACT).catch(() => {});

          const record: WorkSession = {
            id: randomUUID(),
            projectId,
            name: sessionName,
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

          await appendRecord(record);
          return record;
        } catch (error) {
          if (worktreeCreated) {
            await removeWorktree({ projectRoot, worktreePath }).catch(() => {});
          }
          if (!branchPreexisted) {
            await execFileAsync("git", ["branch", "-D", branch], { cwd: projectRoot }).catch(() => {});
          }
          throw error;
        }
      });
    },

    updateSessionCheckpoint({ sessionId, checkpointPath }) {
      return runExclusive(async () => {
        const records = await readAll();
        const index = records.findIndex((record) => record.id === sessionId);
        if (index === -1) {
          throw new Error(`Session not found: ${sessionId}`);
        }

        const current = records[index] as WorkSession;
        records[index] = { ...current, checkpointPath };
        await writeAll(records);
      });
    },

    setReviewedSha({ sessionId, sha }) {
      return runExclusive(async () => {
        const records = await readAll();
        const index = records.findIndex((record) => record.id === sessionId);
        if (index === -1) throw new Error(`Session not found: ${sessionId}`);
        const current = records[index] as WorkSession;
        if (!current.pr) throw new Error("Session has no PR to update.");
        records[index] = { ...current, pr: { ...current.pr, lastReviewedSha: sha } };
        await writeAll(records);
      });
    },

    markSetupDone({ sessionId }) {
      return runExclusive(async () => {
        const records = await readAll();
        const index = records.findIndex((record) => record.id === sessionId);
        if (index === -1) throw new Error(`Session not found: ${sessionId}`);
        const current = records[index] as WorkSession;
        records[index] = { ...current, setupDone: true };
        await writeAll(records);
      });
    },

    removeSession({ sessionId }) {
      return runExclusive(async () => {
        const records = await readAll();
        const filtered = records.filter((record) => record.id !== sessionId);
        if (filtered.length !== records.length) {
          await writeAll(filtered);
        }
      });
    },
  };
}
