import { describe, expect, it, vi } from "vitest";
import { createIpcHandlerRegistry, type IpcMessageSender } from "./ipc-transport";

function sender(): IpcMessageSender {
  return { isDestroyed: () => false, send: vi.fn() };
}

describe("createIpcHandlerRegistry", () => {
  it("routes request/response handlers without Electron", async () => {
    const registry = createIpcHandlerRegistry();
    registry.handle("projects:list", async (_event, prefix: string) => `${prefix}-ok`);

    await expect(registry.invoke(sender(), "projects:list", ["remote"])).resolves.toBe("remote-ok");
    expect(registry.hasHandler("projects:list")).toBe(true);
  });

  it("routes terminal-style fire-and-forget events", () => {
    const registry = createIpcHandlerRegistry();
    const write = vi.fn();
    registry.on("terminal:write", (_event, sessionId: string, data: string) => write(sessionId, data));

    registry.emit(sender(), "terminal:write", ["pty-1", "hello"]);

    expect(write).toHaveBeenCalledWith("pty-1", "hello");
    expect(registry.hasListener("terminal:write")).toBe(true);
  });

  it("rejects duplicate channel registration", () => {
    const registry = createIpcHandlerRegistry();
    registry.handle("projects:list", () => []);

    expect(() => registry.handle("projects:list", () => [])).toThrow(/already registered/i);
  });
});
