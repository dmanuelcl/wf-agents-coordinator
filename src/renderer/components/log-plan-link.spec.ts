import { describe, expect, it } from "vitest";
import { planFileCandidates, planFileToken } from "./log-plan-link";

describe("planFileToken", () => {
  it("recognizes the workflow ledger basename format", () => {
    expect(planFileToken("plan-2-persistence.md")).toBe("plan-2-persistence.md");
  });

  it("extracts explicit markdown links and code paths", () => {
    expect(planFileToken("[Plan 2](docs/workflow/plans/plan-2-persistence.md)")).toBe(
      "docs/workflow/plans/plan-2-persistence.md",
    );
    expect(planFileToken("`docs/workflow/plans/plan-3-ui.mdx`")).toBe(
      "docs/workflow/plans/plan-3-ui.mdx",
    );
  });

  it("ignores synthetic plans that are not files", () => {
    expect(planFileToken("fix-brief")).toBeNull();
  });
});

describe("planFileCandidates", () => {
  it("resolves ledger basenames through the canonical plans directory first", () => {
    expect(planFileCandidates("plan-1-toggle.md")).toEqual([
      "docs/workflow/plans/plan-1-toggle.md",
      "plan-1-toggle.md",
    ]);
  });

  it("keeps an explicit path exact", () => {
    expect(planFileCandidates("docs/workflow/plans/plan-1-toggle.md")).toEqual([
      "docs/workflow/plans/plan-1-toggle.md",
    ]);
  });
});
