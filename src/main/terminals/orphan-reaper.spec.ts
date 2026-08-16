import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrphanReaper } from "./orphan-reaper";

let dir: string;

function storePath(): string {
  return join(dir, "spawned-groups.json");
}

function makeReaper(params: {
  ownerPid?: number;
  liveGroups?: number[];
  alivePids?: number[];
  killGroup?: (pgid: number) => void;
}) {
  return createOrphanReaper({
    storeFilePath: storePath(),
    ownerPid: params.ownerPid ?? 100,
    listLiveProcessGroups: () => params.liveGroups ?? [],
    isProcessAlive: (pid) => (params.alivePids ?? []).includes(pid),
    killGroup: params.killGroup ?? vi.fn(),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-coordinator-reaper-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createOrphanReaper", () => {
  it("kills a group left behind by a run that is no longer alive", () => {
    makeReaper({ ownerPid: 100 }).track(555);

    const killGroup = vi.fn();
    // A new app instance: the old owner is gone, its group is not.
    const swept = makeReaper({ ownerPid: 200, liveGroups: [555], alivePids: [200], killGroup }).sweep();

    expect(killGroup).toHaveBeenCalledWith(555);
    expect(swept).toEqual([555]);
  });

  // Two instances can share a state directory. Killing another live instance's
  // terminals would be far worse than leaving an orphan.
  it("leaves a group whose owning run is still alive", () => {
    makeReaper({ ownerPid: 100 }).track(555);

    const killGroup = vi.fn();
    makeReaper({ ownerPid: 200, liveGroups: [555], alivePids: [100, 200], killGroup }).sweep();

    expect(killGroup).not.toHaveBeenCalled();
  });

  // A pgid with no live member cannot be reaped, and signalling it could reach
  // an unrelated process if the id was recycled.
  it("does not signal a group that has no live members", () => {
    makeReaper({ ownerPid: 100 }).track(555);

    const killGroup = vi.fn();
    makeReaper({ ownerPid: 200, liveGroups: [], alivePids: [200], killGroup }).sweep();

    expect(killGroup).not.toHaveBeenCalled();
  });

  it("forgets a group whose terminal exited normally", () => {
    const reaper = makeReaper({ ownerPid: 100 });
    reaper.track(555);
    reaper.release(555);

    const killGroup = vi.fn();
    makeReaper({ ownerPid: 200, liveGroups: [555], alivePids: [200], killGroup }).sweep();

    expect(killGroup).not.toHaveBeenCalled();
  });

  it("drops swept and dead entries so the file cannot grow without bound", () => {
    const first = makeReaper({ ownerPid: 100 });
    first.track(1);
    first.track(2);

    makeReaper({ ownerPid: 200, liveGroups: [1], alivePids: [200] }).sweep();

    expect(JSON.parse(readFileSync(storePath(), "utf8"))).toEqual({ entries: [] });
  });

  it("keeps another live run's entries when it sweeps", () => {
    makeReaper({ ownerPid: 100 }).track(555);
    makeReaper({ ownerPid: 300 }).track(777);

    makeReaper({ ownerPid: 200, liveGroups: [555, 777], alivePids: [200, 300] }).sweep();

    expect(JSON.parse(readFileSync(storePath(), "utf8"))).toEqual({
      entries: [{ pgid: 777, ownerPid: 300 }],
    });
  });

  // The whole point is surviving a crash, so a half-written or hand-edited file
  // must not stop the app from starting.
  it("starts clean when the store is unreadable", () => {
    writeFileSync(storePath(), "{ not json", "utf8");

    const reaper = makeReaper({ ownerPid: 200, liveGroups: [555], alivePids: [200] });
    expect(reaper.sweep()).toEqual([]);
    reaper.track(9);
    expect(JSON.parse(readFileSync(storePath(), "utf8"))).toEqual({ entries: [{ pgid: 9, ownerPid: 200 }] });
  });

  it("records a group as soon as it is tracked, so a crash still leaves a trail", () => {
    makeReaper({ ownerPid: 100 }).track(42);

    expect(JSON.parse(readFileSync(storePath(), "utf8"))).toEqual({ entries: [{ pgid: 42, ownerPid: 100 }] });
  });
});
