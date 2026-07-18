import type { VcsHost } from "./vcs-config";

export type WorkSessionKind = "feature" | "fix" | "review" | "pr-fix";

// Keep UI labels readable and leave ample room beneath common filesystem
// component limits for worktree/checkpoint suffixes.
export const SESSION_NAME_MAX_LENGTH = 100;
export const SESSION_SLUG_MAX_LENGTH = 80;

// A review session created from a PR link carries this so it can post back to
// the PR and run progressively. Null for manual reviews and non-review sessions.
export interface PrLink {
  host: VcsHost;
  workspace: string;
  repo: string;
  prId: string;
  url: string;
  // The source-branch SHA of the most recent posted review; null until first post.
  lastReviewedSha: string | null;
  // PR-fix only: HEAD before the implementer changed anything, so its reviewer
  // can inspect exactly the correction. Optional for sessions from older builds.
  fixBaseSha?: string;
}

// A project's "repo root" workspace is modelled as a synthetic session whose id
// is this prefix + the project id. It has no worktree (it IS the repo root) and
// no agent/checkpoint tabs — just shells + files + diff.
export const REPO_SESSION_PREFIX = "repo::";
export function isRepoSessionId(id: string): boolean {
  return id.startsWith(REPO_SESSION_PREFIX);
}

/**
 * One unit of work: a project's session = one worktree = (eventually) one
 * checkpoint. `name` is a sidebar label only; `slug`/`branch`/`worktreePath`
 * are derived at creation. `checkpointPath` stays null until the architect
 * creates the checkpoint and the watcher fills it in.
 */
export interface WorkSession {
  id: string;
  projectId: string;
  name: string;
  kind: WorkSessionKind;
  slug: string;
  branch: string;
  // The branch a review session reviews AGAINST. Null for feature/fix sessions.
  baseBranch: string | null;
  // Set for a review session created from a PR link; null otherwise.
  pr: PrLink | null;
  worktreePath: string;
  checkpointPath: string | null;
  // Whether the project's setup command has already run, or its build artifacts
  // were explicitly reused, so setup does not run again before every tab.
  setupDone: boolean;
  createdAtEpochMs: number;
}

const COMBINING_MARKS = /[\u0300-\u036f]/g;
const NON_ALPHANUMERIC = /[^a-z0-9]+/g;
const EDGE_HYPHENS = /^-+|-+$/g;

export function normalizeSessionName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Session name cannot be empty");
  if (trimmed.length > SESSION_NAME_MAX_LENGTH) {
    throw new Error(`Session name cannot exceed ${SESSION_NAME_MAX_LENGTH} characters`);
  }
  return trimmed;
}

/** Fit generated PR labels without rejecting a valid PR because its title is long. */
export function truncateSessionName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= SESSION_NAME_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, SESSION_NAME_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * Turn a user-given session name into a lowercase kebab slug that is safe to
 * use as a folder name and a git branch segment. Diacritics are folded to
 * ASCII, every run of non-alphanumeric characters becomes a single hyphen, and
 * leading/trailing hyphens are trimmed. Idempotent, so it doubles as a stable
 * dedupe key.
 */
export function slugifySessionName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(NON_ALPHANUMERIC, "-")
    .replace(EDGE_HYPHENS, "")
    .slice(0, SESSION_SLUG_MAX_LENGTH)
    .replace(EDGE_HYPHENS, "");
}

/** Append an allocation suffix without ever exceeding the slug component cap. */
export function sessionSlugWithSuffix(baseSlug: string, suffix: number): string {
  if (suffix <= 1) return baseSlug.slice(0, SESSION_SLUG_MAX_LENGTH).replace(EDGE_HYPHENS, "");
  const suffixText = `-${suffix}`;
  const stem = baseSlug
    .slice(0, SESSION_SLUG_MAX_LENGTH - suffixText.length)
    .replace(EDGE_HYPHENS, "");
  return `${stem}${suffixText}`;
}
