# Customizing cmux-home

`cmux-home` is a launcher whose workflow policy lives in shell scripts. The default config can start Codex and Claude. Your config can start any shell script that knows how to prepare a workspace and run an agent.

Use this when your parallel work does not fit one built-in pattern:

- Git worktrees
- many local checkouts
- SSH hosts
- cloud VMs
- local service stacks
- browser previews
- review and CI dashboards

## Config Shape

Pass a JSON config with `--config` or set `CMUX_HOME_CONFIG`:

```json
{
  "agents": {
    "codex": {
      "command": "{codex_bin} --yolo {image_args} {prompt}",
      "plan_command": "{codex_bin} --yolo {image_args} {prompt}",
      "submit_command": "scripts/submit-codex.sh --payload {payload}"
    },
    "claude": {
      "command": "{claude_bin} --dangerously-skip-permissions",
      "plan_command": "{claude_bin} --dangerously-skip-permissions --permission-mode plan",
      "submit_command": "scripts/submit-claude.sh --payload {payload}"
    }
  },
  "rename": {
    "command": "scripts/name-workspace.sh --workspace-id {workspace_id} --prompt {prompt} --title {title} --agent {agent} --mode {mode} --socket {socket}"
  }
}
```

`command` and `plan_command` create the initial terminal command for the new cmux workspace. If the command contains `{prompt}`, `cmux-home` assumes the agent receives the prompt as part of startup. If it does not contain `{prompt}`, `cmux-home` starts the command first and then runs `submit_command` in the background.

Available command placeholders:

- `{prompt}`: shell-quoted prompt text
- `{workspace_cwd}`: shell-quoted cwd passed to `cmux-home`
- `{codex_bin}`: shell-quoted Codex executable path
- `{claude_bin}`: shell-quoted Claude executable path
- `{terminal_path}`: shell-quoted original `PATH`
- `{image_args}`: raw Codex-style `--image <path>` arguments
- `{codex_env}`: raw Codex environment forwarding arguments
- `{claude_env}`: raw Claude environment forwarding arguments

Available submit hook placeholders:

- `{payload}`: shell-quoted path to a JSON payload
- `{workspace_id}`: shell-quoted cmux workspace id
- `{socket}`: shell-quoted cmux socket path

The submit payload contains:

```json
{
  "workspace_id": "workspace:123",
  "prompt": "fix the failing test",
  "title": "codex: fix the failing test",
  "agent": "codex",
  "mode": "build",
  "workspace_cwd": "/path/to/repo",
  "socket": "/path/to/cmux.sock",
  "images": ["/tmp/example.png"]
}
```

## Worktree Starter

Use a worktree script when each task should get an isolated checkout:

```json
{
  "agents": {
    "codex": {
      "command": "scripts/start-worktree-codex.sh --root {workspace_cwd} --codex {codex_bin} --prompt {prompt} -- {image_args}"
    }
  }
}
```

Example script:

```bash
#!/usr/bin/env bash
set -euo pipefail

root=""
codex="codex"
prompt=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) root="$2"; shift 2 ;;
    --codex) codex="$2"; shift 2 ;;
    --prompt) prompt="$2"; shift 2 ;;
    --) shift; break ;;
    *) shift ;;
  esac
done

slug="$(printf '%s' "$prompt" | tr -cs '[:alnum:]' '-' | tr '[:upper:]' '[:lower:]' | sed 's/^-//;s/-$//' | cut -c 1-48)"
slug="${slug:-task-$(date +%s)}"
worktree="$root/worktrees/$slug"

mkdir -p "$root/worktrees"
git -C "$root/repo" worktree add "$worktree" -b "$slug"
cd "$worktree"
exec "$codex" --yolo "$@" "$prompt"
```

## Multiple Checkouts

Use a selector script when a person already keeps many clones:

```json
{
  "agents": {
    "codex": {
      "command": "scripts/start-checkout-codex.sh --base ~/src/cmux-checkouts --codex {codex_bin} --prompt {prompt} -- {image_args}"
    }
  }
}
```

The script can pick the first clean checkout, create one when needed, or use a naming convention such as `cmux0`, `cmux1`, and `cmux2`.

## SSH or VM Starter

Use SSH when the workspace should live on a remote machine:

```json
{
  "agents": {
    "claude": {
      "command": "scripts/start-remote-claude.sh --host devbox --prompt {prompt}"
    }
  }
}
```

The script can provision a VM, copy prompt assets, then `ssh -t` into the host and run Claude or Codex there. Keep the terminal process attached so cmux can display logs and preserve scrollback.

## Multi-Pane Setup

The command starts inside the new cmux workspace. cmux terminals expose workspace and socket environment such as `CMUX_WORKSPACE_ID` and `CMUX_SOCKET_PATH`. A bootstrap script can add panes after startup:

```bash
cmux new-pane --workspace "$CMUX_WORKSPACE_ID" --type terminal --direction right --focus false
cmux new-pane --workspace "$CMUX_WORKSPACE_ID" --type browser --direction down --url "http://127.0.0.1:3000" --focus false
exec codex --yolo "$prompt"
```

This is the simplest way to make one prompt fan out into an agent, a test watcher, logs, and a browser preview.

## Rename Hook

The rename hook can use a cheap local heuristic or an agent. It should finish by renaming the cmux workspace:

```bash
payload="$(
  python3 - "$workspace_id" "$title" <<'PY'
import json
import sys

print(json.dumps({"workspace_id": sys.argv[1], "title": sys.argv[2]}))
PY
)"
cmux rpc workspace.rename "$payload"
```

Keep title generation best-effort. The workspace should be useful even if naming fails.

## Design Guidance

- Keep the TUI minimal. Put workflow policy in shell scripts.
- Make scripts idempotent enough to survive a retry.
- Persist prompts before doing slow work.
- Keep visible work in cmux terminals and browsers.
- Prefer cmux CLI and socket APIs over hidden background processes.
- Use `events.stream` for liveness and snapshots for recovery.
