import type { AgentKind, AgentState, Workspace } from "./types.js";

export const AGENT_STATE_ORDER: ReadonlyArray<AgentState> = [
  "needs-attention",
  "working",
  "idle",
  "empty",
  "unknown",
];

export const AGENT_STATE_LABEL: Readonly<Record<AgentState, string>> = {
  "needs-attention": "needs attention",
  working: "working",
  idle: "idle",
  empty: "empty",
  unknown: "unknown",
};

export const AGENT_STATE_COLOR: Readonly<Record<AgentState, string>> = {
  "needs-attention": "magenta",
  working: "yellow",
  idle: "green",
  empty: "gray",
  unknown: "white",
};

export const AGENT_COLOR: Readonly<Record<AgentKind, string>> = {
  codex: "cyan",
  claude: "redBright",
};

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

export function groupByState(
  workspaces: ReadonlyArray<Workspace>,
): Map<AgentState, Workspace[]> {
  const grouped = new Map<AgentState, Workspace[]>();
  for (const state of AGENT_STATE_ORDER) grouped.set(state, []);
  for (const ws of workspaces) {
    const state = agentState(ws);
    grouped.get(state)!.push(ws);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.index - b.index;
    });
  }
  return grouped;
}

export function oneLinePreview(text: string, maxLen: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLen - 1))}…`;
}

export function agentLabel(kind: AgentKind, planMode: boolean): string {
  return planMode ? `${kind} (plan)` : kind;
}
