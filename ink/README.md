# cmux-home (Ink)

TypeScript/Ink TUI for browsing cmux workspaces and spawning Claude/Codex tasks. Intended for users who already have Node 20+ or Bun on `PATH` and would rather not install Rust.

## Run

```bash
cd cmux-home/ink
bun install        # or: npm install
bun dev            # or: npx tsx src/index.tsx
```

Or invoke through the bin wrapper from anywhere:

```bash
./bin/cmux-home.mjs --socket "$CMUX_SOCKET_PATH"
```

It auto-discovers the cmux socket from `CMUX_SOCKET_PATH`, falling back to `/tmp/cmux.sock`. Run it inside an active cmux session and the env var is set for you.

## Keys

- `Tab` switches Codex / Claude.
- `Shift+Tab` toggles plan mode.
- `Enter` submits the composer text as a new cmux workspace running the selected agent.
- `↑` / `↓` move selection in the workspace list.
- `Ctrl+R` forces a snapshot refresh.
- `Ctrl+Q`, `Ctrl+D`, or a double `Ctrl+C` quits.

## How it talks to cmux

The CLI dials cmux's local Unix socket and speaks the same JSON-RPC the Rust version uses:

- `workspace.list`, `notification.list` for the initial snapshot and after debounced refreshes.
- `workspace.create`, `workspace.prompt_submit` for the composer.
- `events.stream` (with auto-reconnect) for live updates.

The MVP is intentionally smaller than the Rust impl: no persisted drafts, no stash list, no image attachments, no rename hooks, no mouse support. Those can land incrementally on top of the same components.

## Relationship to the Rust crate

The Rust crate at the repo root is the source of truth for the feature set today. This Ink port covers the most common path (browse → compose → submit) so that JavaScript-only environments can dogfood cmux without a Rust toolchain. The Rust crate stays in place; both can coexist until one is preferred.
