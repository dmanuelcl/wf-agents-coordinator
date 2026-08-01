import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { createElectronIpcTransport } from "./ipc/electron-ipc-transport";
import { createElectronSystemIntegration } from "./platform/electron-system-integration";
import { createCoordinatorRuntime } from "./runtime/coordinator-runtime";
import { createElectronSecretCipher } from "./vcs/electron-secret-cipher";

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    window.webContents.send(channel, payload);
  }
}

const APP_ICON_PATH = join(__dirname, "../../build/icon.png");

function createMainWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    // Only the packaged bundle's generated .icns is present at runtime; the raw
    // build/icon.png isn't packaged, so guard it (a missing icon must never block
    // the window). macOS ignores this option anyway (uses the bundle icon).
    icon: existsSync(APP_ICON_PATH) ? APP_ICON_PATH : undefined,
    backgroundColor: "#151110",
    // Frameless with the native traffic lights floated into the sidebar top
    // (ADE parity) — the app draws its own titlebar via -webkit-app-region.
    frame: false,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function isRemoteDesktopClient(): boolean {
  const hasRemoteUrl = Boolean(
    process.env["AGENT_COORDINATOR_REMOTE_URL"]?.trim() ||
      process.argv.some((arg) => arg.startsWith("--agent-coordinator-remote-url=")),
  );
  const hasRemoteToken = Boolean(
    process.env["AGENT_COORDINATOR_REMOTE_TOKEN"]?.trim() ||
      process.argv.some((arg) => arg.startsWith("--agent-coordinator-remote-token=")),
  );
  return hasRemoteUrl || hasRemoteToken;
}

// In dev the app runs as the default Electron binary, so the menu bar / app menu
// shows "Electron" (productName only applies to the packaged build). Set the name
// explicitly so dev matches the shipped app.
app.setName("Agent Coordinator");

void app.whenReady().then(async () => {
  // setIcon THROWS on a missing image — and build/icon.png isn't packaged — so
  // guard it, or the throw aborts startup before the window is ever created.
  if (process.platform === "darwin" && existsSync(APP_ICON_PATH)) {
    app.dock?.setIcon(APP_ICON_PATH);
  }

  if (!isRemoteDesktopClient()) {
    const runtime = await createCoordinatorRuntime({
      stateDir: app.getPath("userData"),
      transport: createElectronIpcTransport(),
      systemIntegration: createElectronSystemIntegration(),
      vcsSecretCipher: createElectronSecretCipher(),
      broadcast,
    });

    // No orphans: kill every agent PTY and close every file watcher on quit;
    // flush any pending scrollback so a restart can restore it.
    app.on("will-quit", () => {
      void runtime.close();
    });
  }

  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
