---
name: cmux-home
description: "Use when developing cmux-home, explaining its cmux event-driven Rust TUI, or adapting it into a custom cmux launcher for parallel agent workflows across worktrees, multiple checkouts, SSH hosts, VMs, browsers, or review dashboards."
---

# cmux-home

Use this skill when working on `cmux-home` itself or when helping someone adapt it into their own cmux launcher.

## Core Idea

`cmux-home` is a small composition of cmux primitives:

- cmux workspaces hold tasks
- terminal surfaces run agents and scripts
- browser surfaces can show previews or dashboards
- notifications and sidebar metadata say which workspace needs attention
- the cmux socket API starts work and streams updates
- local shell scripts define the user's workflow policy

This follows the Zen of cmux. cmux gives composable primitives. The developer owns the workflow shape.

## Product Philosophy

Keep `cmux-home` minimal and scriptable.

- The TUI should show status, accept prompts, and get out of the way.
- Workflow opinions belong in config and shell scripts.
- Do not bake in one topology such as Git worktrees.
- Support many valid setups: worktrees, multiple checkouts, SSH, cloud VMs, browser previews, test watchers, review queues, and project-specific dashboards.
- Preserve typed prompts, stashes, image paths, and history before starting slow or fallible work.
- Use optimistic UI for local feedback, then reconcile from cmux events and snapshots.

## Architecture

The Rust TUI lives in `src/`.

- `src/main.rs`: UI state, rendering, input handling, refresh workers, submit workers
- `src/events.rs`: event payload helpers and optimistic event patching helpers
- `src/cmux_client.rs`: newline JSON socket client
- `src/config.rs`: persisted state and JSON config
- `src/commands.rs`: command templating and submit payload files
- `src/skills.rs`: skill discovery for autocomplete
- `src/model.rs`: workspace status and grouping model

Detailed docs:

- Read `docs/events.md` before changing live update behavior.
- Read `docs/customization.md` before changing agent launch, submit hooks, or rename hooks.

## Event Model

`cmux-home` starts with a full snapshot, then follows `events.stream` with categories:

```json
["workspace", "sidebar", "notification", "surface", "pane"]
```

Patch common workspace, notification, and sidebar events directly. Use targeted workspace refreshes for pane and surface events. Use a full refresh for unknown events or events without a workspace id.

Needs input, working, and completed are derived from unread notifications, sidebar metadata, and Codex/Claude JSONL trajectories. Latest assistant messages imply needs input. Latest user messages imply working.

## Customization Pattern

The main extension point is the JSON config:

```json
{
  "agents": {
    "codex": {
      "command": "scripts/start-codex.sh --prompt {prompt} -- {image_args}",
      "plan_command": "scripts/start-codex-plan.sh --prompt {prompt} -- {image_args}",
      "submit_command": "scripts/submit-codex.sh --payload {payload}"
    },
    "claude": {
      "command": "scripts/start-claude.sh",
      "plan_command": "scripts/start-claude-plan.sh",
      "submit_command": "scripts/submit-claude.sh --payload {payload}"
    }
  },
  "rename": {
    "command": "scripts/name-workspace.sh --workspace-id {workspace_id} --prompt {prompt} --title {title}"
  }
}
```

Use `command` when a prompt can be passed on process startup. Use `submit_command` when the app must start first and receive input later. Use `rename.command` for best-effort workspace naming after creation.

To customize parallelization, make the command script prepare the environment, then exec the agent:

- Git worktree: create or reuse a worktree, `cd` into it, exec Codex or Claude.
- Multiple checkouts: choose a checkout, pull or reset according to local policy, exec the agent.
- SSH or VM: provision or select a host, `ssh -t`, then exec the remote agent.
- Multi-pane workspace: call `cmux new-pane` or `cmux new-surface` with `--workspace "$CMUX_WORKSPACE_ID"` before execing the primary agent.
- Browser workflow: open a cmux browser pane for the dev server or issue page.

## Development Workflow

From the `cmux-home` repo root, build and test with the release profile:

```bash
cargo test --release
cargo build --release
```

From a parent checkout that has `cmux-home` as a submodule:

```bash
cargo test --release --manifest-path cmux-home/Cargo.toml
cargo build --release --manifest-path cmux-home/Cargo.toml
```

When working from `cmuxterm-hq`, every change must reload `$cmux-workspace`
before handoff, including docs and skill changes:

```bash
CMUX_HOME_FOCUS=false ./scripts/dogfood-cmux-home.sh
```

Use the current caller workspace from `CMUX_WORKSPACE_ID` / `cmux identify`,
reuse the right-side helper pane, preserve focus, and verify the surface with
`cmux read-screen`, `cmux surface-health`, and `cmux top` before reporting that
the TUI is ready.

If the non-focus launch creates an unattached terminal surface, clean it up.
For this cmux-home reload handoff only, briefly materialize the caller
workspace to attach the TUI, verify it, then restore the workspace and surface
that were focused before the reload.

## Change Guidance

- Keep text short and status-oriented.
- Keep keyboard and mouse behavior consistent with terminal text boxes.
- Avoid blocking the UI thread. Slow cmux calls should go through workers.
- Prefer event patches for responsiveness and snapshot refreshes for correctness.
- Keep custom workflow code out of the core TUI unless it is a generic extension point.
- Do not introduce secrets or user-specific absolute paths in docs, examples, or tests.
