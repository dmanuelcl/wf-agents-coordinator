import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { CHECKPOINT_IPC_CHANNELS, SESSION_IPC_CHANNELS } from "../shared/ipc/contract";
import { registerIpcHandlers } from "./ipc/register-ipc-handlers";
import { registerTerminalIpcHandlers } from "./ipc/register-terminal-ipc-handlers";
import { createChokidarWatcher } from "./projects/chokidar-watcher-adapter";
import { createCheckpointWatchManager } from "./projects/checkpoint-watch-manager";
import { createSessionCheckpointWatchManager } from "./projects/session-checkpoint-watch-manager";
import { createSessionRegistry } from "./projects/session-registry";
import { createSqliteProjectRegistry } from "./projects/sqlite-project-registry";
import { createWorkspaceLayoutStore } from "./projects/workspace-layout-store";
import { createVcsSecretStore } from "./vcs/vcs-secret-store";
import { spawnRealPty } from "./terminals/node-pty-adapter";
import { createPtySessionManager } from "./terminals/pty-session-manager";
import { createSessionAgentUuidStore } from "./terminals/session-agent-uuid-store";
import { createSessionStateStore } from "./terminals/session-state-store";
import { createTerminalScrollbackStore } from "./terminals/terminal-scrollback-store";

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

// In dev the app runs as the default Electron binary, so the menu bar / app menu
// shows "Electron" (productName only applies to the packaged build). Set the name
// explicitly so dev matches the shipped app.
app.setName("Agent Coordinator");

void app.whenReady().then(() => {
  // setIcon THROWS on a missing image — and build/icon.png isn't packaged — so
  // guard it, or the throw aborts startup before the window is ever created.
  if (process.platform === "darwin" && existsSync(APP_ICON_PATH)) {
    app.dock?.setIcon(APP_ICON_PATH);
  }

  const projectRegistry = createSqliteProjectRegistry({
    sqliteFilePath: join(app.getPath("userData"), "app.db"),
    legacyJsonFilePath: join(app.getPath("userData"), "projects.json"),
  });

  const sessionRegistry = createSessionRegistry({
    storeFilePath: join(app.getPath("userData"), "sessions.json"),
  });

  const sessionAgentUuidStore = createSessionAgentUuidStore({
    storeFilePath: join(app.getPath("userData"), "session-agents.json"),
  });

  const workspaceLayoutStore = createWorkspaceLayoutStore({
    storeFilePath: join(app.getPath("userData"), "workspace-layout.json"),
  });

  const vcsSecretStore = createVcsSecretStore({
    storeFilePath: join(app.getPath("userData"), "vcs-secrets.json"),
  });

  const checkpointWatchManager = createCheckpointWatchManager({
    createWatcher: createChokidarWatcher,
    onCheckpointChanged: (projectId, checkpoint) => {
      broadcast(CHECKPOINT_IPC_CHANNELS.changed, { projectId, checkpoint });
    },
    onCheckpointRemoved: (projectId, checkpointPath) => {
      broadcast(CHECKPOINT_IPC_CHANNELS.removed, { projectId, checkpointPath });
    },
  });

  const sessionCheckpointWatchManager = createSessionCheckpointWatchManager({
    createWatcher: createChokidarWatcher,
    onCheckpointDetected: (sessionId, checkpointPath) => {
      // Persist the path first, THEN tell the renderer — a Log re-fetch triggered
      // by the broadcast must see the updated record, not race it.
      void sessionRegistry
        .updateSessionCheckpoint({ sessionId, checkpointPath })
        .then(() => {
          broadcast(SESSION_IPC_CHANNELS.checkpointDetected, { sessionId, checkpointPath });
        })
        .catch((error: unknown) => {
          // Deletion can win the race after the filesystem event was queued.
          // The serialized registry correctly rejects the now-missing session;
          // never turn that expected late event into an unhandled rejection.
          console.error(`Could not persist checkpoint for session ${sessionId}:`, error);
        });
    },
  });

  registerIpcHandlers({
    projectRegistry,
    checkpointWatchManager,
    sessionRegistry,
    sessionCheckpointWatchManager,
    sessionAgentUuidStore,
    workspaceLayoutStore,
    vcsSecretStore,
  });

  void projectRegistry
    .listProjects()
    .then(async (projects) => {
      // Materialize/watch each session checkpoint directory before starting the
      // broader project watcher. Chokidar 5 can miss children of a directory
      // that did not exist when its watch began.
      for (const project of projects) {
        const sessions = await sessionRegistry.listSessions({ projectId: project.id });
        await Promise.all(
          sessions
            .filter(
              (session) =>
                (session.kind === "feature" || session.kind === "fix") && session.checkpointPath === null,
            )
            .map((session) =>
              sessionCheckpointWatchManager.watchSession({
                sessionId: session.id,
                worktreePath: session.worktreePath,
                createdAtEpochMs: session.createdAtEpochMs,
              }),
            ),
        );
        await checkpointWatchManager.watchProject(project);
      }
    })
    .catch((error: unknown) => {
      console.error("Could not initialize checkpoint watchers:", error);
    });

  const ptySessionManager = createPtySessionManager({ spawnPty: spawnRealPty });
  const sessionStateStore = createSessionStateStore({
    storeFilePath: join(app.getPath("userData"), "session-state.json"),
  });
  const scrollbackStore = createTerminalScrollbackStore({
    dir: join(app.getPath("userData"), "terminal-scrollback"),
  });
  registerTerminalIpcHandlers({ ptySessionManager, sessionStateStore, scrollbackStore });

  // No orphans: kill every agent PTY and close every file watcher on quit;
  // flush any pending scrollback so a restart can restore it.
  app.on("will-quit", () => {
    ptySessionManager.killAll();
    void scrollbackStore.flush();
    void checkpointWatchManager.closeAll();
    void sessionCheckpointWatchManager.closeAll();
  });

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
