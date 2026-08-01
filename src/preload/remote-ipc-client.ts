import type { RemoteServerFrame } from "../shared/remote/protocol";
import type { CoordinatorClientTransport } from "./agent-coordinator-api";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function errorOf(value: unknown): Error {
  return new Error(typeof value === "string" ? value : String(value));
}

/** Browser-compatible WebSocket implementation of the Coordinator IPC shape. */
export function createRemoteIpcClient(params: { url: string; token: string }): CoordinatorClientTransport {
  const subscriptions = new Map<string, Set<(payload: unknown) => void>>();
  const pending = new Map<string, PendingRequest>();
  let socket: WebSocket | null = null;
  let ready: Promise<void> | null = null;
  let requestCounter = 0;
  let fatalError: Error | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function dispatch(channel: string, payload: unknown): void {
    for (const callback of subscriptions.get(channel) ?? []) callback(payload);
  }

  function rejectPending(error: Error): void {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  function scheduleReconnect(): void {
    if (fatalError || reconnectTimer || subscriptions.size === 0) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void ensureConnected().catch(() => {});
    }, 750);
  }

  function ensureConnected(): Promise<void> {
    if (fatalError) return Promise.reject(fatalError);
    if (socket?.readyState === WebSocket.OPEN && ready) return ready;
    if (ready) return ready;

    ready = new Promise<void>((resolve, reject) => {
      let authenticated = false;
      const candidate = new WebSocket(params.url);
      socket = candidate;
      const timeout = setTimeout(() => {
        if (!authenticated) candidate.close();
        reject(new Error("Timed out connecting to the remote Coordinator runner."));
      }, 10_000);

      candidate.addEventListener("open", () => {
        candidate.send(JSON.stringify({ type: "hello", protocol: 1, token: params.token }));
      });
      candidate.addEventListener("message", (event) => {
        let frame: RemoteServerFrame;
        try {
          frame = JSON.parse(String(event.data)) as RemoteServerFrame;
        } catch {
          candidate.close();
          return;
        }
        if (frame.type === "hello:ok") {
          authenticated = true;
          clearTimeout(timeout);
          resolve();
          return;
        }
        if (frame.type === "response") {
          const request = pending.get(frame.id);
          if (!request) return;
          pending.delete(frame.id);
          if (frame.error) request.reject(errorOf(frame.error.message));
          else request.resolve(frame.result);
          return;
        }
        if (frame.type === "event") {
          dispatch(frame.channel, frame.payload);
          return;
        }
        if (frame.type === "error" && !authenticated) {
          fatalError = errorOf(frame.message);
          clearTimeout(timeout);
          reject(fatalError);
        }
      });
      candidate.addEventListener("error", () => {
        if (!authenticated) reject(new Error("Could not connect to the remote Coordinator runner."));
      });
      candidate.addEventListener("close", () => {
        clearTimeout(timeout);
        if (socket === candidate) socket = null;
        if (!authenticated) reject(new Error("Remote Coordinator connection closed before authentication."));
        ready = null;
        rejectPending(new Error("Remote Coordinator connection closed; reconnecting."));
        scheduleReconnect();
      });
    });
    return ready;
  }

  async function send(frame: unknown): Promise<void> {
    await ensureConnected();
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Remote Coordinator is not connected.");
    socket.send(JSON.stringify(frame));
  }

  return {
    async invoke(channel, ...args) {
      const id = `${Date.now()}-${++requestCounter}`;
      const response = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
      try {
        await send({ type: "invoke", id, channel, args });
      } catch (error) {
        pending.delete(id);
        throw error;
      }
      return response;
    },
    emit(channel, ...args) {
      void send({ type: "emit", channel, args }).catch((error: unknown) => {
        console.warn("Could not send remote Coordinator event:", error);
      });
    },
    on(channel, callback) {
      let callbacks = subscriptions.get(channel);
      if (!callbacks) {
        callbacks = new Set();
        subscriptions.set(channel, callbacks);
      }
      callbacks.add(callback);
      void ensureConnected().catch(() => {});
      return () => {
        const current = subscriptions.get(channel);
        current?.delete(callback);
        if (current?.size === 0) subscriptions.delete(channel);
      };
    },
  };
}
