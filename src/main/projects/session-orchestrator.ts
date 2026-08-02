import { randomUUID } from "node:crypto";
import { SESSION_IPC_CHANNELS } from "../../shared/ipc/contract";
import type { SessionRoleLaunch, SessionViewRestoreIntent } from "../../shared/ipc/contract";
import { isSessionRoleUnlocked } from "../../shared/workflow/session-role-launch";
import type { SessionAgentRole } from "../../shared/workflow/session-role-launch";
import { INITIAL_CONDUCTOR_STATE } from "../../shared/workflow/conductor";
import { decideConductor } from "../../shared/workflow/conductor";
import type { AutoPilotConfig } from "../../shared/workflow/auto-pilot-config";
import type { ParsedCheckpoint } from "../../shared/workflow/workflow-types";
import type { AgentKind } from "../../shared/workflow/agent-runtime-config";
import { findKimiSessionId } from "../../shared/workflow/kimi-session-id";
import { isRepoSessionId } from "../../shared/workflow/work-session";
import type { WorkSession } from "../../shared/workflow/work-session";
import type { RunnerTerminalController } from "../ipc/register-terminal-ipc-handlers";
import type { ProjectRecord, ProjectRegistry } from "./project-registry";
import type {
  RunnerSessionRuntimeRecord,
  RunnerTerminalRecord,
  SessionRuntimeStore,
} from "./session-runtime-store";
import type { SessionRegistry } from "./session-registry";
import type { SessionAgentUuidStore } from "../terminals/session-agent-uuid-store";

// One server-owned grid is shared by every viewer. A moderately wide baseline
// keeps large displays from showing a huge font and premature line wrapping,
// without letting a browser resize an agent running on another device.
const RUNNER_COLS = 160;
const RUNNER_ROWS = 44;

export interface SessionRuntimeChangedEvent {
  sessionId: string;
  setupDone: boolean;
  runtime: RunnerSessionRuntimeRecord;
}

export interface SessionOrchestrator {
  setRoleLaunchBuilder(builder: (sessionId: string, role: SessionAgentRole, mode: "fresh" | "resume") => Promise<SessionRoleLaunch>): void;
  setAutopilotLaunchBuilder(builder: (sessionId: string, role: SessionAgentRole, lane: string, prompt: string) => Promise<{
    command: string;
    agentKind: AgentKind;
    cwd: string;
    environment: Record<string, string>;
    typePrompt: string | null;
  }>): void;
  resume(): Promise<void>;
  ensure(sessionId: string): Promise<RunnerSessionRuntimeRecord>;
  openRole(sessionId: string, role: SessionAgentRole): Promise<RunnerTerminalRecord>;
  openShell(params: { sessionId: string; root: boolean }): Promise<RunnerTerminalRecord>;
  closeTerminal(sessionId: string, key: string): Promise<void>;
  runtime(sessionId: string): Promise<RunnerSessionRuntimeRecord | null>;
  skipFailedSetup(sessionId: string): Promise<void>;
  setAutopilot(sessionId: string, enabled: boolean): Promise<RunnerSessionRuntimeRecord>;
  runCommand(sessionId: string, role: SessionAgentRole, lane: string, command: string): Promise<void>;
  restoreView(sessionId: string, intent: SessionViewRestoreIntent): Promise<RunnerSessionRuntimeRecord>;
  onCheckpoint(sessionId: string, checkpoint: ParsedCheckpoint): void;
  onSetupExit(params: { sessionId: string; code: number }): Promise<void>;
  onTerminalExit(params: { terminalId: string; code: number }): void;
  onTerminalData(params: { terminalId: string; data: string }): void;
  onTerminalInitialInputDelivered(params: { terminalId: string; submit: boolean }): void;
  onTerminalInput(params: { terminalId: string; data: string }): void;
  remove(sessionId: string): Promise<void>;
}

function primaryRole(session: WorkSession): SessionAgentRole {
  return session.kind === "review" ? "reviewer" : session.kind === "pr-fix" ? "implementer" : "architect";
}

function roleKey(sessionId: string, role: SessionAgentRole): string {
  return `${sessionId}::role::${role}`;
}

function setupKey(sessionId: string): string {
  return `${sessionId}::setup`;
}

function blankRuntime(sessionId: string, setupDone: boolean): RunnerSessionRuntimeRecord {
  return {
    sessionId,
    phase: setupDone ? "ready" : "setup-pending",
    terminals: [],
    error: null,
    autoPilot: { enabled: false, state: INITIAL_CONDUCTOR_STATE, message: null },
  };
}

/**
 * The durable session state machine. Browser clients may ask for a user action
 * (open a role or shell), but never decide the setup/agent command sequence or
 * own a terminal's lifetime.
 */
export function createSessionOrchestrator(params: {
  projectRegistry: ProjectRegistry;
  sessionRegistry: SessionRegistry;
  runtimeStore: SessionRuntimeStore;
  terminals: RunnerTerminalController;
  sessionAgentUuidStore: SessionAgentUuidStore;
  readCheckpoint(sessionId: string): Promise<ParsedCheckpoint | null>;
  broadcast(channel: string, payload: unknown): void;
}): SessionOrchestrator {
  const { projectRegistry, sessionRegistry, runtimeStore, terminals, sessionAgentUuidStore, readCheckpoint, broadcast } = params;
  type RoleLaunchBuilder = (sessionId: string, role: SessionAgentRole, mode: "fresh" | "resume") => Promise<SessionRoleLaunch>;
  type AutopilotLaunchBuilder = (sessionId: string, role: SessionAgentRole, lane: string, prompt: string) => Promise<{
    command: string;
    agentKind: AgentKind;
    cwd: string;
    environment: Record<string, string>;
    typePrompt: string | null;
  }>;
  let buildRoleLaunch: RoleLaunchBuilder | null = null;
  let buildAutopilotLaunch: AutopilotLaunchBuilder | null = null;
  const liveTerminal = new Map<string, {
    sessionId: string;
    key: string;
    agentKind?: AgentKind;
    sessionLane?: string;
  }>();
  const workBySession = new Map<string, Promise<unknown>>();
  const autoPilotTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const latestCheckpoint = new Map<string, ParsedCheckpoint>();
  // Kimi exposes the durable conversation id in terminal output. Keep the
  // small rolling window on the runner: a browser reconnect must not decide
  // whether an agent can later be resumed.
  const kimiOutputByTerminal = new Map<string, string>();

  async function projectFor(id: string): Promise<ProjectRecord> {
    const project = (await projectRegistry.listProjects()).find((candidate) => candidate.id === id);
    if (!project) throw new Error(`Project not found: ${id}`);
    return project;
  }

  async function sessionFor(sessionId: string): Promise<WorkSession> {
    const session = await sessionRegistry.getSession({ sessionId });
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  function serial<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = workBySession.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    workBySession.set(sessionId, next);
    // Do not use `finally` here. `finally` creates a second promise that
    // rejects along with `next`; leaving that promise unobserved turns a
    // recoverable restore error into Node's unhandled-rejection crash.
    void next.then(
      () => {
        if (workBySession.get(sessionId) === next) workBySession.delete(sessionId);
      },
      () => {
        if (workBySession.get(sessionId) === next) workBySession.delete(sessionId);
      },
    );
    return next;
  }

  async function publish(sessionId: string, setupDone: boolean, runtime: RunnerSessionRuntimeRecord): Promise<void> {
    await runtimeStore.put(runtime);
    // `markSetupDone` may have just persisted a new session record while this
    // transition still holds the pre-update object. The runtime phase is the
    // authoritative state for the event sent to views.
    const resolvedSetupDone = runtime.phase === "ready" ? true : setupDone;
    broadcast(SESSION_IPC_CHANNELS.runtimeChanged, {
      sessionId,
      setupDone: resolvedSetupDone,
      runtime,
    } satisfies SessionRuntimeChangedEvent);
  }

  async function ensureAgent(session: WorkSession, runtime: RunnerSessionRuntimeRecord, terminal: RunnerTerminalRecord): Promise<void> {
    if (!terminal.role) return;
    const attached = await terminals.attach(terminal.key);
    if (attached) {
      liveTerminal.set(attached.sessionId, {
        sessionId: session.id,
        key: terminal.key,
        agentKind: undefined,
        sessionLane: terminal.role,
      });
      return;
    }
    if (!buildRoleLaunch) throw new Error("Session orchestrator was started before its role launch builder was registered.");
    const launch = await buildRoleLaunch(session.id, terminal.role, terminal.mode ?? "fresh");
    const created = await terminals.create({
      cwd: launch.cwd,
      cols: RUNNER_COLS,
      rows: RUNNER_ROWS,
      launchCommand: launch.agentCommand,
      environment: launch.environment,
      persistKey: terminal.key,
      initialInput: launch.wfCommand === null ? null : {
        text: launch.wfCommand,
        submit: session.kind === "review" || (session.kind === "pr-fix" && terminal.role === "implementer"),
      },
    });
    liveTerminal.set(created.sessionId, {
      sessionId: session.id,
      key: terminal.key,
      agentKind: launch.agentKind,
      sessionLane: terminal.role,
    });
    if (!created.reused) terminal.generation = (terminal.generation ?? 0) + 1;
  }

  function markTerminalResumable(terminalId: string): void {
    const live = liveTerminal.get(terminalId);
    if (!live) return;
    void serial(live.sessionId, async () => {
      const runtime = await runtimeStore.get(live.sessionId);
      const terminal = runtime?.terminals.find((candidate) => candidate.key === live.key && candidate.kind === "agent");
      if (!runtime || !terminal || terminal.mode === "resume") return;
      terminal.mode = "resume";
      const session = await sessionFor(live.sessionId);
      await publish(live.sessionId, session.setupDone, runtime);
    }).catch((error: unknown) => {
      console.error(`Could not mark ${live.key} resumable:`, error);
    });
  }

  async function ensureSetupOrPrimary(sessionId: string): Promise<RunnerSessionRuntimeRecord> {
    const session = await sessionFor(sessionId);
    const project = await projectFor(session.projectId);
    const current = (await runtimeStore.get(sessionId)) ?? blankRuntime(sessionId, session.setupDone);
    if (current.phase === "failed") return current;

    if (!session.setupDone) {
      const command = project.setupCommand.trim();
      if (!command) {
        await sessionRegistry.markSetupDone({ sessionId });
        current.phase = "ready";
      } else {
        const setup = current.terminals.find((terminal) => terminal.kind === "setup") ?? {
          key: setupKey(sessionId),
          kind: "setup" as const,
        };
        if (!current.terminals.some((terminal) => terminal.key === setup.key)) current.terminals.push(setup);
        const attached = await terminals.attach(setup.key);
        if (attached) {
          liveTerminal.set(attached.sessionId, { sessionId, key: setup.key });
          current.phase = "setup-running";
          current.error = null;
          await publish(sessionId, false, current);
          return current;
        }
        const created = await terminals.create({
          cwd: session.worktreePath,
          cols: RUNNER_COLS,
          rows: RUNNER_ROWS,
          launchCommand: command,
          persistKey: setup.key,
          setupSessionId: sessionId,
        });
        liveTerminal.set(created.sessionId, { sessionId, key: setup.key });
        current.phase = "setup-running";
        current.error = null;
        await publish(sessionId, false, current);
        return current;
      }
    }

    current.phase = "ready";
    current.error = null;
    const role = primaryRole(session);
    let agent = current.terminals.find((terminal) => terminal.kind === "agent" && terminal.role === role);
    if (!agent) {
      agent = { key: roleKey(sessionId, role), kind: "agent", role, mode: "fresh", generation: 0 };
      current.terminals.push(agent);
    }
    await ensureAgent(session, current, agent);

    // A runner restart has no PTYs left, but the durable runtime still tells
    // us which user-opened roles and shells existed. Rebuild that whole
    // server-side session, not merely whichever browser tab happens to mount.
    for (const terminal of current.terminals) {
      if (terminal === agent || terminal.kind === "setup") continue;
      if (terminal.kind === "agent") {
        await ensureAgent(session, current, terminal);
      } else if (terminal.kind === "shell") {
        await ensureShell(terminal, sessionId, terminal.root ? project.rootPath : session.worktreePath);
      }
    }
    await publish(sessionId, true, current);
    return current;
  }

  async function ensureShell(record: RunnerTerminalRecord, sessionId: string, cwd: string): Promise<void> {
    const attached = await terminals.attach(record.key);
    if (attached) {
      liveTerminal.set(attached.sessionId, { sessionId, key: record.key });
      return;
    }
    const created = await terminals.create({ cwd, cols: RUNNER_COLS, rows: RUNNER_ROWS, persistKey: record.key });
    liveTerminal.set(created.sessionId, { sessionId, key: record.key });
  }

  async function ensureRepositoryShells(sessionId: string): Promise<RunnerSessionRuntimeRecord> {
    // `repo::<projectId>` is a deliberately synthetic session: it has shell
    // tabs but no WorkSession row. Restoring it through sessionFor() therefore
    // made every runner restart fail as soon as a root workspace was open.
    const project = await projectFor(sessionId.slice("repo::".length));
    const current = (await runtimeStore.get(sessionId)) ?? blankRuntime(sessionId, true);
    current.phase = "ready";
    current.error = null;

    for (const terminal of current.terminals) {
      if (terminal.kind === "shell") {
        await ensureShell(terminal, sessionId, project.rootPath);
      }
    }
    await publish(sessionId, true, current);
    return current;
  }

  function isMissingRuntimeTarget(error: unknown): boolean {
    return error instanceof Error && /^(Session|Project) not found: /.test(error.message);
  }

  async function runAutopilot(sessionId: string): Promise<void> {
    await serial(sessionId, async () => {
      const checkpoint = latestCheckpoint.get(sessionId);
      const runtime = await runtimeStore.get(sessionId);
      if (!checkpoint || !runtime?.autoPilot.enabled) return;
      const session = await sessionFor(sessionId);
      const project = await projectFor(session.projectId);
      const config: AutoPilotConfig = project.autoPilot;
      const { action, next } = decideConductor({ prev: runtime.autoPilot.state, checkpoint, config });
      if (action.kind === "noop") return;

      if (action.kind === "pause") {
        runtime.autoPilot.state = next;
        runtime.autoPilot.message = `paused · ${action.reason}`;
        if (action.role && action.command) {
          const terminal = runtime.terminals.find((candidate) => candidate.kind === "agent" && candidate.role === action.role);
          if (terminal) {
            const attached = await terminals.attach(terminal.key);
            if (attached) {
              terminals.write(attached.sessionId, `\x1b[200~${action.command}\x1b[201~`);
            }
          }
        }
        await publish(sessionId, runtime.phase === "ready", runtime);
        return;
      }

      if (!buildAutopilotLaunch) throw new Error("Session orchestrator was started before its auto-pilot launch builder was registered.");
      const launch = await buildAutopilotLaunch(sessionId, action.role, action.lane, action.command);
      let terminal = runtime.terminals.find((candidate) => candidate.kind === "agent" && candidate.role === action.role);
      if (!terminal) {
        terminal = { key: roleKey(sessionId, action.role), kind: "agent", role: action.role, mode: "resume", generation: 0 };
        runtime.terminals.push(terminal);
      }
      const created = await terminals.replace({
        cwd: launch.cwd,
        cols: RUNNER_COLS,
        rows: RUNNER_ROWS,
        launchCommand: launch.command,
        environment: launch.environment,
        persistKey: terminal.key,
        initialInput: launch.typePrompt === null ? null : { text: launch.typePrompt, submit: true },
      });
      liveTerminal.set(created.sessionId, {
        sessionId,
        key: terminal.key,
        agentKind: launch.agentKind,
        sessionLane: action.lane,
      });
      terminal.mode = launch.typePrompt === null ? "resume" : "fresh";
      terminal.generation = (terminal.generation ?? 0) + 1;
      runtime.autoPilot.state = next;
      runtime.autoPilot.message = `→ ${action.command}`;
      await publish(sessionId, session.setupDone, runtime);
    });
  }

  function scheduleAutopilot(sessionId: string, delayMs: number): void {
    const current = autoPilotTimers.get(sessionId);
    if (current) clearTimeout(current);
    autoPilotTimers.set(sessionId, setTimeout(() => {
      autoPilotTimers.delete(sessionId);
      void runAutopilot(sessionId).catch((error: unknown) => {
        console.error(`Could not run auto-pilot for ${sessionId}:`, error);
      });
    }, delayMs));
  }

  return {
    setRoleLaunchBuilder(builder) {
      buildRoleLaunch = builder;
    },
    setAutopilotLaunchBuilder(builder) {
      buildAutopilotLaunch = builder;
    },
    async resume() {
      const records = await runtimeStore.list();
      await Promise.all(records.map(async (record) => {
        try {
          await serial(record.sessionId, () => (
            isRepoSessionId(record.sessionId)
              ? ensureRepositoryShells(record.sessionId)
              : ensureSetupOrPrimary(record.sessionId)
          ));
        } catch (error) {
          console.error(`Could not resume session ${record.sessionId}:`, error);
          // Session/project deletion leaves behind only runner intent. Remove
          // that orphan so it cannot fail every subsequent service start.
          if (isMissingRuntimeTarget(error)) {
            try {
              await runtimeStore.remove(record.sessionId);
            } catch (cleanupError) {
              console.error(`Could not remove stale runtime ${record.sessionId}:`, cleanupError);
            }
          }
        }
      }));
    },
    ensure(sessionId) {
      return serial(sessionId, () => ensureSetupOrPrimary(sessionId));
    },
    openRole(sessionId, role) {
      return serial(sessionId, async () => {
        const session = await sessionFor(sessionId);
        if (!isSessionRoleUnlocked(session.kind, role, session.checkpointPath !== null)) {
          throw new Error(`Role ${role} is not unlocked for this session.`);
        }
        const runtime = await ensureSetupOrPrimary(sessionId);
        if (runtime.phase !== "ready") throw new Error("Worktree setup has not completed.");
        let terminal = runtime.terminals.find((candidate) => candidate.kind === "agent" && candidate.role === role);
        if (!terminal) {
          terminal = { key: roleKey(sessionId, role), kind: "agent", role, mode: "fresh", generation: 0 };
          runtime.terminals.push(terminal);
        }
        await ensureAgent(session, runtime, terminal);
        await publish(sessionId, true, runtime);
        return terminal;
      });
    },
    openShell({ sessionId, root }) {
      return serial(sessionId, async () => {
        const repo = isRepoSessionId(sessionId);
        const projectId = repo ? sessionId.slice("repo::".length) : (await sessionFor(sessionId)).projectId;
        const project = await projectFor(projectId);
        const session = repo ? null : await sessionFor(sessionId);
        const runtime = (await runtimeStore.get(sessionId)) ?? blankRuntime(sessionId, true);
        const id = randomUUID();
        const ordinal = runtime.terminals.filter((terminal) => terminal.kind === "shell").length + 1;
        const terminal: RunnerTerminalRecord = {
          key: `${sessionId}::shell::${id}`,
          kind: "shell",
          title: `Shell ${ordinal}`,
          root,
          generation: 0,
        };
        runtime.terminals.push(terminal);
        await ensureShell(terminal, sessionId, root || repo ? project.rootPath : session!.worktreePath);
        await publish(sessionId, repo || session!.setupDone, runtime);
        return terminal;
      });
    },
    closeTerminal(sessionId, key) {
      return serial(sessionId, async () => {
        const runtime = await runtimeStore.get(sessionId);
        if (!runtime) return;
        const attached = await terminals.attach(key);
        if (attached) {
          liveTerminal.delete(attached.sessionId);
          terminals.kill(attached.sessionId);
        }
        runtime.terminals = runtime.terminals.filter((terminal) => terminal.key !== key);
        const repo = isRepoSessionId(sessionId);
        const session = repo ? null : await sessionFor(sessionId);
        await publish(sessionId, repo || session!.setupDone, runtime);
      });
    },
    runtime(sessionId) {
      return runtimeStore.get(sessionId);
    },
    skipFailedSetup(sessionId) {
      return serial(sessionId, async () => {
        const runtime = await runtimeStore.get(sessionId);
        if (!runtime || runtime.phase !== "failed") throw new Error("This session does not have a failed setup to skip.");
        await sessionRegistry.markSetupDone({ sessionId });
        runtime.phase = "ready";
        runtime.error = null;
        await publish(sessionId, true, runtime);
        await ensureSetupOrPrimary(sessionId);
      });
    },
    setAutopilot(sessionId, enabled) {
      return serial(sessionId, async () => {
        const runtime = await ensureSetupOrPrimary(sessionId);
        runtime.autoPilot.enabled = enabled;
        runtime.autoPilot.message = enabled ? "Auto-pilot enabled" : "Auto-pilot disabled";
        if (!enabled) {
          runtime.autoPilot.state = INITIAL_CONDUCTOR_STATE;
          const timer = autoPilotTimers.get(sessionId);
          if (timer) clearTimeout(timer);
          autoPilotTimers.delete(sessionId);
        }
        const session = await sessionFor(sessionId);
        await publish(sessionId, session.setupDone, runtime);
        if (enabled) {
          const checkpoint = latestCheckpoint.get(sessionId) ?? await readCheckpoint(sessionId);
          if (checkpoint) latestCheckpoint.set(sessionId, checkpoint);
          if (checkpoint) scheduleAutopilot(sessionId, (await projectFor(session.projectId)).autoPilot.settleDelayMs);
        }
        return runtime;
      });
    },
    runCommand(sessionId, role, lane, command) {
      return serial(sessionId, async () => {
        if (!buildAutopilotLaunch) throw new Error("Session orchestrator was started before its command launch builder was registered.");
        const session = await sessionFor(sessionId);
        const runtime = await ensureSetupOrPrimary(sessionId);
        if (runtime.phase !== "ready") throw new Error("Worktree setup has not completed.");
        const launch = await buildAutopilotLaunch(sessionId, role, lane, command);
        let terminal = runtime.terminals.find((candidate) => candidate.kind === "agent" && candidate.role === role);
        if (!terminal) {
          terminal = { key: roleKey(sessionId, role), kind: "agent", role, mode: "resume", generation: 0 };
          runtime.terminals.push(terminal);
        }
        const created = await terminals.replace({
          cwd: launch.cwd,
          cols: RUNNER_COLS,
          rows: RUNNER_ROWS,
          launchCommand: launch.command,
          environment: launch.environment,
          persistKey: terminal.key,
          initialInput: launch.typePrompt === null ? null : { text: launch.typePrompt, submit: true },
        });
        liveTerminal.set(created.sessionId, {
          sessionId,
          key: terminal.key,
          agentKind: launch.agentKind,
          sessionLane: lane,
        });
        terminal.mode = launch.typePrompt === null ? "resume" : "fresh";
        terminal.generation = (terminal.generation ?? 0) + 1;
        await publish(sessionId, session.setupDone, runtime);
      });
    },
    restoreView(sessionId, intent) {
      return serial(sessionId, async () => {
        const session = await sessionFor(sessionId);
        const project = await projectFor(session.projectId);
        const runtime = await ensureSetupOrPrimary(sessionId);

        // Imported workspace layout can name stale or locked tabs. It is an
        // advisory view preference, never permission to bypass workflow gates.
        for (const role of intent.roles) {
          if (!isSessionRoleUnlocked(session.kind, role, session.checkpointPath !== null)) continue;
          let terminal = runtime.terminals.find((candidate) => candidate.kind === "agent" && candidate.role === role);
          if (!terminal) {
            terminal = { key: roleKey(sessionId, role), kind: "agent", role, mode: "fresh", generation: 0 };
            runtime.terminals.push(terminal);
          }
          if (runtime.phase === "ready") await ensureAgent(session, runtime, terminal);
        }
        for (const shell of intent.shells) {
          const key = shell.id.includes("::") ? shell.id : `${sessionId}::${shell.id}`;
          let terminal = runtime.terminals.find((candidate) => candidate.kind === "shell" && candidate.key === key);
          if (!terminal) {
            terminal = { key, kind: "shell", title: shell.title || "Shell", root: shell.root === true, generation: 0 };
            runtime.terminals.push(terminal);
          }
          if (runtime.phase === "ready") {
            await ensureShell(terminal, sessionId, terminal.root ? project.rootPath : session.worktreePath);
          }
        }
        await publish(sessionId, runtime.phase === "ready", runtime);
        return runtime;
      });
    },
    onCheckpoint(sessionId, checkpoint) {
      latestCheckpoint.set(sessionId, checkpoint);
      void runtimeStore.get(sessionId).then(async (runtime) => {
        if (!runtime?.autoPilot.enabled) return;
        const session = await sessionFor(sessionId);
        const project = await projectFor(session.projectId);
        scheduleAutopilot(sessionId, project.autoPilot.settleDelayMs);
      }).catch((error: unknown) => {
        console.error(`Could not schedule auto-pilot for ${sessionId}:`, error);
      });
    },
    onSetupExit({ sessionId, code }) {
      return serial(sessionId, async () => {
        const runtime = (await runtimeStore.get(sessionId)) ?? blankRuntime(sessionId, false);
        if (code !== 0) {
          runtime.phase = "failed";
          runtime.error = `Setup failed (exit ${code}).`;
          await publish(sessionId, false, runtime);
          return;
        }
        await sessionRegistry.markSetupDone({ sessionId });
        runtime.phase = "ready";
        runtime.error = null;
        await publish(sessionId, true, runtime);
        await ensureSetupOrPrimary(sessionId);
      });
    },
    onTerminalExit({ terminalId }) {
      liveTerminal.delete(terminalId);
      kimiOutputByTerminal.delete(terminalId);
    },
    onTerminalData({ terminalId, data }) {
      const live = liveTerminal.get(terminalId);
      if (!live || live.agentKind !== "kimi" || !live.sessionLane) return;
      const text = `${kimiOutputByTerminal.get(terminalId) ?? ""}${data}`.slice(-16_384);
      kimiOutputByTerminal.set(terminalId, text);
      const sessionUuid = findKimiSessionId(text);
      if (!sessionUuid) return;
      kimiOutputByTerminal.delete(terminalId);
      void sessionAgentUuidStore.set({
        sessionId: live.sessionId,
        lane: live.sessionLane,
        binding: { agentKind: "kimi", sessionUuid },
      }).catch((error: unknown) => {
        console.error(`Could not persist Kimi session id for ${live.sessionId}/${live.sessionLane}:`, error);
      });
    },
    onTerminalInitialInputDelivered({ terminalId, submit }) {
      if (submit) markTerminalResumable(terminalId);
    },
    onTerminalInput({ terminalId, data }) {
      // A pre-typed workflow command deliberately remains fresh until the user
      // submits it. That prevents `codex resume <id>` after an update from
      // targeting a conversation that was never actually created.
      if (/\r(?:\n)?$/.test(data)) markTerminalResumable(terminalId);
    },
    async remove(sessionId) {
      const timer = autoPilotTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      autoPilotTimers.delete(sessionId);
      latestCheckpoint.delete(sessionId);
      await runtimeStore.remove(sessionId);
      for (const [terminalId, live] of liveTerminal) {
        if (live.sessionId !== sessionId) continue;
        terminals.kill(terminalId);
        liveTerminal.delete(terminalId);
        kimiOutputByTerminal.delete(terminalId);
      }
    },
  };
}
