import type { VcsHost } from "./vcs-config";

export type WorkSessionKind = "feature" | "fix" | "review" | "pr-fix";

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
  // Whether the project's setup command has already run in this worktree (so it
  // runs once, before the agent, not on every tab open).
  setupDone: boolean;
  createdAtEpochMs: number;
}

const COMBINING_MARKS = /[\u0300-\u036f]/g;
const NON_ALPHANUMERIC = /[^a-z0-9]+/g;
const EDGE_HYPHENS = /^-+|-+$/g;

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
    .replace(EDGE_HYPHENS, "");
}
