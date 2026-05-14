export type AgentKind = "codex" | "claude";

export type AgentState = "empty" | "idle" | "working" | "needs-attention" | "unknown";

export interface Workspace {
  id: string;
  ref: string;
  title: string;
  description: string | null;
  pinned: boolean;
  index: number;
  currentDirectory: string;
  statuses: Record<string, string>;
  unreadNotifications: number;
  latestMessage: string;
  updatedAt: number | null;
}

export interface Notification {
  id: string;
  workspaceId: string;
  title: string;
  body: string;
  subtitle: string | null;
  isRead: boolean;
  createdAt: string;
  surfaceId: string | null;
}

export interface EventFrame {
  name: string;
  category?: string | null;
  seq?: number;
  params?: Record<string, unknown>;
}
