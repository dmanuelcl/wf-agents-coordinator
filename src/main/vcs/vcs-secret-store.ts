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

export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export function createVcsSecretStore(params: { storeFilePath: string; cipher: SecretCipher }): VcsSecretStore {
  const { storeFilePath, cipher } = params;

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
      if (!cipher.isAvailable()) {
        throw new Error("Secure storage is unavailable on this OS; refusing to store the token in plaintext.");
      }
      const ciphertext = cipher.encrypt(token);
      const map = await readAll();
      map[projectId] = ciphertext;
      await writeAll(map);
    },

    async getToken(projectId) {
      const map = await readAll();
      const ciphertext = map[projectId];
      if (!ciphertext || !cipher.isAvailable()) return null;
      return cipher.decrypt(ciphertext);
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
