import { createConnection, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import type { EventFrame, Notification, Workspace } from "./types.js";

export interface CmuxClientOptions {
  readonly socketPath: string;
  readonly password?: string;
}

export function defaultSocketPath(): string {
  return (
    process.env.CMUX_SOCKET_PATH ??
    process.env.CMUX_SOCKET ??
    "/tmp/cmux.sock"
  );
}

let rpcCounter = 0;
const nextRpcId = (method: string): string =>
  `cmux-home-${process.pid}-${Date.now().toString(36)}-${(rpcCounter++).toString(36)}-${method}`;

interface RawResponse {
  ok?: boolean;
  result?: unknown;
  error?: { message?: string } | string;
}

export class CmuxClient {
  constructor(private readonly options: CmuxClientOptions) {}

  async rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const request = JSON.stringify({ id: nextRpcId(method), method, params });
    const response = await sendOneLine(this.options.socketPath, request, 5_000);
    let parsed: RawResponse;
    try {
      parsed = JSON.parse(response.trim()) as RawResponse;
    } catch (err) {
      throw new Error(`cmux ${method} returned invalid JSON: ${response.slice(0, 200)}`);
    }
    if (parsed.ok !== true) {
      const message =
        typeof parsed.error === "string"
          ? parsed.error
          : parsed.error?.message ?? JSON.stringify(parsed);
      throw new Error(`cmux ${method} failed: ${message}`);
    }
    return parsed.result;
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const result = (await this.rpc("workspace.list", {})) as
      | { workspaces?: unknown }
      | undefined;
    const raw = Array.isArray(result?.workspaces) ? result!.workspaces : [];
    return raw.map(coerceWorkspace).filter((w): w is Workspace => w !== null);
  }

  async listNotifications(): Promise<Notification[]> {
    const result = (await this.rpc("notification.list", {})) as
      | { notifications?: unknown }
      | undefined;
    const raw = Array.isArray(result?.notifications) ? result!.notifications : [];
    return raw.map(coerceNotification).filter((n): n is Notification => n !== null);
  }

  async createWorkspace(input: {
    title: string;
    description?: string;
    initialCommand: string;
    cwd: string;
    focus: boolean;
  }): Promise<string> {
    const result = (await this.rpc("workspace.create", {
      title: input.title,
      description: input.description ?? "",
      initial_command: input.initialCommand,
      cwd: input.cwd,
      focus: input.focus,
    })) as { workspace_id?: unknown } | undefined;
    const id = typeof result?.workspace_id === "string" ? result.workspace_id : "";
    if (!id) throw new Error("workspace.create did not return workspace_id");
    return id;
  }

  async createBrowserPane(input: {
    workspaceId: string;
    url: string;
    direction?: "right" | "left" | "up" | "down";
    focus?: boolean;
  }): Promise<{ paneRef: string; surfaceRef: string } | null> {
    const result = (await this.rpc("pane.create", {
      workspace_id: input.workspaceId,
      type: "browser",
      direction: input.direction ?? "right",
      url: input.url,
      focus: input.focus ?? false,
    })) as { pane_ref?: string; surface_ref?: string } | undefined;
    if (!result?.pane_ref || !result?.surface_ref) return null;
    return { paneRef: result.pane_ref, surfaceRef: result.surface_ref };
  }

  async createTerminalPane(input: {
    workspaceId: string;
    direction?: "right" | "left" | "up" | "down";
    focus?: boolean;
  }): Promise<{ paneRef: string; surfaceRef: string } | null> {
    const result = (await this.rpc("pane.create", {
      workspace_id: input.workspaceId,
      type: "terminal",
      direction: input.direction ?? "right",
      focus: input.focus ?? false,
    })) as { pane_ref?: string; surface_ref?: string } | undefined;
    if (!result?.pane_ref || !result?.surface_ref) return null;
    return { paneRef: result.pane_ref, surfaceRef: result.surface_ref };
  }

  async splitSurface(input: {
    workspaceId: string;
    surfaceRef: string;
    direction: "left" | "right" | "up" | "down";
    type?: "terminal" | "browser";
    url?: string;
    focus?: boolean;
  }): Promise<{ paneRef: string; surfaceRef: string } | null> {
    const result = (await this.rpc("surface.split", {
      workspace_id: input.workspaceId,
      surface: input.surfaceRef,
      direction: input.direction,
      type: input.type ?? "terminal",
      url: input.url,
      focus: input.focus ?? false,
    })) as { pane_ref?: string; surface_ref?: string } | undefined;
    if (!result?.pane_ref || !result?.surface_ref) return null;
    return { paneRef: result.pane_ref, surfaceRef: result.surface_ref };
  }

  async sendText(surfaceRef: string, text: string): Promise<void> {
    await this.rpc("surface.send_text", { surface: surfaceRef, text });
  }

  async submitPrompt(workspaceId: string, message: string): Promise<void> {
    await this.rpc("workspace.prompt_submit", {
      workspace_id: workspaceId,
      message,
    });
  }

  streamEvents(): CmuxEventStream {
    return new CmuxEventStream(this.options.socketPath);
  }
}

type EventStreamMap = {
  event: EventFrame;
  error: Error;
  open: void;
};

export class CmuxEventStream {
  private socket: Socket | null = null;
  private buffer = "";
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly emitter = new EventEmitter();

  constructor(private readonly socketPath: string) {
    this.connect();
  }

  on<K extends keyof EventStreamMap>(
    event: K,
    listener: EventStreamMap[K] extends void
      ? () => void
      : (payload: EventStreamMap[K]) => void,
  ): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  private emit<K extends keyof EventStreamMap>(
    event: K,
    payload?: EventStreamMap[K] extends void ? undefined : EventStreamMap[K],
  ): void {
    this.emitter.emit(event, payload);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.destroy();
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1_000);
  }

  private connect(): void {
    if (this.closed) return;
    const socket = createConnection({ path: this.socketPath });
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      const request = JSON.stringify({
        id: nextRpcId("events.stream"),
        method: "events.stream",
        params: { reconnect: true, heartbeat: true },
      });
      socket.write(`${request}\n`);
      this.emit("open");
    });
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const frame = JSON.parse(line) as RawEventFrame;
          const normalized = normalizeEventFrame(frame);
          if (normalized) this.emit("event", normalized);
        } catch (err) {
          this.emit("error", new Error(`events.stream parse error: ${(err as Error).message}`));
        }
      }
    });
    socket.on("error", (err: Error) => {
      this.emit("error", err);
    });
    socket.on("close", () => {
      this.socket = null;
      this.scheduleReconnect();
    });
  }
}

interface RawEventFrame {
  event?: string;
  name?: string;
  category?: string | null;
  seq?: number;
  params?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

function normalizeEventFrame(frame: RawEventFrame): EventFrame | null {
  const name = frame.name ?? frame.event ?? null;
  if (!name) return null;
  return {
    name,
    category: frame.category ?? null,
    seq: frame.seq,
    params: frame.params ?? frame.data ?? {},
  };
}

function sendOneLine(
  socketPath: string,
  line: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let received = "";
    let settled = false;

    const finish = (err?: Error, data?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve(data ?? "");
    };

    const timer = setTimeout(() => {
      finish(new Error(`cmux socket timed out after ${timeoutMs}ms (${socketPath})`));
    }, timeoutMs);

    socket.once("connect", () => {
      socket.write(`${line}\n`);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
      const newline = received.indexOf("\n");
      if (newline >= 0) finish(undefined, received.slice(0, newline));
    });
    socket.on("error", (err: Error) => finish(err));
    socket.on("close", () => {
      if (!settled) {
        if (received) finish(undefined, received);
        else finish(new Error(`cmux socket closed without response (${socketPath})`));
      }
    });
  });
}

function coerceWorkspace(raw: unknown): Workspace | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : "";
  if (!id) return null;
  const description = typeof obj.description === "string" ? obj.description : null;
  return {
    id,
    ref: typeof obj.ref === "string" ? obj.ref : id,
    title: typeof obj.title === "string" && obj.title
      ? obj.title
      : description ?? id,
    description,
    pinned: obj.pinned === true,
    index: typeof obj.index === "number" ? obj.index : 0,
    currentDirectory:
      typeof obj.current_directory === "string" ? obj.current_directory : "",
    statuses: coerceStatuses(obj),
    unreadNotifications: 0,
    latestMessage: description ?? "",
    updatedAt: null,
  };
}

function coerceStatuses(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const status = raw.status;
  if (status && typeof status === "object") {
    for (const [key, value] of Object.entries(status as Record<string, unknown>)) {
      if (typeof value === "string") out[key.toLowerCase()] = value;
      else if (value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string") {
        out[key.toLowerCase()] = (value as { message: string }).message;
      }
    }
  }
  const statuses = raw.statuses;
  if (Array.isArray(statuses)) {
    for (const entry of statuses) {
      if (entry && typeof entry === "object") {
        const key = (entry as { key?: unknown }).key;
        const message = (entry as { message?: unknown }).message;
        if (typeof key === "string" && typeof message === "string") {
          out[key.toLowerCase()] = message;
        }
      }
    }
  }
  return out;
}

function coerceNotification(raw: unknown): Notification | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : "";
  const workspaceId = typeof obj.workspace_id === "string" ? obj.workspace_id : "";
  if (!id || !workspaceId) return null;
  return {
    id,
    workspaceId,
    title: typeof obj.title === "string" ? obj.title : "",
    body: typeof obj.body === "string" ? obj.body : "",
    subtitle: typeof obj.subtitle === "string" ? obj.subtitle : null,
    isRead: obj.is_read === true,
    createdAt: typeof obj.created_at === "string" ? obj.created_at : "",
    surfaceId: typeof obj.surface_id === "string" ? obj.surface_id : null,
  };
}
