import { readFile } from "node:fs/promises";
import { parseStateFile, writeStateFile } from "../state/state-file";
import type { LaunchRole } from "../../shared/workflow/role-launch-plan";

export interface ProjectSessionState {
  selectedCheckpointPath: string | null;
  openPanesByCheckpoint: Record<string, LaunchRole[]>;
  activeRoleByCheckpoint: Record<string, LaunchRole>;
}

export interface SessionStateStore {
  get(projectId: string): Promise<ProjectSessionState | null>;
  set(projectId: string, state: ProjectSessionState): Promise<void>;
}

export function createSessionStateStore(params: { storeFilePath: string }): SessionStateStore {
  const { storeFilePath } = params;

  async function readAll(): Promise<Record<string, ProjectSessionState>> {
    try {
      const raw = await readFile(storeFilePath, "utf8");
      return parseStateFile(raw, storeFilePath) as Record<string, ProjectSessionState>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  async function writeAll(records: Record<string, ProjectSessionState>): Promise<void> {
    await writeStateFile(storeFilePath, JSON.stringify(records, null, 2));
  }

  return {
    async get(projectId) {
      const records = await readAll();
      return records[projectId] ?? null;
    },

    async set(projectId, state) {
      const records = await readAll();
      records[projectId] = state;
      await writeAll(records);
    },
  };
}
