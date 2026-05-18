import type { AgentKind } from "./types.js";

export interface AgentCommandConfig {
  readonly codex: string;
  readonly codexPlan: string;
  readonly claude: string;
  readonly claudePlan: string;
}

export function defaultAgentCommands(): AgentCommandConfig {
  return {
    codex:
      process.env.CMUX_AGENT_TUI_CODEX_COMMAND ??
      "codex",
    codexPlan:
      process.env.CMUX_AGENT_TUI_CODEX_PLAN_COMMAND ??
      "codex",
    claude:
      process.env.CMUX_AGENT_TUI_CLAUDE_COMMAND ??
      "claude",
    claudePlan:
      process.env.CMUX_AGENT_TUI_CLAUDE_PLAN_COMMAND ??
      "claude --permission-mode plan",
  };
}

export function renderInitialCommand(
  agent: AgentKind,
  planMode: boolean,
  config: AgentCommandConfig,
  prompt: string,
): string {
  const base =
    agent === "codex"
      ? planMode
        ? config.codexPlan
        : config.codex
      : planMode
        ? config.claudePlan
        : config.claude;
  if (!prompt) return base;
  return `${base} ${shellQuote(prompt)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
