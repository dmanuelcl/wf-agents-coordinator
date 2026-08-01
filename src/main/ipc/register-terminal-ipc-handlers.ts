import { IPC_CHANNELS, TERMINAL_IPC_CHANNELS } from "../../shared/ipc/contract";
import type { TerminalScreenSnapshot } from "../../shared/ipc/contract";
import { hasBlockingStartupConfirmation } from "../../shared/terminals/startup-readiness";
import { resolveShell, resolveShellForCommand } from "../terminals/shell-resolver";
import type { PtySessionManager } from "../terminals/pty-session-manager";
import type { ProjectSessionState, SessionStateStore } from "../terminals/session-state-store";
import type { TerminalScrollbackStore } from "../terminals/terminal-scrollback-store";
import type { TerminalScreenStore } from "../terminals/terminal-screen-store";
import type { IpcTransport } from "./ipc-transport";

const INITIAL_INPUT_SETTLE_MS = 1_200;
const INITIAL_INPUT_MAX_WAIT_MS = 10_000;

interface InitialInputDelivery {
  text: string;
  submit: boolean;
  settledTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  generation: number;
  delivered: boolean;
}

export interface RunnerTerminalCreateInput {
  cwd: string;
  cols: number;
  rows: number;
  launchCommand?: string | null;
  environment?: Record<string, string>;
  persistKey?: string | null;
  setupSessionId?: string | null;
  initialInput?: { text: string; submit: boolean } | null;
}

/** Programmatic terminal surface used by the runner's session orchestrator. */
export interface RunnerTerminalController {
  create(input: RunnerTerminalCreateInput): Promise<{ sessionId: string; reused: boolean }>;
  replace(input: RunnerTerminalCreateInput): Promise<{ sessionId: string; reused: boolean }>;
  attach(persistKey: string): Promise<{
    sessionId: string;
    reused: true;
    alternateScreen?: true;
    snapshot?: TerminalScreenSnapshot;
  } | null>;
  kill(sessionId: string): void;
  write(sessionId: string, data: string): void;
}

export function registerTerminalIpcHandlers(params: {
  ptySessionManager: PtySessionManager;
  sessionStateStore: SessionStateStore;
  scrollbackStore: TerminalScrollbackStore;
  screenStore: TerminalScreenStore;
  transport: IpcTransport;
  broadcast(channel: string, payload: unknown): void;
  onSetupExit?: (params: { sessionId: string; code: number }) => Promise<void>;
  onTerminalExit?: (params: { terminalId: string; persistKey: string | null; code: number }) => void;
  onTerminalData?: (params: { terminalId: string; persistKey: string | null; data: string }) => void;
  onInitialInputDelivered?: (params: { terminalId: string; persistKey: string | null; submit: boolean }) => void;
  onTerminalInput?: (params: { terminalId: string; persistKey: string | null; data: string }) => void;
}): RunnerTerminalController {
  const {
    ptySessionManager,
    sessionStateStore,
    scrollbackStore,
    screenStore,
    transport,
    broadcast,
    onSetupExit,
    onTerminalExit,
    onTerminalData,
    onInitialInputDelivered,
    onTerminalInput,
  } = params;
  const ipc = transport;
  const terminalByPersistKey = new Map<string, string>();
  const terminalPersistKeyById = new Map<string, string>();
  const initialInputByTerminal = new Map<string, InitialInputDelivery>();

  function clearInitialInputTimers(delivery: InitialInputDelivery): void {
    if (delivery.settledTimer) clearTimeout(delivery.settledTimer);
    if (delivery.deadlineTimer) clearTimeout(delivery.deadlineTimer);
    delivery.settledTimer = null;
    delivery.deadlineTimer = null;
  }

  function discardInitialInput(sessionId: string): void {
    const delivery = initialInputByTerminal.get(sessionId);
    if (!delivery) return;
    clearInitialInputTimers(delivery);
    initialInputByTerminal.delete(sessionId);
  }

  async function tryDeliverInitialInput(sessionId: string, expectedGeneration?: number): Promise<void> {
    const delivery = initialInputByTerminal.get(sessionId);
    if (!delivery || delivery.delivered || !ptySessionManager.has(sessionId)) {
      discardInitialInput(sessionId);
      return;
    }
    if (expectedGeneration !== undefined && delivery.generation !== expectedGeneration) return;

    const snapshot = await screenStore.snapshot(sessionId);
    // New data arrived while the snapshot was being rendered. Wait for that
    // output to settle instead of submitting into a changing startup screen.
    if (expectedGeneration !== undefined && delivery.generation !== expectedGeneration) return;
    if (hasBlockingStartupConfirmation(snapshot?.lines.join("\n") ?? "")) return;

    delivery.delivered = true;
    clearInitialInputTimers(delivery);
    initialInputByTerminal.delete(sessionId);
    const paste = `\x1b[200~${delivery.text}\x1b[201~`;
    ptySessionManager.write(sessionId, delivery.submit ? `${paste}\r` : paste);
    onInitialInputDelivered?.({
      terminalId: sessionId,
      persistKey: terminalPersistKeyById.get(sessionId) ?? null,
      submit: delivery.submit,
    });
    broadcast(TERMINAL_IPC_CHANNELS.initialInputDelivered, { sessionId });
  }

  function scheduleInitialInputAfterSettle(sessionId: string): void {
    const delivery = initialInputByTerminal.get(sessionId);
    if (!delivery || delivery.delivered) return;
    delivery.generation += 1;
    if (delivery.settledTimer) clearTimeout(delivery.settledTimer);
    const generation = delivery.generation;
    delivery.settledTimer = setTimeout(() => {
      delivery.settledTimer = null;
      void tryDeliverInitialInput(sessionId, generation).catch((error: unknown) => {
        console.error(`Could not deliver initial terminal input for ${sessionId}:`, error);
      });
    }, INITIAL_INPUT_SETTLE_MS);
  }

  function queueInitialInput(sessionId: string, input: { text: string; submit: boolean } | null | undefined): void {
    if (!input?.text) return;
    const delivery: InitialInputDelivery = {
      text: input.text,
      submit: input.submit,
      settledTimer: null,
      deadlineTimer: null,
      generation: 0,
      delivered: false,
    };
    initialInputByTerminal.set(sessionId, delivery);
    delivery.deadlineTimer = setTimeout(() => {
      delivery.deadlineTimer = null;
      void tryDeliverInitialInput(sessionId).catch((error: unknown) => {
        console.error(`Could not deliver initial terminal input for ${sessionId}:`, error);
      });
    }, INITIAL_INPUT_MAX_WAIT_MS);
  }

  async function attachPersistentTerminal(persistKey: string): Promise<{
    sessionId: string;
    reused: true;
    alternateScreen?: true;
    snapshot?: TerminalScreenSnapshot;
  } | null> {
    const existingSessionId = terminalByPersistKey.get(persistKey);
    if (!existingSessionId) return null;
    if (!ptySessionManager.has(existingSessionId)) {
      terminalByPersistKey.delete(persistKey);
      return null;
    }
    const snapshot = await screenStore.snapshot(existingSessionId);
    return {
      sessionId: existingSessionId,
      reused: true,
      ...(scrollbackStore.isInAlternateScreen(persistKey) ? { alternateScreen: true as const } : {}),
      ...(snapshot ? { snapshot } : {}),
    };
  }

  async function createTerminal(input: RunnerTerminalCreateInput): Promise<{ sessionId: string; reused: boolean }> {
    const persistKey = input.persistKey ?? null;
    const attached = persistKey ? await attachPersistentTerminal(persistKey) : null;
    if (attached) {
      // This is a read-only lookup. The runner broadcasts the PTY stream to
      // every authenticated client; no browser owns or mutates the terminal
      // merely by opening/reloading a view.
      return attached;
    }

    const shell = input.launchCommand
      ? resolveShellForCommand({ platform: process.platform, env: process.env, command: input.launchCommand })
      : resolveShell({ platform: process.platform, env: process.env });
    // A previous PTY may have died while a full-screen TUI was active. Its
    // replacement (agent fallback shell, fresh run) starts in the normal
    // screen, so do not carry that stale state across processes.
    if (persistKey) scrollbackStore.resetAlternateScreen(persistKey);
    const sessionId = ptySessionManager.create({
      cwd: input.cwd,
      shell,
      cols: input.cols,
      rows: input.rows,
      environment: input.environment,
    });

    if (persistKey) {
      terminalByPersistKey.set(persistKey, sessionId);
      terminalPersistKeyById.set(sessionId, persistKey);
    }
    screenStore.create(sessionId, { cols: input.cols, rows: input.rows });
    queueInitialInput(sessionId, input.initialInput);
    ptySessionManager.onData(sessionId, (data) => {
      // Bounded scrollback capture (opt-in per terminal) before forwarding.
      if (persistKey) scrollbackStore.record(persistKey, data);
      screenStore.write(sessionId, data);
      scheduleInitialInputAfterSettle(sessionId);
      onTerminalData?.({ terminalId: sessionId, persistKey, data });
      // PTY ownership belongs to the runner, not to the browser that created
      // it. Broadcast to all currently authenticated views so reconnecting or
      // second clients immediately receive the live stream.
      broadcast(TERMINAL_IPC_CHANNELS.data, { sessionId, data });
    });
    ptySessionManager.onExit(sessionId, (code) => {
      if (persistKey && terminalByPersistKey.get(persistKey) === sessionId) terminalByPersistKey.delete(persistKey);
      terminalPersistKeyById.delete(sessionId);
      discardInitialInput(sessionId);
      if (input.setupSessionId && onSetupExit) {
        void onSetupExit({ sessionId: input.setupSessionId, code }).catch((error: unknown) => {
          console.error(`Could not finalize setup for session ${input.setupSessionId}:`, error);
        });
      }
      screenStore.remove(sessionId);
      onTerminalExit?.({ terminalId: sessionId, persistKey, code });
      broadcast(TERMINAL_IPC_CHANNELS.exit, { sessionId, code });
    });

    return { sessionId, reused: false };
  }

  async function replaceTerminal(input: RunnerTerminalCreateInput): Promise<{ sessionId: string; reused: boolean }> {
    const persistKey = input.persistKey ?? null;
    if (persistKey) {
      const attached = await attachPersistentTerminal(persistKey);
      if (attached) {
        discardInitialInput(attached.sessionId);
        ptySessionManager.kill(attached.sessionId);
      }
    }
    return createTerminal(input);
  }

  ipc.handle(TERMINAL_IPC_CHANNELS.create, (_event, input: RunnerTerminalCreateInput) => createTerminal(input));

  ipc.handle(TERMINAL_IPC_CHANNELS.attach, (_event, persistKey: string) => attachPersistentTerminal(persistKey));

  ipc.on(TERMINAL_IPC_CHANNELS.write, (_event, sessionId: string, data: string) => {
    ptySessionManager.write(sessionId, data);
    onTerminalInput?.({ terminalId: sessionId, persistKey: terminalPersistKeyById.get(sessionId) ?? null, data });
    // A user may have just answered a trust/permissions confirmation. Recheck
    // the runner-owned screen after its response settles.
    scheduleInitialInputAfterSettle(sessionId);
  });

  ipc.on(TERMINAL_IPC_CHANNELS.resize, (_event, sessionId: string, cols: number, rows: number) => {
    ptySessionManager.resize(sessionId, cols, rows);
    screenStore.resize(sessionId, { cols, rows });
  });

  ipc.on(TERMINAL_IPC_CHANNELS.kill, (_event, sessionId: string) => {
    discardInitialInput(sessionId);
    ptySessionManager.kill(sessionId);
  });

  ipc.handle(TERMINAL_IPC_CHANNELS.readScrollback, async (_event, persistKey: string) => {
    return scrollbackStore.read(persistKey);
  });

  ipc.handle(TERMINAL_IPC_CHANNELS.clearScrollback, async (_event, persistKey: string) => {
    await scrollbackStore.clear(persistKey);
  });

  ipc.handle(IPC_CHANNELS.sessionStateGet, async (_event, projectId: string) => {
    return sessionStateStore.get(projectId);
  });

  ipc.handle(IPC_CHANNELS.sessionStateSet, async (_event, projectId: string, state: ProjectSessionState) => {
    await sessionStateStore.set(projectId, state);
  });

  return {
    create: createTerminal,
    replace: replaceTerminal,
    attach: attachPersistentTerminal,
    kill(sessionId) {
      discardInitialInput(sessionId);
      ptySessionManager.kill(sessionId);
    },
    write(sessionId, data) {
      ptySessionManager.write(sessionId, data);
    },
  };
}
