import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { CHECKPOINT_IPC_CHANNELS, IPC_CHANNELS, SESSION_IPC_CHANNELS } from "../../shared/ipc/contract";
import { parseCheckpointMarkdown } from "../../shared/workflow/checkpoint-parser";
import { prFixCompletionCheckpointPath } from "../../shared/workflow/pr-fix-kickoff";
import { registerIpcHandlers } from "../ipc/register-ipc-handlers";
import { registerTerminalIpcHandlers } from "../ipc/register-terminal-ipc-handlers";
import type { IpcTransport } from "../ipc/ipc-transport";
import type { SystemIntegration } from "../platform/system-integration";
import { createChokidarWatcher } from "../projects/chokidar-watcher-adapter";
import { createCheckpointWatchManager } from "../projects/checkpoint-watch-manager";
import { sessionsOwningCheckpoint } from "../projects/checkpoint-session-routing";
import { createSessionCheckpointWatchManager } from "../projects/session-checkpoint-watch-manager";
import { createSessionHandoffWatchManager } from "../projects/session-handoff-watch-manager";
import { createSessionRegistry } from "../projects/session-registry";
import { createSessionOrchestrator } from "../projects/session-orchestrator";
import { createSessionRuntimeStore } from "../projects/session-runtime-store";
import { createSessionSetupCoordinator } from "../projects/session-setup-coordinator";
import { createSqliteProjectRegistry } from "../projects/sqlite-project-registry";
import { createWorkspaceLayoutStore } from "../projects/workspace-layout-store";
import { createOrphanReaper } from "../terminals/orphan-reaper";
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
  let sessionOrchestrator: ReturnType<typeof createSessionOrchestrator> | null = null;
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
  async function readSessionCheckpointForRunner(sessionId: string) {
    const session = await sessionRegistry.getSession({ sessionId });
    if (!session?.checkpointPath) return null;
    try {
      const markdown = await readFile(join(session.worktreePath, session.checkpointPath), "utf8");
      return parseCheckpointMarkdown({ checkpointPath: session.checkpointPath, markdown });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  const checkpointWatchManager = createCheckpointWatchManager({
    createWatcher: createChokidarWatcher,
    onCheckpointChanged: (projectId, checkpoint) => {
      broadcast(CHECKPOINT_IPC_CHANNELS.changed, { projectId, checkpoint });
      void Promise.all([
        projectRegistry.listProjects(),
        sessionRegistry.listSessions({ projectId }),
      ]).then(([projects, sessions]) => {
        const projectRoot = projects.find((candidate) => candidate.id === projectId)?.rootPath;
        if (!projectRoot) return;
        for (const session of sessionsOwningCheckpoint({
          projectRoot,
          sessions,
          changedCheckpointPath: checkpoint.checkpointPath,
        })) {
          sessionOrchestrator?.onCheckpoint(session.id, checkpoint);
        }
      }).catch((error: unknown) => {
        console.error(`Could not route checkpoint ${checkpoint.checkpointPath} to auto-pilot:`, error);
      });
    },
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
        .then(async () => {
          broadcast(SESSION_IPC_CHANNELS.checkpointDetected, { sessionId, checkpointPath });
          const checkpoint = await readSessionCheckpointForRunner(sessionId);
          if (checkpoint) sessionOrchestrator?.onCheckpoint(sessionId, checkpoint);
        })
        .catch((error: unknown) => {
          console.error(`Could not persist checkpoint for session ${sessionId}:`, error);
        });
    },
  });

  const sessionHandoffWatchManager = createSessionHandoffWatchManager({
    createWatcher: createChokidarWatcher,
    onHandoff: (sessionId, handoff) => sessionOrchestrator?.onHandoff(sessionId, handoff),
  });

  // Reap first, then start: anything still standing belongs to a run that is
  // already gone, and a build pipeline left that way holds gigabytes for as
  // long as the machine is up.
  const orphanReaper = createOrphanReaper({ storeFilePath: join(stateDir, "spawned-groups.json") });
  const reaped = orphanReaper.sweep();
  if (reaped.length > 0) {
    console.warn(`Killed ${reaped.length} process group(s) orphaned by a previous run: ${reaped.join(", ")}`);
  }
  const ptySessionManager = createPtySessionManager({ spawnPty: spawnRealPty, spawnedGroups: orphanReaper });
  const scrollbackStore = createTerminalScrollbackStore({ dir: join(stateDir, "terminal-scrollback") });
  const screenStore = createTerminalScreenStore();
  const sessionSetupCoordinator = createSessionSetupCoordinator();

  const terminalController = registerTerminalIpcHandlers({
    ptySessionManager,
    sessionStateStore: createSessionStateStore({ storeFilePath: join(stateDir, "session-state.json") }),
    scrollbackStore,
    screenStore,
    transport,
    broadcast,
    onSetupExit: async ({ sessionId, code }) => {
      try {
        if (sessionOrchestrator) {
          await sessionOrchestrator.onSetupExit({ sessionId, code });
        } else if (code === 0) {
          await sessionRegistry.markSetupDone({ sessionId });
        }
      } finally {
        // The setup process, not a particular browser connection, owns this
        // lifecycle. Always unlock it after exit so a failed setup can be
        // repaired/retried even if the client disconnected meanwhile.
        sessionSetupCoordinator.release(sessionId);
      }
    },
    onTerminalExit: ({ terminalId, code }) => sessionOrchestrator?.onTerminalExit({ terminalId, code }),
    onTerminalData: ({ terminalId, data }) => sessionOrchestrator?.onTerminalData({ terminalId, data }),
    onInitialInputDelivered: ({ terminalId, submit }) =>
      sessionOrchestrator?.onTerminalInitialInputDelivered({ terminalId, submit }),
    onTerminalInput: ({ terminalId, data }) => sessionOrchestrator?.onTerminalInput({ terminalId, data }),
  });

  sessionOrchestrator = createSessionOrchestrator({
    projectRegistry,
    sessionRegistry,
    runtimeStore: createSessionRuntimeStore({ storeFilePath: join(stateDir, "session-runtime.json") }),
    terminals: terminalController,
    sessionAgentUuidStore,
    readCheckpoint: readSessionCheckpointForRunner,
    broadcast,
  });

  const ipcServices = registerIpcHandlers({
    projectRegistry,
    checkpointWatchManager,
    sessionRegistry,
    sessionCheckpointWatchManager,
    sessionHandoffWatchManager,
    sessionAgentUuidStore,
    workspaceLayoutStore,
    vcsSecretStore,
    transport,
    systemIntegration,
    killTerminalsForWorktree: (worktreePath) => ptySessionManager.killByCwd(worktreePath),
    sessionSetupCoordinator,
    onSessionCreated: (session) => sessionOrchestrator!.ensure(session.id).then(() => {}),
    onSessionRemoved: (sessionId) => sessionOrchestrator!.remove(sessionId),
  });
  sessionOrchestrator.setRoleLaunchBuilder(ipcServices.buildRoleLaunch);
  sessionOrchestrator.setAutopilotLaunchBuilder(ipcServices.buildRoleAutopilot);
  sessionOrchestrator.setRepoAgentLaunchBuilder(ipcServices.buildRepoAgentLaunch);

  transport.handle(IPC_CHANNELS.sessionsEnsureRuntime, (_event, sessionId: string) => sessionOrchestrator!.ensure(sessionId));
  transport.handle(IPC_CHANNELS.sessionsGetRuntime, (_event, sessionId: string) => sessionOrchestrator!.runtime(sessionId));
  transport.handle(IPC_CHANNELS.sessionsOpenRole, (_event, sessionId: string, role) =>
    sessionOrchestrator!.openRole(sessionId, role),
  );
  transport.handle(IPC_CHANNELS.sessionsOpenShell, (_event, sessionId: string, root: boolean) =>
    sessionOrchestrator!.openShell({ sessionId, root }),
  );
  transport.handle(IPC_CHANNELS.sessionsOpenRepoAgent, (_event, sessionId: string) =>
    sessionOrchestrator!.openRepoAgent({ sessionId }),
  );
  transport.handle(IPC_CHANNELS.sessionsRenameTerminal, (_event, sessionId: string, key: string, title: string) =>
    sessionOrchestrator!.renameTerminal(sessionId, key, title),
  );
  transport.handle(IPC_CHANNELS.sessionsCloseTerminal, (_event, sessionId: string, key: string) =>
    sessionOrchestrator!.closeTerminal(sessionId, key),
  );
  transport.handle(IPC_CHANNELS.sessionsSkipFailedSetup, (_event, sessionId: string) =>
    sessionOrchestrator!.skipFailedSetup(sessionId),
  );
  transport.handle(IPC_CHANNELS.sessionsSetAutopilot, (_event, sessionId: string, enabled: boolean) =>
    sessionOrchestrator!.setAutopilot(sessionId, enabled),
  );
  transport.handle(
    IPC_CHANNELS.sessionsRunCommand,
    (_event, sessionId: string, role, lane: string, command: string) =>
      sessionOrchestrator!.runCommand(sessionId, role, lane, command),
  );
  transport.handle(IPC_CHANNELS.sessionsRestoreView, (_event, sessionId: string, intent) =>
    sessionOrchestrator!.restoreView(sessionId, intent),
  );

  // Build session watches before the broad project watcher. Chokidar can miss
  // children of a directory that did not exist when its parent began watching.
  void (async () => {
    try {
      await sessionOrchestrator?.resume();
      const projects = await projectRegistry.listProjects();
      for (const project of projects) {
        const sessions = await sessionRegistry.listSessions({ projectId: project.id });
        const workflowSessions = sessions.filter(
          (session) => session.kind === "feature" || session.kind === "fix" || session.kind === "pr-fix",
        );
        await Promise.all(
          workflowSessions
            .filter((session) => session.checkpointPath === null)
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
        // Unlike the checkpoint gate, hand-offs matter for the whole life of a
        // session, so this watches every workflow session, checkpoint or not.
        await Promise.all(
          workflowSessions.map((session) =>
            sessionHandoffWatchManager.watchSession({
              sessionId: session.id,
              worktreePath: session.worktreePath,
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
      await sessionHandoffWatchManager.closeAll();
    },
  };
}
