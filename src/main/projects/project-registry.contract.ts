import { describe, expect, it } from "vitest";
import { createDefaultProjectRuntimeConfig } from "../../shared/workflow/agent-runtime-config";
import type { ProjectRegistry } from "./project-registry";

/**
 * Shared behavioral contract for any ProjectRegistry implementation. Run
 * against both the Plan 1 JSON-backed registry and the Plan 3 SQLite-backed
 * one to prove interface + behavior parity, per plan-3-hardening.md Step 1.
 */
export function defineProjectRegistryContractTests(createRegistry: () => ProjectRegistry): void {
  describe("ProjectRegistry contract", () => {
    it("starts empty when nothing is stored", async () => {
      const registry = createRegistry();
      await expect(registry.listProjects()).resolves.toEqual([]);
    });

    it("persists an added project across registry instances", async () => {
      const registry = createRegistry();
      const record = await registry.addProject({ rootPath: "/repo/one" });

      expect(record.rootPath).toBe("/repo/one");
      expect(record.checkpointGlobs).toEqual(["docs/workflow/checkpoints/*-checkpoint.md"]);
      expect(record.iconDataUrl).toBeNull();
      expect(record.runtimeConfig).toEqual(createDefaultProjectRuntimeConfig());

      const reloaded = createRegistry();
      const listed = await reloaded.listProjects();
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(record.id);
    });

    it("round-trips a custom iconDataUrl and runtimeConfig exactly", async () => {
      const registry = createRegistry();
      const customRuntimeConfig = {
        ...createDefaultProjectRuntimeConfig(),
        implementer: { kind: "codex" as const, model: "gpt-5", effort: "high", dangerous: true },
      };

      const record = await registry.addProject({
        rootPath: "/repo/custom",
        iconDataUrl: "data:image/png;base64,abc123",
        runtimeConfig: customRuntimeConfig,
      });

      expect(record.iconDataUrl).toBe("data:image/png;base64,abc123");
      expect(record.runtimeConfig).toEqual(customRuntimeConfig);

      const reloaded = createRegistry();
      const [listed] = await reloaded.listProjects();
      expect(listed?.iconDataUrl).toBe("data:image/png;base64,abc123");
      expect(listed?.runtimeConfig).toEqual(customRuntimeConfig);
    });

    it("does not create a duplicate record for the same root path", async () => {
      const registry = createRegistry();
      const first = await registry.addProject({ rootPath: "/repo/one", name: "One" });
      const second = await registry.addProject({ rootPath: "/repo/one", name: "One Again" });

      expect(second.id).toBe(first.id);
      await expect(registry.listProjects()).resolves.toHaveLength(1);
    });

    it("derives a default name from the root path when none is given", async () => {
      const registry = createRegistry();
      const record = await registry.addProject({ rootPath: "/repo/my-project" });
      expect(record.name).toBe("my-project");
    });

    it("removes a project by id", async () => {
      const registry = createRegistry();
      const record = await registry.addProject({ rootPath: "/repo/one" });
      await registry.removeProject(record.id);
      await expect(registry.listProjects()).resolves.toEqual([]);
    });

    it("updates name, iconDataUrl, and runtimeConfig, leaving rootPath untouched", async () => {
      const registry = createRegistry();
      const record = await registry.addProject({ rootPath: "/repo/one", name: "Original" });
      const newRuntimeConfig = {
        ...createDefaultProjectRuntimeConfig(),
        architect: { kind: "codex" as const, model: "gpt-5", effort: "medium", dangerous: false },
      };

      const updated = await registry.updateProject(record.id, {
        name: "Renamed",
        iconDataUrl: "data:image/png;base64,xyz",
        runtimeConfig: newRuntimeConfig,
      });

      expect(updated.id).toBe(record.id);
      expect(updated.rootPath).toBe("/repo/one");
      expect(updated.name).toBe("Renamed");
      expect(updated.iconDataUrl).toBe("data:image/png;base64,xyz");
      expect(updated.runtimeConfig).toEqual(newRuntimeConfig);

      const reloaded = createRegistry();
      const [listed] = await reloaded.listProjects();
      expect(listed?.name).toBe("Renamed");
      expect(listed?.iconDataUrl).toBe("data:image/png;base64,xyz");
      expect(listed?.runtimeConfig).toEqual(newRuntimeConfig);
    });

    it("applies a partial update without disturbing unspecified fields", async () => {
      const registry = createRegistry();
      const record = await registry.addProject({
        rootPath: "/repo/one",
        name: "Original",
        iconDataUrl: "data:image/png;base64,keep-me",
      });

      const updated = await registry.updateProject(record.id, { name: "Renamed" });

      expect(updated.name).toBe("Renamed");
      expect(updated.iconDataUrl).toBe("data:image/png;base64,keep-me");
      expect(updated.runtimeConfig).toEqual(createDefaultProjectRuntimeConfig());
    });

    it("rejects updating a project id that does not exist", async () => {
      const registry = createRegistry();
      await expect(registry.updateProject("missing-id", { name: "New" })).rejects.toThrow(/not found/);
    });
  });
}
