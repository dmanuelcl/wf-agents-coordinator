import { describe, expect, it } from "vitest";
import { slugifySessionName } from "./work-session";
import type { WorkSession, WorkSessionKind } from "./work-session";

describe("slugifySessionName", () => {
  it("lowercases and hyphenates spaces", () => {
    expect(slugifySessionName("My Feature")).toBe("my-feature");
  });

  it("collapses runs of separators into a single hyphen", () => {
    expect(slugifySessionName("Multiple   Spaces")).toBe("multiple-spaces");
  });

  it("trims leading and trailing separators", () => {
    expect(slugifySessionName("  Trim me!  ")).toBe("trim-me");
  });

  it("replaces any non-alphanumeric run with one hyphen", () => {
    expect(slugifySessionName("Fix: the/bug (now)!")).toBe("fix-the-bug-now");
  });

  it("preserves digits", () => {
    expect(slugifySessionName("Plan 4 redesign")).toBe("plan-4-redesign");
  });

  it("strips diacritics to ASCII", () => {
    expect(slugifySessionName("Café Señor")).toBe("cafe-senor");
  });

  it("is idempotent on an already-kebab slug (dedupe-safe)", () => {
    const once = slugifySessionName("Already Kebab");
    expect(once).toBe("already-kebab");
    expect(slugifySessionName(once)).toBe(once);
  });

  it("produces only folder/branch-safe characters (no leading/trailing hyphen, no double hyphen)", () => {
    const slug = slugifySessionName("  Weird__Name -- with...dots  ");
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});

describe("WorkSession shape", () => {
  it("holds all declared fields with the right types", () => {
    const kind: WorkSessionKind = "fix";
    const session: WorkSession = {
      id: "s1",
      projectId: "p1",
      name: "Fix login",
      kind,
      slug: "fix-login",
      branch: "fix/fix-login",
      baseBranch: null,
      pr: null,
      worktreePath: "/repo/.worktrees/fix-login",
      checkpointPath: null,
      createdAtEpochMs: 1_700_000_000_000,
    };

    expect(session.checkpointPath).toBeNull();
    expect(session.kind).toBe("fix");
    expect(session.branch).toBe("fix/fix-login");
  });
});
