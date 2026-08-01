import { safeStorage } from "electron";
import type { SecretCipher } from "./vcs-secret-store";

export function createElectronSecretCipher(): SecretCipher {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext).toString("base64"),
    decrypt: (ciphertext) => safeStorage.decryptString(Buffer.from(ciphertext, "base64")),
  };
}
