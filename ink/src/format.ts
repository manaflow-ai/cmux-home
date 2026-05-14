import type { AgentKind, AgentState, Workspace } from "./types.js";

export const COLORS = {
  muted: "#999999",
  selectedBg: "#373737",
  selectedTitleFg: "#E6E6E6",
  inputFg: "#E6E6E6",
  imageToken: "#569CD6",
  selectionFg: "#F5F5F5",
  selectionBg: "#464646",
  codex: "#66D9EF",
  claude: "#D77757",
  purple: "#AF96FF",
  unread: "#569CD6",
} as const;

export const AGENT_COLOR: Readonly<Record<AgentKind, string>> = {
  codex: COLORS.codex,
  claude: COLORS.claude,
};

export const COMPOSER_PROMPT = "❯ ";
export const COMPOSER_CONTINUATION_PROMPT = "  ";
export const COMPOSER_PLACEHOLDER = "describe a task for a new workspace";

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;
export const SPINNER_INTERVAL_MS = 140;

export const GROUP_DEFINITIONS: ReadonlyArray<{
  readonly state: AgentState;
  readonly label: string;
}> = [
  { state: "needs-attention", label: "Needs input" },
  { state: "working", label: "Working" },
  { state: "idle", label: "Completed" },
];

export function displayGroup(state: AgentState): AgentState {
  switch (state) {
    case "needs-attention":
      return "needs-attention";
    case "working":
      return "working";
    case "idle":
    case "empty":
    case "unknown":
    default:
      return "idle";
  }
}

export function agentState(workspace: Workspace): AgentState {
  if (workspace.unreadNotifications > 0) return "needs-attention";
  let sawStatus = false;
  for (const [key, value] of Object.entries(workspace.statuses)) {
    if (!isAgentKey(key)) continue;
    sawStatus = true;
    const v = value.toLowerCase();
    if (matches(v, ["error", "failed", "failure", "blocked", "denied", "rejected"])) {
      return "needs-attention";
    }
    if (matches(v, ["running", "working", "thinking", "busy"])) {
      return "working";
    }
    if (matches(v, ["idle", "done", "complete", "completed"])) {
      return "idle";
    }
  }
  return sawStatus ? "unknown" : "empty";
}

function isAgentKey(key: string): boolean {
  const k = key.toLowerCase();
  return k === "codex" || k === "claude" || k === "claude_code";
}

function matches(value: string, needles: ReadonlyArray<string>): boolean {
  return needles.some((needle) => value.includes(needle));
}

export function oneLinePreview(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return truncate(collapsed, maxChars);
}

export function truncate(text: string, maxChars: number): string {
  const chars = [...text];
  if (chars.length <= maxChars) return chars.join("");
  if (maxChars <= 1) return "…";
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

export function padEnd(text: string, width: number): string {
  const chars = [...text];
  if (chars.length >= width) return chars.join("");
  return chars.join("") + " ".repeat(width - chars.length);
}

export function timeAgo(timestampMs: number | null): string {
  if (timestampMs === null) return "-";
  const elapsed = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (elapsed < 60) return `${elapsed}s`;
  if (elapsed < 60 * 60) return `${Math.floor(elapsed / 60)}m`;
  if (elapsed < 60 * 60 * 24) return `${Math.floor(elapsed / 60 / 60)}h`;
  return `${Math.floor(elapsed / 60 / 60 / 24)}d`;
}

export function agentLabel(kind: AgentKind, planMode: boolean): string {
  return planMode ? `${kind} plan` : kind;
}
