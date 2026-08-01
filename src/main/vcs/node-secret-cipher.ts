import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretCipher } from "./vcs-secret-store";

const VERSION = "v1";

/** AES-256-GCM cipher for a headless host; its key lives in deployment env. */
export function createNodeSecretCipher(keyBase64: string | undefined): SecretCipher {
  const key = keyBase64 ? Buffer.from(keyBase64, "base64") : null;
  const validKey = key && key.length === 32 ? key : null;

  function requireKey(): Buffer {
    if (!validKey) {
      throw new Error(
        "AGENT_COORDINATOR_DATA_KEY must be a base64-encoded 32-byte key before VCS tokens can be stored on the runner.",
      );
    }
    return validKey;
  }

  return {
    isAvailable: () => validKey !== null,
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", requireKey(), iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(":");
    },
    decrypt(ciphertext) {
      const [version, ivBase64, tagBase64, encryptedBase64, ...rest] = ciphertext.split(":");
      if (version !== VERSION || !ivBase64 || !tagBase64 || !encryptedBase64 || rest.length > 0) {
        throw new Error("This VCS token was not encrypted by the remote runner.");
      }
      const decipher = createDecipheriv("aes-256-gcm", requireKey(), Buffer.from(ivBase64, "base64"));
      decipher.setAuthTag(Buffer.from(tagBase64, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(encryptedBase64, "base64")), decipher.final()]).toString("utf8");
    },
  };
}
