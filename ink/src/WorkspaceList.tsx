import React from "react";
import { Box, Text } from "ink";
import type { AgentState, Workspace } from "./types.js";
import {
  COLORS,
  GROUP_DEFINITIONS,
  SPINNER_FRAMES,
  agentState,
  cellWidth,
  displayGroup,
  oneLinePreview,
  padEnd,
  timeAgo,
  truncate,
} from "./format.js";

export type ListRow =
  | { kind: "header"; state: AgentState; label: string }
  | { kind: "workspace"; workspaceIndex: number; depth?: number }
  | { kind: "vm-header" }
  | { kind: "vm"; vmId: string; depth?: number }
  | { kind: "blank" };

export function buildVisibleRows(
  workspaces: ReadonlyArray<Workspace>,
  collapsed: ReadonlySet<AgentState>,
): ListRow[] {
  const rows: ListRow[] = [];
  for (const { state, label } of GROUP_DEFINITIONS) {
    const indexes: number[] = [];
    workspaces.forEach((ws, i) => {
      if (displayGroup(agentState(ws)) === state) indexes.push(i);
    });
    if (indexes.length === 0) continue;
    if (rows.length > 0) rows.push({ kind: "blank" });
    const suffix = collapsed.has(state) ? " collapsed" : "";
    rows.push({
      kind: "header",
      state,
      label: `${label} (${indexes.length})${suffix}`,
    });
    if (!collapsed.has(state)) {
      for (const i of indexes) rows.push({ kind: "workspace", workspaceIndex: i });
    }
  }
  return rows;
}

export function isSelectableRow(row: ListRow | undefined): boolean {
  return (
    !!row &&
    (row.kind === "header" ||
      row.kind === "workspace" ||
      row.kind === "vm-header" ||
      row.kind === "vm")
  );
}

export interface VmRowEntry {
  readonly id: string;
  readonly state: "starting" | "running" | "suspending" | "suspended" | "stopped" | "lost";
  readonly snapshotId: string | null;
  readonly lastActivityMs: number | null;
  readonly createdAtMs: number | null;
  readonly persistence: "sticky" | "ephemeral" | "persistent" | null;
}

export interface WorkspaceListProps {
  readonly rows: ListRow[];
  readonly workspaces: ReadonlyArray<Workspace>;
  readonly vmsById: ReadonlyMap<string, VmRowEntry>;
  readonly vmHeaderLabel: string;
  readonly selectedIndex: number;
  readonly scroll: number;
  readonly height: number;
  readonly width: number;
  readonly spinnerTick: number;
}

export const WorkspaceList = React.memo(WorkspaceListBase);

function WorkspaceListBase(props: WorkspaceListProps): React.JSX.Element {
  const slice = props.rows
    .map((row, index) => ({ row, index }))
    .slice(props.scroll, props.scroll + props.height);

  return (
    <Box flexDirection="column">
      {slice.map(({ row, index }) => {
        const selected = index === props.selectedIndex;
        if (row.kind === "blank") {
          return <Box key={`b-${index}`}><Text> </Text></Box>;
        }
        if (row.kind === "header") {
          return (
            <HeaderRow
              key={`h-${row.state}-${index}`}
              label={row.label}
              selected={selected}
              width={props.width}
            />
          );
        }
        if (row.kind === "vm-header") {
          return (
            <HeaderRow
              key={`vh-${index}`}
              label={props.vmHeaderLabel}
              selected={selected}
              width={props.width}
            />
          );
        }
        if (row.kind === "vm") {
          const vm = props.vmsById.get(row.vmId);
          if (!vm) return null;
          // Compute marker string here so static (running / stopped / lost /
          // suspended) rows get a stable string prop — React.memo on VmRow
          // then short-circuits the render for them, and only the
          // starting/suspending rows actually re-render per spinner tick.
          const isMoving = vm.state === "starting" || vm.state === "suspending";
          const marker = isMoving
            ? SPINNER_FRAMES[props.spinnerTick % SPINNER_FRAMES.length]!
            : VM_STATE_GLYPH[vm.state];
          return (
            <VmRow
              key={`vm-${vm.id}-${index}`}
              vm={vm}
              selected={selected}
              width={props.width}
              marker={marker}
              depth={row.depth ?? 0}
            />
          );
        }
        const ws = props.workspaces[row.workspaceIndex]!;
        const wsState = agentState(ws);
        const wsGroup = displayGroup(wsState);
        const wsMarker =
          wsGroup === "working"
            ? SPINNER_FRAMES[props.spinnerTick % SPINNER_FRAMES.length]!
            : wsGroup === "needs-attention"
              ? " "
              : "∙";
        return (
          <WorkspaceRow
            key={`w-${ws.id}-${index}`}
            workspace={ws}
            selected={selected}
            width={props.width}
            marker={wsMarker}
            depth={row.depth ?? 0}
          />
        );
      })}
    </Box>
  );
}

const VM_STATE_GLYPH: Record<VmRowEntry["state"], string> = {
  starting: "·",
  running: "●",
  suspending: "·",
  suspended: "◐",
  stopped: "○",
  lost: "?",
};

const VM_STATE_COLOR: Record<VmRowEntry["state"], string> = {
  starting: COLORS.purple,
  running: COLORS.codex,
  suspending: COLORS.muted,
  suspended: COLORS.muted,
  stopped: COLORS.muted,
  lost: COLORS.unread,
};

const VmRow = React.memo(function VmRow({
  vm,
  selected,
  width,
  marker,
  depth = 0,
}: {
  vm: VmRowEntry;
  selected: boolean;
  width: number;
  marker: string;
  depth?: number;
}): React.JSX.Element {
  const baseBg = selected ? COLORS.selectedBg : undefined;
  const baseColor = COLORS.muted;
  const titleColor = selected ? COLORS.selectedTitleFg : COLORS.muted;
  const stateColor = VM_STATE_COLOR[vm.state];

  const indent = depth > 0 ? "  ".repeat(depth - 1) + "└─ " : "";
  const indentWidth = cellWidth(indent);
  const idWidth = Math.max(8, 22 - indentWidth);
  const stateWidth = 11;
  const snapshotWidth = 24;
  const ageStr = timeAgo(vm.lastActivityMs ?? vm.createdAtMs);
  const ageLen = cellWidth(ageStr);
  const id = padEnd(truncate(vm.id, idWidth), idWidth);
  const stateLabel = padEnd(vm.state, stateWidth);
  const snapshotLabel = padEnd(
    truncate(vm.snapshotId ?? "no snapshot", snapshotWidth),
    snapshotWidth,
  );
  // Layout: "   " + marker + " " + indent + id + " " + state + " " + snapshot + <pad> + age
  // The trailing age is right-flushed against the screen edge.
  const prefix = `   ${marker} `; // 3 + 2 = 5 cells
  const prefixWidth = cellWidth(prefix);
  const midSegment = ` ${stateLabel} ${snapshotLabel}`;
  const midWidth = cellWidth(midSegment);
  const usedWidth = prefixWidth + indentWidth + idWidth + midWidth + ageLen;
  const padBeforeAge = Math.max(1, width - usedWidth);

  return (
    <Box>
      <Text>
        <Text color={baseColor} backgroundColor={baseBg}>{"   "}</Text>
        <Text color={stateColor} backgroundColor={baseBg}>{`${marker} `}</Text>
        {indent ? (
          <Text color={baseColor} backgroundColor={baseBg}>{indent}</Text>
        ) : null}
        <Text color={titleColor} backgroundColor={baseBg}>{id}</Text>
        <Text color={baseColor} backgroundColor={baseBg}>{midSegment}</Text>
        <Text color={baseColor} backgroundColor={baseBg}>{" ".repeat(padBeforeAge)}</Text>
        <Text color={baseColor} backgroundColor={baseBg}>{ageStr}</Text>
      </Text>
    </Box>
  );
});

function padStart(text: string, width: number): string {
  const w = cellWidth(text);
  if (w >= width) return text;
  return " ".repeat(width - w) + text;
}

const HeaderRow = React.memo(function HeaderRow({
  label,
  selected,
  width,
}: {
  label: string;
  selected: boolean;
  width: number;
}): React.JSX.Element {
  const text = padEnd(label, width);
  if (selected) {
    return (
      <Box>
        <Text color={COLORS.selectedTitleFg} backgroundColor={COLORS.selectedBg}>
          {text}
        </Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text color={COLORS.muted}>{text}</Text>
    </Box>
  );
});

const WorkspaceRow = React.memo(function WorkspaceRow({
  workspace,
  selected,
  width,
  marker,
  depth = 0,
}: {
  workspace: Workspace;
  selected: boolean;
  width: number;
  marker: string;
  depth?: number;
}): React.JSX.Element {
  const state = agentState(workspace);
  const group = displayGroup(state);
  const age = timeAgo(workspace.updatedAt);

  const unreadText =
    workspace.unreadNotifications > 0 || group === "needs-attention" ? "  ∙" : "   ";

  const indent = depth > 0 ? "  ".repeat(depth - 1) + "└─ " : "";
  const indentWidth = cellWidth(indent);
  const titleWidth = Math.max(8, 28 - indentWidth);
  const unreadWidth = cellWidth(unreadText);
  const markerWidth = cellWidth(marker) + 1; // marker + space
  const ageLen = cellWidth(age);
  // Layout: unread + marker + indent + title + " " + message + <pad> + age
  // Age is flush right against the edge.
  const usedFixedWidth = unreadWidth + markerWidth + indentWidth + titleWidth + 1 + ageLen;
  const messageWidth = Math.max(8, width - usedFixedWidth - 1);
  const title = padEnd(oneLinePreview(workspace.title, titleWidth), titleWidth);
  const message = oneLinePreview(workspace.latestMessage, messageWidth);
  const messageLen = cellWidth(message);
  const padBeforeAge = Math.max(
    1,
    width - (unreadWidth + markerWidth + indentWidth + titleWidth + 1 + messageLen) - ageLen,
  );
  const pad = " ".repeat(padBeforeAge);

  const baseColor = COLORS.muted;
  const baseBg = selected ? COLORS.selectedBg : undefined;
  const titleColor = selected ? COLORS.selectedTitleFg : COLORS.muted;
  const unreadColor = COLORS.unread;
  const markerSegment = `${marker} `;
  const tailSegment = ` ${message}${pad}${age}`;

  return (
    <Box>
      <Text>
        <Text color={unreadColor} backgroundColor={baseBg}>{unreadText}</Text>
        <Text color={baseColor} backgroundColor={baseBg}>{markerSegment}</Text>
        {indent ? (
          <Text color={baseColor} backgroundColor={baseBg}>{indent}</Text>
        ) : null}
        <Text color={titleColor} backgroundColor={baseBg}>{title}</Text>
        <Text color={baseColor} backgroundColor={baseBg}>{tailSegment}</Text>
      </Text>
    </Box>
  );
});

export function selectableRowBefore(rows: ListRow[], selected: number): number {
  for (let i = selected - 1; i >= 0; i -= 1) {
    if (isSelectableRow(rows[i])) return i;
  }
  return selected;
}

export function selectableRowAfter(rows: ListRow[], selected: number): number {
  for (let i = selected + 1; i < rows.length; i += 1) {
    if (isSelectableRow(rows[i])) return i;
  }
  return selected;
}

