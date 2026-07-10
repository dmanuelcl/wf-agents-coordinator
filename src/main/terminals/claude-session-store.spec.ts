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
