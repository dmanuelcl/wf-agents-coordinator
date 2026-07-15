import { describe, expect, it } from "vitest";
import { buildPrFixKickoff } from "./pr-fix-kickoff";

describe("buildPrFixKickoff", () => {
  it("names the PR and lists comments in order, with inline location", () => {
    const out = buildPrFixKickoff({
      title: "Add contacts",
      source: "feature/contacts",
      target: "develop",
      comments: [
        { body: "rename this" },
        { body: "wrong type", inline: { path: "src/a.ts", line: 42 } },
      ],
    });
    expect(out).toContain("Add contacts");
    expect(out).toContain("feature/contacts");
    expect(out).toContain("develop");
    expect(out).toContain("rename this");
    expect(out).toContain("src/a.ts:42");
    expect(out).toMatch(/commit/i);
    expect(out).toMatch(/no.*push/i);
  });

  it("handles a PR with no comments", () => {
    const out = buildPrFixKickoff({ title: "x", source: "a", target: "b", comments: [] });
    expect(out).toMatch(/no hay comentarios/i);
  });
});
