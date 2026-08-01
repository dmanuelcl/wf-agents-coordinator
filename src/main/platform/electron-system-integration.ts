import { clipboard, dialog, shell } from "electron";
import type { SystemIntegration } from "./system-integration";

export function createElectronSystemIntegration(): SystemIntegration {
  return {
    async pickFolder() {
      const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0] ?? null;
    },
    async showInFileManager(path) {
      shell.showItemInFolder(path);
    },
    async openPath(path) {
      // Electron returns an error string for a false-positive terminal path;
      // Coordinator intentionally treats that as a no-op.
      await shell.openPath(path);
    },
    async openExternal(url) {
      await shell.openExternal(url);
    },
    async copyText(text) {
      clipboard.writeText(text);
    },
  };
}
