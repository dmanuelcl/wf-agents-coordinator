import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createDefaultProjectRuntimeConfig } from "../../shared/workflow/agent-runtime-config";
import type { ProjectRuntimeConfig } from "../../shared/workflow/agent-runtime-config";
import { createDefaultAutoPilotConfig } from "../../shared/workflow/auto-pilot-config";
import type { AutoPilotConfig } from "../../shared/workflow/auto-pilot-config";
import { createDefaultReviewConfig } from "../../shared/workflow/review-config";
import type { ReviewConfig } from "../../shared/workflow/review-config";
import { createDefaultVcsConfig } from "../../shared/workflow/vcs-config";
import type { VcsConfig } from "../../shared/workflow/vcs-config";
import type { ProjectRecord, ProjectRegistry, ProjectUpdateInput } from "./project-registry";

const DEFAULT_CHECKPOINT_GLOBS = ["docs/workflow/checkpoints/*-checkpoint.md"];

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  checkpoint_globs: string;
  icon_data_url: string | null;
  runtime_config: string;
  auto_pilot: string;
  review: string;
  vcs: string;
  created_at_epoch_ms: number;
  updated_at_epoch_ms: number;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      checkpoint_globs TEXT NOT NULL,
      created_at_epoch_ms INTEGER NOT NULL,
      updated_at_epoch_ms INTEGER NOT NULL
    )
  `);

  const columns = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("icon_data_url")) {
    db.exec("ALTER TABLE projects ADD COLUMN icon_data_url TEXT DEFAULT NULL");
  }

  if (!columnNames.has("runtime_config")) {
    // ALTER TABLE ... ADD COLUMN ... DEFAULT backfills every existing row with
    // this value immediately, so pre-Plan-4 rows get a real default, not NULL.
    const defaultConfigJson = escapeSqlString(JSON.stringify(createDefaultProjectRuntimeConfig()));
    db.exec(`ALTER TABLE projects ADD COLUMN runtime_config TEXT NOT NULL DEFAULT '${defaultConfigJson}'`);
  }

  if (!columnNames.has("auto_pilot")) {
    // Same ADD COLUMN ... DEFAULT backfill: pre-conductor rows get a real
    // default AutoPilotConfig, not NULL.
    const defaultAutoPilotJson = escapeSqlString(JSON.stringify(createDefaultAutoPilotConfig()));
    db.exec(`ALTER TABLE projects ADD COLUMN auto_pilot TEXT NOT NULL DEFAULT '${defaultAutoPilotJson}'`);
  }

  if (!columnNames.has("review")) {
    const defaultReviewJson = escapeSqlString(JSON.stringify(createDefaultReviewConfig()));
    db.exec(`ALTER TABLE projects ADD COLUMN review TEXT NOT NULL DEFAULT '${defaultReviewJson}'`);
  }

  if (!columnNames.has("vcs")) {
    const defaultVcsJson = escapeSqlString(JSON.stringify(createDefaultVcsConfig()));
    db.exec(`ALTER TABLE projects ADD COLUMN vcs TEXT NOT NULL DEFAULT '${defaultVcsJson}'`);
  }
}

function rowToRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    checkpointGlobs: JSON.parse(row.checkpoint_globs) as string[],
    iconDataUrl: row.icon_data_url,
    runtimeConfig: JSON.parse(row.runtime_config) as ProjectRuntimeConfig,
    autoPilot: JSON.parse(row.auto_pilot) as AutoPilotConfig,
    review: JSON.parse(row.review) as ReviewConfig,
    vcs: JSON.parse(row.vcs) as VcsConfig,
    createdAtEpochMs: row.created_at_epoch_ms,
    updatedAtEpochMs: row.updated_at_epoch_ms,
  };
}

function insertRecord(db: Database.Database, record: ProjectRecord): void {
  db.prepare(
    `INSERT INTO projects (id, name, root_path, checkpoint_globs, icon_data_url, runtime_config, auto_pilot, review, vcs, created_at_epoch_ms, updated_at_epoch_ms)
     VALUES (@id, @name, @rootPath, @checkpointGlobs, @iconDataUrl, @runtimeConfig, @autoPilot, @review, @vcs, @createdAtEpochMs, @updatedAtEpochMs)`,
  ).run({
    id: record.id,
    name: record.name,
    rootPath: record.rootPath,
    checkpointGlobs: JSON.stringify(record.checkpointGlobs),
    iconDataUrl: record.iconDataUrl,
    runtimeConfig: JSON.stringify(record.runtimeConfig),
    autoPilot: JSON.stringify(record.autoPilot),
    review: JSON.stringify(record.review),
    vcs: JSON.stringify(record.vcs),
    createdAtEpochMs: record.createdAtEpochMs,
    updatedAtEpochMs: record.updatedAtEpochMs,
  });
}

function updateRecord(db: Database.Database, id: string, input: ProjectUpdateInput): ProjectRecord {
  const existing = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  if (!existing) {
    throw new Error(`Project not found: ${id}`);
  }

  const current = rowToRecord(existing);
  const updated: ProjectRecord = {
    ...current,
    name: input.name ?? current.name,
    iconDataUrl: input.iconDataUrl !== undefined ? input.iconDataUrl : current.iconDataUrl,
    runtimeConfig: input.runtimeConfig ?? current.runtimeConfig,
    autoPilot: input.autoPilot ?? current.autoPilot,
    review: input.review ?? current.review,
    vcs: input.vcs ?? current.vcs,
    updatedAtEpochMs: Date.now(),
  };

  db.prepare(
    "UPDATE projects SET name = @name, icon_data_url = @iconDataUrl, runtime_config = @runtimeConfig, auto_pilot = @autoPilot, review = @review, vcs = @vcs, updated_at_epoch_ms = @updatedAtEpochMs WHERE id = @id",
  ).run({
    id: updated.id,
    name: updated.name,
    iconDataUrl: updated.iconDataUrl,
    runtimeConfig: JSON.stringify(updated.runtimeConfig),
    autoPilot: JSON.stringify(updated.autoPilot),
    review: JSON.stringify(updated.review),
    vcs: JSON.stringify(updated.vcs),
    updatedAtEpochMs: updated.updatedAtEpochMs,
  });

  return updated;
}

async function migrateFromLegacyJson(db: Database.Database, legacyJsonFilePath: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(legacyJsonFilePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  const legacyRecords = JSON.parse(raw) as Array<Partial<ProjectRecord>>;
  const insertAll = db.transaction((records: Array<Partial<ProjectRecord>>) => {
    for (const legacy of records) {
      if (!legacy.id || !legacy.name || !legacy.rootPath) continue;
      const record: ProjectRecord = {
        id: legacy.id,
        name: legacy.name,
        rootPath: legacy.rootPath,
        checkpointGlobs: legacy.checkpointGlobs ?? [...DEFAULT_CHECKPOINT_GLOBS],
        iconDataUrl: legacy.iconDataUrl ?? null,
        runtimeConfig: legacy.runtimeConfig ?? createDefaultProjectRuntimeConfig(),
        autoPilot: legacy.autoPilot ?? createDefaultAutoPilotConfig(),
        review: legacy.review ?? createDefaultReviewConfig(),
        vcs: legacy.vcs ?? createDefaultVcsConfig(),
        createdAtEpochMs: legacy.createdAtEpochMs ?? Date.now(),
        updatedAtEpochMs: legacy.updatedAtEpochMs ?? Date.now(),
      };
      insertRecord(db, record);
    }
  });
  insertAll(legacyRecords);
}

export function createSqliteProjectRegistry(params: {
  sqliteFilePath: string;
  legacyJsonFilePath?: string;
}): ProjectRegistry {
  const { sqliteFilePath, legacyJsonFilePath } = params;

  const isFirstBoot = !existsSync(sqliteFilePath);
  mkdirSync(dirname(sqliteFilePath), { recursive: true });

  const db = new Database(sqliteFilePath);
  db.pragma("journal_mode = WAL");
  ensureSchema(db);

  const migrationDone: Promise<void> =
    isFirstBoot && legacyJsonFilePath ? migrateFromLegacyJson(db, legacyJsonFilePath) : Promise.resolve();

  return {
    async listProjects() {
      await migrationDone;
      const rows = db.prepare("SELECT * FROM projects ORDER BY created_at_epoch_ms ASC").all() as ProjectRow[];
      return rows.map(rowToRecord);
    },

    async addProject(input) {
      await migrationDone;
      const existing = db.prepare("SELECT * FROM projects WHERE root_path = ?").get(input.rootPath) as
        | ProjectRow
        | undefined;
      if (existing) {
        return rowToRecord(existing);
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
        createdAtEpochMs: now,
        updatedAtEpochMs: now,
      };

      insertRecord(db, record);
      return record;
    },

    async updateProject(id, input) {
      await migrationDone;
      return updateRecord(db, id, input);
    },

    async removeProject(id) {
      await migrationDone;
      db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    },
  };
}
