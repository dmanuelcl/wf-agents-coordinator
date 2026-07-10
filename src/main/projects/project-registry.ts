import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createDefaultProjectRuntimeConfig } from "../../shared/workflow/agent-runtime-config";
import type { ProjectRuntimeConfig } from "../../shared/workflow/agent-runtime-config";

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  checkpointGlobs: string[];
  iconDataUrl: string | null;
  runtimeConfig: ProjectRuntimeConfig;
  createdAtEpochMs: number;
  updatedAtEpochMs: number;
}

export interface ProjectUpdateInput {
  name?: string;
  iconDataUrl?: string | null;
  runtimeConfig?: ProjectRuntimeConfig;
}

export interface ProjectRegistry {
  listProjects(): Promise<ProjectRecord[]>;
  addProject(input: {
    rootPath: string;
    name?: string;
    iconDataUrl?: string | null;
    runtimeConfig?: ProjectRuntimeConfig;
  }): Promise<ProjectRecord>;
  updateProject(id: string, input: ProjectUpdateInput): Promise<ProjectRecord>;
  removeProject(id: string): Promise<void>;
}

const DEFAULT_CHECKPOINT_GLOBS = ["docs/workflow/checkpoints/*-checkpoint.md"];

export function createProjectRegistry(params: { storeFilePath: string }): ProjectRegistry {
  const { storeFilePath } = params;

  async function readAll(): Promise<ProjectRecord[]> {
    try {
      const raw = await readFile(storeFilePath, "utf8");
      return JSON.parse(raw) as ProjectRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async function writeAll(records: ProjectRecord[]): Promise<void> {
    await mkdir(dirname(storeFilePath), { recursive: true });
    await writeFile(storeFilePath, JSON.stringify(records, null, 2), "utf8");
  }

  return {
    async listProjects() {
      return readAll();
    },

    async addProject(input) {
      const records = await readAll();
      const existing = records.find((record) => record.rootPath === input.rootPath);
      if (existing) {
        return existing;
      }

      const now = Date.now();
      const record: ProjectRecord = {
        id: randomUUID(),
        name: input.name ?? basename(input.rootPath),
        rootPath: input.rootPath,
        checkpointGlobs: [...DEFAULT_CHECKPOINT_GLOBS],
        iconDataUrl: input.iconDataUrl ?? null,
        runtimeConfig: input.runtimeConfig ?? createDefaultProjectRuntimeConfig(),
        createdAtEpochMs: now,
        updatedAtEpochMs: now,
      };

      records.push(record);
      await writeAll(records);
      return record;
    },

    async updateProject(id, input) {
      const records = await readAll();
      const index = records.findIndex((record) => record.id === id);
      if (index === -1) {
        throw new Error(`Project not found: ${id}`);
      }

      const current = records[index] as ProjectRecord;
      const updated: ProjectRecord = {
        ...current,
        name: input.name ?? current.name,
        iconDataUrl: input.iconDataUrl !== undefined ? input.iconDataUrl : current.iconDataUrl,
        runtimeConfig: input.runtimeConfig ?? current.runtimeConfig,
        updatedAtEpochMs: Date.now(),
      };

      records[index] = updated;
      await writeAll(records);
      return updated;
    },

    async removeProject(id) {
      const records = await readAll();
      const filtered = records.filter((record) => record.id !== id);
      await writeAll(filtered);
    },
  };
}
