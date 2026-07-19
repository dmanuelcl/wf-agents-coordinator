import { describe, expect, it, vi } from "vitest";
import { createPtySessionManager } from "./pty-session-manager";
import type { PtySpawn } from "./pty-session-manager";

interface FakePty extends PtySpawn {
  emitData(data: string): void;
  emitExit(code: number): void;
  writeCalls: string[];
  resizeCalls: Array<[number, number]>;
  killCalled: boolean;
}

function createFakePty(): FakePty {
  let dataCb: ((data: string) => void) | null = null;
  let exitCb: ((e: { exitCode: number }) => void) | null = null;

  const fake: FakePty = {
    writeCalls: [],
    resizeCalls: [],
    killCalled: false,
    onData(cb) {
      dataCb = cb;
    },
    onExit(cb) {
      exitCb = cb;
    },
    write(data) {
      fake.writeCalls.push(data);
    },
    resize(cols, rows) {
      fake.resizeCalls.push([cols, rows]);
    },
    kill() {
      fake.killCalled = true;
    },
    emitData(data) {
      dataCb?.(data);
    },
    emitExit(code) {
      exitCb?.({ exitCode: code });
    },
  };

  return fake;
}

const SHELL = { file: "/bin/bash", args: ["-l"] };

describe("createPtySessionManager", () => {
  it("forwards provider environment overrides to the PTY", () => {
    const fakePty = createFakePty();
    const spawnPty = vi.fn(() => fakePty);
    const manager = createPtySessionManager({ spawnPty });

    manager.create({
      cwd: "/repo",
      shell: SHELL,
      cols: 80,
      rows: 24,
      environment: { KIMI_MODEL_THINKING_EFFORT: "high" },
    });

    expect(spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ environment: { KIMI_MODEL_THINKING_EFFORT: "high" } }),
    );
  });

  it("create returns an id and registers the session", () => {
    const fakePty = createFakePty();
    const manager = createPtySessionManager({ spawnPty: () => fakePty });

    const sessionId = manager.create({ cwd: "/repo", shell: SHELL, cols: 80, rows: 24 });

    expect(sessionId).toBeTruthy();
    manager.write(sessionId, "ls\n");
    expect(fakePty.writeCalls).toEqual(["ls\n"]);
  });

  it("generates incrementing ids, not random or timestamp ones", () => {
    const manager = createPtySessionManager({ spawnPty: () => createFakePty() });

    const id1 = manager.create({ cwd: "/repo", shell: SHELL, cols: 80, rows: 24 });
    const id2 = manager.create({ cwd: "/repo", shell: SHELL, cols: 80, rows: 24 });

    expect(id2).not.toBe(id1);
    expect(Number(id2)).toBe(Number(id1) + 1);
  });

  it("forwards write and resize to the underlying pty", () => {
    const fakePty = createFakePty();
    const manager = createPtySessionManager({ spawnPty: () => fakePty });
    const sessionId = manager.create({ cwd: "/repo", shell: SHELL, cols: 80, rows: 24 });

    manager.write(sessionId, "echo hi\n");
    manager.resize(sessionId, 100, 30);

    expect(fakePty.writeCalls).toEqual(["echo hi\n"]);
    expect(fakePty.resizeCalls).toEqual([[100, 30]]);
  });

  it("forwards data from the underlying pty to registered callbacks", () => {
    const fakePty = createFakePty();
    const manager = createPtySessionManager({ spawnPty: () => fakePty });
    const sessionId = manager.create({ cwd: "/repo", shell: SHELL, cols: 80, rows: 24 });

    const received: string[] = [];
    manager.onData(sessionId, (data) => received.push(data));
    fakePty.emitData("hello\n");

    expect(received).toEqual(["hello\n"]);
  });

  it("kill disposes the pty and removes it from tracking", () => {
    const fakePty = createFakePty();
    const manager = createPtySessionManager({ spawnPty: () => fakePty });
    const sessionId = manager.create({ cwd: "/repo", shell: SHELL, cols: 80, rows: 24 });

    manager.kill(sessionId);
    expect(fakePty.killCalled).toBe(true);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    manager.write(sessionId, "ls\n");
    expect(warnSpy).toHaveBeenCalled();
    expect(fakePty.writeCalls).toEqual([]);
    warnSpy.mockRestore();
  });

  it("killAll disposes every live pty and clears tracking", () => {
    const ptys = [createFakePty(), createFakePty(), createFakePty()];
    let next = 0;
    const manager = createPtySessionManager({ spawnPty: () => ptys[next++]! });

    const ids = [
      manager.create({ cwd: "/repo", shell: SHELL, cols: 80, rows: 24 }),
      manager.create({ cwd: "/repo", shell: SHELL, cols: 80, rows: 24 }),
      manager.create({ cwd: "/repo", shell: SHELL, cols: 80, rows: 24 }),
    ];

    manager.killAll();

    expect(ptys.every((pty) => pty.killCalled)).toBe(true);

    // Every session is gone: writing to any of them now warns.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const id of ids) {
      manager.write(id, "ls\n");
    }
    expect(warnSpy).toHaveBeenCalledTimes(ids.length);
    warnSpy.mockRestore();
  });

  it("warns and does not throw when killing an unknown session id", () => {
    const manager = createPtySessionManager({ spawnPty: () => createFakePty() });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() => manager.kill("does-not-exist")).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("fires onExit with the exit code and cleans up the session", () => {
    const fakePty = createFakePty();
    const manager = createPtySessionManager({ spawnPty: () => fakePty });
    const sessionId = manager.create({ cwd: "/repo", shell: SHELL, cols: 80, rows: 24 });

    const exitCodes: number[] = [];
    manager.onExit(sessionId, (code) => exitCodes.push(code));
    fakePty.emitExit(0);

    expect(exitCodes).toEqual([0]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    manager.write(sessionId, "ls\n");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
