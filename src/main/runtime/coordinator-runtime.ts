import { join } from "node:path";
import { CHECKPOINT_IPC_CHANNELS, SESSION_IPC_CHANNELS } from "../../shared/ipc/contract";
import { prFixCompletionCheckpointPath } from "../../shared/workflow/pr-fix-kickoff";
import { registerIpcHandlers } from "../ipc/register-ipc-handlers";
import { registerTerminalIpcHandlers } from "../ipc/register-terminal-ipc-handlers";
import type { IpcTransport } from "../ipc/ipc-transport";
import type { SystemIntegration } from "../platform/system-integration";
import { createChokidarWatcher } from "../projects/chokidar-watcher-adapter";
import { createCheckpointWatchManager } from "../projects/checkpoint-watch-manager";
import { createSessionCheckpointWatchManager } from "../projects/session-checkpoint-watch-manager";
import { createSessionRegistry } from "../projects/session-registry";
import { createSessionSetupCoordinator } from "../projects/session-setup-coordinator";
import { createSqliteProjectRegistry } from "../projects/sqlite-project-registry";
import { createWorkspaceLayoutStore } from "../projects/workspace-layout-store";
import { createPtySessionManager } from "../terminals/pty-session-manager";
import { spawnRealPty } from "../terminals/node-pty-adapter";
import { createSessionAgentUuidStore } from "../terminals/session-agent-uuid-store";
import { createSessionStateStore } from "../terminals/session-state-store";
import { createTerminalScrollbackStore } from "../terminals/terminal-scrollback-store";
import { createTerminalScreenStore } from "../terminals/terminal-screen-store";
import { createVcsSecretStore } from "../vcs/vcs-secret-store";
import type { SecretCipher } from "../vcs/vcs-secret-store";

export interface CoordinatorRuntime {
  close(): Promise<void>;
}

export interface CreateCoordinatorRuntimeOptions {
  stateDir: string;
  transport: IpcTransport;
  systemIntegration?: SystemIntegration;
  vcsSecretCipher: SecretCipher;
  broadcast(channel: string, payload: unknown): void;
}

/**
 * The Coordinator domain runtime. It owns durable records, filesystem
 * watchers and PTYs; Electron and the remote runner are only transports around
 * this same core.
 */
export async function createCoordinatorRuntime(
  options: CreateCoordinatorRuntimeOptions,
): Promise<CoordinatorRuntime> {
  const { stateDir, transport, systemIntegration, vcsSecretCipher, broadcast } = options;
  const projectRegistry = createSqliteProjectRegistry({
    sqliteFilePath: join(stateDir, "app.db"),
    legacyJsonFilePath: join(stateDir, "projects.json"),
  });
  const sessionRegistry = createSessionRegistry({ storeFilePath: join(stateDir, "sessions.json") });
  const sessionAgentUuidStore = createSessionAgentUuidStore({
    storeFilePath: join(stateDir, "session-agents.json"),
  });
  const workspaceLayoutStore = createWorkspaceLayoutStore({
    storeFilePath: join(stateDir, "workspace-layout.json"),
  });
  const vcsSecretStore = createVcsSecretStore({
    storeFilePath: join(stateDir, "vcs-secrets.json"),
    cipher: vcsSecretCipher,
  });
  const checkpointWatchManager = createCheckpointWatchManager({
    createWatcher: createChokidarWatcher,
    onCheckpointChanged: (projectId, checkpoint) =>
      broadcast(CHECKPOINT_IPC_CHANNELS.changed, { projectId, checkpoint }),
    onCheckpointRemoved: (projectId, checkpointPath) =>
      broadcast(CHECKPOINT_IPC_CHANNELS.removed, { projectId, checkpointPath }),
  });
  const sessionCheckpointWatchManager = createSessionCheckpointWatchManager({
    createWatcher: createChokidarWatcher,
    onCheckpointDetected: (sessionId, checkpointPath) => {
      // Persist before signalling so a client that refreshes immediately sees
      // a fully updated session record.
      void sessionRegistry
        .updateSessionCheckpoint({ sessionId, checkpointPath })
        .then(() => broadcast(SESSION_IPC_CHANNELS.checkpointDetected, { sessionId, checkpointPath }))
        .catch((error: unknown) => {
          console.error(`Could not persist checkpoint for session ${sessionId}:`, error);
        });
    },
  });

  const ptySessionManager = createPtySessionManager({ spawnPty: spawnRealPty });
  const scrollbackStore = createTerminalScrollbackStore({ dir: join(stateDir, "terminal-scrollback") });
  const screenStore = createTerminalScreenStore();
  const sessionSetupCoordinator = createSessionSetupCoordinator();

  registerIpcHandlers({
    projectRegistry,
    checkpointWatchManager,
    sessionRegistry,
    sessionCheckpointWatchManager,
    sessionAgentUuidStore,
    workspaceLayoutStore,
    vcsSecretStore,
    transport,
    systemIntegration,
    killTerminalsForWorktree: (worktreePath) => ptySessionManager.killByCwd(worktreePath),
    sessionSetupCoordinator,
  });

  registerTerminalIpcHandlers({
    ptySessionManager,
    sessionStateStore: createSessionStateStore({ storeFilePath: join(stateDir, "session-state.json") }),
    scrollbackStore,
    screenStore,
    transport,
    broadcast,
    onSetupExit: async ({ sessionId, code }) => {
      try {
        if (code === 0) await sessionRegistry.markSetupDone({ sessionId });
      } finally {
        // The setup process, not a particular browser connection, owns this
        // lifecycle. Always unlock it after exit so a failed setup can be
        // repaired/retried even if the client disconnected meanwhile.
        sessionSetupCoordinator.release(sessionId);
      }
    },
  });

  // Build session watches before the broad project watcher. Chokidar can miss
  // children of a directory that did not exist when its parent began watching.
  void (async () => {
    try {
      const projects = await projectRegistry.listProjects();
      for (const project of projects) {
        const sessions = await sessionRegistry.listSessions({ projectId: project.id });
        await Promise.all(
          sessions
            .filter(
              (session) =>
                (session.kind === "feature" || session.kind === "fix" || session.kind === "pr-fix") &&
                session.checkpointPath === null,
            )
            .map((session) =>
              sessionCheckpointWatchManager.watchSession({
                sessionId: session.id,
                worktreePath: session.worktreePath,
                createdAtEpochMs: session.createdAtEpochMs,
                expectedCheckpointPath:
                  session.kind === "pr-fix" ? prFixCompletionCheckpointPath(session.slug) : undefined,
              }),
            ),
        );
        await checkpointWatchManager.watchProject(project);
      }
    } catch (error) {
      console.error("Could not initialize checkpoint watchers:", error);
    }
  })();

  return {
    async close() {
      ptySessionManager.killAll();
      await scrollbackStore.flush();
      await checkpointWatchManager.closeAll();
      await sessionCheckpointWatchManager.closeAll();
    },
  };
}
