import { describe, expect, it } from "vitest";
import { hasBlockingStartupConfirmation } from "./terminal-startup-readiness";

describe("hasBlockingStartupConfirmation", () => {
  it("detects Claude's bypass-permissions acceptance screen", () => {
    expect(
      hasBlockingStartupConfirmation(`
        Bypass Permissions mode
        Claude Code will not ask for permission before running commands.
        1. No, exit
        2. Yes, I accept
      `),
    ).toBe(true);
  });

  it("detects workspace trust confirmations", () => {
    expect(hasBlockingStartupConfirmation("Do you trust this folder? Yes / No")).toBe(true);
  });

  it("does not block normal agent chrome that only reports bypass mode", () => {
    expect(hasBlockingStartupConfirmation("Claude Code · bypass permissions on · /help for help")).toBe(false);
  });

  it("does not block a normal ready prompt", () => {
    expect(hasBlockingStartupConfirmation("Claude Code ready >")).toBe(false);
  });
});
