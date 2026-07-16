import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createDefaultProjectRuntimeConfig } from "../../shared/workflow/agent-runtime-config";
import type { ProjectRuntimeConfig } from "../../shared/workflow/agent-runtime-config";
import { createDefaultAutoPilotConfig } from "../../shared/workflow/auto-pilot-config";
import type { AutoPilotConfig } from "../../shared/workflow/auto-pilot-config";
import { createDefaultReviewConfig } from "../../shared/workflow/review-config";
import type { ReviewConfig } from "../../shared/workflow/review-config";
import { createDefaultVcsConfig } from "../../shared/workflow/vcs-config";
import type { VcsConfig } from "../../shared/workflow/vcs-config";

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  checkpointGlobs: string[];
  iconDataUrl: string | null;
  runtimeConfig: ProjectRuntimeConfig;
  autoPilot: AutoPilotConfig;
  review: ReviewConfig;
  vcs: VcsConfig;
  // Shell command run once in a fresh worktree before the agent starts (e.g.
  // `pnpm install`). Empty = nothing. The agent waits for it to finish.
  setupCommand: string;
  createdAtEpochMs: number;
  updatedAtEpochMs: number;
}

export interface ProjectUpdateInput {
  name?: string;
  iconDataUrl?: string | null;
  runtimeConfig?: ProjectRuntimeConfig;
  autoPilot?: AutoPilotConfig;
  review?: ReviewConfig;
  vcs?: VcsConfig;
  setupCommand?: string;
}

export interface ProjectRegistry {
  listProjects(): Promise<ProjectRecord[]>;
  addProject(input: {
    rootPath: string;
    name?: string;
    iconDataUrl?: string | null;
    runtimeConfig?: ProjectRuntimeConfig;
    autoPilot?: AutoPilotConfig;
    review?: ReviewConfig;
    vcs?: VcsConfig;
    setupCommand?: string;
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
        autoPilot: input.autoPilot ?? createDefaultAutoPilotConfig(),
        review: input.review ?? createDefaultReviewConfig(),
        vcs: input.vcs ?? createDefaultVcsConfig(),
        setupCommand: input.setupCommand ?? "",
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
        autoPilot: input.autoPilot ?? current.autoPilot,
        review: input.review ?? current.review,
        vcs: input.vcs ?? current.vcs,
        setupCommand: input.setupCommand ?? current.setupCommand,
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
