import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { extname, normalize, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  REMOTE_PROTOCOL_VERSION,
  parseRemoteFrameJson,
  type RemoteServerFrame,
} from "../../shared/remote/protocol";
import type { IpcHandlerRegistry, IpcMessageSender } from "../ipc/ipc-transport";

export interface RemoteRunnerServer {
  port(): number;
  broadcast(channel: string, payload: unknown): void;
  close(): Promise<void>;
}

export interface CreateRemoteRunnerServerOptions {
  transport: IpcHandlerRegistry;
  token: string;
  host?: string;
  port?: number;
  staticDir?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStaticFile(params: {
  staticDir: string | undefined;
  url: string | undefined;
  method: string | undefined;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string | Buffer): void;
}): Promise<void> {
  const { staticDir, url, method, writeHead, end } = params;
  if (url === "/health") {
    writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    end(method === "HEAD" ? undefined : JSON.stringify({ ok: true }));
    return;
  }
  if (!staticDir || (method !== "GET" && method !== "HEAD")) {
    writeHead(404);
    end();
    return;
  }
  const pathname = new URL(url ?? "/", "http://runner.invalid").pathname;
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const root = resolve(staticDir);
  const candidate = resolve(root, normalize(requested));
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    writeHead(403);
    end();
    return;
  }
  try {
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error("Not a file");
    const body = method === "HEAD" ? undefined : await readFile(candidate);
    writeHead(200, {
      "content-type": CONTENT_TYPES[extname(candidate)] ?? "application/octet-stream",
      "cache-control": extname(candidate) === ".html" ? "no-store" : "public, max-age=31536000, immutable",
    });
    end(body);
  } catch {
    // Client-side routing is intentionally not used today; a missing file is a
    // real 404 rather than silently returning the app shell.
    writeHead(404);
    end();
  }
}

function tokenMatches(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serialize(frame: RemoteServerFrame): string {
  return JSON.stringify(frame);
}

/**
 * Owns the private WebSocket endpoint of a headless Coordinator runner. It is
 * deliberately loopback-friendly: Tailscale Serve supplies TLS and identity at
 * the network boundary, while this token protects the application protocol.
 */
export async function createRemoteRunnerServer(
  options: CreateRemoteRunnerServerOptions,
): Promise<RemoteRunnerServer> {
  if (!options.token.trim()) throw new Error("AGENT_COORDINATOR_REMOTE_TOKEN must not be empty.");

  const clients = new Set<WebSocket>();
  const httpServer = createServer((request, response) => {
    void serveStaticFile({
      staticDir: options.staticDir,
      url: request.url,
      method: request.method,
      writeHead: (status, headers) => response.writeHead(status, headers),
      end: (body) => response.end(body),
    });
  });
  const server = new WebSocketServer({
    server: httpServer,
    path: "/rpc",
    maxPayload: 1024 * 1024,
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 4765, options.host ?? "127.0.0.1");
  });

  // Keep an otherwise idle WebSocket alive through reverse proxies such as
  // Cloudflare Tunnel. Browser WebSockets answer protocol pings automatically;
  // this is transport liveness only and never changes Coordinator state.
  const heartbeat = setInterval(() => {
    for (const socket of clients) {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }, 25_000);

  function send(socket: WebSocket, frame: RemoteServerFrame): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(serialize(frame));
  }

  server.on("connection", (socket) => {
    let authenticated = false;
    const authenticationTimeout = setTimeout(() => {
      if (!authenticated) socket.close(4001, "Authentication required");
    }, 5_000);

    const sender: IpcMessageSender = {
      isDestroyed: () => socket.readyState !== WebSocket.OPEN,
      send(channel, payload) {
        send(socket, { type: "event", channel, payload });
      },
    };

    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        send(socket, { type: "error", message: "Binary frames are not supported." });
        socket.close(4002, "Invalid frame");
        return;
      }
      const frame = parseRemoteFrameJson(raw.toString());
      if (!frame) {
        send(socket, { type: "error", message: "Invalid protocol frame." });
        socket.close(4002, "Invalid frame");
        return;
      }

      if (!authenticated) {
        if (frame.type !== "hello" || !tokenMatches(options.token, frame.token)) {
          send(socket, { type: "error", message: "Authentication failed." });
          socket.close(4001, "Authentication failed");
          return;
        }
        authenticated = true;
        clearTimeout(authenticationTimeout);
        clients.add(socket);
        send(socket, { type: "hello:ok", protocol: REMOTE_PROTOCOL_VERSION });
        return;
      }

      if (frame.type === "hello") {
        send(socket, { type: "error", message: "Already authenticated." });
        return;
      }
      if (frame.type === "invoke") {
        void options.transport
          .invoke(sender, frame.channel, frame.args)
          .then((result) => send(socket, { type: "response", id: frame.id, result }))
          .catch((error: unknown) =>
            send(socket, { type: "response", id: frame.id, error: { message: errorMessage(error) } }),
          );
        return;
      }
      try {
        options.transport.emit(sender, frame.channel, frame.args);
      } catch (error) {
        send(socket, { type: "error", message: errorMessage(error) });
      }
    });

    socket.on("close", () => {
      clearTimeout(authenticationTimeout);
      clients.delete(socket);
    });
  });

  return {
    port: () => (httpServer.address() as AddressInfo).port,
    broadcast(channel, payload) {
      for (const socket of clients) send(socket, { type: "event", channel, payload });
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(heartbeat);
        for (const socket of clients) socket.close(1001, "Runner stopping");
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          httpServer.close((httpError) => (httpError ? reject(httpError) : resolve()));
        });
      }),
  };
}
