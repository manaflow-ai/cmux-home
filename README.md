# cmux-home

Minimal Rust TUI for starting Claude/Codex cmux workspaces and watching their live status.

## Run

From inside a cmux-launched shell:

```bash
cargo run --release
```

Or point it at a cmux socket:

```bash
cargo run --release -- --socket /tmp/cmux.sock
```

## Keys

- `Tab` switches Claude/Codex.
- `Shift+Tab` toggles plan mode.
- `Enter` opens the selected workspace or creates a new one from the composer.
- `Ctrl+R` renames the selected workspace.
- `Ctrl+S` restores the latest stash.
- `/stash` opens persisted stashes.
- `Ctrl+J` or `Shift+Enter` inserts a newline.
- `Ctrl+Q`, double `Ctrl+C`, or double `Ctrl+D` quits.

## How It Updates

`cmux-home` uses cmux `events.stream` for responsive updates. It patches common events directly:

- workspace create, select, rename, close
- notification create, read, remove, clear
- sidebar status set, clear, reset

Surface and pane events refresh only the affected workspace. A full snapshot is still used for startup and fallback resync.

## Notes

This is an early dogfood tool. It expects cmux socket APIs such as `workspace.list`, `notification.list`, `surface.read_text`, `sidebar_state`, and `events.stream`.
