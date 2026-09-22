import { describe, expect, it } from "vitest";
import { resolveLastReviewedSha } from "./pr-review-continuity";
import type { PrLink, WorkSession } from "./work-session";

const PR = { host: "bitbucket", workspace: "acme", repo: "app", prId: "276" } as const;

function session(overrides: { id: string; createdAtEpochMs: number; pr: PrLink | null }): WorkSession {
  return {
    id: overrides.id,
    projectId: "p1",
    name: overrides.id,
    kind: "review",
    slug: overrides.id,
    branch: "origin/feat/crm",
    baseBranch: "origin/develop",
    pr: overrides.pr,
    worktreePath: `/tmp/${overrides.id}`,
    checkpointPath: null,
    setupDone: true,
    createdAtEpochMs: overrides.createdAtEpochMs,
  };
}

function prLink(overrides: Partial<PrLink> = {}): PrLink {
  return { ...PR, url: "https://example.test/pr/276", lastReviewedSha: null, ...overrides };
}

describe("resolveLastReviewedSha", () => {
  it("no previous session for this PR: nothing to inherit", () => {
    expect(resolveLastReviewedSha({ sessions: [], pr: PR })).toBeNull();
  });

  it("inherits the sha a previous round of the SAME pr already posted", () => {
    const sessions = [session({ id: "round-6", createdAtEpochMs: 100, pr: prLink({ lastReviewedSha: "aaa111" }) })];
    expect(resolveLastReviewedSha({ sessions, pr: PR })).toBe("aaa111");
  });

  it("takes the MOST RECENT round, not the first one it happens to find", () => {
    const sessions = [
      session({ id: "round-6", createdAtEpochMs: 100, pr: prLink({ lastReviewedSha: "aaa111" }) }),
      session({ id: "round-7", createdAtEpochMs: 300, pr: prLink({ lastReviewedSha: "ccc333" }) }),
      session({ id: "round-5", createdAtEpochMs: 50, pr: prLink({ lastReviewedSha: "bbb222" }) }),
    ];
    expect(resolveLastReviewedSha({ sessions, pr: PR })).toBe("ccc333");
  });

  it("skips a more recent round that never posted, instead of returning null", () => {
    // The round that is running right now has no sha yet. Letting it win would throw away the
    // anchor the previous round did leave — which is exactly the bug this function exists for.
    const sessions = [
      session({ id: "round-6", createdAtEpochMs: 100, pr: prLink({ lastReviewedSha: "aaa111" }) }),
      session({ id: "round-7-in-flight", createdAtEpochMs: 300, pr: prLink({ lastReviewedSha: null }) }),
    ];
    expect(resolveLastReviewedSha({ sessions, pr: PR })).toBe("aaa111");
  });

  it("never crosses PRs: a different prId in the same repo is a different thread", () => {
    const sessions = [session({ id: "other", createdAtEpochMs: 100, pr: prLink({ prId: "999", lastReviewedSha: "zzz999" }) })];
    expect(resolveLastReviewedSha({ sessions, pr: PR })).toBeNull();
  });

  it("never crosses repos or workspaces that happen to share a pr number", () => {
    const sessions = [
      session({ id: "other-repo", createdAtEpochMs: 100, pr: prLink({ repo: "other", lastReviewedSha: "zzz999" }) }),
      session({ id: "other-ws", createdAtEpochMs: 200, pr: prLink({ workspace: "other", lastReviewedSha: "yyy888" }) }),
    ];
    expect(resolveLastReviewedSha({ sessions, pr: PR })).toBeNull();
  });

  it("ignores sessions with no PR link at all", () => {
    const sessions = [session({ id: "feature", createdAtEpochMs: 400, pr: null })];
    expect(resolveLastReviewedSha({ sessions, pr: PR })).toBeNull();
  });
});
