import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTerminalScrollbackStore } from "./terminal-scrollback-store";

const MAX_BYTES = 256 * 1024;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scrollback-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createTerminalScrollbackStore", () => {
  it("records and reads back a terminal's output", async () => {
    const store = createTerminalScrollbackStore({ dir });
    store.record("s1::t1", "hello\n");
    store.record("s1::t1", "world\n");
    expect(await store.read("s1::t1")).toBe("hello\nworld\n");
  });

  it("returns empty for an unknown key", async () => {
    const store = createTerminalScrollbackStore({ dir });
    expect(await store.read("nope")).toBe("");
  });

  it("persists to disk on flush and a fresh store reads it back", async () => {
    const store = createTerminalScrollbackStore({ dir });
    store.record("s1::t1", "persisted output\n");
    await store.flush();

    const reopened = createTerminalScrollbackStore({ dir });
    expect(await reopened.read("s1::t1")).toBe("persisted output\n");
  });

  it("caps the buffer to the tail so a noisy terminal can't balloon memory", async () => {
    const store = createTerminalScrollbackStore({ dir });
    // ~400 KB of line-delimited output, well over the 256 KB cap.
    store.record("s1::t1", "line\n".repeat(80_000));
    const result = await store.read("s1::t1");

    expect(result.length).toBeLessThanOrEqual(MAX_BYTES);
    // Trimmed to a line boundary, and the newest content is retained.
    expect(result.startsWith("line\n")).toBe(true);
    expect(result.endsWith("line\n")).toBe(true);
  });

  it("skips alt-screen TUI content (across chunks), keeping only the real shell output", async () => {
    const store = createTerminalScrollbackStore({ dir });
    store.record("s1::t1", "$ ls\nfile.txt\n");
    store.record("s1::t1", "\x1b[?1049hCLAUDE TUI NOISE"); // enter alt screen + noise
    store.record("s1::t1", "more noise\x1b[?1049l"); // exit alt screen in a later chunk
    store.record("s1::t1", "$ echo done\ndone\n");

    expect(await store.read("s1::t1")).toBe("$ ls\nfile.txt\n$ echo done\ndone\n");
  });

  it("clears a key from memory and disk", async () => {
    const store = createTerminalScrollbackStore({ dir });
    store.record("s1::t1", "data\n");
    await store.flush();
    await store.clear("s1::t1");

    const reopened = createTerminalScrollbackStore({ dir });
    expect(await reopened.read("s1::t1")).toBe("");
  });
});
