import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { AgentKind } from "../../shared/workflow/agent-runtime-config";

/** The executable each configured agent kind contributes to a terminal. */
export const AGENT_EXECUTABLES: Readonly<Record<AgentKind, string>> = {
  claude: "claude",
  codex: "codex",
  kimi: "kimi",
  opencode: "opencode",
  copilot: "copilot",
  gemini: "gemini",
  antigravity: "agy",
};

export interface AgentExecutableResolution {
  /** Absolute path to the CLI executable. Safe to pass directly to child_process.spawn. */
  executable: string;
  /** PATH to pass to a child terminal so the executable and its runtime are available. */
  path: string;
}

export interface ResolveAgentExecutableOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  checkExecutable?: (path: string) => boolean;
  probeLoginShell?: (params: {
    executable: string;
    environment: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
  }) => AgentExecutableResolution | null;
}

const resolvedExecutables = new Map<AgentKind, AgentExecutableResolution>();

function executableCandidates(executable: string, platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string[] {
  if (platform !== "win32") return [executable];
  if (/\.(?:cmd|exe|bat)$/i.test(executable)) return [executable];
  const extensions = (environment["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  return [executable, ...extensions.map((extension) => `${executable}${extension.toLowerCase()}`)];
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(params: {
  executable: string;
  path: string;
  platform: NodeJS.Platform;
  environment: NodeJS.ProcessEnv;
  checkExecutable: (path: string) => boolean;
}): string | null {
  const separator = params.platform === "win32" ? ";" : delimiter;
  const names = executableCandidates(params.executable, params.platform, params.environment);
  for (const directory of params.path.split(separator)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (params.checkExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Desktop apps launched from Finder do not inherit a user's shell PATH. Ask
 * the login shell for the command location and the complete PATH it set up.
 * The sentinel makes this resilient to harmless shell-startup output.
 */
function defaultProbeLoginShell(params: {
  executable: string;
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): AgentExecutableResolution | null {
  if (params.platform === "win32") return null;

  const shell = params.environment["SHELL"] || userInfo().shell || "/bin/sh";
  const marker = "__AGENT_COORDINATOR_PATH__";
  const command = `command -v ${shellQuote(params.executable)}; printf '\\n${marker}%s\\n' \"$PATH\"`;
  const result = spawnSync(shell, ["-l", "-i", "-c", command], {
    encoding: "utf8",
    env: params.environment,
    timeout: 3_000,
    windowsHide: true,
  });
  if (result.error || result.stdout == null) return null;

  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim());
  let markerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.startsWith(marker)) {
      markerIndex = index;
      break;
    }
  }
  if (markerIndex < 0) return null;

  const path = lines[markerIndex]?.slice(marker.length).trim();
  if (!path) return null;
  for (let index = markerIndex - 1; index >= 0; index -= 1) {
    const candidate = lines[index];
    if (candidate && isAbsolute(candidate) && defaultIsExecutable(candidate)) {
      return { executable: candidate, path };
    }
  }
  return null;
}

function fallbackDirectories(params: {
  platform: NodeJS.Platform;
  homeDirectory: string;
  environment: NodeJS.ProcessEnv;
}): string[] {
  const { platform, homeDirectory, environment } = params;
  if (platform === "win32") {
    const appData = environment["APPDATA"];
    const localAppData = environment["LOCALAPPDATA"];
    return [
      appData ? join(appData, "npm") : "",
      localAppData ? join(localAppData, "pnpm") : "",
    ].filter(Boolean);
  }
  return [
    join(homeDirectory, ".local", "bin"),
    join(homeDirectory, ".cargo", "bin"),
    join(homeDirectory, ".bun", "bin"),
    join(homeDirectory, "Library", "pnpm"),
    join(homeDirectory, ".local", "share", "pnpm"),
    join(homeDirectory, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

function prependDirectory(directory: string, path: string, platform: NodeJS.Platform): string {
  const separator = platform === "win32" ? ";" : delimiter;
  return path.split(separator).includes(directory) ? path : `${directory}${separator}${path}`;
}

/**
 * Finds the CLI selected for an agent role even when Agent Coordinator was
 * launched as a macOS/Windows desktop app with a minimal PATH. The return value
 * includes the shell PATH needed by script-based CLIs such as npm installs.
 */
export function resolveAgentExecutable(
  kind: AgentKind,
  options: ResolveAgentExecutableOptions = {},
): AgentExecutableResolution | null {
  const canUseCache = Object.keys(options).length === 0;
  if (canUseCache) {
    const cached = resolvedExecutables.get(kind);
    if (cached) return cached;
  }

  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const checkExecutable = options.checkExecutable ?? defaultIsExecutable;
  const executable = AGENT_EXECUTABLES[kind];
  const currentPath = environment["PATH"] ?? "";

  const fromCurrentPath = findOnPath({ executable, path: currentPath, platform, environment, checkExecutable });
  if (fromCurrentPath) {
    const resolution = { executable: fromCurrentPath, path: currentPath };
    if (canUseCache) resolvedExecutables.set(kind, resolution);
    return resolution;
  }

  const probeLoginShell = options.probeLoginShell ?? defaultProbeLoginShell;
  const fromLoginShell = probeLoginShell({ executable, environment, platform });
  if (fromLoginShell) {
    if (canUseCache) resolvedExecutables.set(kind, fromLoginShell);
    return fromLoginShell;
  }

  for (const directory of fallbackDirectories({ platform, homeDirectory, environment })) {
    const candidate = findOnPath({ executable, path: directory, platform, environment, checkExecutable });
    if (candidate) {
      const resolution = { executable: candidate, path: prependDirectory(directory, currentPath, platform) };
      if (canUseCache) resolvedExecutables.set(kind, resolution);
      return resolution;
    }
  }

  return null;
}

export function missingAgentExecutableMessage(kind: AgentKind): string {
  const executable = AGENT_EXECUTABLES[kind];
  return `Agent Coordinator could not find the ${executable} CLI for the ${kind} role. Install it, then reopen the app.`;
}
