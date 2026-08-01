import { describe, expect, it } from "vitest";
import { createTerminalScreenStore } from "./terminal-screen-store";

describe("createTerminalScreenStore", () => {
  it("captures the runner's current alternate-screen TUI without a browser", async () => {
    const store = createTerminalScreenStore();
    store.create("pty-1", { cols: 20, rows: 4 });
    store.write("pty-1", "\x1b[?1049hClaude is reviewing");

    const snapshot = await store.snapshot("pty-1");

    expect(snapshot).toMatchObject({ cols: 20, rows: 4, alternateScreen: true });
    expect(snapshot?.lines.join("\n")).toContain("Claude is reviewing");
  });

  it("serializes writes in PTY order before taking a snapshot", async () => {
    const store = createTerminalScreenStore();
    store.create("pty-1", { cols: 20, rows: 4 });
    store.write("pty-1", "first ");
    store.write("pty-1", "second");

    const snapshot = await store.snapshot("pty-1");

    expect(snapshot?.lines.join("\n")).toContain("first second");
  });
});
