import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeConversationExists } from "./claude-session-store";

let projectsDir: string;

beforeEach(() => {
  projectsDir = mkdtempSync(join(tmpdir(), "claude-projects-"));
});

afterEach(() => {
  rmSync(projectsDir, { recursive: true, force: true });
});

describe("claudeConversationExists", () => {
  it("finds a conversation file under any project dir, regardless of the escaped cwd", async () => {
    const dir = join(projectsDir, "-Users-me-Projects-app--worktrees-feat");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "abc-123.jsonl"), "{}", "utf8");

    expect(await claudeConversationExists("abc-123", projectsDir)).toBe(true);
  });

  it("returns false when no file exists for the uuid (never persisted)", async () => {
    mkdirSync(join(projectsDir, "-some-project"), { recursive: true });
    expect(await claudeConversationExists("missing-uuid", projectsDir)).toBe(false);
  });

  it("returns false when the projects dir does not exist", async () => {
    expect(await claudeConversationExists("x", join(projectsDir, "does-not-exist"))).toBe(false);
  });
});

import { claudeSessionContextTokens } from "./claude-session-store";

describe("claudeSessionContextTokens", () => {
  const usage = (input: number, cacheRead: number, cacheCreation = 0) =>
    JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation } },
    });

  it("reads the LAST assistant usage of the session's transcript", async () => {
    const dir = join(projectsDir, "-Users-me-Projects-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s-1.jsonl"), [usage(10, 100), '{"type":"user"}', usage(2_000, 310_000, 8_000)].join("\n"), "utf8");

    expect(await claudeSessionContextTokens("s-1", projectsDir)).toBe(320_000);
  });

  it("returns null when the transcript has no usage, is garbage, or does not exist", async () => {
    const dir = join(projectsDir, "-p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s-2.jsonl"), 'not-json\n{"type":"assistant","message":{}}', "utf8");

    expect(await claudeSessionContextTokens("s-2", projectsDir)).toBeNull();
    expect(await claudeSessionContextTokens("nope", projectsDir)).toBeNull();
  });
});
