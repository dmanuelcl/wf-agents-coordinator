import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import {
  normalizeSessionName,
  sessionSlugWithSuffix,
  slugifySessionName,
} from "../../shared/workflow/work-session";
import type { PrLink, WorkSession, WorkSessionKind } from "../../shared/workflow/work-session";
import { buildWorktreeCreatePlan, createWorktree, pruneWorktrees, removeWorktree } from "./worktree-manager";
import { normalizeStartRef, resolveStartPoint } from "./session-start-point";
import type { BranchState, StartPointPlan } from "./session-start-point";
import { reuseWorktreeArtifacts } from "./worktree-artifacts";
import { addWorktreeExclude } from "./worktree-exclude";

export interface SessionStartFrom {
  mode: "continue" | "fork";
  /** A branch as picked in the UI; may be remote-qualified (`origin/feature/x`). */
  ref: string;
  /** A checkpoint committed on that ref, relative to the repo root. */
  checkpointPath?: string | null;
}

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
    /**
     * Pick up work that already exists instead of branching off the repo root:
     * `continue` opens a teammate's branch writable, `fork` starts a fresh
     * branch from a base an architect published specs on. `checkpointPath`
     * adopts a checkpoint committed on that ref, which opens the workflow gate
     * at creation. Absent means today's behavior.
     */
    startFrom?: SessionStartFrom;
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
    diagnoseFirst?: boolean;
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

/**
 * Compare worktree paths by their real location. Git reports the resolved path
 * (`/private/var/...` on macOS) while a stored record can hold the symlinked
 * one (`/var/...`), so plain `resolve` would call two names for one directory
 * different.
 */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The repo root's branch — the base a session's work will be compared against. */
async function currentBranch(projectRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: projectRoot });
    return stdout.trim() || null;
  } catch {
    // Detached HEAD has no branch to record; the diff falls back to main/master.
    return null;
  }
}

async function remoteNames(projectRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["remote"], { cwd: projectRoot });
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function refExists(projectRoot: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: projectRoot });
    return true;
  } catch {
    return false;
  }
}

/** Where each branch is checked out, so we can name the worktree that holds one. */
async function branchWorktrees(projectRoot: string): Promise<Map<string, string>> {
  const held = new Map<string, string>();
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: projectRoot });
    let path: string | null = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      else if (line.startsWith("branch refs/heads/") && path) {
        held.set(line.slice("branch refs/heads/".length).trim(), path);
      }
    }
  } catch {
    // No git metadata to read means nothing is held.
  }
  return held;
}

/**
 * Read everything `resolveStartPoint` needs about one branch. Ahead/behind are
 * only meaningful after a fetch, so the caller fetches first — resolving
 * against stale remote-tracking refs would call a behind branch up to date.
 */
async function readBranchState(params: {
  projectRoot: string;
  branch: string;
  remotes: readonly string[];
  /** Worktree path -> session name, so a conflict can name the session, not just a path. */
  sessionNameByWorktree?: Map<string, string>;
}): Promise<BranchState> {
  const { projectRoot, branch, remotes } = params;
  const hasLocal = await localBranchExists(projectRoot, branch);

  let remote: string | null = null;
  for (const candidate of remotes) {
    if (await refExists(projectRoot, `refs/remotes/${candidate}/${branch}`)) {
      remote = candidate;
      break;
    }
  }

  let ahead = 0;
  let behind = 0;
  if (hasLocal && remote) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["rev-list", "--left-right", "--count", `${branch}...${remote}/${branch}`],
        { cwd: projectRoot },
      );
      const [left, right] = stdout.trim().split(/\s+/);
      ahead = Number(left) || 0;
      behind = Number(right) || 0;
    } catch {
      // Unrelated histories: treat as diverged rather than silently proceeding.
      ahead = 1;
      behind = 1;
    }
  }

  const heldAt = (await branchWorktrees(projectRoot)).get(branch) ?? null;
  const sessionName = heldAt ? params.sessionNameByWorktree?.get(canonicalPath(heldAt)) : undefined;

  return {
    hasLocal,
    remote,
    ahead,
    behind,
    // Prefer the session's name: "at /long/path/.worktrees/auth-work" makes the
    // user map a path back to a session themselves.
    checkedOutAt: heldAt === null ? null : sessionName ? `"${sessionName}" (${heldAt})` : heldAt,
  };
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

    createSession({ projectId, projectRoot, name, kind, copyEnv, reuseBuildArtifacts, startFrom }) {
      return runExclusive(async () => {
        const { sessionName, baseSlug } = sessionIdentity(name);

        const sessionBranchForSlug = (slug: string): string => `${kind === "fix" ? "fix" : "feature"}/${slug}`;
        const mode = startFrom?.mode ?? "new";
        const remotes = startFrom ? await remoteNames(projectRoot) : [];
        const ref = startFrom ? normalizeStartRef(startFrom.ref, remotes) : null;

        // Refresh remote-tracking refs BEFORE reading ahead/behind. A failed
        // fetch on a branch that has a remote means the state we would resolve
        // against is stale, so we surface it instead of starting on old code.
        let fetchError: string | null = null;
        if (startFrom && remotes.length > 0) {
          fetchError = await fetchRemotes(projectRoot);
        }

        // Continuing takes the branch as given, so only the worktree path needs
        // allocating; the other modes must also land on a free branch name.
        const slug =
          mode === "continue"
            ? await allocateSlug({ projectRoot, baseSlug })
            : await allocateSlug({ projectRoot, baseSlug, branchForSlug: sessionBranchForSlug });
        const sessionBranch = sessionBranchForSlug(slug);

        const state = await readBranchState({
          projectRoot,
          branch: mode === "continue" || mode === "fork" ? (ref as string) : sessionBranch,
          remotes,
          sessionNameByWorktree: new Map(
            (await readAll()).map((record) => [canonicalPath(record.worktreePath), record.name]),
          ),
        });
        if (fetchError && state.remote) {
          throw new Error(
            `Could not refresh "${ref}" from ${state.remote}, so this session would start on an out-of-date copy:\n${fetchError}`,
          );
        }

        const plan: StartPointPlan = resolveStartPoint({ mode, ref, sessionBranch, state });
        if (plan.action === "abort") throw new Error(plan.reason);

        const branch = plan.branch;
        const worktreePath = buildWorktreeCreatePlan({ projectRoot, slug, branch }).path;
        // Only a branch WE create may be deleted on rollback. A continued
        // branch belongs to whoever else is working on it.
        const createdBranch = plan.action === "new-branch";
        let worktreeCreated = false;

        try {
          if (plan.action === "checkout" && plan.fastForward && state.remote) {
            // Fast-forward-only by construction: git refuses this refspec when
            // the update would not be a fast-forward, and the branch is not
            // checked out anywhere, so no working tree can be disturbed.
            await execFileAsync("git", ["fetch", state.remote, `${branch}:${branch}`], { cwd: projectRoot });
          }
          await createWorktree({
            projectRoot,
            slug,
            branch,
            createBranch: createdBranch,
            from: plan.action === "new-branch" ? plan.from : undefined,
          });
          worktreeCreated = true;

          const record: WorkSession = {
            id: randomUUID(),
            projectId,
            name: sessionName,
            kind,
            slug,
            branch,
            // Forking knows its base exactly; otherwise the work branched off
            // whatever the repo root has checked out — in practice `develop`.
            baseBranch: mode === "fork" ? ref : await currentBranch(projectRoot),
            pr: null,
            worktreePath,
            // Adopting a checkpoint opens the workflow gate at creation, so the
            // watcher (which ignores files inherited from the checkout) is
            // never consulted for this session.
            checkpointPath: startFrom?.checkpointPath ?? null,
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
          if (createdBranch) {
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

    createFixSession({ projectId, projectRoot, name, branch, baseBranch, pr, diagnoseFirst = false, expectedHeadSha }) {
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
            prFixDiagnoseFirst: diagnoseFirst,
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
