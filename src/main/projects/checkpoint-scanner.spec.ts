import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultProjectRuntimeConfig } from "../../shared/workflow/agent-runtime-config";
import { scanProjectCheckpoints } from "./checkpoint-scanner";
import type { ProjectRecord } from "./project-registry";

let dir: string;

function checkpointMarkdown(slug: string): string {
  return `---
feature: Example ${slug}
slug: ${slug}
kind: feature
status: IN_PROGRESS
active: none
---

# ▶ NEXT
- **Rol:** implementer
- **Corre:** \`wf implement docs/workflow/checkpoints/${slug}-checkpoint.md\`
- **Abre sesión fresca en:** capacidad económica · esfuerzo moderado · cwd \`.\`
- **Tarea:** Do it.
`;
}

function writeCheckpoint(root: string, slug: string): void {
  const checkpointDir = join(root, "docs", "workflow", "checkpoints");
  mkdirSync(checkpointDir, { recursive: true });
  writeFileSync(join(checkpointDir, `${slug}-checkpoint.md`), checkpointMarkdown(slug), "utf8");
}

function makeProject(rootPath: string): ProjectRecord {
  return {
    id: "test-project",
    name: "test-project",
    rootPath,
    checkpointGlobs: ["docs/workflow/checkpoints/*-checkpoint.md"],
    iconDataUrl: null,
    runtimeConfig: createDefaultProjectRuntimeConfig(),
    createdAtEpochMs: 0,
    updatedAtEpochMs: 0,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-coordinator-scanner-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("scanProjectCheckpoints", () => {
  it("returns an empty array when the checkpoint directory is missing", async () => {
    const result = await scanProjectCheckpoints({ project: makeProject(dir) });
    expect(result).toEqual([]);
  });

  it("scans checkpoints at the project root", async () => {
    writeCheckpoint(dir, "root-example");

    const result = await scanProjectCheckpoints({ project: makeProject(dir) });

    expect(result).toHaveLength(1);
    expect(result[0]?.slug).toBe("root-example");
    expect(result[0]?.next?.role).toBe("implementer");
  });

  it("falls back to scanning .worktrees/* when git is unavailable", async () => {
    writeCheckpoint(join(dir, ".worktrees", "feature-x"), "feature-x-example");

    const result = await scanProjectCheckpoints({ project: makeProject(dir) });

    expect(result).toHaveLength(1);
    expect(result[0]?.slug).toBe("feature-x-example");
  });

  it("de-duplicates checkpoints with the same slug found in multiple roots", async () => {
    writeCheckpoint(dir, "duplicate-slug");
    writeCheckpoint(join(dir, ".worktrees", "dup"), "duplicate-slug");

    const result = await scanProjectCheckpoints({ project: makeProject(dir) });

    expect(result).toHaveLength(1);
    expect(result[0]?.slug).toBe("duplicate-slug");
  });
});
