import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
      return JSON.parse(raw) as Record<string, ProjectSessionState>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  async function writeAll(records: Record<string, ProjectSessionState>): Promise<void> {
    await mkdir(dirname(storeFilePath), { recursive: true });
    await writeFile(storeFilePath, JSON.stringify(records, null, 2), "utf8");
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
