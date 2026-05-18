# cmux-home

Minimal Rust TUI for starting Claude/Codex cmux workspaces and watching their live status.

`cmux-home` is a small example of the Zen of cmux. cmux gives you terminals, browsers, workspaces, splits, tabs, notifications, and a CLI. `cmux-home` composes those primitives into one personal launcher. The launcher is intentionally thin so teams can replace the shell scripts with their own worktree, multi-checkout, SSH, VM, browser, or review workflows.

## Run

From inside a cmux-launched shell:

```bash
cargo run --release
```

Or point it at a cmux socket:

```bash
cargo run --release -- --socket /tmp/cmux.sock
```

With a config file:

```bash
cargo run --release -- --config ./cmux-home.json
```

## What It Does

- Lists cmux workspaces grouped by needs input, working, and completed.
- Shows the latest user or assistant message when Codex/Claude history is available.
- Tracks unread cmux notifications as blue dots.
- Starts new agent workspaces from a multiline composer with image paths.
- Keeps prompt history, stashes, selected agent, selected mode, and the current draft on disk.
- Lets command templates decide how workspaces are created and how prompts are submitted.

## Keys

- `Tab` switches Claude/Codex.
- `Shift+Tab` toggles plan/build mode.
- `Enter` opens the selected workspace or creates a new one from the composer.
- `Ctrl+R` renames the selected workspace.
- `Ctrl+S` stashes the current draft.
- `/stash` opens persisted stashes.
- `/history` opens previous prompts.
- `/`, `$`, and `@` open command, skill, and file suggestions.
- `Ctrl+J` or `Shift+Enter` inserts a newline.
- `Ctrl+Q`, double `Ctrl+C`, or double `Ctrl+D` quits.

## Event-Driven Updates

`cmux-home` keeps the UI current with cmux `events.stream`. It takes a full snapshot on startup, then applies common events incrementally:

- workspace create, select, rename, close, and delete
- notification create, read, remove, and clear
- sidebar status update, clear, and reset
- surface and pane events as targeted workspace refreshes

Unknown events fall back to a full snapshot. Surface and pane changes refresh only the affected workspace when the event includes a workspace id.

Status grouping is derived from three sources:

- cmux unread notifications
- cmux sidebar metadata such as Codex or Claude running/idle state
- Codex and Claude JSONL trajectories, used to show the latest message and infer whether the last speaker was the user or assistant

See [docs/events.md](docs/events.md) for the exact stream request, event categories, fallback behavior, and event API improvements that would make this simpler.

## Customization

`cmux-home` starts work through command templates. The default can launch Codex or Claude directly. A project can replace that with any script:

- create a Git worktree, then start Codex in it
- choose one of many local checkouts
- SSH into a VM and run an agent there
- open extra cmux panes for logs, tests, browsers, or dashboards
- run a rename hook after startup
- submit prompts through a CLI, a socket API, or an app-specific helper

See [docs/customization.md](docs/customization.md) for config examples and script shapes.

## Developer Skill

This repo includes a `$cmux-home` skill at [skills/cmux-home/SKILL.md](skills/cmux-home/SKILL.md). Use it when asking an agent to work on `cmux-home`, explain the philosophy, or adapt it into a custom launcher for another parallel workflow.
