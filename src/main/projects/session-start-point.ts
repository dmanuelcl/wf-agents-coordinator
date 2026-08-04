/**
 * Decides HOW a session's worktree should be created, without touching git.
 * The caller fetches, reads the branch state, this resolves it to a plan, and
 * only then does `session-registry` execute. Keeping the decision pure is what
 * makes the whole matrix — diverged, remote-only, already checked out —
 * testable without a repository.
 */

export type StartPointMode = "new" | "continue" | "fork";

export interface BranchState {
  /** A local branch of this name exists. */
  hasLocal: boolean;
  /**
   * Name of the remote that carries this branch (`origin`, `upstream`, …), or
   * null when it exists only locally. Never assume `origin`: a fork's base ref
   * and a teammate's branch can live on different remotes.
   */
  remote: string | null;
  /**
   * Commits the local branch has that the remote does not, and vice versa.
   * Only meaningful once the caller has fetched — resolving against stale
   * remote-tracking refs would call a behind branch up to date.
   */
  ahead: number;
  behind: number;
  /** Worktree path already holding this branch checked out, or null. */
  checkedOutAt: string | null;
}

export type StartPointPlan =
  | { action: "abort"; reason: string }
  | { action: "new-branch"; branch: string; from: string }
  | { action: "checkout"; branch: string; fastForward: boolean };

export interface ResolveStartPointParams {
  mode: StartPointMode;
  /** The chosen ref for continue/fork. Ignored for `new`. */
  ref: string | null;
  /** The `<kind>/<slug>` branch a `new` or `fork` session creates. */
  sessionBranch: string;
  /**
   * State of the branch this mode acts on: `ref` for continue and fork,
   * `sessionBranch` for new.
   */
  state: BranchState;
}

function missingRef(ref: string): StartPointPlan {
  return { action: "abort", reason: `Branch "${ref}" no longer exists locally or on any remote.` };
}

export function resolveStartPoint(params: ResolveStartPointParams): StartPointPlan {
  const { mode, ref, sessionBranch, state } = params;

  if (mode === "new") {
    // A deleted session intentionally leaves its branch behind. Recreating the
    // same name reopens that branch rather than failing on `-b`.
    return state.hasLocal
      ? { action: "checkout", branch: sessionBranch, fastForward: false }
      : { action: "new-branch", branch: sessionBranch, from: "HEAD" };
  }

  const target = ref ?? "";
  if (!state.hasLocal && !state.remote) return missingRef(target);

  if (mode === "fork") {
    // Branch off what was PUBLISHED: the architect's specs reach the team
    // through the remote, so local commits on the base are deliberately not
    // the starting point. The dialog states this so it cannot surprise.
    return {
      action: "new-branch",
      branch: sessionBranch,
      from: state.remote ? `${state.remote}/${target}` : target,
    };
  }

  if (state.checkedOutAt) {
    return {
      action: "abort",
      reason: `Branch "${target}" is already checked out at ${state.checkedOutAt}. Git allows a branch in only one worktree.`,
    };
  }

  if (state.ahead > 0 && state.behind > 0) {
    return {
      action: "abort",
      reason:
        `Branch "${target}" has diverged from its remote: ${state.ahead} local commits it does not have, ` +
        `${state.behind} remote commits you do not have. Reconcile it before continuing the session.`,
    };
  }

  // Behind-only is the common case when a teammate keeps pushing, and a
  // fast-forward of a branch that is not checked out cannot lose work.
  // Remote-only needs no fast-forward: `git worktree add <path> <branch>`
  // DWIMs a tracking branch from the ref the caller already fetched.
  return { action: "checkout", branch: target, fastForward: state.behind > 0 };
}

/**
 * Turn a ref as picked in the UI into a plain branch name. The branch combobox
 * lists remote branches as `origin/feature/x`, but a continued session needs a
 * WRITABLE checkout, which requires the local branch name. Only strips a
 * prefix that names a real remote, so a local branch legitimately called
 * `origin/feature/x` survives.
 */
export function normalizeStartRef(ref: string, remotes: readonly string[]): string {
  for (const remote of remotes) {
    const prefix = `${remote}/`;
    if (ref.startsWith(prefix) && ref.length > prefix.length) return ref.slice(prefix.length);
  }
  return ref;
}
