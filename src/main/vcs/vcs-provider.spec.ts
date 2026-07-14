import { describe, expect, it } from "vitest";
import { parseBitbucketUrl, parseGithubUrl, parsePrUrl } from "./vcs-provider";

describe("parseBitbucketUrl", () => {
  it("extracts workspace/repo/prId and canonicalizes the url", () => {
    expect(parseBitbucketUrl("https://bitbucket.org/acme/web/pull-requests/482")).toEqual({
      host: "bitbucket",
      workspace: "acme",
      repo: "web",
      prId: "482",
      url: "https://bitbucket.org/acme/web/pull-requests/482",
    });
  });

  it("tolerates a trailing path and returns null on non-PR urls", () => {
    expect(parseBitbucketUrl("https://bitbucket.org/acme/web/pull-requests/482/diff")?.prId).toBe("482");
    expect(parseBitbucketUrl("https://bitbucket.org/acme/web/src/main")).toBeNull();
    expect(parseBitbucketUrl("nonsense")).toBeNull();
  });
});

describe("parseGithubUrl", () => {
  it("extracts owner/repo/prId", () => {
    expect(parseGithubUrl("https://github.com/acme/web/pull/17")).toMatchObject({
      host: "github",
      workspace: "acme",
      repo: "web",
      prId: "17",
    });
  });
  it("returns null on non-PR urls", () => {
    expect(parseGithubUrl("https://github.com/acme/web/issues/17")).toBeNull();
  });
});

describe("parsePrUrl (host-dispatch)", () => {
  it("routes by host", () => {
    expect(parsePrUrl("bitbucket", "https://bitbucket.org/a/b/pull-requests/1")?.host).toBe("bitbucket");
    expect(parsePrUrl("github", "https://github.com/a/b/pull/1")?.host).toBe("github");
    expect(parsePrUrl("none", "https://github.com/a/b/pull/1")).toBeNull();
  });
});
