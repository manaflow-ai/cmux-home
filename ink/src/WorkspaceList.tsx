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
  padEnd,
  timeAgo,
  truncate,
} from "./format.js";

export type ListRow =
  | { kind: "header"; state: AgentState; label: string }
  | { kind: "workspace"; workspaceIndex: number }
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
  return !!row && (row.kind === "header" || row.kind === "workspace");
}

export interface WorkspaceListProps {
  readonly rows: ListRow[];
  readonly workspaces: ReadonlyArray<Workspace>;
  readonly selectedIndex: number;
  readonly scroll: number;
  readonly height: number;
  readonly width: number;
  readonly spinnerTick: number;
}

export function WorkspaceList(props: WorkspaceListProps): React.JSX.Element {
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
        const ws = props.workspaces[row.workspaceIndex]!;
        return (
          <WorkspaceRow
            key={`w-${ws.id}-${index}`}
            workspace={ws}
            selected={selected}
            width={props.width}
            spinnerTick={props.spinnerTick}
          />
        );
      })}
    </Box>
  );
}

function HeaderRow({
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
}

function WorkspaceRow({
  workspace,
  selected,
  width,
  spinnerTick,
}: {
  workspace: Workspace;
  selected: boolean;
  width: number;
  spinnerTick: number;
}): React.JSX.Element {
  const state = agentState(workspace);
  const group = displayGroup(state);
  const age = timeAgo(workspace.updatedAt);

  const unreadText =
    workspace.unreadNotifications > 0 || group === "needs-attention" ? "  ∙" : "   ";
  const marker =
    group === "working"
      ? SPINNER_FRAMES[spinnerTick % SPINNER_FRAMES.length]!
      : group === "needs-attention"
        ? " "
        : "∙";

  const titleWidth = 28;
  const unreadWidth = cellWidth(unreadText);
  const markerWidth = cellWidth(marker) + 1; // marker + space
  const ageLen = cellWidth(age);
  const fixedWidth = unreadWidth + markerWidth + titleWidth + 2 + ageLen;
  const messageWidth = Math.max(8, width - fixedWidth);
  const title = padEnd(truncate(workspace.title, titleWidth), titleWidth);
  const message = truncate(workspace.latestMessage, messageWidth);
  const messageLen = cellWidth(message);
  const gap = Math.max(
    1,
    width - (unreadWidth + markerWidth + titleWidth + 1 + messageLen) - ageLen,
  );
  const pad = " ".repeat(gap);
  const trailing = Math.max(
    0,
    width -
      (unreadWidth + markerWidth + titleWidth + 1 + messageLen + pad.length + ageLen),
  );

  const baseColor = COLORS.muted;
  const baseBg = selected ? COLORS.selectedBg : undefined;
  const titleColor = selected ? COLORS.selectedTitleFg : COLORS.muted;
  const unreadColor = COLORS.unread;
  const markerSegment = `${marker} `;
  const tailSegment = ` ${message}${pad}${age}${" ".repeat(trailing)}`;

  return (
    <Box>
      <Text>
        <Text color={unreadColor} backgroundColor={baseBg}>{unreadText}</Text>
        <Text color={baseColor} backgroundColor={baseBg}>{markerSegment}</Text>
        <Text color={titleColor} backgroundColor={baseBg}>{title}</Text>
        <Text color={baseColor} backgroundColor={baseBg}>{tailSegment}</Text>
      </Text>
    </Box>
  );
}

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

