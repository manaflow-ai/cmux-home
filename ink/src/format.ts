import stringWidth from "string-width";
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

export function oneLinePreview(text: string, maxWidth: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return truncate(collapsed, maxWidth);
}

/**
 * Truncate `text` so its terminal display width does not exceed `maxWidth`.
 * Adds an ellipsis when truncation happens.
 */
export function truncate(text: string, maxWidth: number): string {
  if (cellWidth(text) <= maxWidth) return text;
  if (maxWidth <= 1) return "…";
  const ellipsisWidth = cellWidth("…");
  const target = Math.max(0, maxWidth - ellipsisWidth);
  let acc = "";
  let width = 0;
  for (const ch of text) {
    const w = cellWidth(ch);
    if (width + w > target) break;
    acc += ch;
    width += w;
  }
  return `${acc}…`;
}

/** Pad `text` with spaces on the right so its display width equals `width`. */
export function padEnd(text: string, width: number): string {
  const w = cellWidth(text);
  if (w >= width) return text;
  return text + " ".repeat(width - w);
}

/** Display width of `text` in terminal cells (handles wide unicode). */
export function cellWidth(text: string): number {
  return stringWidth(text);
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
