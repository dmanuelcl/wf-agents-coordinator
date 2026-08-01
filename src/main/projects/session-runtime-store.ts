import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionAgentRole } from "../../shared/workflow/session-role-launch";
import type { ConductorState } from "../../shared/workflow/conductor";
import { INITIAL_CONDUCTOR_STATE } from "../../shared/workflow/conductor";

export type RunnerSessionPhase = "setup-pending" | "setup-running" | "ready" | "failed";
export type RunnerTerminalKind = "setup" | "agent" | "shell";

/** Durable intent, not a live PTY id. A runner restart recreates this intent. */
export interface RunnerTerminalRecord {
  key: string;
  kind: RunnerTerminalKind;
  role?: SessionAgentRole;
  title?: string;
  root?: boolean;
  // Agent terminals keep their intended durable conversation lane. The PTY id
  // is deliberately absent: it is process-local and must never be restored.
  mode?: "fresh" | "resume";
  generation?: number;
}

export interface RunnerSessionRuntimeRecord {
  sessionId: string;
  phase: RunnerSessionPhase;
  terminals: RunnerTerminalRecord[];
  error: string | null;
  autoPilot: {
    enabled: boolean;
    state: ConductorState;
    message: string | null;
  };
}

export interface SessionRuntimeStore {
  get(sessionId: string): Promise<RunnerSessionRuntimeRecord | null>;
  list(): Promise<RunnerSessionRuntimeRecord[]>;
  put(record: RunnerSessionRuntimeRecord): Promise<void>;
  remove(sessionId: string): Promise<void>;
}

export function createSessionRuntimeStore(params: { storeFilePath: string }): SessionRuntimeStore {
  const { storeFilePath } = params;

  async function readAll(): Promise<Record<string, RunnerSessionRuntimeRecord>> {
    try {
      return JSON.parse(await readFile(storeFilePath, "utf8")) as Record<string, RunnerSessionRuntimeRecord>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async function writeAll(records: Record<string, RunnerSessionRuntimeRecord>): Promise<void> {
    await mkdir(dirname(storeFilePath), { recursive: true });
    await writeFile(storeFilePath, JSON.stringify(records, null, 2), "utf8");
  }

  function normalize(record: RunnerSessionRuntimeRecord): RunnerSessionRuntimeRecord {
    return {
      ...record,
      autoPilot: record.autoPilot ?? { enabled: false, state: INITIAL_CONDUCTOR_STATE, message: null },
    };
  }

  return {
    async get(sessionId) {
      const record = (await readAll())[sessionId];
      return record ? normalize(record) : null;
    },
    async list() {
      return Object.values(await readAll()).map(normalize);
    },
    async put(record) {
      const records = await readAll();
      records[record.sessionId] = record;
      await writeAll(records);
    },
    async remove(sessionId) {
      const records = await readAll();
      delete records[sessionId];
      await writeAll(records);
    },
  };
}
