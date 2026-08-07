import { describe, expect, it } from "vitest";
import { checkpointLabel, checkpointSearchText, statusBadgeClass } from "./checkpoint-display";
import type { RefCheckpointSummary } from "../../shared/ipc/contract";

function checkpoint(overrides: Partial<RefCheckpointSummary> = {}): RefCheckpointSummary {
  return {
    path: "docs/checkpoints/session-start-point.md",
    feature: "Session start point",
    slug: "session-start-point",
    status: "PLANNED",
    ...overrides,
  };
}

describe("checkpointLabel", () => {
  it("prefers the feature title", () => {
    expect(checkpointLabel(checkpoint())).toBe("Session start point");
  });

  it("falls back to the slug when the checkpoint has no feature title", () => {
    expect(checkpointLabel(checkpoint({ feature: null }))).toBe("session-start-point");
  });

  it("falls back to the path when it has neither a title nor a slug", () => {
    expect(checkpointLabel(checkpoint({ feature: null, slug: null }))).toBe(
      "docs/checkpoints/session-start-point.md",
    );
  });
});

describe("checkpointSearchText", () => {
  it("matches on the title, slug, path or status", () => {
    const text = checkpointSearchText(checkpoint());

    expect(text).toContain("session start point");
    expect(text).toContain("session-start-point");
    expect(text).toContain("docs/checkpoints/session-start-point.md");
    expect(text).toContain("planned");
  });

  it("skips the fields a checkpoint does not have", () => {
    const text = checkpointSearchText(checkpoint({ feature: null, slug: null }));

    expect(text).toBe("docs/checkpoints/session-start-point.md planned");
  });
});

describe("statusBadgeClass", () => {
  it("marks BLOCKED as needing attention and DONE as finished", () => {
    expect(statusBadgeClass("BLOCKED")).toBe("badge badge-attention");
    expect(statusBadgeClass("DONE")).toBe("badge badge-done");
  });

  it("leaves every other status as a plain badge", () => {
    expect(statusBadgeClass("PLANNED")).toBe("badge");
    expect(statusBadgeClass("IN_REVIEW")).toBe("badge");
  });
});
