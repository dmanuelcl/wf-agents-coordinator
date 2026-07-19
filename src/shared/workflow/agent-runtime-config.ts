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
    command: result.command,
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

// kimi [--session <existing-id>] [--model <model>] [--yolo]
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
  const warnings: string[] = [];
  if (config.effort) warnings.push("Kimi Code CLI has no reasoning-effort launch flag; effort ignored.");
  return { command: parts.join(" "), warnings };
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
