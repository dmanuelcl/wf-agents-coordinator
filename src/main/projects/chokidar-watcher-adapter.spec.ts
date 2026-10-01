import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChokidarWatcher } from "./chokidar-watcher-adapter";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-coordinator-chokidar-adapter-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createChokidarWatcher", () => {
  // Every caller only cares about files directly inside the watched directory.
  // An agent once left a whole project copy with its node_modules under `.wf/`;
  // walking it opened one descriptor per directory and the main process died
  // with EMFILE.
  it("does not descend into subdirectories of a watched directory", async () => {
    const nestedDir = join(dir, "pr-fix-plan-1", "node_modules", "eslint");
    mkdirSync(nestedDir, { recursive: true });
    const watcher = createChokidarWatcher([dir]);
    const seen: string[] = [];
    watcher.onAdd((path) => seen.push(path));
    watcher.onChange((path) => seen.push(path));

    try {
      // The watcher has no "ready" signal; keep writing until it reports the
      // direct child. The nested file is always written first.
      let attempt = 0;
      await vi.waitFor(
        () => {
          attempt += 1;
          writeFileSync(join(nestedDir, "index.js"), String(attempt), "utf8");
          writeFileSync(join(dir, "handoff.json"), String(attempt), "utf8");
          expect(seen).toContain(join(dir, "handoff.json"));
        },
        { timeout: 5000, interval: 100 },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(seen).not.toContain(join(nestedDir, "index.js"));
    } finally {
      await watcher.close();
    }
  });
});
