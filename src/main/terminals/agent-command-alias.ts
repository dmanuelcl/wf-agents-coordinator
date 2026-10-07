import { execFile } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { basename } from "node:path";

/**
 * A custom agent command such as `claude-biz` is usually a shell ALIAS
 * (`alias claude-biz="CLAUDE_CONFIG_DIR=~/.claude-biz command claude"`). The
 * terminal runs agents as `$SHELL -l -i -c "exec <command>"`, and `exec` does
 * not expand aliases, so the coordinator reads the alias from the user's
 * login shell and runs what it stands for: the program, its leading arguments
 * and the environment assignments in front of it.
 */
export interface AgentCommandInvocation {
  /** Program to run (a bare name looked up on PATH, or a path). */
  executable: string;
  /** Arguments the alias puts before any launch flag. */
  args: string[];
  /** `NAME=value` assignments the alias makes for the program. */
  environment: Record<string, string>;
}

/**
 * POSIX-ish word splitting for one alias body: single/double quotes and
 * backslash escapes. Null for anything that is more than one simple command
 * (pipes, lists, substitutions…) — those cannot be reduced to a program.
 */
export function splitShellWords(input: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (char === "'") {
      const end = input.indexOf("'", index + 1);
      if (end < 0) return null;
      current += input.slice(index + 1, end);
      inWord = true;
      index = end;
    } else if (char === '"') {
      let end = index + 1;
      let quoted = "";
      while (end < input.length && input[end] !== '"') {
        if (input[end] === "$" || input[end] === "`") return null;
        if (input[end] === "\\" && end + 1 < input.length) end += 1;
        quoted += input[end];
        end += 1;
      }
      if (end >= input.length) return null;
      current += quoted;
      inWord = true;
      index = end;
    } else if (char === "\\") {
      if (index + 1 >= input.length) return null;
      current += input[index + 1];
      inWord = true;
      index += 1;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else if (/[;&|<>()`]/.test(char) || (char === "$" && input[index + 1] === "(")) {
      return null;
    } else {
      current += char;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

function expandHome(value: string, homeDirectory: string): string {
  if (value === "~" || value.startsWith("~/")) return homeDirectory + value.slice(1);
  if (value === "$HOME" || value.startsWith("$HOME/")) return homeDirectory + value.slice("$HOME".length);
  if (value === "${HOME}" || value.startsWith("${HOME}/")) return homeDirectory + value.slice("${HOME}".length);
  return value;
}

/** What an alias body runs, or null when it is not a single simple command. */
export function parseAliasBody(body: string, homeDirectory: string = homedir()): AgentCommandInvocation | null {
  const words = splitShellWords(body);
  if (!words) return null;
  const environment: Record<string, string> = {};
  let index = 0;
  const takeAssignments = (): void => {
    for (; index < words.length; index += 1) {
      const match = ASSIGNMENT.exec(words[index]!);
      if (!match) return;
      environment[match[1]!] = expandHome(match[2]!, homeDirectory);
    }
  };
  takeAssignments();
  // `command claude`, `exec claude`, `env X=1 claude` all run the same program.
  while (words[index] === "command" || words[index] === "exec" || words[index] === "builtin" || words[index] === "env") {
    index += 1;
    takeAssignments();
  }
  const executable = words[index];
  if (!executable || executable.startsWith("-")) return null;
  return { executable: expandHome(executable, homeDirectory), args: words.slice(index + 1), environment };
}

/**
 * Aliases from `alias` output: zsh prints `name=value`, bash `alias name='value'`.
 * Lines that are not a definition (shell start-up noise) are skipped.
 */
export function parseAliasListing(output: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
    const match = /^(?:alias\s+)?([A-Za-z0-9_.:+@-]+)=(.*)$/.exec(line);
    if (!match) continue;
    const value = splitShellWords(match[2]!);
    if (!value || value.length !== 1) continue;
    aliases.set(match[1]!, value[0]!);
  }
  return aliases;
}

/** Whether an invocation runs Claude Code (so the claude launch flags apply). */
export function invokesClaude(invocation: AgentCommandInvocation): boolean {
  return basename(invocation.executable) === "claude";
}

/** The alias map, or null when the shell could not be read. */
export type ReadShellAliases = () => Promise<Map<string, string> | null>;

/** The user's aliases as their interactive login shell defines them. */
export function readLoginShellAliases(environment: NodeJS.ProcessEnv = process.env): Promise<Map<string, string> | null> {
  if (process.platform === "win32") return Promise.resolve(new Map());
  const shell = environment["SHELL"] || userInfo().shell || "/bin/sh";
  const marker = "__AGENT_COORDINATOR_ALIASES__";
  return new Promise((resolve) => {
    // Async: a cold login shell takes ~1s and must not block the main process.
    execFile(
      shell,
      ["-l", "-i", "-c", `printf '\\n${marker}\\n'; alias`],
      { encoding: "utf8", env: environment, timeout: 5_000, windowsHide: true },
      (error, stdout) => {
        const start = stdout?.lastIndexOf(marker) ?? -1;
        if (error || start < 0) {
          resolve(null);
          return;
        }
        resolve(parseAliasListing(stdout.slice(start + marker.length)));
      },
    );
  });
}

let cachedAliases: Promise<Map<string, string> | null> | null = null;

/**
 * The login shell's aliases, read once per app run (like the executables in
 * agent-executable-resolver; a new alias needs an app restart). A failed read
 * is NOT kept: the next call probes the shell again.
 */
export function readCachedShellAliases(): Promise<Map<string, string> | null> {
  if (!cachedAliases) {
    const read = readLoginShellAliases();
    cachedAliases = read;
    void read.then((aliases) => {
      if (!aliases && cachedAliases === read) cachedAliases = null;
    });
  }
  return cachedAliases;
}

/**
 * The commands the agent selector can offer as "Claude": every alias that runs
 * `claude` under another name (claude-biz, claude-dm…), sorted.
 */
export async function listClaudeCommands(readAliases: ReadShellAliases = readCachedShellAliases): Promise<string[]> {
  const names: string[] = [];
  for (const [name, body] of (await readAliases()) ?? []) {
    if (name === "claude") continue;
    const invocation = parseAliasBody(body);
    if (invocation && invokesClaude(invocation)) names.push(name);
  }
  return names.sort();
}

/** What the alias `name` runs; null when there is no such (parseable) alias. */
export async function resolveCustomCommand(
  name: string,
  readAliases: ReadShellAliases = readCachedShellAliases,
): Promise<AgentCommandInvocation | null> {
  const body = (await readAliases())?.get(name);
  return body === undefined ? null : parseAliasBody(body);
}
