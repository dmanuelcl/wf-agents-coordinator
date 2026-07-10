import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PersistedShellTab {
  id: string;
  title: string;
  // Shell tabs opened in the repo root rather than the session worktree.
  root?: boolean;
}

// One opened session's UI state: which agent tabs are open, the dynamic shell
// tabs (each with a title), and which tab is active. Values are stored loosely
// and validated on the renderer side, so a stale file can't crash a restore.
export interface PersistedSessionLayout {
  sessionId: string;
  openedRoleTabs: string[];
  shellTabs: PersistedShellTab[];
  activeTab: string;
}

export interface WorkspaceLayout {
  openedSessions: PersistedSessionLayout[];
  selectedSessionId: string | null;
}

/**
 * Persists the session workspace layout (which sessions/tabs are open, what's
 * selected) so a restart restores the desk exactly — the user never has to
 * re-find their way through dozens of sessions. Agent conversations are
 * restored separately via each tab's stored `--resume` id.
 */
export interface WorkspaceLayoutStore {
  get(): Promise<WorkspaceLayout | null>;
  set(layout: WorkspaceLayout): Promise<void>;
}

export function createWorkspaceLayoutStore(params: { storeFilePath: string }): WorkspaceLayoutStore {
  const { storeFilePath } = params;

  return {
    async get() {
      try {
        const raw = await readFile(storeFilePath, "utf8");
        return JSON.parse(raw) as WorkspaceLayout;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },

    async set(layout) {
      await mkdir(dirname(storeFilePath), { recursive: true });
      await writeFile(storeFilePath, JSON.stringify(layout, null, 2), "utf8");
    },
  };
}
