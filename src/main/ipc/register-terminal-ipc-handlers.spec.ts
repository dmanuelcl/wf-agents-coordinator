import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, TERMINAL_IPC_CHANNELS } from "../../shared/ipc/contract";
import { createIpcHandlerRegistry, type IpcMessageSender } from "./ipc-transport";
import { registerTerminalIpcHandlers } from "./register-terminal-ipc-handlers";
import { createPtySessionManager, type PtySpawn } from "../terminals/pty-session-manager";

function sender(destroyed = false): IpcMessageSender {
  return { isDestroyed: () => destroyed, send: vi.fn() };
}

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
    const transport = createIpcHandlerRegistry();
    registerTerminalIpcHandlers({
      transport,
      ptySessionManager: createPtySessionManager({ spawnPty }),
      sessionStateStore: { get: async () => null, set: async () => {} },
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
    expect(second).toEqual({ sessionId: "1", reused: true });
    expect(spawnPty).toHaveBeenCalledTimes(1);

    dataCallback?.("still running");
    expect(reconnected.send).toHaveBeenCalledWith(TERMINAL_IPC_CHANNELS.data, {
      sessionId: "1",
      data: "still running",
    });
    expect(disconnected.send).not.toHaveBeenCalled();
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
    const resetAlternateScreen = vi.fn();
    registerTerminalIpcHandlers({
      transport,
      ptySessionManager: createPtySessionManager({ spawnPty }),
      sessionStateStore: { get: async () => null, set: async () => {} },
      scrollbackStore: {
        record: () => {}, read: async () => "", isInAlternateScreen: () => true, resetAlternateScreen, clear: async () => {}, flush: async () => {},
      },
    });

    const firstClient = sender(true);
    const reloadedClient = sender();
    const setup = { cwd: process.cwd(), cols: 80, rows: 24, launchCommand: "pnpm worktree:setup", persistKey: "session::setup" };

    await transport.invoke(firstClient, TERMINAL_IPC_CHANNELS.create, [setup]);
    const attached = await transport.invoke(reloadedClient, TERMINAL_IPC_CHANNELS.attach, [setup.persistKey]);

    expect(attached).toEqual({ sessionId: "1", reused: true, alternateScreen: true });
    expect(spawnPty).toHaveBeenCalledTimes(1);
    expect(resetAlternateScreen).toHaveBeenCalledWith(setup.persistKey);

    dataCallback?.("setup still running");
    expect(reloadedClient.send).toHaveBeenCalledWith(TERMINAL_IPC_CHANNELS.data, {
      sessionId: "1",
      data: "setup still running",
    });
  });

  it("continues routing terminal input through the transport", () => {
    const write = vi.fn();
    const fakePty: PtySpawn = { onData: () => {}, onExit: () => {}, write, resize: vi.fn(), kill: vi.fn() };
    const transport = createIpcHandlerRegistry();
    registerTerminalIpcHandlers({
      transport,
      ptySessionManager: createPtySessionManager({ spawnPty: () => fakePty }),
      sessionStateStore: { get: async () => null, set: async () => {} },
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
});
