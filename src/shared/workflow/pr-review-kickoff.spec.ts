import { describe, expect, it } from "vitest";
import { buildPrReviewKickoff } from "./pr-review-kickoff";

const BASE = {
  template: "Revisa {branch} contra {base}.",
  branch: "origin/feature/x",
  base: "origin/develop",
  artifactFile: ".agent-review.md",
};

describe("buildPrReviewKickoff", () => {
  it("first run: full diff from base, no prior reports, writes the artifact", () => {
    const out = buildPrReviewKickoff({ ...BASE, priorReports: [], lastReviewedSha: null });
    expect(out).toContain("Revisa origin/feature/x contra origin/develop.");
    expect(out).toContain("git diff origin/develop..HEAD");
    expect(out).toContain(".agent-review.md");
    expect(out).not.toContain("Review previo");
  });

  it("progressive run: includes prior reports verbatim and diffs from the last sha", () => {
    const out = buildPrReviewKickoff({
      ...BASE,
      priorReports: ["Hallazgo A pendiente", "Hallazgo B resuelto"],
      lastReviewedSha: "abc123",
    });
    expect(out).toContain("Hallazgo A pendiente");
    expect(out).toContain("Hallazgo B resuelto");
    expect(out).toContain("git diff abc123..HEAD");
  });
});
