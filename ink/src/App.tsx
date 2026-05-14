import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { Key } from "ink";
import { CmuxClient, defaultSocketPath } from "./client.js";
import {
  COLORS,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  agentState,
  displayGroup,
} from "./format.js";
import type { AgentKind, AgentState, Workspace } from "./types.js";
import {
  buildVisibleRows,
  isSelectableRow,
  selectableRowAfter,
  selectableRowBefore,
  WorkspaceList,
  type ListRow,
} from "./WorkspaceList.js";
import { Composer } from "./Composer.js";
import { HelpBar } from "./HelpBar.js";
import {
  backspace,
  composerFromLines,
  composerHasInput,
  composerHasText,
  EMPTY_COMPOSER,
  insertNewline,
  insertText,
  killToEndOfLine,
  killToStartOfLine,
  killWordBackward,
  moveDown,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveUp,
  type ComposerState,
} from "./composer-state.js";
import {
  defaultAgentCommands,
  renderInitialCommand,
} from "./agent-commands.js";

export interface AppProps {
  readonly socketPath?: string;
  readonly cwd?: string;
}

interface QuitTap {
  readonly ch: "c" | "d";
  readonly at: number;
}

export function App({ socketPath, cwd }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const resolvedSocketPath = useMemo(
    () => socketPath ?? defaultSocketPath(),
    [socketPath],
  );
  const resolvedCwd = useMemo(() => cwd ?? process.cwd(), [cwd]);
  const clientRef = useRef<CmuxClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new CmuxClient({ socketPath: resolvedSocketPath });
  }
  const client = clientRef.current;

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<AgentState>>(
    () => new Set(),
  );
  const [provider, setProvider] = useState<AgentKind>("codex");
  const [planMode, setPlanMode] = useState<boolean>(false);
  const [composer, setComposer] = useState<ComposerState>(EMPTY_COMPOSER);
  const [selected, setSelected] = useState<number>(0);
  const [listScroll, setListScroll] = useState<number>(0);
  const [showShortcuts, setShowShortcuts] = useState<boolean>(false);
  const [statusLine, setStatusLine] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [quitTap, setQuitTap] = useState<QuitTap | null>(null);
  const [spinnerTick, setSpinnerTick] = useState<number>(0);
  const [composerMode, setComposerMode] = useState<
    { kind: "new" } | { kind: "rename"; workspaceId: string }
  >({ kind: "new" });

  const commands = useMemo(defaultAgentCommands, []);

  // Terminal size.
  const stdout = useStdout();
  const [rows, setRows] = useState<number>(stdout?.stdout.rows ?? 24);
  const [cols, setCols] = useState<number>(stdout?.stdout.columns ?? 80);
  useEffect(() => {
    if (!stdout) return;
    const update = (): void => {
      setRows(stdout.stdout.rows ?? 24);
      setCols(stdout.stdout.columns ?? 80);
    };
    update();
    stdout.stdout.on("resize", update);
    return () => {
      stdout.stdout.off("resize", update);
    };
  }, [stdout]);

  // Spinner only ticks when there is at least one workspace in the
  // "working" group; otherwise it would cause a full re-render every
  // SPINNER_INTERVAL_MS for no visible change.
  const hasWorkingWorkspace = useMemo(
    () =>
      workspaces.some(
        (ws) => agentState(ws) === "working" || displayGroup(agentState(ws)) === "working",
      ),
    [workspaces],
  );
  useEffect(() => {
    if (!hasWorkingWorkspace) return;
    const id = setInterval(
      () => setSpinnerTick((t) => (t + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    );
    return () => clearInterval(id);
  }, [hasWorkingWorkspace]);

  // Live data + event stream.
  const refresh = useCallback(
    async (reason: string) => {
      try {
        const [list, notifications] = await Promise.all([
          client.listWorkspaces(),
          client.listNotifications(),
        ]);
        const counts = new Map<string, number>();
        for (const n of notifications) {
          if (n.isRead) continue;
          counts.set(n.workspaceId, (counts.get(n.workspaceId) ?? 0) + 1);
        }
        const now = Date.now();
        setWorkspaces((prev) => {
          const prevById = new Map<string, Workspace>();
          for (const ws of prev) prevById.set(ws.id, ws);
          const next: Workspace[] = list.map((ws) => {
            const previous = prevById.get(ws.id);
            const unread = counts.get(ws.id) ?? 0;
            const updatedAt = previous?.updatedAt ?? now;
            // Reuse the previous object identity when nothing user-visible changed
            // so React/ink can skip re-rendering memoized row components.
            if (
              previous &&
              previous.title === ws.title &&
              previous.description === ws.description &&
              previous.pinned === ws.pinned &&
              previous.index === ws.index &&
              previous.currentDirectory === ws.currentDirectory &&
              previous.unreadNotifications === unread &&
              statusesEqual(previous.statuses, ws.statuses)
            ) {
              return previous;
            }
            return { ...ws, unreadNotifications: unread, updatedAt };
          });
          // If every element is identical to prev (same ids in same order, same refs),
          // return prev to keep the array reference stable too.
          if (
            next.length === prev.length &&
            next.every((ws, i) => ws === prev[i])
          ) {
            return prev;
          }
          return next;
        });
        // Don't update statusLine for routine refreshes; that would force the
        // HelpBar to re-render on every cmux event even though its visible
        // content never depends on the refresh reason.
      } catch (err) {
        setStatusLine(`refresh failed: ${(err as Error).message}`);
      }
    },
    [client],
  );

  useEffect(() => {
    void refresh("startup");
    const stream = client.streamEvents();
    let debounce: NodeJS.Timeout | null = null;
    const schedule = (reason: string): void => {
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
        schedule(name);
      }
    });
    stream.on("error", (err) => {
      setStatusLine(`event stream: ${err.message}`);
    });
    return () => {
      if (debounce) clearTimeout(debounce);
      stream.close();
    };
  }, [client, refresh]);

  // Visible rows + selection clamp.
  const visibleRows: ListRow[] = useMemo(
    () => buildVisibleRows(workspaces, collapsedGroups),
    [workspaces, collapsedGroups],
  );

  const composerActive =
    composerHasInput(composer) || composerMode.kind === "rename";
  const composerHeight = useMemo(() => {
    if (!composerActive) return 1;
    // Cap at 3/4 of screen.
    const cap = Math.max(1, Math.floor((rows * 3) / 4));
    return Math.max(1, Math.min(cap, composerVisualLineCount(composer, cols)));
  }, [composer, composerActive, rows, cols]);
  const helpHeight = showShortcuts ? 2 : 1;
  const listHeight = Math.max(1, rows - composerHeight - helpHeight - 2);

  // Ensure selected is in view.
  useEffect(() => {
    if (selected < listScroll) {
      setListScroll(selected);
      return;
    }
    if (selected >= listScroll + listHeight) {
      setListScroll(Math.max(0, selected + 1 - listHeight));
    }
  }, [selected, listScroll, listHeight]);

  // Reset selection if out of range (e.g. snapshot refresh shrinks list).
  useEffect(() => {
    if (visibleRows.length === 0) {
      if (selected !== 0) setSelected(0);
      return;
    }
    if (selected >= visibleRows.length) {
      setSelected(visibleRows.length - 1);
    }
  }, [visibleRows.length, selected]);

  const selectedRow = visibleRows[selected];
  const selectedIsGroup = selectedRow?.kind === "header";
  const selectedWorkspace =
    selectedRow?.kind === "workspace"
      ? workspaces[selectedRow.workspaceIndex] ?? null
      : null;

  const recordQuitTap = useCallback(
    (ch: "c" | "d"): boolean => {
      const now = Date.now();
      const last = quitTap;
      const shouldQuit = !!last && last.ch === ch && now - last.at <= 700;
      setQuitTap({ ch, at: now });
      if (!shouldQuit) {
        setStatusLine(`press ctrl+${ch} to quit`);
      }
      return shouldQuit;
    },
    [quitTap],
  );

  const submit = useCallback(async () => {
    if (submitting) return;
    const prompt = composer.lines.join("\n").trim();
    if (!prompt && !composerHasInput(composer)) return;
    setSubmitting(true);
    setStatusLine(`starting ${planMode ? `${provider} plan` : provider}…`);
    try {
      const initialCommand = renderInitialCommand(
        provider,
        planMode,
        commands,
        prompt,
      );
      const title = prompt
        ? `${provider}: ${prompt.slice(0, 48)}`
        : planMode
          ? `${provider} plan`
          : provider;
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
          setStatusLine(`created, but prompt_submit failed: ${(err as Error).message}`);
        }
      }
      setComposer(EMPTY_COMPOSER);
      setStatusLine(
        `started ${planMode ? `${provider} plan` : provider} workspace ${workspaceId.slice(0, 8)}…`,
      );
      void refresh("workspace.create");
    } catch (err) {
      setStatusLine(`submit failed: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }, [
    client,
    commands,
    composer,
    planMode,
    provider,
    refresh,
    resolvedCwd,
    submitting,
  ]);

  const toggleCollapsedSelected = useCallback((): boolean => {
    if (!selectedRow || selectedRow.kind !== "header") return false;
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(selectedRow.state)) next.delete(selectedRow.state);
      else next.add(selectedRow.state);
      return next;
    });
    return true;
  }, [selectedRow]);

  const submitRename = useCallback(
    async (workspaceId: string): Promise<void> => {
      const title = composer.lines.join(" ").trim();
      if (!title) {
        setStatusLine("rename cancelled");
        setComposer(EMPTY_COMPOSER);
        setComposerMode({ kind: "new" });
        return;
      }
      try {
        await client.rpc("workspace.rename", {
          workspace_id: workspaceId,
          title,
        });
        setStatusLine(`renamed workspace`);
        setComposer(EMPTY_COMPOSER);
        setComposerMode({ kind: "new" });
        void refresh("workspace.renamed");
      } catch (err) {
        setStatusLine(`rename failed: ${(err as Error).message}`);
      }
    },
    [client, composer, refresh],
  );

  const handleComposerKey = useCallback(
    (input: string, key: Key): void => {
      if (key.return) {
        if (key.shift) {
          setComposer((c) => insertNewline(c));
          return;
        }
        if (composerMode.kind === "rename") {
          void submitRename(composerMode.workspaceId);
          return;
        }
        if (composerHasText(composer)) {
          void submit();
        }
        return;
      }
      if (key.ctrl && (input === "j" || input === "J")) {
        setComposer((c) => insertNewline(c));
        return;
      }
      if (key.tab && key.shift) {
        setPlanMode((p) => !p);
        return;
      }
      if (key.tab) {
        setProvider((p) => (p === "codex" ? "claude" : "codex"));
        return;
      }
      if (key.escape) {
        setComposer(EMPTY_COMPOSER);
        setComposerMode({ kind: "new" });
        return;
      }
      // Ink reports the backspace key (DEL/0x7F) as key.delete=true.
      // key.backspace=true corresponds to ctrl+H. Treat both as backspace
      // since true forward-delete on a Mac keyboard sends an escape sequence
      // that Ink doesn't surface here.
      if (key.backspace || key.delete) {
        setComposer((c) => backspace(c));
        return;
      }
      if (key.leftArrow) {
        setComposer((c) => moveLeft(c));
        return;
      }
      if (key.rightArrow) {
        setComposer((c) => moveRight(c));
        return;
      }
      if (key.upArrow) {
        setComposer((c) => moveUp(c));
        return;
      }
      if (key.downArrow) {
        setComposer((c) => moveDown(c));
        return;
      }
      if (key.ctrl) {
        switch (input) {
          case "a":
            setComposer((c) => moveHome(c));
            return;
          case "e":
            setComposer((c) => moveEnd(c));
            return;
          case "k":
            setComposer((c) => killToEndOfLine(c));
            return;
          case "u":
            setComposer((c) => killToStartOfLine(c));
            return;
          case "w":
            setComposer((c) => killWordBackward(c));
            return;
          default:
            break;
        }
      }
      if (input && !key.ctrl && !key.meta) {
        setComposer((c) => insertText(c, input));
      }
    },
    [composer, composerMode, submit, submitRename],
  );

  useInput((input, key) => {
    if (submitting) return;
    // Global quit handling.
    if (key.ctrl && (input === "c" || input === "d")) {
      if (recordQuitTap(input as "c" | "d")) exit();
      return;
    }
    if (key.ctrl && input === "q") {
      exit();
      return;
    }
    if (key.ctrl && input === "s") {
      // stash placeholder
      setStatusLine("stash not wired in ink port yet");
      return;
    }
    if (showShortcuts && key.escape) {
      setShowShortcuts(false);
      return;
    }
    if (composerActive) {
      handleComposerKey(input, key);
      return;
    }
    if (key.ctrl && input === "r") {
      if (selectedWorkspace) {
        setComposer(composerFromLines([selectedWorkspace.title]));
        setComposerMode({ kind: "rename", workspaceId: selectedWorkspace.id });
        setStatusLine("renaming workspace");
      } else {
        setStatusLine("select a workspace to rename");
      }
      return;
    }
    if (key.ctrl && input === "t") {
      setStatusLine("pin toggle not wired in ink port yet");
      return;
    }
    if (input === "?" && !key.ctrl && !key.meta) {
      setShowShortcuts((s) => !s);
      return;
    }
    if (key.tab && key.shift) {
      setPlanMode((p) => !p);
      return;
    }
    if (key.tab) {
      setProvider((p) => (p === "codex" ? "claude" : "codex"));
      return;
    }
    if (key.upArrow || (key.ctrl && input === "p")) {
      setSelected((idx) => selectableRowBefore(visibleRows, idx));
      return;
    }
    if (key.downArrow || (key.ctrl && input === "n")) {
      setSelected((idx) => selectableRowAfter(visibleRows, idx));
      return;
    }
    if (key.return) {
      if (toggleCollapsedSelected()) return;
      if (selectedWorkspace) {
        setStatusLine(`open: ${selectedWorkspace.title}`);
      }
      return;
    }
    if (input) {
      setComposer((c) => insertText(c, input));
    }
  });

  // Determine which mode to show in the help bar.
  const helpMode: "workspace" | "composer" | "rename" = composerActive
    ? composerMode.kind === "rename"
      ? "rename"
      : "composer"
    : "workspace";

  // Only forward a status override when it's the "press ctrl+X to quit"
  // hint that the HelpBar actually displays. This keeps the HelpBar props
  // stable across routine state changes so it can stay memoized.
  const statusOverride = statusLine.startsWith("press ctrl+") ? statusLine : null;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <WorkspaceList
          rows={visibleRows}
          workspaces={workspaces}
          selectedIndex={selected}
          scroll={listScroll}
          height={listHeight}
          width={cols}
          spinnerTick={spinnerTick}
        />
      </Box>
      <Separator width={cols} />
      <Box flexDirection="column" height={composerHeight}>
        <Composer
          state={composer}
          active={composerActive}
          width={cols}
          maxHeight={composerHeight}
        />
      </Box>
      <Separator width={cols} />
      <Box height={helpHeight}>
        <HelpBar
          mode={helpMode}
          provider={provider}
          planMode={planMode}
          composerSlashActive={false}
          selectedIsGroup={selectedIsGroup}
          showShortcuts={showShortcuts}
          statusOverride={statusOverride}
        />
      </Box>
    </Box>
  );
}

function Separator({ width }: { width: number }): React.JSX.Element {
  return (
    <Box>
      <Text color={COLORS.muted}>{"─".repeat(Math.max(0, width))}</Text>
    </Box>
  );
}

function statusesEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

function composerVisualLineCount(state: ComposerState, width: number): number {
  // Match Rust composer_visual_line_count: per-line ceil(chars/text_width), sum, clamp >= 1.
  let total = 0;
  state.lines.forEach((line, rowIndex) => {
    const promptWidth = rowIndex === 0 ? 2 : 2; // "❯ " and "  " both width 2 in cells
    const textWidth = Math.max(1, width - promptWidth);
    const chars = [...line].length;
    total += chars === 0 ? 1 : Math.ceil(chars / textWidth);
  });
  return Math.max(1, total);
}

