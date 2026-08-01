import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIpcHandlerRegistry } from "../main/ipc/ipc-transport";
import { createRemoteRunnerServer, type RemoteRunnerServer } from "../main/remote/runner-server";
import { createRemoteIpcClient } from "./remote-ipc-client";

const servers: RemoteRunnerServer[] = [];

beforeEach(() => {
  vi.stubGlobal("WebSocket", WebSocket);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("createRemoteIpcClient", () => {
  it("does not resolve its connection gate until the runner accepts the token", async () => {
    const transport = createIpcHandlerRegistry();
    transport.handle("projects:list", () => [{ id: "remote-project" }]);
    const server = await createRemoteRunnerServer({ transport, token: "correct-token", port: 0 });
    servers.push(server);
    const client = createRemoteIpcClient({
      url: `ws://127.0.0.1:${server.port()}/rpc`,
      token: "correct-token",
    });

    await expect(client.connect()).resolves.toBeUndefined();
    await expect(client.invoke("projects:list")).resolves.toEqual([{ id: "remote-project" }]);
  });

  it("rejects an invalid token before any Coordinator API can be invoked", async () => {
    const transport = createIpcHandlerRegistry();
    transport.handle("projects:list", () => [{ id: "must-stay-private" }]);
    const server = await createRemoteRunnerServer({ transport, token: "correct-token", port: 0 });
    servers.push(server);
    const client = createRemoteIpcClient({
      url: `ws://127.0.0.1:${server.port()}/rpc`,
      token: "wrong-token",
    });

    await expect(client.connect()).rejects.toThrow(/authentication failed/i);
    await expect(client.invoke("projects:list")).rejects.toThrow(/authentication failed/i);
  });
});
