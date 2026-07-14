import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultProjectRuntimeConfig } from "../../shared/workflow/agent-runtime-config";
import { defineProjectRegistryContractTests } from "./project-registry.contract";
import { createSqliteProjectRegistry } from "./sqlite-project-registry";
import type { ProjectRecord } from "./project-registry";

type LegacyProjectRecord = Omit<ProjectRecord, "iconDataUrl" | "runtimeConfig" | "autoPilot" | "review" | "vcs">;

let dir: string;
let sqliteFilePath: string;
let legacyJsonFilePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-coordinator-sqlite-registry-"));
  sqliteFilePath = join(dir, "app.db");
  legacyJsonFilePath = join(dir, "projects.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

defineProjectRegistryContractTests(() => createSqliteProjectRegistry({ sqliteFilePath }));

describe("createSqliteProjectRegistry autoPilot", () => {
  it("defaults autoPilot on add and round-trips an updated value across instances", async () => {
    const registry = createSqliteProjectRegistry({ sqliteFilePath });
    const created = await registry.addProject({ rootPath: "/repo/auto-pilot" });
    expect(created.autoPilot).toEqual({ reloopLimit: 3, settleDelayMs: 4000 });

    const updated = await registry.updateProject(created.id, {
      autoPilot: { reloopLimit: 5, settleDelayMs: 6000 },
    });
    expect(updated.autoPilot).toEqual({ reloopLimit: 5, settleDelayMs: 6000 });

    const reloaded = createSqliteProjectRegistry({ sqliteFilePath });
    const [listed] = await reloaded.listProjects();
    expect(listed?.autoPilot).toEqual({ reloopLimit: 5, settleDelayMs: 6000 });
  });
});

describe("createSqliteProjectRegistry review config", () => {
  it("defaults review on add and round-trips an updated value across instances", async () => {
    const registry = createSqliteProjectRegistry({ sqliteFilePath });
    const created = await registry.addProject({ rootPath: "/repo/review" });
    expect(created.review.slackChannel).toBe("");
    expect(created.review.kickoff).toContain("{branch}");

    const updated = await registry.updateProject(created.id, {
      review: { slackChannel: "#pr-reviews", kickoff: "review {branch} vs {base}" },
    });
    expect(updated.review).toEqual({ slackChannel: "#pr-reviews", kickoff: "review {branch} vs {base}" });

    const reloaded = createSqliteProjectRegistry({ sqliteFilePath });
    const [listed] = await reloaded.listProjects();
    expect(listed?.review).toEqual({ slackChannel: "#pr-reviews", kickoff: "review {branch} vs {base}" });
  });
});

describe("createSqliteProjectRegistry vcs config", () => {
  it("defaults vcs on add and round-trips an updated value across instances", async () => {
    const registry = createSqliteProjectRegistry({ sqliteFilePath });
    const created = await registry.addProject({ rootPath: "/repo/vcs" });
    expect(created.vcs).toEqual({ host: "none", workspace: "", repo: "", email: "" });

    const vcs = { host: "bitbucket" as const, workspace: "acme", repo: "web", email: "me@acme.co" };
    const updated = await registry.updateProject(created.id, { vcs });
    expect(updated.vcs).toEqual(vcs);

    const reloaded = createSqliteProjectRegistry({ sqliteFilePath });
    const [listed] = await reloaded.listProjects();
    expect(listed?.vcs).toEqual(vcs);
  });
});

describe("createSqliteProjectRegistry migration", () => {
  function legacyRecord(overrides: Partial<LegacyProjectRecord>): LegacyProjectRecord {
    return {
      id: "legacy-id",
      name: "legacy-project",
      rootPath: "/repo/legacy",
      checkpointGlobs: ["docs/workflow/checkpoints/*-checkpoint.md"],
      createdAtEpochMs: 1000,
      updatedAtEpochMs: 1000,
      ...overrides,
    };
  }

  it("migrates existing JSON projects into SQLite rows on first boot", async () => {
    const legacyRecords: LegacyProjectRecord[] = [
      legacyRecord({ id: "legacy-1", rootPath: "/repo/one", name: "One" }),
      legacyRecord({ id: "legacy-2", rootPath: "/repo/two", name: "Two" }),
    ];
    writeFileSync(legacyJsonFilePath, JSON.stringify(legacyRecords), "utf8");

    const registry = createSqliteProjectRegistry({ sqliteFilePath, legacyJsonFilePath });
    const projects = await registry.listProjects();

    expect(projects).toHaveLength(2);
    expect(projects.map((p) => p.rootPath).sort()).toEqual(["/repo/one", "/repo/two"]);
  });

  it("backfills a default iconDataUrl and runtimeConfig for a pre-Plan-4 legacy row", async () => {
    writeFileSync(
      legacyJsonFilePath,
      JSON.stringify([legacyRecord({ id: "legacy-1", rootPath: "/repo/one" })]),
      "utf8",
    );

    const registry = createSqliteProjectRegistry({ sqliteFilePath, legacyJsonFilePath });
    const [project] = await registry.listProjects();

    expect(project?.iconDataUrl).toBeNull();
    expect(project?.runtimeConfig).toEqual(createDefaultProjectRuntimeConfig());
  });

  it("preserves original ids during migration (session state is keyed by project id)", async () => {
    writeFileSync(
      legacyJsonFilePath,
      JSON.stringify([legacyRecord({ id: "legacy-1", rootPath: "/repo/one" })]),
      "utf8",
    );

    const registry = createSqliteProjectRegistry({ sqliteFilePath, legacyJsonFilePath });
    const [project] = await registry.listProjects();

    expect(project?.id).toBe("legacy-1");
  });

  it("does not re-import on a second boot", async () => {
    writeFileSync(
      legacyJsonFilePath,
      JSON.stringify([legacyRecord({ id: "legacy-1", rootPath: "/repo/one" })]),
      "utf8",
    );

    const first = createSqliteProjectRegistry({ sqliteFilePath, legacyJsonFilePath });
    await first.listProjects();
    await first.addProject({ rootPath: "/repo/added-after-migration" });

    const second = createSqliteProjectRegistry({ sqliteFilePath, legacyJsonFilePath });
    const projects = await second.listProjects();

    expect(projects).toHaveLength(2);
    expect(projects.filter((p) => p.rootPath === "/repo/one")).toHaveLength(1);
  });

  it("does nothing when there is no legacy JSON store", async () => {
    const registry = createSqliteProjectRegistry({ sqliteFilePath, legacyJsonFilePath });
    await expect(registry.listProjects()).resolves.toEqual([]);
  });
});

describe("projects table schema", () => {
  it("rejects a duplicate root_path at the database level", async () => {
    const registry = createSqliteProjectRegistry({ sqliteFilePath });
    await registry.addProject({ rootPath: "/repo/one" });

    const db = new Database(sqliteFilePath);
    expect(() =>
      db
        .prepare(
          `INSERT INTO projects (id, name, root_path, checkpoint_globs, created_at_epoch_ms, updated_at_epoch_ms)
           VALUES ('dup-id', 'dup', '/repo/one', '[]', 0, 0)`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    db.close();
  });
});
