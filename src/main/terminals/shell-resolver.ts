export interface ShellSpec {
  file: string;
  args: string[];
}

export function resolveShell(params: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv }): ShellSpec {
  const { platform, env } = params;

  if (platform === "win32") {
    return { file: env["COMSPEC"] ?? "powershell.exe", args: [] };
  }

  return { file: env["SHELL"] ?? "/bin/bash", args: ["-l"] };
}

/**
 * A shell spec that RUNS `command` as the terminal's process rather than opening
 * an interactive prompt. On POSIX we go through a login shell (`-lc`) so the
 * user's PATH is populated — the agent CLI (`claude`, `codex`, …) lives there —
 * and `exec` so the agent replaces the shell: when the agent exits the PTY
 * closes, leaving no orphan shell behind.
 */
export function resolveShellForCommand(params: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  command: string;
}): ShellSpec {
  const { platform, env, command } = params;

  if (platform === "win32") {
    return { file: env["COMSPEC"] ?? "powershell.exe", args: ["-Command", command] };
  }

  return { file: env["SHELL"] ?? "/bin/bash", args: ["-lc", `exec ${command}`] };
}
