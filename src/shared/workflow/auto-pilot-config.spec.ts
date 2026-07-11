import { describe, expect, it } from "vitest";
import { clampAutoPilotConfig, createDefaultAutoPilotConfig } from "./auto-pilot-config";

describe("createDefaultAutoPilotConfig", () => {
  it("defaults to 3 re-loops and a 4s settle delay", () => {
    expect(createDefaultAutoPilotConfig()).toEqual({ reloopLimit: 3, settleDelayMs: 4000 });
  });

  it("returns a fresh object each call (no shared reference)", () => {
    const a = createDefaultAutoPilotConfig();
    a.reloopLimit = 9;
    expect(createDefaultAutoPilotConfig().reloopLimit).toBe(3);
  });
});

describe("clampAutoPilotConfig", () => {
  it("fills missing fields from the default", () => {
    expect(clampAutoPilotConfig({})).toEqual({ reloopLimit: 3, settleDelayMs: 4000 });
  });

  it("clamps reloopLimit into 1..10 and floors it to an integer", () => {
    expect(clampAutoPilotConfig({ reloopLimit: 0 }).reloopLimit).toBe(1);
    expect(clampAutoPilotConfig({ reloopLimit: 99 }).reloopLimit).toBe(10);
    expect(clampAutoPilotConfig({ reloopLimit: 3.9 }).reloopLimit).toBe(3);
  });

  it("floors settleDelayMs to a minimum of 500ms", () => {
    expect(clampAutoPilotConfig({ settleDelayMs: 10 }).settleDelayMs).toBe(500);
    expect(clampAutoPilotConfig({ settleDelayMs: 8000 }).settleDelayMs).toBe(8000);
  });
});
