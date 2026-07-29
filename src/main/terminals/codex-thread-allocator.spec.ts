import { describe, expect, it } from "vitest";
import {
  createCodexThreadAllocator,
  type CodexAppServerProcess,
  type CodexAppServerProcessFactory,
} from "./codex-thread-allocator";

class FakeCodexProcess implements CodexAppServerProcess {
  readonly sent: unknown[] = [];
  closed = false;
  private lineListener: ((line: string) => void) | null = null;
  private errorListener: ((error: Error) => void) | null = null;
  private exitListener: ((code: number | null, stderr: string | null) => void) | null = null;

  send(message: unknown): void {
    this.sent.push(message);
  }

  onLine(listener: (line: string) => void): void {
    this.lineListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  onExit(listener: (code: number | null, stderr: string | null) => void): void {
    this.exitListener = listener;
  }

  close(): void {
    this.closed = true;
  }

  emit(message: unknown): void {
    this.lineListener?.(JSON.stringify(message));
  }

  fail(error: Error): void {
    this.errorListener?.(error);
  }

  exit(code: number | null, stderr: string | null = null): void {
    this.exitListener?.(code, stderr);
  }
}

describe("createCodexThreadAllocator", () => {
  it("initializes app-server, starts a durable thread, and returns its exact id", async () => {
    const process = new FakeCodexProcess();
    const processFactory: CodexAppServerProcessFactory = () => process;
    const allocator = createCodexThreadAllocator({ processFactory, timeoutMs: 5_000 });

    const pending = allocator.create({
      cwd: "/repo/.worktrees/feature",
      model: "gpt-5.5",
    });

    expect(process.sent[0]).toMatchObject({ method: "initialize", id: 0 });
    process.emit({ id: 0, result: { userAgent: "codex" } });
    expect(process.sent[1]).toEqual({ method: "initialized", params: {} });
    expect(process.sent[2]).toEqual({
      method: "thread/start",
      id: 1,
      params: {
        cwd: "/repo/.worktrees/feature",
        model: "gpt-5.5",
        serviceName: "agent_coordinator",
      },
    });

    process.emit({ id: 1, result: { thread: { id: "019facaa-8c67-7722-911a-fc32220232c0" } } });
    await expect(pending).resolves.toBe("019facaa-8c67-7722-911a-fc32220232c0");
    expect(process.closed).toBe(true);
  });

  it("rejects an app-server response that does not contain a thread id", async () => {
    const process = new FakeCodexProcess();
    const allocator = createCodexThreadAllocator({ processFactory: () => process, timeoutMs: 5_000 });
    const pending = allocator.create({ cwd: "/repo", model: "" });

    process.emit({ id: 0, result: {} });
    process.emit({ id: 1, result: { thread: {} } });

    await expect(pending).rejects.toThrow(/thread id/i);
    expect(process.closed).toBe(true);
  });

  it("includes app-server stderr when allocation exits early", async () => {
    const process = new FakeCodexProcess();
    const allocator = createCodexThreadAllocator({ processFactory: () => process, timeoutMs: 5_000 });
    const pending = allocator.create({ cwd: "/repo", model: "" });

    process.exit(1, "authentication unavailable");

    await expect(pending).rejects.toThrow(/authentication unavailable/);
    expect(process.closed).toBe(true);
  });
});
