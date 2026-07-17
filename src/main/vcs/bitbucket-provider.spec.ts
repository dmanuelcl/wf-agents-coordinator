import { describe, expect, it } from "vitest";
import { mapComments, mapPullRequest } from "./bitbucket-provider";
import { REVIEW_COMMENT_MARKER } from "./vcs-provider";
import type { PrRef } from "./vcs-provider";

const REF: PrRef = {
  host: "bitbucket",
  workspace: "acme",
  repo: "web",
  prId: "482",
  url: "https://bitbucket.org/acme/web/pull-requests/482",
};

describe("mapPullRequest", () => {
  it("maps source/destination branch names + title + head sha", () => {
    const json = {
      title: "Fix contacts",
      source: { branch: { name: "feature/contacts" }, commit: { hash: "abc1234def" } },
      destination: { branch: { name: "develop" } },
    };
    expect(mapPullRequest(json, REF)).toEqual({
      ...REF,
      source: "feature/contacts",
      target: "develop",
      title: "Fix contacts",
      headSha: "abc1234def",
    });
  });

  it("defaults headSha to empty string when the commit hash is absent", () => {
    const json = {
      title: "Fix contacts",
      source: { branch: { name: "feature/contacts" } },
      destination: { branch: { name: "develop" } },
    };
    expect(mapPullRequest(json, REF).headSha).toBe("");
  });

  it("throws when branches are missing", () => {
    expect(() => mapPullRequest({ title: "x" }, REF)).toThrow(/branch/i);
  });
});

describe("mapComments", () => {
  it("flags tool-authored comments by the marker and parses timestamps", () => {
    const result = mapComments([
      { id: 1, content: { raw: `Prior review\n\n${REVIEW_COMMENT_MARKER}` }, created_on: "2026-07-01T10:00:00Z" },
      { id: 2, content: { raw: "a human comment" }, created_on: "2026-07-02T10:00:00Z" },
    ]);
    expect(result[0]).toMatchObject({ id: "1", authoredByTool: true });
    expect(result[0]?.createdAtEpochMs).toBeGreaterThan(0);
    expect(result[1]).toMatchObject({ id: "2", authoredByTool: false });
  });

  it("handles empty/missing content", () => {
    expect(mapComments([{ id: 3 }])).toEqual([{ id: "3", body: "", createdAtEpochMs: 0, authoredByTool: false }]);
  });

  it("captures inline file/line context", () => {
    const [comment] = mapComments([{ id: 4, content: { raw: "fix this" }, inline: { path: "src/a.ts", to: 42 } }]);
    expect(comment?.inline).toEqual({ path: "src/a.ts", line: 42 });
  });
});
