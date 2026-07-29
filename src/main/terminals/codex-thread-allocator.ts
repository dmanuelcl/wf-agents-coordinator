import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface CodexAppServerProcess {
  send(message: unknown): void;
  onLine(listener: (line: string) => void): void;
  onError(listener: (error: Error) => void): void;
  onExit(listener: (code: number | null, stderr: string | null) => void): void;
  close(): void;
}

export type CodexAppServerProcessFactory = () => CodexAppServerProcess;

export interface CodexThreadAllocator {
  create(params: { cwd: string; model: string }): Promise<string>;
}

function createCodexAppServerProcess(): CodexAppServerProcess {
  const child = spawn("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
  });

  return {
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onLine(listener) {
      lines.on("line", listener);
    },
    onError(listener) {
      child.on("error", listener);
    },
    onExit(listener) {
      child.on("exit", (code) => {
        listener(code, stderr.trim() || null);
      });
    },
    close() {
      lines.close();
      child.kill();
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseError(message: Record<string, unknown>): string | null {
  const error = message.error;
  if (!isRecord(error)) return null;
  return typeof error.message === "string" ? error.message : "unknown app-server error";
}

function threadIdFrom(message: Record<string, unknown>): string | null {
  const result = message.result;
  if (!isRecord(result)) return null;
  const thread = result.thread;
  if (!isRecord(thread)) return null;
  return typeof thread.id === "string" && thread.id.trim() ? thread.id : null;
}

export function createCodexThreadAllocator(params: {
  processFactory?: CodexAppServerProcessFactory;
  timeoutMs?: number;
} = {}): CodexThreadAllocator {
  const processFactory = params.processFactory ?? createCodexAppServerProcess;
  const timeoutMs = params.timeoutMs ?? 15_000;

  return {
    create({ cwd, model }) {
      return new Promise<string>((resolve, reject) => {
        const process = processFactory();
        let settled = false;

        const finish = (result: { threadId: string } | { error: Error }): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          process.close();
          if ("threadId" in result) resolve(result.threadId);
          else reject(result.error);
        };

        const timeout = setTimeout(() => {
          finish({ error: new Error(`Codex app-server did not allocate a thread within ${timeoutMs}ms`) });
        }, timeoutMs);

        process.onLine((line) => {
          let message: unknown;
          try {
            message = JSON.parse(line);
          } catch {
            return;
          }
          if (!isRecord(message) || typeof message.id !== "number") return;
          const error = responseError(message);
          if (error) {
            finish({ error: new Error(`Codex app-server request ${message.id} failed: ${error}`) });
            return;
          }
          if (message.id === 0) {
            process.send({ method: "initialized", params: {} });
            process.send({
              method: "thread/start",
              id: 1,
              params: {
                cwd,
                ...(model.trim() ? { model: model.trim() } : {}),
                serviceName: "agent_coordinator",
              },
            });
            return;
          }
          if (message.id === 1) {
            const threadId = threadIdFrom(message);
            if (!threadId) {
              finish({ error: new Error("Codex app-server thread/start response did not include a thread id") });
              return;
            }
            finish({ threadId });
          }
        });
        process.onError((error) => finish({ error }));
        process.onExit((code, stderr) => {
          if (!settled) {
            const detail = stderr ? `: ${stderr}` : "";
            finish({
              error: new Error(
                `Codex app-server exited before allocating a thread (exit ${code ?? "unknown"})${detail}`,
              ),
            });
          }
        });
        process.send({
          method: "initialize",
          id: 0,
          params: {
            clientInfo: {
              name: "agent_coordinator",
              title: "Agent Coordinator",
              version: "0.1.0",
            },
          },
        });
      });
    },
  };
}
