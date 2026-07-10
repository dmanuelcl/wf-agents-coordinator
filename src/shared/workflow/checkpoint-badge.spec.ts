import { describe, expect, it } from "vitest";
import { deriveCheckpointBadge } from "./checkpoint-badge";

describe("deriveCheckpointBadge", () => {
  it("marks BLOCKED as attention severity — the state that needs the human", () => {
    const badge = deriveCheckpointBadge({ status: "BLOCKED", activeRole: "implementer" });
    expect(badge.severity).toBe("attention");
    expect(badge.statusLabel).toBe("BLOCKED");
    expect(badge.activeRoleLabel).toBe("implementer");
  });

  it("marks IN_PROGRESS as normal severity", () => {
    const badge = deriveCheckpointBadge({ status: "IN_PROGRESS", activeRole: "none" });
    expect(badge.severity).toBe("normal");
    expect(badge.activeRoleLabel).toBeNull();
  });

  it("marks DONE as done severity, visually distinct from both normal and attention", () => {
    const badge = deriveCheckpointBadge({ status: "DONE", activeRole: "none" });
    expect(badge.severity).toBe("done");
  });

  it("marks UNKNOWN status as normal severity (not attention — only BLOCKED needs the human)", () => {
    const badge = deriveCheckpointBadge({ status: "UNKNOWN", activeRole: "unknown" });
    expect(badge.severity).toBe("normal");
    expect(badge.activeRoleLabel).toBeNull();
  });

  it("surfaces the active role label when a role is actively working", () => {
    const badge = deriveCheckpointBadge({ status: "IN_PROGRESS", activeRole: "reviewer" });
    expect(badge.activeRoleLabel).toBe("reviewer");
  });

  it("treats 'none' and 'unknown' active roles identically as no active role label", () => {
    const noneBadge = deriveCheckpointBadge({ status: "IN_PROGRESS", activeRole: "none" });
    const unknownBadge = deriveCheckpointBadge({ status: "IN_PROGRESS", activeRole: "unknown" });
    expect(noneBadge.activeRoleLabel).toBeNull();
    expect(unknownBadge.activeRoleLabel).toBeNull();
  });
});
