import { describe, expect, it } from "vitest";
import {
  normalizeSessionName,
  SESSION_NAME_MAX_LENGTH,
  SESSION_SLUG_MAX_LENGTH,
  sessionSlugWithSuffix,
  slugifySessionName,
  truncateSessionName,
} from "./work-session";
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

  it("caps the folder/branch component and removes a cut trailing separator", () => {
    const slug = slugifySessionName(`${"a".repeat(79)} ${"b".repeat(80)}`);
    expect(slug.length).toBeLessThanOrEqual(SESSION_SLUG_MAX_LENGTH);
    expect(slug).not.toMatch(/-$/);
  });

  it("keeps collision suffixes inside the same component cap", () => {
    const base = "a".repeat(SESSION_SLUG_MAX_LENGTH);
    expect(sessionSlugWithSuffix(base, 2)).toHaveLength(SESSION_SLUG_MAX_LENGTH);
    expect(sessionSlugWithSuffix(base, 2)).toMatch(/-2$/);
    expect(sessionSlugWithSuffix(base, 9999)).toHaveLength(SESSION_SLUG_MAX_LENGTH);
    expect(sessionSlugWithSuffix(base, 9999)).toMatch(/-9999$/);
  });
});

describe("session name limits", () => {
  it("trims and accepts a name at the limit", () => {
    expect(normalizeSessionName(`  ${"x".repeat(SESSION_NAME_MAX_LENGTH)}  `)).toHaveLength(
      SESSION_NAME_MAX_LENGTH,
    );
  });

  it("rejects names beyond the limit", () => {
    expect(() => normalizeSessionName("x".repeat(SESSION_NAME_MAX_LENGTH + 1))).toThrow(/cannot exceed 100/i);
  });

  it("truncates generated PR labels to the UI limit", () => {
    const name = truncateSessionName("PR #42: " + "x".repeat(200));
    expect(name).toHaveLength(SESSION_NAME_MAX_LENGTH);
    expect(name).toMatch(/…$/);
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
      setupDone: false,
      createdAtEpochMs: 1_700_000_000_000,
    };

    expect(session.checkpointPath).toBeNull();
    expect(session.kind).toBe("fix");
    expect(session.branch).toBe("fix/fix-login");
  });
});
