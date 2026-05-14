import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import {
  CmuxClient,
  defaultSocketPath,
} from "./client.js";
import {
  AGENT_COLOR,
  AGENT_STATE_COLOR,
  AGENT_STATE_LABEL,
  AGENT_STATE_ORDER,
  agentLabel,
  agentState,
  groupByState,
  oneLinePreview,
} from "./format.js";
import {
  defaultAgentCommands,
  renderInitialCommand,
} from "./agent-commands.js";
import type { AgentKind, Workspace } from "./types.js";

export interface AppProps {
  readonly socketPath?: string;
  readonly cwd?: string;
}

export function App({ socketPath, cwd }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const resolvedSocketPath = useMemo(
    () => socketPath ?? defaultSocketPath(),
    [socketPath],
  );
  const resolvedCwd = useMemo(() => cwd ?? process.cwd(), [cwd]);
  const clientRef = useRef<CmuxClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = new CmuxClient({ socketPath: resolvedSocketPath });
  }
  const client = clientRef.current;

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [unreadByWorkspace, setUnreadByWorkspace] = useState<
    Record<string, number>
  >({});
  const [status, setStatus] = useState<string>("connecting…");
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [agent, setAgent] = useState<AgentKind>("codex");
  const [planMode, setPlanMode] = useState<boolean>(false);
  const [composer, setComposer] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [quitArmed, setQuitArmed] = useState<boolean>(false);

  const commands = useMemo(defaultAgentCommands, []);

  const refresh = useCallback(
    async (reason: string) => {
      try {
        const [list, notifications] = await Promise.all([
          client.listWorkspaces(),
          client.listNotifications(),
        ]);
        const counts: Record<string, number> = {};
        for (const n of notifications) {
          if (n.isRead) continue;
          counts[n.workspaceId] = (counts[n.workspaceId] ?? 0) + 1;
        }
        const merged = list.map((ws) => ({
          ...ws,
          unreadNotifications: counts[ws.id] ?? 0,
        }));
        setWorkspaces(merged);
        setUnreadByWorkspace(counts);
        setStatus(`refreshed (${reason}) · ${merged.length} workspaces`);
      } catch (err) {
        setStatus(`refresh failed: ${(err as Error).message}`);
      }
    },
    [client],
  );

  useEffect(() => {
    void refresh("startup");
    const stream = client.streamEvents();
    let debounce: NodeJS.Timeout | null = null;
    const scheduleRefresh = (reason: string): void => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        void refresh(reason);
      }, 200);
    };
    stream.on("event", (frame) => {
      const name = frame.name;
      if (
        name.startsWith("workspace.") ||
        name.startsWith("notification.") ||
        name.startsWith("sidebar.") ||
        name.startsWith("surface.")
      ) {
        scheduleRefresh(name);
      }
    });
    stream.on("error", (err) => {
      setStatus(`event stream: ${err.message}`);
    });
    return () => {
      if (debounce) clearTimeout(debounce);
      stream.close();
    };
  }, [client, refresh]);

  const grouped = useMemo(() => groupByState(workspaces), [workspaces]);
  const orderedWorkspaces = useMemo(() => {
    const flat: Workspace[] = [];
    for (const state of AGENT_STATE_ORDER) {
      for (const ws of grouped.get(state) ?? []) flat.push(ws);
    }
    return flat;
  }, [grouped]);

  const submit = useCallback(async () => {
    if (submitting) return;
    const prompt = composer.trim();
    setSubmitting(true);
    setStatus(`starting ${agentLabel(agent, planMode)}…`);
    try {
      const initialCommand = renderInitialCommand(
        agent,
        planMode,
        commands,
        prompt,
      );
      const title = prompt
        ? `${agent}: ${oneLinePreview(prompt, 48)}`
        : agentLabel(agent, planMode);
      const workspaceId = await client.createWorkspace({
        title,
        description: prompt,
        initialCommand,
        cwd: resolvedCwd,
        focus: true,
      });
      if (prompt) {
        try {
          await client.submitPrompt(workspaceId, prompt);
        } catch (err) {
          setStatus(`workspace created, but prompt_submit failed: ${(err as Error).message}`);
        }
      }
      setComposer("");
      setStatus(`started ${agentLabel(agent, planMode)} workspace ${workspaceId.slice(0, 8)}…`);
      void refresh("workspace.create");
    } catch (err) {
      setStatus(`submit failed: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }, [
    agent,
    client,
    commands,
    composer,
    planMode,
    refresh,
    resolvedCwd,
    submitting,
  ]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (quitArmed) {
        exit();
        return;
      }
      setQuitArmed(true);
      setStatus("press Ctrl+C again to quit");
      setTimeout(() => setQuitArmed(false), 1500);
      return;
    }
    if (key.ctrl && (input === "q" || input === "d")) {
      exit();
      return;
    }
    if (key.tab && key.shift) {
      setPlanMode((mode) => !mode);
      return;
    }
    if (key.tab) {
      setAgent((current) => (current === "codex" ? "claude" : "codex"));
      return;
    }
    if (key.ctrl && input === "r") {
      void refresh("manual");
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((idx) => Math.max(0, idx - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((idx) =>
        Math.min(Math.max(0, orderedWorkspaces.length - 1), idx + 1),
      );
      return;
    }
  });

  const stdout = useStdout();
  const [rows, setRows] = useState<number>(stdout?.stdout.rows ?? 24);
  useEffect(() => {
    if (!stdout) return;
    const update = (): void => setRows(stdout.stdout.rows ?? 24);
    update();
    stdout.stdout.on("resize", update);
    return () => {
      stdout.stdout.off("resize", update);
    };
  }, [stdout]);

  // Reserve rows for: header (1), status (1), composer (1), footer (1),
  // and outer paddingY (0) plus borders / margins (~2).
  const listHeight = Math.max(6, rows - 6);

  return (
    <Box flexDirection="column" paddingX={1} height={rows}>
      <Header
        socketPath={resolvedSocketPath}
        cwd={resolvedCwd}
        agent={agent}
        planMode={planMode}
      />
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        <WorkspaceList
          grouped={grouped}
          ordered={orderedWorkspaces}
          selectedIndex={selectedIndex}
          maxHeight={listHeight}
        />
      </Box>
      <StatusLine status={status} />
      <Composer
        agent={agent}
        planMode={planMode}
        submitting={submitting}
        value={composer}
        onChange={setComposer}
        onSubmit={() => {
          void submit();
        }}
      />
      <Footer />
    </Box>
  );
}

function Header({
  socketPath,
  cwd,
  agent,
  planMode,
}: {
  socketPath: string;
  cwd: string;
  agent: AgentKind;
  planMode: boolean;
}): React.JSX.Element {
  return (
    <Box justifyContent="space-between">
      <Text>
        <Text color="blueBright" bold>
          cmux home
        </Text>
        <Text color="gray"> · {socketPath}</Text>
      </Text>
      <Text>
        <Text color={AGENT_COLOR[agent]}>{agentLabel(agent, planMode)}</Text>
        <Text color="gray"> · {oneLinePreview(cwd, 48)}</Text>
      </Text>
    </Box>
  );
}

interface FlatRow {
  kind: "header" | "row";
  state: import("./types.js").AgentState;
  workspace?: Workspace;
  workspaceIndex?: number;
  groupSize?: number;
}

function flattenGrouped(
  grouped: Map<import("./types.js").AgentState, Workspace[]>,
): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const state of AGENT_STATE_ORDER) {
    const list = grouped.get(state) ?? [];
    if (list.length === 0) continue;
    rows.push({ kind: "header", state, groupSize: list.length });
    list.forEach((ws, idx) => {
      rows.push({ kind: "row", state, workspace: ws, workspaceIndex: idx });
    });
  }
  return rows;
}

function WorkspaceList({
  grouped,
  ordered,
  selectedIndex,
  maxHeight,
}: {
  grouped: Map<import("./types.js").AgentState, Workspace[]>;
  ordered: Workspace[];
  selectedIndex: number;
  maxHeight: number;
}): React.JSX.Element {
  if (ordered.length === 0) {
    return (
      <Box paddingY={1}>
        <Text color="gray">No workspaces yet. Type a prompt below and press Enter.</Text>
      </Box>
    );
  }
  const flat = flattenGrouped(grouped);
  const selectedFlatIndex = (() => {
    const selected = ordered[selectedIndex];
    if (!selected) return -1;
    return flat.findIndex((r) => r.kind === "row" && r.workspace?.id === selected.id);
  })();

  const window = computeWindow(flat.length, selectedFlatIndex, maxHeight);
  const slice = flat.slice(window.start, window.end);
  const hiddenBefore = window.start;
  const hiddenAfter = flat.length - window.end;

  return (
    <Box flexDirection="column">
      {hiddenBefore > 0 ? (
        <Text color="gray">↑ {hiddenBefore} more</Text>
      ) : null}
      {slice.map((row, idx) => {
        if (row.kind === "header") {
          return (
            <Box key={`h-${row.state}-${idx}`}>
              <Text color={AGENT_STATE_COLOR[row.state]} bold>
                {AGENT_STATE_LABEL[row.state]}
              </Text>
              <Text color="gray"> ({row.groupSize})</Text>
            </Box>
          );
        }
        const ws = row.workspace!;
        const isSelected = ws.id === ordered[selectedIndex]?.id;
        return <WorkspaceRow key={ws.id} workspace={ws} selected={isSelected} />;
      })}
      {hiddenAfter > 0 ? (
        <Text color="gray">↓ {hiddenAfter} more</Text>
      ) : null}
    </Box>
  );
}

function computeWindow(
  total: number,
  selected: number,
  maxHeight: number,
): { start: number; end: number } {
  const cap = Math.max(3, maxHeight - 2); // reserve room for ↑/↓ hints
  if (total <= cap) return { start: 0, end: total };
  const half = Math.floor(cap / 2);
  let start = Math.max(0, (selected < 0 ? 0 : selected) - half);
  let end = start + cap;
  if (end > total) {
    end = total;
    start = end - cap;
  }
  return { start, end };
}

function WorkspaceRow({
  workspace,
  selected,
}: {
  workspace: Workspace;
  selected: boolean;
}): React.JSX.Element {
  const state = agentState(workspace);
  const indicator = selected ? "▶" : " ";
  const dot =
    workspace.unreadNotifications > 0
      ? `●${workspace.unreadNotifications > 1 ? workspace.unreadNotifications : ""}`
      : workspace.pinned
        ? "★"
        : "·";
  return (
    <Box>
      <Text color={selected ? "cyan" : undefined}>
        <Text>{indicator} </Text>
        <Text color={AGENT_STATE_COLOR[state]}>{dot.padEnd(3, " ")}</Text>
        <Text> </Text>
        <Text bold={selected}>{oneLinePreview(workspace.title || workspace.ref, 40)}</Text>
      </Text>
      <Box marginLeft={2} flexGrow={1}>
        <Text color="gray">
          {oneLinePreview(workspace.latestMessage || workspace.currentDirectory, 80)}
        </Text>
      </Box>
    </Box>
  );
}

function StatusLine({ status }: { status: string }): React.JSX.Element {
  return (
    <Box>
      <Text color="gray">— {status}</Text>
    </Box>
  );
}

function Composer({
  agent,
  planMode,
  submitting,
  value,
  onChange,
  onSubmit,
}: {
  agent: AgentKind;
  planMode: boolean;
  submitting: boolean;
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
}): React.JSX.Element {
  return (
    <Box marginTop={1}>
      <Text color={AGENT_COLOR[agent]} bold>
        {planMode ? `${agent}* ` : `${agent} `}
      </Text>
      <Text color="gray">❯ </Text>
      {submitting ? (
        <Text color="yellow">submitting…</Text>
      ) : (
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder="describe a task for a new workspace" />
      )}
    </Box>
  );
}

function Footer(): React.JSX.Element {
  return (
    <Box marginTop={1}>
      <Text color="gray">
        Tab agent · Shift+Tab plan · Enter submit · ↑/↓ navigate · Ctrl+R refresh · Ctrl+Q quit
      </Text>
    </Box>
  );
}
