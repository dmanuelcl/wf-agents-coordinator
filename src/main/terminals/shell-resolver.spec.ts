import { describe, expect, it } from "vitest";
import { resolveShell, resolveShellForCommand } from "./shell-resolver";

describe("resolveShell", () => {
  it("resolves the user's shell on darwin", () => {
    const shell = resolveShell({ platform: "darwin", env: { SHELL: "/bin/zsh" } });
    expect(shell).toEqual({ file: "/bin/zsh", args: ["-l"] });
  });

  it("resolves COMSPEC or falls back to powershell on win32", () => {
    const shell = resolveShell({ platform: "win32", env: {} });
    expect(shell).toEqual({ file: "powershell.exe", args: [] });
  });

  it("uses COMSPEC when set on win32", () => {
    const shell = resolveShell({ platform: "win32", env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" } });
    expect(shell).toEqual({ file: "C:\\Windows\\System32\\cmd.exe", args: [] });
  });

  it("falls back to /bin/bash on linux when SHELL is unset", () => {
    const shell = resolveShell({ platform: "linux", env: {} });
    expect(shell).toEqual({ file: "/bin/bash", args: ["-l"] });
  });
});

describe("resolveShellForCommand", () => {
  it("runs the command through a login shell and execs it on POSIX", () => {
    const shell = resolveShellForCommand({
      platform: "darwin",
      env: { SHELL: "/bin/zsh" },
      command: "claude --session-id abc --model opus",
    });
    expect(shell).toEqual({ file: "/bin/zsh", args: ["-lc", "exec claude --session-id abc --model opus"] });
  });

  it("falls back to /bin/bash on linux when SHELL is unset", () => {
    const shell = resolveShellForCommand({ platform: "linux", env: {}, command: "codex --model gpt" });
    expect(shell).toEqual({ file: "/bin/bash", args: ["-lc", "exec codex --model gpt"] });
  });

  it("uses -Command on win32", () => {
    const shell = resolveShellForCommand({ platform: "win32", env: {}, command: "claude --resume abc" });
    expect(shell).toEqual({ file: "powershell.exe", args: ["-Command", "claude --resume abc"] });
  });
});
