import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionAgentRole } from "../../shared/workflow/session-role-launch";

type Store = Record<string, Partial<Record<SessionAgentRole, string>>>;

/**
 * Remembers the agent conversation id for each (session, role) tab. Claude's
 * id is minted by the app; Kimi's `session_<uuid>` is captured from its TUI.
 * A later launch can then restore that exact conversation instead of relying
 * on a cwd-wide "most recent" heuristic. One flat JSON file, mirroring the
 * other registries.
 */
export interface SessionAgentUuidStore {
  get(params: { sessionId: string; role: SessionAgentRole }): Promise<string | null>;
  set(params: { sessionId: string; role: SessionAgentRole; uuid: string }): Promise<void>;
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
    async get({ sessionId, role }) {
      const records = await readAll();
      return records[sessionId]?.[role] ?? null;
    },

    async set({ sessionId, role, uuid }) {
      const records = await readAll();
      const forSession = records[sessionId] ?? {};
      forSession[role] = uuid;
      records[sessionId] = forSession;
      await writeAll(records);
    },
  };
}
