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
 * an interactive prompt. On POSIX we use an interactive login shell so both
 * login files and interactive files such as `.zshrc` populate PATH — agent
 * installers commonly add their bin directory there. `exec` then replaces the
 * shell, so the PTY closes when the agent exits instead of leaving an orphan.
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

  return { file: env["SHELL"] ?? "/bin/bash", args: ["-l", "-i", "-c", `exec ${command}`] };
}
