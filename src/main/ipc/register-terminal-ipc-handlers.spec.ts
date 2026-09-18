import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, TERMINAL_IPC_CHANNELS } from "../../shared/ipc/contract";
import { createIpcHandlerRegistry, type IpcMessageSender } from "./ipc-transport";
import { registerTerminalIpcHandlers } from "./register-terminal-ipc-handlers";
import { createPtySessionManager, type PtySpawn } from "../terminals/pty-session-manager";
import { createTerminalScreenStore } from "../terminals/terminal-screen-store";

function sender(destroyed = false): IpcMessageSender {
  return { isDestroyed: () => destroyed, send: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("registerTerminalIpcHandlers", () => {
  it("reattaches a reconnecting client to a persistent terminal instead of spawning a second PTY", async () => {
    let dataCallback: ((data: string) => void) | undefined;
    const fakePty: PtySpawn = {
      pid: 4242,
      killGroup: () => {},
      onData: (callback) => {
        dataCallback = callback;
      },
      onExit: () => {},
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    const spawnPty = vi.fn(() => fakePty);
    const broadcast = vi.fn();
    const transport = createIpcHandlerRegistry();
    registerTerminalIpcHandlers({
      transport,
      ptySessionManager: createPtySessionManager({ spawnPty }),
      sessionStateStore: { get: async () => null, set: async () => {} },
      broadcast,
      screenStore: createTerminalScreenStore(),
      scrollbackStore: {
        record: () => {}, read: async () => "", isInAlternateScreen: () => false, resetAlternateScreen: () => {}, clear: async () => {}, flush: async () => {},
      },
    });
    const disconnected = sender(true);
    const reconnected = sender();
    const input = { cwd: process.cwd(), cols: 80, rows: 24, persistKey: "session::architect" };

    const first = await transport.invoke(disconnected, TERMINAL_IPC_CHANNELS.create, [input]);
    const second = await transport.invoke(reconnected, TERMINAL_IPC_CHANNELS.create, [input]);

    expect(first).toEqual({ sessionId: "1", reused: false });
    expect(second).toMatchObject({
      sessionId: "1",
      reused: true,
      snapshot: { cols: 80, rows: 24, alternateScreen: false },
    });
    expect(spawnPty).toHaveBeenCalledTimes(1);

    dataCallback?.("still running");
    expect(broadcast).toHaveBeenCalledWith(TERMINAL_IPC_CHANNELS.data, {
      sessionId: "1",
      data: "still running",
    });
  });

  it("can attach to a live persistent setup terminal without creating a setup command", async () => {
    let dataCallback: ((data: string) => void) | undefined;
    const fakePty: PtySpawn = {
      pid: 4242,
      killGroup: () => {},
      onData: (callback) => {
        dataCallback = callback;
      },
      onExit: () => {},
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    const spawnPty = vi.fn(() => fakePty);
    const transport = createIpcHandlerRegistry();
    const broadcast = vi.fn();
    const resetAlternateScreen = vi.fn();
    registerTerminalIpcHandlers({
      transport,
      ptySessionManager: createPtySessionManager({ spawnPty }),
      sessionStateStore: { get: async () => null, set: async () => {} },
      broadcast,
      screenStore: createTerminalScreenStore(),
      scrollbackStore: {
        record: () => {}, read: async () => "", isInAlternateScreen: () => true, resetAlternateScreen, clear: async () => {}, flush: async () => {},
      },
    });

    const firstClient = sender(true);
    const reloadedClient = sender();
    const setup = { cwd: process.cwd(), cols: 80, rows: 24, launchCommand: "pnpm worktree:setup", persistKey: "session::setup" };

    await transport.invoke(firstClient, TERMINAL_IPC_CHANNELS.create, [setup]);
    const attached = await transport.invoke(reloadedClient, TERMINAL_IPC_CHANNELS.attach, [setup.persistKey]);

    expect(attached).toMatchObject({
      sessionId: "1",
      reused: true,
      alternateScreen: true,
      snapshot: { cols: 80, rows: 24 },
    });
    expect(spawnPty).toHaveBeenCalledTimes(1);
    expect(resetAlternateScreen).toHaveBeenCalledWith(setup.persistKey);

    dataCallback?.("setup still running");
    expect(broadcast).toHaveBeenCalledWith(TERMINAL_IPC_CHANNELS.data, {
      sessionId: "1",
      data: "setup still running",
    });
  });

  it("finalizes setup in the runner when its PTY exits after the browser disconnects", async () => {
    let exitCallback: ((event: { exitCode: number }) => void) | undefined;
    const fakePty: PtySpawn = {
      pid: 4242,
      killGroup: () => {},
      onData: () => {},
      onExit: (callback) => {
        exitCallback = callback;
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    const onSetupExit = vi.fn(async () => {});
    const transport = createIpcHandlerRegistry();
    registerTerminalIpcHandlers({
      transport,
      ptySessionManager: createPtySessionManager({ spawnPty: () => fakePty }),
      sessionStateStore: { get: async () => null, set: async () => {} },
      broadcast: () => {},
      screenStore: createTerminalScreenStore(),
      scrollbackStore: {
        record: () => {}, read: async () => "", isInAlternateScreen: () => false, resetAlternateScreen: () => {}, clear: async () => {}, flush: async () => {},
      },
      onSetupExit,
    });

    await transport.invoke(sender(true), TERMINAL_IPC_CHANNELS.create, [{
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      persistKey: "session::setup",
      setupSessionId: "session",
    }]);
    exitCallback?.({ exitCode: 0 });

    expect(onSetupExit).toHaveBeenCalledWith({ sessionId: "session", code: 0 });
  });

  it("continues routing terminal input through the transport", () => {
    const write = vi.fn();
    const fakePty: PtySpawn = { pid: 4242, killGroup: () => {}, onData: () => {}, onExit: () => {}, write, resize: vi.fn(), kill: vi.fn() };
    const transport = createIpcHandlerRegistry();
    registerTerminalIpcHandlers({
      transport,
      ptySessionManager: createPtySessionManager({ spawnPty: () => fakePty }),
      sessionStateStore: { get: async () => null, set: async () => {} },
      broadcast: () => {},
      screenStore: createTerminalScreenStore(),
      scrollbackStore: {
        record: () => {}, read: async () => "", isInAlternateScreen: () => false, resetAlternateScreen: () => {}, clear: async () => {}, flush: async () => {},
      },
    });
    const client = sender();
    void transport.invoke(client, TERMINAL_IPC_CHANNELS.create, [{ cwd: process.cwd(), cols: 80, rows: 24 }]);

    transport.emit(client, TERMINAL_IPC_CHANNELS.write, ["1", "hello"]);
    expect(write).toHaveBeenCalledWith("hello");
    expect(transport.hasHandler(IPC_CHANNELS.sessionStateGet)).toBe(true);
  });

  it("updates the existing PTY display grid without creating a new process", async () => {
    const resize = vi.fn();
    const fakePty: PtySpawn = { pid: 4242, killGroup: () => {}, onData: () => {}, onExit: () => {}, write: vi.fn(), resize, kill: vi.fn() };
    const transport = createIpcHandlerRegistry();
    registerTerminalIpcHandlers({
      transport,
      ptySessionManager: createPtySessionManager({ spawnPty: () => fakePty }),
      sessionStateStore: { get: async () => null, set: async () => {} },
      broadcast: () => {},
      screenStore: createTerminalScreenStore(),
      scrollbackStore: {
        record: () => {}, read: async () => "", isInAlternateScreen: () => false, resetAlternateScreen: () => {}, clear: async () => {}, flush: async () => {},
      },
    });
    const client = sender();
    await transport.invoke(client, TERMINAL_IPC_CHANNELS.create, [{ cwd: process.cwd(), cols: 80, rows: 24, persistKey: "session::shell" }]);

    const first = await transport.invoke(client, TERMINAL_IPC_CHANNELS.setDisplayGeometry, ["1", 166, 51]);
    const second = await transport.invoke(client, TERMINAL_IPC_CHANNELS.setDisplayGeometry, ["1", 100, 30]);

    expect(first).toMatchObject({ cols: 166, rows: 51 });
    expect(second).toMatchObject({ cols: 100, rows: 30 });
    expect(resize).toHaveBeenCalledTimes(2);
    expect(resize).toHaveBeenNthCalledWith(1, 166, 51);
    expect(resize).toHaveBeenNthCalledWith(2, 100, 30);
  });

  it("delivers a launch prompt in the runner even when its requesting browser is gone", async () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const fakePty: PtySpawn = { pid: 4242, killGroup: () => {}, onData: () => {}, onExit: () => {}, write, resize: vi.fn(), kill: vi.fn() };
    const broadcast = vi.fn();
    const transport = createIpcHandlerRegistry();
    registerTerminalIpcHandlers({
      transport,
      ptySessionManager: createPtySessionManager({ spawnPty: () => fakePty }),
      sessionStateStore: { get: async () => null, set: async () => {} },
      broadcast,
      screenStore: createTerminalScreenStore(),
      scrollbackStore: {
        record: () => {}, read: async () => "", isInAlternateScreen: () => false, resetAlternateScreen: () => {}, clear: async () => {}, flush: async () => {},
      },
    });

    await transport.invoke(sender(true), TERMINAL_IPC_CHANNELS.create, [{
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      initialInput: { text: "review this PR", submit: true },
    }]);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(write).toHaveBeenCalledWith("\x1b[200~review this PR\x1b[201~\r");
    expect(broadcast).toHaveBeenCalledWith(TERMINAL_IPC_CHANNELS.initialInputDelivered, { sessionId: "1" });
  });

  /** Pantalla controlada: la lógica de entrega se prueba sin depender de los temporizadores internos de xterm. */
  function harness(): { write: ReturnType<typeof vi.fn>; broadcast: ReturnType<typeof vi.fn>; transport: ReturnType<typeof createIpcHandlerRegistry>; emit: (data: string) => void; screen: { lines: string[] } } {
    const write = vi.fn();
    let listener: ((data: string) => void) | null = null;
    const fakePty: PtySpawn = {
      pid: 4243, killGroup: () => {}, onData: (cb) => { listener = cb; }, onExit: () => {}, write, resize: vi.fn(), kill: vi.fn(),
    };
    const screen = { lines: [] as string[] };
    const broadcast = vi.fn();
    const transport = createIpcHandlerRegistry();
    registerTerminalIpcHandlers({
      transport,
      ptySessionManager: createPtySessionManager({ spawnPty: () => fakePty }),
      sessionStateStore: { get: async () => null, set: async () => {} },
      broadcast,
      screenStore: {
        create: () => {}, write: () => {}, resize: () => {}, remove: () => {},
        snapshot: async () => ({ cols: 80, rows: 24, alternateScreen: false, lines: screen.lines, cursorX: 0, cursorY: 0 }),
      },
      scrollbackStore: {
        record: () => {}, read: async () => "", isInAlternateScreen: () => false, resetAlternateScreen: () => {}, clear: async () => {}, flush: async () => {},
      },
    });
    return { write, broadcast, transport, emit: (data) => listener?.(data), screen };
  }

  it("waits for the agent's input box before delivering the launch prompt, with or without an attached view", async () => {
    vi.useFakeTimers();
    const { write, broadcast, transport, emit, screen } = harness();
    await transport.invoke(sender(true), TERMINAL_IPC_CHANNELS.create, [{ cwd: process.cwd(), cols: 80, rows: 24, initialInput: { text: "review this PR", submit: true } }]);

    // Banner sin caja de entrada: el CLI sigue cargando. Se calma 1,2 s y NO se entrega.
    screen.lines = ["Welcome to the agent", "Loading MCP servers..."];
    emit("Welcome to the agent\r\nLoading MCP servers...\r\n");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(write).not.toHaveBeenCalled();

    // Aparece la caja de entrada: se entrega en cuanto se calma.
    screen.lines = ["Welcome to the agent", "│ > "];
    emit("\r\n│ > \r\n");
    await vi.advanceTimersByTimeAsync(1_300);
    expect(write).toHaveBeenCalledWith("\x1b[200~review this PR\x1b[201~\r");
    expect(broadcast).toHaveBeenCalledWith(TERMINAL_IPC_CHANNELS.initialInputDelivered, { sessionId: "1" });
  });

  it("re-sends Enter when the typed prompt sits in the input box and the screen does not move", async () => {
    vi.useFakeTimers();
    const { write, transport, emit, screen } = harness();
    await transport.invoke(sender(true), TERMINAL_IPC_CHANNELS.create, [{ cwd: process.cwd(), cols: 80, rows: 24, initialInput: { text: "review this PR", submit: true } }]);
    screen.lines = ["│ > "];
    emit("\r\n│ > \r\n");
    await vi.advanceTimersByTimeAsync(1_300);
    expect(write).toHaveBeenCalledTimes(1);

    // El TUI ecoa el texto en la caja pero no lo acepta: nada más cambia.
    screen.lines = ["│ > review this PR"];
    await vi.advanceTimersByTimeAsync(1_500 + 3_500 + 50);
    expect(write).toHaveBeenLastCalledWith("\r");
    expect(write).toHaveBeenCalledTimes(2);

    // Ahora el agente responde: la pantalla cambia y no se reenvía más.
    screen.lines = ["> review this PR", "⠋ Thinking…"];
    await vi.advanceTimersByTimeAsync(1_500 + 3_500 + 50);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
