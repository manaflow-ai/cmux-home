import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { Key } from "ink";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VM_SSH_SCRIPT = resolve(__dirname, "..", "bin", "freestyle-vm-ssh.mjs");
import { CmuxClient, defaultSocketPath } from "./client.js";
import {
  COLORS,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  agentState,
  displayGroup,
  oneLinePreview,
} from "./format.js";
import {
  FreestyleClient,
  defaultFreestyleApiKey,
  type FreestyleSummary,
} from "./freestyle-client.js";
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

  const freestyleRef = useRef<FreestyleClient | null>(null);
  if (!freestyleRef.current) {
    freestyleRef.current = new FreestyleClient(defaultFreestyleApiKey());
  }
  const freestyle = freestyleRef.current;

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [freestyleSummary, setFreestyleSummary] = useState<FreestyleSummary | null>(null);
  const [freestyleError, setFreestyleError] = useState<string | null>(null);
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
  const [destroyArmedVmId, setDestroyArmedVmId] = useState<string | null>(null);
  const destroyArmTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [composerMode, setComposerMode] = useState<
    { kind: "new" } | { kind: "rename"; workspaceId: string }
  >({ kind: "new" });
  // Local map of forked VM id → parent VM id. Reset on TUI restart.
  // Encoded into the fork's snapshot name so we can also recover after a
  // restart via VM list metadata.
  const [forkParents, setForkParents] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  // Monotonic mac-side port allocator for SSH -L forwards. Each spawned
  // task / fork gets its own port so concurrent VMs don't fight over 3000.
  const nextDevPortRef = useRef<number>(30000);
  const allocDevPort = useCallback((): number => {
    const p = nextDevPortRef.current;
    nextDevPortRef.current = p + 1;
    return p;
  }, []);

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

  // Spinner ticks while anything visible is animating: a workspace in the
  // "working" group, OR a Freestyle VM whose state shows the braille
  // spinner (starting / suspending). Tracking VMs here is what makes the
  // ⠋ marker on a starting VM actually animate during the cold-path
  // tailscale install.
  const hasAnimatedRow = useMemo(() => {
    const workspaceWorking = workspaces.some(
      (ws) =>
        agentState(ws) === "working" || displayGroup(agentState(ws)) === "working",
    );
    if (workspaceWorking) return true;
    return (freestyleSummary?.vms ?? []).some(
      (vm) => vm.state === "starting" || vm.state === "suspending",
    );
  }, [workspaces, freestyleSummary]);
  useEffect(() => {
    if (!hasAnimatedRow) return;
    const id = setInterval(
      () => setSpinnerTick((t) => (t + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    );
    return () => clearInterval(id);
  }, [hasAnimatedRow]);

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

  const refreshFreestyle = useCallback(async (): Promise<void> => {
    if (!freestyle.isEnabled()) return;
    try {
      const summary = await freestyle.list();
      if (!summary) return;
      setFreestyleSummary((prev) => {
        if (
          prev &&
          prev.totalCount === summary.totalCount &&
          prev.runningCount === summary.runningCount &&
          prev.startingCount === summary.startingCount &&
          prev.suspendedCount === summary.suspendedCount &&
          prev.stoppedCount === summary.stoppedCount &&
          prev.vms.length === summary.vms.length &&
          prev.vms.every((vm, i) => {
            const next = summary.vms[i]!;
            return (
              vm.id === next.id &&
              vm.state === next.state &&
              vm.snapshotId === next.snapshotId &&
              vm.lastActivityMs === next.lastActivityMs &&
              vm.persistence === next.persistence
            );
          })
        ) {
          return prev;
        }
        return summary;
      });
      setFreestyleError(null);
    } catch (err) {
      setFreestyleError((err as Error).message);
    }
  }, [freestyle]);

  useEffect(() => {
    if (!freestyle.isEnabled()) return;
    void refreshFreestyle();
    const id = setInterval(() => {
      void refreshFreestyle();
    }, 10_000);
    return () => clearInterval(id);
  }, [freestyle, refreshFreestyle]);

  // Visible rows + selection clamp.
  const workspaceRows: ListRow[] = useMemo(
    () => buildVisibleRows(workspaces, collapsedGroups),
    [workspaces, collapsedGroups],
  );
  const vms = freestyleSummary?.vms ?? [];
  const vmsById = useMemo(() => {
    const map = new Map<string, FreestyleSummary["vms"][number]>();
    for (const vm of vms) map.set(vm.id, vm);
    return map;
  }, [vms]);

  // Build a vmId → child workspaces map by parsing the description we wrote
  // when spawning a cloud sandbox (`freestyle vm <vmId> running codex with…`).
  // Lets the TUI render workspaces nested under the VM that spawned them so
  // the relationship is visible without a separate column.
  const workspacesByVmId = useMemo(() => {
    const map = new Map<string, Workspace[]>();
    const vmIdRegex = /freestyle vm ([a-z0-9]{8,})/i;
    for (const ws of workspaces) {
      const haystack = (ws.description ?? "") + " " + (ws.title ?? "");
      const match = haystack.match(vmIdRegex);
      if (!match) continue;
      const vmId = match[1]!;
      if (!vmsById.has(vmId)) continue;
      const bucket = map.get(vmId) ?? [];
      bucket.push(ws);
      map.set(vmId, bucket);
    }
    return map;
  }, [workspaces, vmsById]);

  // Track which workspaces are already grouped under a VM so we don't
  // double-count them in the top sections.
  const groupedWorkspaceIds = useMemo(() => {
    const set = new Set<string>();
    for (const list of workspacesByVmId.values()) for (const w of list) set.add(w.id);
    return set;
  }, [workspacesByVmId]);

  const vmHeaderLabel = useMemo(() => {
    if (!freestyle.isEnabled()) return "";
    if (freestyleError) return `Freestyle VMs (error)`;
    const total = freestyleSummary?.totalCount ?? vms.length;
    const running = freestyleSummary?.runningCount ?? 0;
    return running > 0
      ? `Freestyle VMs (${total}, ${running} running)`
      : `Freestyle VMs (${total})`;
  }, [freestyle, freestyleSummary, freestyleError, vms.length]);
  // Build the parent → children map for forked VMs. A VM with no parent in
  // forkParents (and no name-based parent hint) is treated as a root.
  const forkChildren = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [child, parent] of forkParents.entries()) {
      const bucket = map.get(parent) ?? [];
      bucket.push(child);
      map.set(parent, bucket);
    }
    return map;
  }, [forkParents]);

  const visibleRows: ListRow[] = useMemo(() => {
    // cmux-freestyle-hq view: skip the top-level cmux workspace sections
    // (Needs input / Working / Completed). The dashboard focuses on the
    // user's Freestyle VMs; workspaces created via /spawn or /fork still
    // appear nested under their VM in the tree below.
    const rows: ListRow[] = [];
    if (freestyle.isEnabled()) {
      rows.push({ kind: "vm-header" });
      const emittedVm = new Set<string>();
      const emitVm = (vm: FreestyleSummary["vms"][number], depth = 0): void => {
        if (emittedVm.has(vm.id)) return;
        emittedVm.add(vm.id);
        rows.push({ kind: "vm", vmId: vm.id, depth });
        const children = workspacesByVmId.get(vm.id) ?? [];
        for (const ws of children) {
          const idx = workspaces.findIndex((w) => w.id === ws.id);
          if (idx >= 0) {
            rows.push({ kind: "workspace", workspaceIndex: idx, depth: depth + 1 });
          }
        }
        const forks = forkChildren.get(vm.id) ?? [];
        for (const forkId of forks) {
          const forkVm = vmsById.get(forkId);
          if (forkVm) emitVm(forkVm, depth + 1);
        }
      };
      for (const vm of vms) {
        // Skip forks whose parent IS present (the parent's emitVm will pick
        // them up). Forks whose parent has been destroyed still need to show
        // up — they're handled by the orphan loop below.
        const parentId = forkParents.get(vm.id);
        if (parentId && vmsById.has(parentId)) continue;
        emitVm(vm, 0);
      }
      // Defensive: any VM not emitted yet (race during refresh) goes as root.
      for (const vm of vms) {
        if (!emittedVm.has(vm.id)) emitVm(vm, 0);
      }
    }
    return rows;
  }, [
    workspaces,
    freestyle,
    vms,
    vmsById,
    workspacesByVmId,
    forkParents,
    forkChildren,
  ]);

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

  // Snap selection to a real selectable row when the row layout shifts
  // (e.g. we removed the workspace sections, or selected fell off the end
  // after a refresh, or the row at `selected` is now a blank).
  useEffect(() => {
    if (visibleRows.length === 0) {
      if (selected !== 0) setSelected(0);
      return;
    }
    const at = visibleRows[selected];
    if (at && isSelectableRow(at) && selected < visibleRows.length) return;
    // Find the first selectable row from the current position.
    const next = selectableRowAfter(visibleRows, -1);
    if (next >= 0 && next !== selected) setSelected(next);
  }, [visibleRows, selected]);

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

  const selectedVmRow = useCallback(() => {
    if (selectedRow?.kind !== "vm") return null;
    return vmsById.get(selectedRow.vmId) ?? null;
  }, [selectedRow, vmsById]);

  const vmDevServerUrl = useCallback((vmId: string): string => {
    // Freestyle exposes port 443 on <vmId>.vm.freestyle.sh which goes to the
    // cmuxd-ws daemon. For variation 1 we point the browser there; the user
    // can re-navigate once their dev server is reachable.
    return `https://${vmId}.vm.freestyle.sh`;
  }, []);

  const launchVmSandbox = useCallback(
    async (vm: FreestyleSummary["vms"][number]) => {
      const shortId = vm.id.slice(0, 8);
      setStatusLine(`opening sandbox for ${shortId}…`);
      try {
        // The helper script reads FREESTYLE_API_KEY from process env, falling
        // back to ~/.secrets/cmux*.env. Don't bake the key into the command
        // string or it leaks into cmux logs and ps listings.
        const cmd = `node ${shellQuote(VM_SSH_SCRIPT)} ${shellQuote(vm.id)}`;
        const workspaceId = await client.createWorkspace({
          title: `vm:${shortId}`,
          description: `cmux ssh + subrouter into freestyle vm ${vm.id}`,
          initialCommand: cmd,
          cwd: resolvedCwd,
          focus: false,
        });
        try {
          await client.createBrowserPane({
            workspaceId,
            url: "http://127.0.0.1:3000",
            direction: "right",
            focus: false,
          });
        } catch (err) {
          setStatusLine(`opened ssh, browser pane failed: ${(err as Error).message}`);
          return;
        }
        setStatusLine(`opened sandbox workspace ${workspaceId.slice(0, 8)} for vm ${shortId}`);
      } catch (err) {
        setStatusLine(`launch failed: ${(err as Error).message}`);
      }
    },
    [client, freestyle, resolvedCwd],
  );

  const launchVmOutside = useCallback(
    async (vm: FreestyleSummary["vms"][number]) => {
      const shortId = vm.id.slice(0, 8);
      setStatusLine(`opening workspace for ${shortId} (codex on mac)…`);
      try {
        const workspaceId = await client.createWorkspace({
          title: `vm:${shortId} (local)`,
          description: `local dev workspace pointing at freestyle vm ${vm.id}`,
          initialCommand: "",
          cwd: resolvedCwd,
          focus: false,
        });
        try {
          await client.createBrowserPane({
            workspaceId,
            url: vmDevServerUrl(vm.id),
            direction: "right",
            focus: false,
          });
        } catch (err) {
          setStatusLine(`workspace created, browser pane failed: ${(err as Error).message}`);
          return;
        }
        setStatusLine(`opened local workspace ${workspaceId.slice(0, 8)} for vm ${shortId}`);
      } catch (err) {
        setStatusLine(`launch failed: ${(err as Error).message}`);
      }
    },
    [client, resolvedCwd, vmDevServerUrl],
  );

  const destroyVm = useCallback(
    async (vm: FreestyleSummary["vms"][number]) => {
      const shortId = vm.id.slice(0, 8);
      setStatusLine(`destroying vm ${shortId}…`);
      try {
        await freestyle.destroy(vm.id);
        setStatusLine(`destroyed vm ${shortId}`);
        void refreshFreestyle();
      } catch (err) {
        setStatusLine(`destroy failed: ${(err as Error).message}`);
      }
    },
    [freestyle, refreshFreestyle],
  );

  const forkSelectedVm = useCallback(
    async (parentVmId: string, prompt: string | null) => {
      if (!freestyle.isEnabled()) {
        setStatusLine("FREESTYLE_API_KEY not set; can't fork");
        return;
      }
      if (submitting) return;
      const shortParent = parentVmId.slice(0, 8);
      setSubmitting(true);
      try {
        setStatusLine(`snapshotting vm ${shortParent} for fork…`);
        const snapshotName = `cmux-home-fork-${parentVmId}-${Date.now()}`;
        const { vmId, snapshotId } = await freestyle.forkVm(
          parentVmId,
          snapshotName,
        );
        setForkParents((prev) => {
          const next = new Map(prev);
          next.set(vmId, parentVmId);
          return next;
        });
        const shortChild = vmId.slice(0, 8);
        setStatusLine(`fork ${shortChild} of ${shortParent} (snap ${snapshotId.slice(0, 8)}); waiting…`);
        const ready = await waitForFreestyleHealthz(vmId, 120_000);
        if (!ready) {
          setStatusLine(`fork ${shortChild} did not become ready in 120 s; opening workspace anyway`);
        } else {
          setStatusLine(`fork ${shortChild} ready, opening workspace…`);
        }
        const promptArg = prompt && prompt.trim()
          ? ` --codex-prompt ${shellQuote(prompt.trim())}`
          : "";
        const devPort = allocDevPort();
        const acctFlag = process.env.SUBROUTER_CODEX_ACCOUNT_ID?.trim()
          ? ` --subrouter-account-id ${shellQuote(process.env.SUBROUTER_CODEX_ACCOUNT_ID.trim())}`
          : "";
        const cmd =
          `node ${shellQuote(VM_SSH_SCRIPT)} ${shellQuote(vmId)} ` +
          `--clone-cmux ` +
          `--dev-server-mac-port ${devPort}` +
          acctFlag +
          promptArg;
        const titlePrompt = prompt && prompt.trim() ? prompt.trim().slice(0, 32) : "shell";
        const workspaceId = await client.createWorkspace({
          title: `fork: ${titlePrompt} (${shortParent}→${shortChild})`,
          description: `freestyle vm ${vmId} forked from ${parentVmId}; codex with:\n${prompt ?? "(no prompt)"}`,
          initialCommand: cmd,
          cwd: resolvedCwd,
          focus: false,
        });
        await openTaskRightSide({
          client,
          workspaceId,
          vmId,
          devPort,
          setStatusLine,
        });
        if (prompt && prompt.trim()) {
          setComposer(EMPTY_COMPOSER);
          setComposerMode({ kind: "new" });
        }
        setStatusLine(`fork ${shortChild} of ${shortParent} ready (workspace ${workspaceId.slice(0, 8)})`);
        void refreshFreestyle();
      } catch (err) {
        setStatusLine(`fork failed: ${(err as Error).message}`);
      } finally {
        setSubmitting(false);
      }
    },
    [client, freestyle, refreshFreestyle, resolvedCwd, submitting, allocDevPort],
  );

  const createVmFromDefaultSnapshot = useCallback(async () => {
    const snapshotId = process.env.FREESTYLE_SANDBOX_SNAPSHOT?.trim();
    if (!snapshotId) {
      setStatusLine("set FREESTYLE_SANDBOX_SNAPSHOT to create a VM from default snapshot");
      return;
    }
    setStatusLine(`creating vm from ${snapshotId.slice(0, 12)}…`);
    try {
      const result = await freestyle.createFromSnapshot(snapshotId);
      setStatusLine(`created vm ${result.vmId.slice(0, 8)}`);
      void refreshFreestyle();
    } catch (err) {
      setStatusLine(`create failed: ${(err as Error).message}`);
    }
  }, [freestyle, refreshFreestyle]);

  const submitToNewCloudSandbox = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed) return;
      if (!freestyle.isEnabled()) {
        setStatusLine("FREESTYLE_API_KEY not set; can't spawn a cloud sandbox");
        return;
      }
      const snapshotId = process.env.FREESTYLE_SANDBOX_SNAPSHOT?.trim();
      if (!snapshotId) {
        setStatusLine("set FREESTYLE_SANDBOX_SNAPSHOT to spawn a cloud sandbox");
        return;
      }
      if (submitting) return;
      setSubmitting(true);
      try {
        const preview = trimmed.slice(0, 48);
        setStatusLine(`spawning cloud sandbox for "${preview}"…`);
        const { vmId } = await freestyle.createFromSnapshot(snapshotId);
        const shortId = vmId.slice(0, 8);
        setStatusLine(`waiting for vm ${shortId} to be ready…`);
        const ready = await waitForFreestyleHealthz(vmId, 120_000);
        if (!ready) {
          setStatusLine(`vm ${shortId} did not become ready in 120 s; opening workspace anyway`);
        } else {
          setStatusLine(`vm ${shortId} ready, opening workspace…`);
        }
        const devPort = allocDevPort();
        const acctFlag = process.env.SUBROUTER_CODEX_ACCOUNT_ID?.trim()
          ? ` --subrouter-account-id ${shellQuote(process.env.SUBROUTER_CODEX_ACCOUNT_ID.trim())}`
          : "";
        const cmd =
          `node ${shellQuote(VM_SSH_SCRIPT)} ${shellQuote(vmId)} ` +
          `--clone-cmux ` +
          `--dev-server-mac-port ${devPort}` +
          acctFlag +
          ` --codex-prompt ${shellQuote(trimmed)}`;
        const workspaceId = await client.createWorkspace({
          title: `task: ${preview}`,
          description: `freestyle vm ${vmId} running codex with:\n${trimmed}`,
          initialCommand: cmd,
          cwd: resolvedCwd,
          focus: false,
        });
        await openTaskRightSide({
          client,
          workspaceId,
          vmId,
          devPort,
          setStatusLine,
        });
        setComposer(EMPTY_COMPOSER);
        setComposerMode({ kind: "new" });
        setStatusLine(`task workspace ${workspaceId.slice(0, 8)} for vm ${shortId} (dev :${devPort})`);
        void refreshFreestyle();
      } catch (err) {
        setStatusLine(`submit failed: ${(err as Error).message}`);
      } finally {
        setSubmitting(false);
      }
    },
    [client, freestyle, refreshFreestyle, resolvedCwd, submitting, allocDevPort],
  );

  const dispatchSlashCommand = useCallback(
    async (cmd: ParsedSlashCommand): Promise<void> => {
      switch (cmd.name) {
        case "fork": {
          const selectedVm = selectedVmRow();
          if (!selectedVm) {
            setStatusLine("/fork needs a VM row selected");
            return;
          }
          const count = cmd.count;
          const prompt = cmd.prompt;
          setComposer(EMPTY_COMPOSER);
          setComposerMode({ kind: "new" });
          setStatusLine(
            `forking ${count} × ${selectedVm.id.slice(0, 8)}${prompt ? ` for "${prompt.slice(0, 32)}"` : ""}`,
          );
          await Promise.allSettled(
            Array.from({ length: count }, () =>
              forkSelectedVm(selectedVm.id, prompt || null),
            ),
          );
          setStatusLine(`fork swarm of ${count} from ${selectedVm.id.slice(0, 8)} dispatched`);
          return;
        }
        case "spawn": {
          const count = cmd.count;
          const prompt = cmd.prompt;
          if (!prompt) {
            setStatusLine("/spawn needs a prompt: /spawn 3 <task>");
            return;
          }
          setComposer(EMPTY_COMPOSER);
          setComposerMode({ kind: "new" });
          setStatusLine(`spawning ${count} cloud sandboxes for "${prompt.slice(0, 32)}"`);
          await Promise.allSettled(
            Array.from({ length: count }, () => submitToNewCloudSandbox(prompt)),
          );
          setStatusLine(`spawn swarm of ${count} dispatched`);
          return;
        }
        default:
          setStatusLine(`unknown slash command: /${cmd.name}`);
      }
    },
    [forkSelectedVm, selectedVmRow, submitToNewCloudSandbox],
  );

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
          // Slash commands: '/fork [N] <prompt>' / '/spawn [N] <prompt>'.
          // Default enter (no slash command) spawns a fresh Freestyle cloud
          // sandbox when the env is wired for it; falls back to the local
          // cmux workspace path otherwise.
          const text = composer.lines.join("\n");
          const cmd = parseSlashCommand(text);
          if (cmd) {
            void dispatchSlashCommand(cmd);
            return;
          }
          const cloudReady =
            freestyle.isEnabled() &&
            !!process.env.FREESTYLE_SANDBOX_SNAPSHOT?.trim();
          if (cloudReady) {
            void submitToNewCloudSandbox(text);
          } else {
            void submit();
          }
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
    [composer, composerMode, submit, submitRename, submitToNewCloudSandbox],
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
        return;
      }
      const selectedVm = selectedVmRow();
      if (selectedVm) {
        void launchVmSandbox(selectedVm);
        return;
      }
      if (selectedRow?.kind === "vm-header") {
        void createVmFromDefaultSnapshot();
        return;
      }
      return;
    }
    if (key.ctrl && input === "o") {
      const selectedVm = selectedVmRow();
      if (selectedVm) {
        void launchVmOutside(selectedVm);
      }
      return;
    }
    if (key.ctrl && input === "f") {
      const selectedVm = selectedVmRow();
      if (selectedVm) {
        const prompt = composer.lines.join("\n").trim();
        void forkSelectedVm(selectedVm.id, prompt ? prompt : null);
      }
      return;
    }
    if (key.ctrl && input === "x") {
      const selectedVm = selectedVmRow();
      if (selectedVm) {
        if (destroyArmedVmId === selectedVm.id) {
          if (destroyArmTimerRef.current) {
            clearTimeout(destroyArmTimerRef.current);
            destroyArmTimerRef.current = null;
          }
          setDestroyArmedVmId(null);
          void destroyVm(selectedVm);
        } else {
          setDestroyArmedVmId(selectedVm.id);
          setStatusLine(
            `press ctrl+x again within 3 s to destroy vm ${selectedVm.id.slice(0, 8)}`,
          );
          if (destroyArmTimerRef.current) clearTimeout(destroyArmTimerRef.current);
          destroyArmTimerRef.current = setTimeout(() => {
            setDestroyArmedVmId((armed) => (armed === selectedVm.id ? null : armed));
            destroyArmTimerRef.current = null;
            setStatusLine("");
          }, 3_000);
        }
      }
      return;
    }
    if (input) {
      setComposer((c) => insertText(c, input));
    }
  });

  // Determine which mode to show in the help bar.
  const helpMode: "workspace" | "composer" | "rename" | "vm" | "vm-header" =
    composerActive
      ? composerMode.kind === "rename"
        ? "rename"
        : "composer"
      : selectedRow?.kind === "vm"
        ? "vm"
        : selectedRow?.kind === "vm-header"
          ? "vm-header"
          : "workspace";

  // Forward the status line to the help bar when it carries something the
  // user needs to see (quit prompts, in-flight cloud submit progress, error
  // messages). Keeps the override null otherwise so the HelpBar stays stable
  // across routine state changes.
  const statusOverride = useMemo(() => {
    const s = statusLine.trim();
    if (!s) return null;
    if (s.startsWith("press ctrl+")) return s;
    if (
      submitting ||
      /^(spawning|waiting|opening|creating|destroying|task workspace|destroyed|created vm|started)/i.test(s) ||
      / failed:/.test(s) ||
      s.startsWith("rename")
    ) {
      return s;
    }
    return null;
  }, [statusLine, submitting]);

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box>
        <Text>
          <Text color="blueBright" bold>cmux-freestyle-hq</Text>
          <Text color={COLORS.muted}>
            {`  ·  ${freestyle.isEnabled() ? "freestyle " + (freestyle.apiKey?.slice(0, 6) ?? "?") + "…" : "no FREESTYLE_API_KEY"}`}
            {`  ·  socket ${oneLinePreview(resolvedSocketPath, 36)}`}
          </Text>
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <WorkspaceList
          rows={visibleRows}
          workspaces={workspaces}
          vmsById={vmsById}
          vmHeaderLabel={vmHeaderLabel}
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface ParsedSlashCommand {
  readonly name: string;
  readonly count: number;
  readonly prompt: string;
}

/**
 * Parse '/fork [N] <prompt>' / '/spawn [N] <prompt>' style commands.
 * Returns null when the text isn't a known slash command.
 *
 * Examples:
 *   '/fork build a snake game'      -> { name: 'fork', count: 1, prompt: 'build a snake game' }
 *   '/fork 5 try harder'            -> { name: 'fork', count: 5, prompt: 'try harder' }
 *   '/spawn 3 implement caching'    -> { name: 'spawn', count: 3, prompt: 'implement caching' }
 *   '/fork'                         -> { name: 'fork', count: 1, prompt: '' }
 */
function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.match(/^\/([a-z][a-z0-9-]*)(?:\s+(.*))?$/i);
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  if (name !== "fork" && name !== "spawn") return null;
  const rest = (match[2] ?? "").trim();
  let count = 1;
  let prompt = rest;
  const countMatch = rest.match(/^(\d{1,3})(?:\s+(.*))?$/);
  if (countMatch) {
    count = Math.max(1, Math.min(32, Number.parseInt(countMatch[1]!, 10)));
    prompt = (countMatch[2] ?? "").trim();
  }
  return { name, count, prompt };
}

/**
 * Set up the right side of a task workspace:
 *   - Top right: terminal that ssh's into the VM and tails the dev log
 *     (`tail -F /tmp/cmux-dev.log`), so the user sees the dev server boot.
 *   - Once the forwarded dev port responds, split that tail surface
 *     downward (so the layout becomes: top=tail, bottom=browser) and
 *     point the browser at http://127.0.0.1:<devPort>.
 *
 * Fire-and-forget; the caller awaits the initial pane creation, but the
 * port poll + browser split happen in the background so the cmux-home
 * composer is unblocked.
 */
async function openTaskRightSide(opts: {
  client: CmuxClient;
  workspaceId: string;
  vmId: string;
  devPort: number;
  setStatusLine: (s: string) => void;
}): Promise<void> {
  const { client, workspaceId, vmId, devPort, setStatusLine } = opts;
  let tailSurface: string | null = null;
  try {
    const tail = await client.createTerminalPane({
      workspaceId,
      direction: "right",
      focus: false,
    });
    if (tail) {
      tailSurface = tail.surfaceRef;
      // Boot the dev-log tail in the new pane. Pre-pend a `clear` so old
      // shell noise doesn't show.
      const tailCmd = `clear && node ${shellQuote(VM_SSH_SCRIPT)} ${shellQuote(vmId)} --attach-dev-tail\n`;
      // Small grace period so the new terminal's shell is ready to accept
      // input; without it the first `cmux send-text` lands before bash is
      // up and the command gets eaten.
      await new Promise<void>((r) => setTimeout(r, 700));
      try {
        await client.sendText(tail.surfaceRef, tailCmd);
      } catch (err) {
        setStatusLine(`tail send failed: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    setStatusLine(`tail pane failed: ${(err as Error).message}; opening browser anyway`);
  }

  // Wait for the dev server on the SSH-forwarded mac port before opening
  // the browser pane. This avoids the browser sitting on a 'connection
  // refused' screen while the VM bootstraps.
  void (async () => {
    const ready = await waitForLocalPort(devPort, 180_000);
    if (!ready) {
      setStatusLine(`dev :${devPort} not ready after 3 min; opening browser anyway`);
    }
    try {
      if (tailSurface) {
        await client.splitSurface({
          workspaceId,
          surfaceRef: tailSurface,
          direction: "down",
          type: "browser",
          url: `http://127.0.0.1:${devPort}`,
          focus: false,
        });
      } else {
        await client.createBrowserPane({
          workspaceId,
          url: `http://127.0.0.1:${devPort}`,
          direction: "right",
          focus: false,
        });
      }
    } catch (err) {
      setStatusLine(`browser pane failed: ${(err as Error).message}`);
    }
  })();
}

async function waitForLocalPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/`;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1_500);
      try {
        // Any response (even 500) means the dev server is listening.
        await fetch(url, { signal: ctrl.signal });
        return true;
      } finally {
        clearTimeout(t);
      }
    } catch {
      // ECONNREFUSED / abort: not ready yet
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

async function waitForFreestyleHealthz(
  vmId: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const url = `https://${vmId}.vm.freestyle.sh/healthz`;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3_000);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (res.ok) return true;
      } finally {
        clearTimeout(t);
      }
    } catch {
      // not ready yet
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
  }
  return false;
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

