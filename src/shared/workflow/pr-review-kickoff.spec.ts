import { describe, expect, it } from "vitest";
import { buildPrReviewKickoff } from "./pr-review-kickoff";

const BASE = {
  template: "Revisa {branch} contra {base}.",
  branch: "origin/feature/x",
  base: "origin/develop",
  contextFile: ".agent-pr-context.md",
  artifactFile: ".agent-review.md",
};

describe("buildPrReviewKickoff", () => {
  it("first run: full diff from base, no prior reports, writes the artifact", () => {
    const out = buildPrReviewKickoff({ ...BASE, lastReviewedSha: null });
    expect(out).toContain("Revisa origin/feature/x contra origin/develop.");
    expect(out).toContain("git diff origin/develop...HEAD");
    expect(out).toContain(".agent-pr-context.md");
    expect(out).toMatch(/lee COMPLETO/i);
    expect(out).toMatch(/por partes.*final del archivo/i);
    expect(out).toContain(".agent-review.md");
  });

  it("progressive run: points at context without embedding reports and diffs from the last sha", () => {
    const out = buildPrReviewKickoff({
      ...BASE,
      lastReviewedSha: "abc123",
    });
    expect(out).not.toContain("Hallazgo A pendiente");
    expect(out).toContain("git diff abc123..HEAD");
  });
});
