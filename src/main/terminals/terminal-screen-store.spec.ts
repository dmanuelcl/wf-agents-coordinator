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

  // A streaming agent writes its answer to the PTY in token-sized pieces, so a
  // brainstorming session is tens of thousands of tiny chunks. Awaiting each one
  // costs a full event-loop turn, which starved the runner and made every
  // client feel slow. Measured on this machine: 20k chunks took 23s that way and
  // 13ms without, so a 2s bound flags the regression without being flaky.
  it("absorbs a streaming agent's chunks without stalling the runner", async () => {
    const store = createTerminalScreenStore();
    store.create("pty-1", { cols: 160, rows: 44 });
    const words = "we could model this as a pure resolver ".split(" ");

    const startedAt = performance.now();
    for (let i = 0; i < 20_000; i += 1) {
      store.write("pty-1", `${words[i % words.length] as string} ${i % 12 === 0 ? "\r\n" : ""}`);
    }
    const snapshot = await store.snapshot("pty-1");
    const elapsedMs = performance.now() - startedAt;

    expect(snapshot).not.toBeNull();
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
