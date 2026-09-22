import type { WorkSession } from "./work-session";

/** The identity of a pull request, independent of which session happens to be reviewing it. */
export interface PrThreadRef {
  host: string;
  workspace: string;
  repo: string;
  prId: string;
}

/**
 * The SHA of the most recent review already posted for THIS pull request.
 *
 * `lastReviewedSha` is persisted on a session's `PrLink`, but what it describes is a property of the
 * PR, not of the session: every new round is created fresh from the PR URL, so initialising it to
 * `null` threw the anchor away and the reviewer fell back to the whole branch. Measured on PR #276:
 * three consecutive rounds started with no anchor, and the third had to dig the SHA out of the prose
 * of the previous report — 320 files in the diff instead of 47.
 *
 * Rounds that never posted are SKIPPED rather than allowed to win: the round in flight always has a
 * `null` sha, and letting the newest record decide would discard the anchor the previous round left.
 */
export function resolveLastReviewedSha(params: { sessions: WorkSession[]; pr: PrThreadRef }): string | null {
  const { sessions, pr } = params;

  const posted = sessions.filter((candidate): boolean => {
    const link = candidate.pr;
    if (!link || link.lastReviewedSha === null) return false;
    // All four parts, or two PRs that share a number across repos would bleed into each other.
    return link.host === pr.host && link.workspace === pr.workspace && link.repo === pr.repo && link.prId === pr.prId;
  });

  const newest = posted.reduce<WorkSession | null>(
    (best, candidate) => (best === null || candidate.createdAtEpochMs > best.createdAtEpochMs ? candidate : best),
    null,
  );

  return newest?.pr?.lastReviewedSha ?? null;
}
