import { describe, expect, it } from "vitest";
import { createNodeSecretCipher } from "./node-secret-cipher";

const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

describe("createNodeSecretCipher", () => {
  it("encrypts and decrypts a runner VCS token", () => {
    const cipher = createNodeSecretCipher(KEY);
    const encrypted = cipher.encrypt("ghp-secret");

    expect(encrypted).not.toContain("ghp-secret");
    expect(cipher.decrypt(encrypted)).toBe("ghp-secret");
  });

  it("refuses to operate without a valid 32-byte deployment key", () => {
    const cipher = createNodeSecretCipher("not-a-key");
    expect(cipher.isAvailable()).toBe(false);
    expect(() => cipher.encrypt("secret")).toThrow(/DATA_KEY/);
  });
});
