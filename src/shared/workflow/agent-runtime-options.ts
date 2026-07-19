import type { AgentKind } from "./agent-runtime-config";

export interface AgentRuntimeOptionCatalog {
  /** Suggested values only: model aliases can be user/provider configured. */
  modelSuggestions: readonly string[];
  modelSupported: boolean;
  /** Empty means that the CLI has no supported effort launch option. */
  effortOptions: readonly string[];
}

/**
 * Provider-aware launch options exposed by the project editor. Models remain
 * editable because several CLIs accept custom aliases and OpenCode's catalog is
 * built from the user's configured providers. Effort is closed because the
 * launchers only accept the values listed by their respective CLIs.
 */
export const AGENT_RUNTIME_OPTION_CATALOG: Readonly<Record<AgentKind, AgentRuntimeOptionCatalog>> = {
  claude: {
    modelSuggestions: ["opus", "sonnet", "haiku", "fable"],
    modelSupported: true,
    effortOptions: ["low", "medium", "high", "xhigh", "max"],
  },
  codex: {
    modelSuggestions: ["gpt-5.5"],
    modelSupported: true,
    effortOptions: ["none", "low", "medium", "high", "xhigh"],
  },
  kimi: {
    modelSuggestions: ["kimi-code/kimi-for-coding"],
    modelSupported: true,
    effortOptions: [],
  },
  opencode: {
    modelSuggestions: ["anthropic/claude-opus-4-8"],
    modelSupported: true,
    effortOptions: [],
  },
  copilot: {
    modelSuggestions: [],
    modelSupported: false,
    effortOptions: [],
  },
  gemini: {
    modelSuggestions: [
      "auto",
      "gemini-3-pro-preview",
      "gemini-3-flash-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ],
    modelSupported: true,
    effortOptions: [],
  },
  antigravity: {
    modelSuggestions: [],
    modelSupported: true,
    effortOptions: [],
  },
};
