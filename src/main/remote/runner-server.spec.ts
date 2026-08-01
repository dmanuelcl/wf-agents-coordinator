import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createIpcHandlerRegistry } from "../ipc/ipc-transport";
import { createRemoteRunnerServer, type RemoteRunnerServer } from "./runner-server";

const servers: RemoteRunnerServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function connect(server: RemoteRunnerServer): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port()}/rpc`);
  await once(socket, "open");
  return socket;
}

function nextFrame(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => socket.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
}

describe("remote runner server", () => {
  it("authenticates then relays invokes and terminal events", async () => {
    const transport = createIpcHandlerRegistry();
    transport.handle("projects:list", () => [{ id: "project-1" }]);
    transport.on("terminal:write", (event, id: string, data: string) => {
      event.sender.send("terminal:data", { sessionId: id, data: data.toUpperCase() });
    });
    const server = await createRemoteRunnerServer({ transport, token: "test-secret", port: 0 });
    servers.push(server);
    const socket = await connect(server);

    socket.send(JSON.stringify({ type: "hello", protocol: 1, token: "test-secret" }));
    await expect(nextFrame(socket)).resolves.toEqual({ type: "hello:ok", protocol: 1 });

    socket.send(JSON.stringify({ type: "invoke", id: "1", channel: "projects:list", args: [] }));
    await expect(nextFrame(socket)).resolves.toEqual({ type: "response", id: "1", result: [{ id: "project-1" }] });

    socket.send(JSON.stringify({ type: "emit", channel: "terminal:write", args: ["pty-1", "hello"] }));
    await expect(nextFrame(socket)).resolves.toEqual({
      type: "event",
      channel: "terminal:data",
      payload: { sessionId: "pty-1", data: "HELLO" },
    });
    socket.close();
  });

  it("rejects an unauthenticated client before any handler runs", async () => {
    const transport = createIpcHandlerRegistry();
    transport.handle("projects:list", () => [{ id: "should-not-return" }]);
    const server = await createRemoteRunnerServer({ transport, token: "test-secret", port: 0 });
    servers.push(server);
    const socket = await connect(server);

    socket.send(JSON.stringify({ type: "hello", protocol: 1, token: "wrong" }));
    await expect(nextFrame(socket)).resolves.toEqual({ type: "error", message: "Authentication failed." });
    await once(socket, "close");
  });

  it("serves the browser bundle and health check on the same loopback port", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "agent-coordinator-web-"));
    tempDirs.push(staticDir);
    await writeFile(join(staticDir, "index.html"), "<h1>Coordinator</h1>");
    const server = await createRemoteRunnerServer({
      transport: createIpcHandlerRegistry(),
      token: "test-secret",
      port: 0,
      staticDir,
    });
    servers.push(server);

    await expect(fetch(`http://127.0.0.1:${server.port()}/health`).then((response) => response.json())).resolves.toEqual({
      ok: true,
    });
    await expect(fetch(`http://127.0.0.1:${server.port()}/`).then((response) => response.text())).resolves.toBe(
      "<h1>Coordinator</h1>",
    );
  });
});
