/**
 * Host actions that only make sense on the machine displaying Coordinator.
 * Keeping them out of domain IPC lets the runner use plain Node.js on Linux.
 */
export interface SystemIntegration {
  pickFolder(): Promise<string | null>;
  showInFileManager(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
}

function unavailable(action: string): never {
  throw new Error(`${action} is available from the Coordinator desktop client, not the remote runner.`);
}

/** Safe default for a headless server. */
export function createHeadlessSystemIntegration(): SystemIntegration {
  return {
    async pickFolder() {
      unavailable("Folder picker");
    },
    async showInFileManager() {
      unavailable("File manager");
    },
    async openPath() {
      unavailable("Opening a local path");
    },
    async openExternal() {
      unavailable("Opening a browser");
    },
    async copyText() {
      unavailable("Clipboard access");
    },
  };
}
