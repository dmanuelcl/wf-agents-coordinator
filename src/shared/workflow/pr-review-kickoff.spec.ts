import { describe, expect, it } from "vitest";
import { buildPrReviewKickoff } from "./pr-review-kickoff";

const BASE = {
  template: "Revisa {branch} contra {base}. Invocá el skill `biznex-pr-review` antes de leer nada.",
  branch: "origin/feature/x",
  base: "origin/develop",
};

describe("buildPrReviewKickoff", () => {
  it("first run: the project template verbatim, with nothing else appended", () => {
    const out = buildPrReviewKickoff({ ...BASE, lastReviewedSha: null });
    expect(out).toBe("Revisa origin/feature/x contra origin/develop. Invocá el skill `biznex-pr-review` antes de leer nada.");
  });

  it("injects no procedure of its own: the review protocol owns context, diff and report", () => {
    const out = buildPrReviewKickoff({ ...BASE, lastReviewedSha: "abc123" });
    // The three blocks the app used to append, each of which contradicted the protocol.
    expect(out).not.toMatch(/lee COMPLETO/i);
    expect(out).not.toMatch(/Analiza (SOLO|el diff)/i);
    expect(out).not.toMatch(/Escribe el review/i);
    expect(out).not.toContain("git diff");
    expect(out).not.toContain(".agent-review.md");
    expect(out).not.toContain(".agent-pr-context.md");
  });

  it("progressive run: passes the last reviewed sha as data, not as an instruction", () => {
    const out = buildPrReviewKickoff({ ...BASE, lastReviewedSha: "abc123" });
    expect(out).toContain("abc123");
    expect(out).toMatch(/no es una instrucción/i);
  });
});
