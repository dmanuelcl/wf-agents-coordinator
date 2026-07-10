import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { createProjectRegistry } from "./project-registry";
import { defineProjectRegistryContractTests } from "./project-registry.contract";

let dir: string;
let storeFilePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-coordinator-registry-"));
  storeFilePath = join(dir, "projects.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

defineProjectRegistryContractTests(() => createProjectRegistry({ storeFilePath }));
