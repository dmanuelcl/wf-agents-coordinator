import { describe, expect, it } from "vitest";
import { buildPrFixKickoff } from "./pr-fix-kickoff";

describe("buildPrFixKickoff", () => {
  it("names the PR and requires reading the complete local context", () => {
    const out = buildPrFixKickoff({
      title: "Add contacts",
      source: "feature/contacts",
      target: "develop",
      contextFile: ".agent-pr-context.md",
    });
    expect(out).toContain("Add contacts");
    expect(out).toContain("feature/contacts");
    expect(out).toContain("develop");
    expect(out).toContain(".agent-pr-context.md");
    expect(out).toMatch(/lee COMPLETO/i);
    expect(out).toMatch(/por partes.*final del archivo/i);
    expect(out).toMatch(/no implementes nada hasta/i);
    expect(out).toMatch(/commit/i);
    expect(out).toMatch(/no.*push/i);
  });

  it("does not embed comment bodies in the terminal prompt", () => {
    const out = buildPrFixKickoff({ title: "x", source: "a", target: "b", contextFile: ".context.md" });
    expect(out).not.toContain("Comentarios del PR (en orden)");
  });
});
