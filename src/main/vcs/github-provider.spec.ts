import { describe, expect, it } from "vitest";
import { mapIssueComments, mapPullRequest, parseNextLink } from "./github-provider";
import { REVIEW_COMMENT_MARKER } from "./vcs-provider";
import type { PrRef } from "./vcs-provider";

const REF: PrRef = {
  host: "github",
  workspace: "acme",
  repo: "web",
  prId: "17",
  url: "https://github.com/acme/web/pull/17",
};

describe("mapPullRequest (github)", () => {
  it("maps head/base ref + title", () => {
    const json = { title: "Add contacts", head: { ref: "feature/contacts" }, base: { ref: "main" } };
    expect(mapPullRequest(json, REF)).toEqual({ ...REF, source: "feature/contacts", target: "main", title: "Add contacts" });
  });
  it("throws when refs are missing", () => {
    expect(() => mapPullRequest({ title: "x" }, REF)).toThrow(/ref/i);
  });
});

describe("mapIssueComments (github)", () => {
  it("flags tool-authored comments and parses timestamps", () => {
    const result = mapIssueComments([
      { id: 1, body: `prior\n\n${REVIEW_COMMENT_MARKER}`, created_at: "2026-07-01T00:00:00Z" },
      { id: 2, body: "human" },
    ]);
    expect(result[0]).toMatchObject({ id: "1", authoredByTool: true });
    expect(result[1]).toMatchObject({ id: "2", authoredByTool: false });
  });
});

describe("parseNextLink", () => {
  it("extracts the rel=next url", () => {
    const header = '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"';
    expect(parseNextLink(header)).toBe("https://api.github.com/x?page=2");
  });
  it("returns null when there is no next", () => {
    expect(parseNextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});
