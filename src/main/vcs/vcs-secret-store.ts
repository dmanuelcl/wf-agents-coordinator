import { safeStorage } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Stores per-project VCS API tokens ENCRYPTED via Electron `safeStorage` (OS
 * keychain). The ciphertext (base64) lives in a JSON file; the plaintext token
 * never touches disk and never leaves the main process. If the OS has no secure
 * storage, we refuse to store rather than fall back to plaintext.
 */
export interface VcsSecretStore {
  setToken(projectId: string, token: string): Promise<void>;
  getToken(projectId: string): Promise<string | null>;
  hasToken(projectId: string): Promise<boolean>;
  deleteToken(projectId: string): Promise<void>;
}

export function createVcsSecretStore(params: { storeFilePath: string }): VcsSecretStore {
  const { storeFilePath } = params;

  async function readAll(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(storeFilePath, "utf8")) as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async function writeAll(map: Record<string, string>): Promise<void> {
    await mkdir(dirname(storeFilePath), { recursive: true });
    await writeFile(storeFilePath, JSON.stringify(map, null, 2), "utf8");
  }

  return {
    async setToken(projectId, token) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("Secure storage is unavailable on this OS; refusing to store the token in plaintext.");
      }
      const cipher = safeStorage.encryptString(token).toString("base64");
      const map = await readAll();
      map[projectId] = cipher;
      await writeAll(map);
    },

    async getToken(projectId) {
      const map = await readAll();
      const cipher = map[projectId];
      if (!cipher) return null;
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(Buffer.from(cipher, "base64"));
    },

    async hasToken(projectId) {
      const map = await readAll();
      return Boolean(map[projectId]);
    },

    async deleteToken(projectId) {
      const map = await readAll();
      if (projectId in map) {
        delete map[projectId];
        await writeAll(map);
      }
    },
  };
}
