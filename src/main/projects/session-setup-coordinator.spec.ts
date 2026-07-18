import { describe, expect, it } from "vitest";
import { createSessionSetupCoordinator } from "./session-setup-coordinator";

describe("createSessionSetupCoordinator", () => {
  it("grants only one concurrent setup owner per session", () => {
    const coordinator = createSessionSetupCoordinator();

    expect(coordinator.tryClaim("s1")).toBe(true);
    expect(coordinator.tryClaim("s1")).toBe(false);
    expect(coordinator.tryClaim("s2")).toBe(true);
  });

  it("allows a retry after completion, failure, or unmount releases the claim", () => {
    const coordinator = createSessionSetupCoordinator();
    expect(coordinator.tryClaim("s1")).toBe(true);

    coordinator.release("s1");

    expect(coordinator.tryClaim("s1")).toBe(true);
  });
});
