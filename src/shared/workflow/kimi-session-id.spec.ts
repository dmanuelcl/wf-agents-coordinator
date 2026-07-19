import { describe, expect, it } from "vitest";
import { findKimiSessionId, isKimiSessionId } from "./kimi-session-id";

describe("Kimi session ids", () => {
  const SID = "session_11111111-1111-4111-8111-111111111111";

  it("extracts the id Kimi renders in its welcome/status screen", () => {
    expect(findKimiSessionId(`Directory: /repo\nSession:   ${SID}\nModel: Kimi for Code`)).toBe(SID);
  });

  it("accepts only current session_<uuid> ids", () => {
    expect(isKimiSessionId(SID)).toBe(true);
    expect(isKimiSessionId("11111111-1111-4111-8111-111111111111")).toBe(false);
    expect(isKimiSessionId("session_../../config.toml")).toBe(false);
  });

  it("returns null when a partial or unrelated id is visible", () => {
    expect(findKimiSessionId("Session: session_11111111…")).toBeNull();
  });
});
