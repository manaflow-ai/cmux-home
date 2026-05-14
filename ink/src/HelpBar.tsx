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
}

function toggleAgent(kind: AgentKind): AgentKind {
  return kind === "codex" ? "claude" : "codex";
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

  if (props.statusOverride && props.statusOverride.startsWith("press ctrl+")) {
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
          {" · enter create · ctrl+s stash · tab switch agent · shift+tab switch mode · esc clear"}
        </Text>
      </Box>
    );
  }

  if (props.mode === "vm") {
    return (
      <Box>
        <CurrentMode provider={props.provider} planMode={props.planMode} />
        <Text color={COLORS.muted}>
          {" · enter open sandbox (ssh + subrouter) · ctrl+o open local workspace · ctrl+x destroy · ? for shortcuts"}
        </Text>
      </Box>
    );
  }
  if (props.mode === "vm-header") {
    return (
      <Box>
        <CurrentMode provider={props.provider} planMode={props.planMode} />
        <Text color={COLORS.muted}>
          {" · enter new VM from FREESTYLE_SANDBOX_SNAPSHOT · ? for shortcuts"}
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
