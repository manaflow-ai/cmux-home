import React from "react";
import { Box, Text } from "ink";
import type { AgentKind } from "./types.js";
import { AGENT_COLOR, COLORS } from "./format.js";

export interface HelpBarProps {
  readonly mode: "workspace" | "composer" | "rename" | "vm" | "vm-header";
  readonly provider: AgentKind;
  readonly planMode: boolean;
  readonly composerSlashActive: boolean;
  readonly selectedIsGroup: boolean;
  readonly showShortcuts: boolean;
  readonly statusOverride: string | null; // for "press ctrl+X to quit"
  // When mode === "vm", which state the highlighted VM is in. Drives the
  // per-row hint text so the user knows which keys are meaningful right now.
  readonly selectedVmState?:
    | "starting"
    | "running"
    | "suspending"
    | "suspended"
    | "stopped"
    | "lost"
    | null;
}

function toggleAgent(kind: AgentKind): AgentKind {
  return kind === "codex" ? "claude" : "codex";
}

function vmHintText(state: NonNullable<HelpBarProps["selectedVmState"]> | null): string {
  switch (state) {
    case "running":
      return " · enter cmux ssh in · ctrl+f fork into new VM · ctrl+o local workspace · ctrl+x destroy · type a task above to spawn another";
    case "starting":
      return " · vm is starting… · ctrl+x destroy (cancel) · type a task above to spawn another";
    case "suspending":
      return " · vm is suspending… · type a task above to spawn another";
    case "suspended":
      return " · enter to resume + cmux ssh in · ctrl+x destroy · type a task above to spawn another";
    case "stopped":
      return " · enter to start + cmux ssh in · ctrl+x destroy · type a task above to spawn another";
    case "lost":
      return " · vm is lost (gateway unreachable) · ctrl+x destroy · type a task above to spawn another";
    default:
      return " · enter open sandbox · ctrl+f fork · ctrl+o local workspace · ctrl+x destroy · ? for shortcuts";
  }
}

function planLabel(planMode: boolean): string {
  return planMode ? "build" : "plan";
}

function planColor(label: string): string {
  return label === "plan" ? COLORS.purple : COLORS.muted;
}

function CurrentMode({
  provider,
  planMode,
}: {
  provider: AgentKind;
  planMode: boolean;
}): React.JSX.Element {
  const modeLabel = planMode ? "plan" : "build";
  const modeColor = planMode ? COLORS.purple : COLORS.muted;
  return (
    <>
      <Text color={COLORS.muted}>{"  "}</Text>
      <Text color={AGENT_COLOR[provider]}>{provider}</Text>
      <Text color={COLORS.muted}> </Text>
      <Text color={modeColor}>{modeLabel}</Text>
    </>
  );
}

export const HelpBar = React.memo(HelpBarBase);

function HelpBarBase(props: HelpBarProps): React.JSX.Element {
  if (props.showShortcuts) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={COLORS.muted}>
            {"  ctrl+r to rename          ctrl+t to pin to top    ctrl+q to quit"}
          </Text>
        </Box>
        <Box>
          <Text color={COLORS.muted}>
            {"  ctrl+s to stash           alt+1-6 to open         esc/? to main"}
          </Text>
        </Box>
      </Box>
    );
  }

  if (props.statusOverride) {
    return (
      <Box>
        <Text color={COLORS.muted}>{`  ${props.statusOverride}`}</Text>
      </Box>
    );
  }

  if (props.mode === "rename") {
    return (
      <Box>
        <Text color={COLORS.muted}>
          {"  renaming workspace · enter rename · esc cancel"}
        </Text>
      </Box>
    );
  }

  if (props.mode === "composer") {
    if (props.composerSlashActive) {
      return (
        <Box>
          <CurrentMode provider={props.provider} planMode={props.planMode} />
          <Text color={COLORS.muted}>{" · enter run · tab complete · esc clear"}</Text>
        </Box>
      );
    }
    return (
      <Box>
        <CurrentMode provider={props.provider} planMode={props.planMode} />
        <Text color={COLORS.muted}>
          {" · enter spawn cloud sandbox · /fork [N] <prompt> · /spawn N <prompt> · tab switch agent · esc clear"}
        </Text>
      </Box>
    );
  }

  if (props.mode === "vm") {
    return (
      <Box>
        <CurrentMode provider={props.provider} planMode={props.planMode} />
        <Text color={COLORS.muted}>{vmHintText(props.selectedVmState ?? null)}</Text>
      </Box>
    );
  }
  if (props.mode === "vm-header") {
    return (
      <Box>
        <CurrentMode provider={props.provider} planMode={props.planMode} />
        <Text color={COLORS.muted}>
          {" · enter new VM from FREESTYLE_SANDBOX_SNAPSHOT · type a task above to spawn a sandbox · ? for shortcuts"}
        </Text>
      </Box>
    );
  }
  const prefix = props.selectedIsGroup
    ? "enter to collapse · ctrl+x to delete all"
    : "enter to open · space to reply · ctrl+x to delete";
  const toggle = toggleAgent(props.provider);
  const plan = planLabel(props.planMode);
  return (
    <Box>
      <CurrentMode provider={props.provider} planMode={props.planMode} />
      <Text color={COLORS.muted}>{` · ${prefix}`}</Text>
      <Text color={COLORS.muted}>{" · tab "}</Text>
      <Text color={AGENT_COLOR[toggle]}>{toggle}</Text>
      <Text color={COLORS.muted}>{" · shift+tab "}</Text>
      <Text color={planColor(plan)}>{plan}</Text>
      <Text color={COLORS.muted}>{" · ? for shortcuts"}</Text>
    </Box>
  );
}
