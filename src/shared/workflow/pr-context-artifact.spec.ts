import { describe, expect, it } from "vitest";
import { buildPrContextArtifact } from "./pr-context-artifact";

describe("buildPrContextArtifact", () => {
  it("keeps every comment body in order and includes inline locations", () => {
    const out = buildPrContextArtifact({
      mode: "fix",
      comments: [
        { body: "first body", authoredByTool: false },
        { body: "second body", authoredByTool: true, inline: { path: "src/a.ts", line: 42 } },
      ],
    });

    expect(out.indexOf("first body")).toBeLessThan(out.indexOf("second body"));
    expect(out).toContain("src/a.ts:42");
    expect(out).toContain("reporte previo de Agent Coordinator");
  });

  it("records provider failures instead of claiming there are no comments", () => {
    const out = buildPrContextArtifact({ mode: "review", comments: [], loadError: "request failed" });
    expect(out).toContain("request failed");
    expect(out).not.toMatch(/no tiene comentarios/i);
  });
});
