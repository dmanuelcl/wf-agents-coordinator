export type AgentKind = "claude" | "codex" | "kimi" | "opencode" | "copilot" | "gemini" | "antigravity";

export interface AgentRuntimeConfig {
  kind: AgentKind;
  model: string;
  effort: string | null;
  dangerous: boolean;
}

export type WorkflowStage = "architect" | "implementer" | "reviewer";

export type ProjectRuntimeConfig = Record<WorkflowStage, AgentRuntimeConfig>;

export const DEFAULT_AGENT_MODELS: Readonly<Record<AgentKind, string>> = {
  claude: "opus",
  codex: "gpt-5.5",
  kimi: "kimi-code/kimi-for-coding",
  opencode: "anthropic/claude-opus-4-8",
  copilot: "",
  gemini: "gemini-2.5-pro",
  antigravity: "",
};

export function createAgentRuntimeConfig(kind: AgentKind = "claude"): AgentRuntimeConfig {
  return {
    kind,
    model: DEFAULT_AGENT_MODELS[kind],
    effort: null,
    dangerous: false,
  };
}

export function createDefaultProjectRuntimeConfig(): ProjectRuntimeConfig {
  return {
    architect: createAgentRuntimeConfig(),
    implementer: createAgentRuntimeConfig(),
    reviewer: createAgentRuntimeConfig(),
  };
}

/** Which agent CLIs accept a per-launch "skip all permission prompts" flag. */
export const DANGEROUS_SUPPORTED: Record<AgentKind, boolean> = {
  claude: true,
  codex: true,
  kimi: true,
  copilot: true,
  gemini: true,
  opencode: false,
  antigravity: false,
};

export interface AgentLaunchCommandResult {
  command: string;
  warnings: string[];
  /** Per-process environment overrides required by this provider. */
  environment?: Readonly<Record<string, string>>;
}

/**
 * A deterministic session directive for an agent launch. Claude accepts an
 * app-minted id for both modes. Kimi mints its own id on a fresh launch, which
 * the renderer captures, and accepts it here on resume. Every other kind
 * relaunches fresh and warns.
 */
export interface AgentSessionLaunch {
  id: string;
  mode: "fresh" | "resume";
}

function model(config: AgentRuntimeConfig): string {
  return config.model.trim();
}

/** Append the "resume is not wired" warning when an unsupported kind is asked to resume/restore. */
function withUnwiredSessionWarning(
  result: AgentLaunchCommandResult,
  kind: AgentKind,
  session: AgentSessionLaunch | undefined,
): AgentLaunchCommandResult {
  if (!session) return result;
  return {
    ...result,
    warnings: [...result.warnings, `${kind} resume is not wired; relaunching fresh`],
  };
}

// claude [--session-id <id> | --resume <id>] --model opus [--effort high]
//        [--dangerously-skip-permissions]
//        (session flag first so restore is deterministic)
function buildClaudeLaunchCommand(
  config: AgentRuntimeConfig,
  session: AgentSessionLaunch | undefined,
): AgentLaunchCommandResult {
  const parts = ["claude"];
  if (session) parts.push(session.mode === "resume" ? "--resume" : "--session-id", session.id);
  if (model(config)) parts.push("--model", model(config));
  if (config.effort) parts.push("--effort", config.effort);
  if (config.dangerous) parts.push("--dangerously-skip-permissions");
  return { command: parts.join(" "), warnings: [] };
}

// codex --model gpt-5.5 -c model_reasoning_effort="high" [--ask-for-approval never --sandbox danger-full-access]
//       -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true
function buildCodexLaunchCommand(config: AgentRuntimeConfig): AgentLaunchCommandResult {
  const parts = ["codex"];
  if (model(config)) parts.push("--model", model(config));
  if (config.effort) parts.push("-c", `model_reasoning_effort="${config.effort}"`);
  if (config.dangerous) parts.push("--ask-for-approval", "never", "--sandbox", "danger-full-access");
  parts.push("-c", 'model_reasoning_summary="detailed"', "-c", "model_supports_reasoning_summaries=true");
  return { command: parts.join(" "), warnings: [] };
}

// KIMI_MODEL_THINKING_EFFORT=<effort> kimi [--session <existing-id>]
//      [--model <model>] [--yolo]
// A fresh launch intentionally omits --session: the current Kimi Code CLI
// generates its own session_<uuid>, which the terminal captures for reopening.
function buildKimiLaunchCommand(
  config: AgentRuntimeConfig,
  session: AgentSessionLaunch | undefined,
): AgentLaunchCommandResult {
  const parts = ["kimi"];
  if (session?.mode === "resume") parts.push("--session", session.id);
  if (model(config)) parts.push("--model", model(config));
  if (config.dangerous) parts.push("--yolo");
  return {
    command: parts.join(" "),
    warnings: [],
    ...(config.effort
      ? { environment: { KIMI_MODEL_THINKING_EFFORT: config.effort } }
      : {}),
  };
}

// copilot [--allow-all]
function buildCopilotLaunchCommand(config: AgentRuntimeConfig): AgentLaunchCommandResult {
  const parts = ["copilot"];
  if (config.dangerous) parts.push("--allow-all");
  const warnings: string[] = [];
  if (model(config)) warnings.push("Copilot has no confirmed model flag; the model field is not applied to the command.");
  if (config.effort) warnings.push("Copilot has no confirmed reasoning-effort flag; effort ignored.");
  return { command: parts.join(" "), warnings };
}

// opencode [--model provider/model]   (no confirmed effort/dangerous flags)
function buildOpencodeLaunchCommand(config: AgentRuntimeConfig): AgentLaunchCommandResult {
  const parts = ["opencode"];
  if (model(config)) parts.push("--model", model(config));
  const warnings: string[] = [];
  if (config.effort) warnings.push("OpenCode has no confirmed reasoning-effort flag; effort ignored.");
  if (config.dangerous) warnings.push("OpenCode has no confirmed permission-bypass flag; dangerous ignored.");
  return { command: parts.join(" "), warnings };
}

// gemini [--model <model>] [--yolo]
function buildGeminiLaunchCommand(config: AgentRuntimeConfig): AgentLaunchCommandResult {
  const parts = ["gemini"];
  if (model(config)) parts.push("--model", model(config));
  if (config.dangerous) parts.push("--yolo");
  const warnings: string[] = [];
  if (config.effort) warnings.push("Gemini has no confirmed reasoning-effort flag; effort ignored.");
  return { command: parts.join(" "), warnings };
}

// agy [--model <model>]
// Antigravity's CLI is not yet verified — the flags here are best-effort. Adjust
// this builder once confirmed against the real binary.
function buildAntigravityLaunchCommand(config: AgentRuntimeConfig): AgentLaunchCommandResult {
  const parts = ["agy"];
  if (model(config)) parts.push("--model", model(config));
  const warnings = ["Antigravity's CLI is unverified — check the launch command against the real binary."];
  if (config.effort) warnings.push("Antigravity has no confirmed reasoning-effort flag; effort ignored.");
  if (config.dangerous) warnings.push("Antigravity has no confirmed permission-bypass flag; dangerous ignored.");
  return { command: parts.join(" "), warnings };
}

/** POSIX single-quote a value so it survives `$SHELL -c "exec <command>"`. */
function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const EXEC_PERMISSION_WARNING =
  "Non-interactive auto-pilot may block on permission prompts; enable Dangerous for this stage to run unattended.";

/**
 * Build the NON-INTERACTIVE command that runs `wfPrompt` in one shot and exits —
 * used by the auto-pilot conductor instead of typing into a live agent. Each
 * kind's headless invocation is verified against its CLI (see docs). Because the
 * command is run through `$SHELL -c "exec <command>"`, the prompt is shell-quoted.
 */
export function buildAgentExecCommand(config: AgentRuntimeConfig, wfPrompt: string): AgentLaunchCommandResult {
  const prompt = shellQuoteSingle(wfPrompt);
  const m = model(config);
  switch (config.kind) {
    // claude -p '<wf>' --model opus [--effort high] [--dangerously-skip-permissions]
    case "claude": {
      const parts = ["claude", "-p", prompt];
      if (m) parts.push("--model", m);
      if (config.effort) parts.push("--effort", config.effort);
      if (config.dangerous) parts.push("--dangerously-skip-permissions");
      return { command: parts.join(" "), warnings: config.dangerous ? [] : [EXEC_PERMISSION_WARNING] };
    }
    // codex exec '<wf>' --model … [-c model_reasoning_effort="high"]
    //   (--sandbox workspace-write runs unattended; dangerous fully bypasses)
    case "codex": {
      const parts = ["codex", "exec", prompt];
      if (m) parts.push("--model", m);
      if (config.effort) parts.push("-c", `model_reasoning_effort="${config.effort}"`);
      parts.push(...(config.dangerous ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", "workspace-write"]));
      return { command: parts.join(" "), warnings: [] };
    }
    // gemini -p '<wf>' --model … [--yolo]
    case "gemini": {
      const parts = ["gemini", "-p", prompt];
      if (m) parts.push("--model", m);
      if (config.dangerous) parts.push("--yolo");
      const warnings: string[] = [];
      if (config.effort) warnings.push("Gemini has no confirmed reasoning-effort flag; effort ignored.");
      if (!config.dangerous) warnings.push(EXEC_PERMISSION_WARNING);
      return { command: parts.join(" "), warnings };
    }
    // kimi -p '<wf>' --model …  (env KIMI_MODEL_THINKING_EFFORT)
    //   -p runs in auto-approve permission mode; --yolo is INCOMPATIBLE with -p.
    case "kimi": {
      const parts = ["kimi", "-p", prompt];
      if (m) parts.push("--model", m);
      return {
        command: parts.join(" "),
        warnings: [],
        ...(config.effort ? { environment: { KIMI_MODEL_THINKING_EFFORT: config.effort } } : {}),
      };
    }
    // copilot -p '<wf>' [--allow-all-tools]  (no confirmed model flag in our config)
    case "copilot": {
      const parts = ["copilot", "-p", prompt];
      if (config.dangerous) parts.push("--allow-all-tools");
      const warnings: string[] = [];
      if (m) warnings.push("Copilot has no confirmed model flag; the model field is not applied to the command.");
      if (config.effort) warnings.push("Copilot has no confirmed reasoning-effort flag; effort ignored.");
      if (!config.dangerous) warnings.push(EXEC_PERMISSION_WARNING);
      return { command: parts.join(" "), warnings };
    }
    // opencode run '<wf>' --model provider/model [--dangerously-skip-permissions]
    case "opencode": {
      const parts = ["opencode", "run", prompt];
      if (m) parts.push("--model", m);
      if (config.dangerous) parts.push("--dangerously-skip-permissions");
      const warnings: string[] = [];
      if (config.effort) warnings.push("OpenCode has no confirmed reasoning-effort flag; effort ignored.");
      if (!config.dangerous) warnings.push(EXEC_PERMISSION_WARNING);
      return { command: parts.join(" "), warnings };
    }
    // agy -p '<wf>' [--model …] — verified prompt form; unattended-approval flag
    // is NOT documented, so this stays best-effort with a loud warning.
    case "antigravity": {
      const parts = ["agy", "-p", prompt];
      if (m) parts.push("--model", m);
      const warnings = [
        "Antigravity's CLI is unverified — confirm the exec command and its unattended-approval flag against the real binary.",
      ];
      if (config.effort) warnings.push("Antigravity has no confirmed reasoning-effort flag; effort ignored.");
      return { command: parts.join(" "), warnings };
    }
  }
}

export function buildAgentLaunchCommand(
  config: AgentRuntimeConfig,
  session?: AgentSessionLaunch,
): AgentLaunchCommandResult {
  switch (config.kind) {
    case "claude":
      return buildClaudeLaunchCommand(config, session);
    case "codex":
      return withUnwiredSessionWarning(buildCodexLaunchCommand(config), config.kind, session);
    case "kimi":
      return buildKimiLaunchCommand(config, session);
    case "opencode":
      return withUnwiredSessionWarning(buildOpencodeLaunchCommand(config), config.kind, session);
    case "copilot":
      return withUnwiredSessionWarning(buildCopilotLaunchCommand(config), config.kind, session);
    case "gemini":
      return withUnwiredSessionWarning(buildGeminiLaunchCommand(config), config.kind, session);
    case "antigravity":
      return withUnwiredSessionWarning(buildAntigravityLaunchCommand(config), config.kind, session);
  }
}
