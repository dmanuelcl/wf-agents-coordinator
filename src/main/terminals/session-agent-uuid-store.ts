import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentKind } from "../../shared/workflow/agent-runtime-config";

export interface AgentSessionBinding {
  agentKind: AgentKind | null;
  sessionUuid: string;
}

interface StoredAgentSessionBinding {
  agentKind: AgentKind;
  sessionUuid: string;
}

type Store = Record<string, Record<string, StoredAgentSessionBinding | string>>;

/**
 * Remembers the provider conversation for each workflow session lane. A lane
 * is bounded to one plan/stage (for example `plan-2/reviewer`) so correction
 * loops resume their context while the next plan starts clean.
 */
export interface SessionAgentUuidStore {
  get(params: { sessionId: string; lane: string }): Promise<AgentSessionBinding | null>;
  set(params: {
    sessionId: string;
    lane: string;
    binding: StoredAgentSessionBinding;
  }): Promise<void>;
}

export function createSessionAgentUuidStore(params: { storeFilePath: string }): SessionAgentUuidStore {
  const { storeFilePath } = params;

  async function readAll(): Promise<Store> {
    try {
      const raw = await readFile(storeFilePath, "utf8");
      return JSON.parse(raw) as Store;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  async function writeAll(records: Store): Promise<void> {
    await mkdir(dirname(storeFilePath), { recursive: true });
    await writeFile(storeFilePath, JSON.stringify(records, null, 2), "utf8");
  }

  return {
    async get({ sessionId, lane }) {
      const records = await readAll();
      const stored = records[sessionId]?.[lane] ?? null;
      if (typeof stored === "string") {
        return { agentKind: null, sessionUuid: stored };
      }
      return stored ?? null;
    },

    async set({ sessionId, lane, binding }) {
      const records = await readAll();
      const forSession = records[sessionId] ?? {};
      forSession[lane] = binding;
      records[sessionId] = forSession;
      await writeAll(records);
    },
  };
}
