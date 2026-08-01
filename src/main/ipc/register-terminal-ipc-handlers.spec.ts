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
    const fakePty: PtySpawn = { onData: () => {}, onExit: () => {}, write, resize: vi.fn(), kill: vi.fn() };
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

  it("accepts only the first viewer's initial geometry claim", async () => {
    const resize = vi.fn();
    const fakePty: PtySpawn = { onData: () => {}, onExit: () => {}, write: vi.fn(), resize, kill: vi.fn() };
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

    const first = await transport.invoke(client, TERMINAL_IPC_CHANNELS.claimInitialGeometry, ["1", 166, 51]);
    const second = await transport.invoke(client, TERMINAL_IPC_CHANNELS.claimInitialGeometry, ["1", 100, 30]);

    expect(first).toMatchObject({ cols: 166, rows: 51 });
    expect(second).toMatchObject({ cols: 166, rows: 51 });
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith(166, 51);
  });

  it("delivers a launch prompt in the runner even when its requesting browser is gone", async () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const fakePty: PtySpawn = { onData: () => {}, onExit: () => {}, write, resize: vi.fn(), kill: vi.fn() };
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

    await vi.advanceTimersByTimeAsync(10_000);

    expect(write).toHaveBeenCalledWith("\x1b[200~review this PR\x1b[201~\r");
    expect(broadcast).toHaveBeenCalledWith(TERMINAL_IPC_CHANNELS.initialInputDelivered, { sessionId: "1" });
  });
});
