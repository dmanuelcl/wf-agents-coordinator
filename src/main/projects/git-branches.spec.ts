import { describe, expect, it } from "vitest";
import { parseGitBranches } from "./git-branches";

describe("parseGitBranches", () => {
  it("splits local + remote, drops HEAD and origin/HEAD, trims, dedupes", () => {
    const local = "main\ndevelop\nfeature/x\nfeature/x\n";
    const remote = "origin/HEAD\norigin/main\n origin/feature/x \norigin/feature/y\n";
    expect(parseGitBranches(local, remote)).toEqual({
      local: ["main", "develop", "feature/x"],
      remote: ["origin/main", "origin/feature/x", "origin/feature/y"],
    });
  });

  it("handles empty input", () => {
    expect(parseGitBranches("", "")).toEqual({ local: [], remote: [] });
  });
});
