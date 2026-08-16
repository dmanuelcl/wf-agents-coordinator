import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface TrackedGroup {
  /** Process-group id of a terminal this app started. */
  pgid: number;
  /** The app run that started it, so a live sibling instance is left alone. */
  ownerPid: number;
}

export interface OrphanReaper {
  track(pgid: number): void;
  release(pgid: number): void;
  /** Kill every tracked group whose owning run is gone. Returns what it killed. */
  sweep(): number[];
}

/**
 * Terminals outlive the app when they are closed the hard way.
 *
 * Killing a PTY reaches its process group, but a crash, a force quit or a lost
 * runner never gets to kill anything — and whatever the shell had started keeps
 * running, reparented to init, with nothing left that knows it exists. A build
 * pipeline left that way holds gigabytes for as long as the machine is up.
 *
 * So each terminal's group id is written to disk the moment it is created, and
 * the next run kills whatever is still standing. Groups are identified by pgid
 * rather than by working directory: this only ever signals processes this app
 * started, never something the user happened to run in the same folder.
 */
export function createOrphanReaper(params: {
  storeFilePath: string;
  ownerPid?: number;
  listLiveProcessGroups?: () => number[];
  isProcessAlive?: (pid: number) => boolean;
  killGroup?: (pgid: number) => void;
}): OrphanReaper {
  const { storeFilePath } = params;
  const ownerPid = params.ownerPid ?? process.pid;
  const listLiveProcessGroups = params.listLiveProcessGroups ?? defaultListLiveProcessGroups;
  const isProcessAlive = params.isProcessAlive ?? defaultIsProcessAlive;
  const killGroup = params.killGroup ?? defaultKillGroup;

  function read(): TrackedGroup[] {
    try {
      const parsed = JSON.parse(readFileSync(storeFilePath, "utf8")) as { entries?: unknown };
      if (!Array.isArray(parsed.entries)) return [];
      return parsed.entries.filter(
        (entry): entry is TrackedGroup =>
          typeof entry === "object" && entry !== null &&
          typeof (entry as TrackedGroup).pgid === "number" &&
          typeof (entry as TrackedGroup).ownerPid === "number",
      );
    } catch {
      // Missing, truncated by a crash, or hand-edited. Losing the trail costs an
      // orphan; refusing to start costs the app.
      return [];
    }
  }

  // Written synchronously and eagerly: the crash this guards against is exactly
  // the moment there is no chance to flush anything later.
  function write(entries: TrackedGroup[]): void {
    try {
      mkdirSync(dirname(storeFilePath), { recursive: true });
      writeFileSync(storeFilePath, JSON.stringify({ entries }), "utf8");
    } catch {
      // Best effort. A terminal must still open when its bookkeeping cannot.
    }
  }

  return {
    track(pgid) {
      const entries = read().filter((entry) => entry.pgid !== pgid);
      entries.push({ pgid, ownerPid });
      write(entries);
    },

    release(pgid) {
      const entries = read();
      const remaining = entries.filter((entry) => !(entry.pgid === pgid && entry.ownerPid === ownerPid));
      if (remaining.length !== entries.length) write(remaining);
    },

    sweep() {
      const entries = read();
      if (entries.length === 0) return [];
      const live = new Set(listLiveProcessGroups());
      const killed: number[] = [];
      const keep: TrackedGroup[] = [];

      for (const entry of entries) {
        // Another instance is still running and still owns its terminals.
        if (entry.ownerPid !== ownerPid && isProcessAlive(entry.ownerPid)) {
          keep.push(entry);
          continue;
        }
        // A group with no live member is already gone; signalling it could reach
        // an unrelated process if the id has since been recycled.
        if (!live.has(entry.pgid)) continue;
        try {
          killGroup(entry.pgid);
          killed.push(entry.pgid);
        } catch {
          // Raced with its own exit, or not ours to signal.
        }
      }

      write(keep);
      return killed;
    },
  };
}

function defaultListLiveProcessGroups(): number[] {
  try {
    const stdout = execFileSync("ps", ["-axo", "pgid="], { encoding: "utf8" });
    return stdout
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pgid) => Number.isInteger(pgid) && pgid > 0);
  } catch {
    return [];
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks without delivering.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultKillGroup(pgid: number): void {
  // A negative pid addresses the whole group, which is what a shell's children
  // inherit — the build workers and dev servers that outlive their terminal.
  process.kill(-pgid, "SIGKILL");
}
