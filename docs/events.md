# cmux Events in cmux-home

`cmux-home` uses `events.stream` as the live update path and cmux snapshots as the recovery path. The goal is a TUI that updates immediately when a workspace starts, finishes, gets renamed, receives a notification, or changes terminal state.

## Startup Snapshot

On startup, `cmux-home` reads the current world once:

- `workspace.list` for workspace identity, title, cwd, selected state, and pins
- `notification.list` for unread counts
- `surface.read_text` for a fallback latest-message preview
- `top --all --no-resources --format tsv` for Codex/Claude tags that identify active sessions and agent status metadata, with a fallback to `top --all --format tsv` for older cmux builds
- `~/.codex/sessions`, `~/.codex/archived_sessions`, and `~/.claude/projects` for JSONL trajectory previews

The snapshot is slower than an event, but it gives the TUI a complete baseline and repairs drift after unknown events.

## Stream Request

The event worker opens the cmux socket and sends one newline-delimited JSON request:

```json
{
  "id": "cmux-home-events",
  "method": "events.stream",
  "params": {
    "include_heartbeats": true,
    "categories": ["workspace", "sidebar", "notification", "surface", "pane"]
  }
}
```

cmux replies with newline-delimited frames. `cmux-home` handles:

- `ack`: stream accepted
- `heartbeat`: keepalive
- `event`: state change
- `error`: stream failure, reconnect after a short delay

## Incremental Patches

The TUI patches these event families without a full refresh:

- `workspace.created`: insert an optimistic workspace row, then refresh that workspace
- `workspace.selected`: update selected flags
- `workspace.renamed`: update the title immediately
- `workspace.closed` and `workspace.deleted`: remove the row
- `notification.created`: increment unread count when unread
- `notification.removed`: decrement unread count when unread
- `notification.read` and `notification.cleared`: decrement unread count
- `sidebar.metadata.updated`: patch sidebar status values
- `sidebar.metadata.cleared` and `sidebar.reset`: clear sidebar status values

The TUI ignores focus-only and layout-only surface or pane events because they
do not change workspace status rows:

- `surface.selected`
- `surface.focused`
- `surface.moved`
- `surface.reordered`
- `pane.focused`
- `pane.resized`
- `pane.swapped`

The TUI asks for a targeted workspace refresh for surface and pane events that
can change a workspace row, terminal preview, or launcher filtering:

- `surface.input_sent`
- `surface.key_sent`
- `surface.created`
- `surface.closed`
- `surface.action`
- `pane.created`
- `pane.closed`
- `pane.broken`
- `pane.joined`

If an event has no usable workspace id, or if the event name is unknown, `cmux-home` takes a full snapshot.

## Status Model

Each workspace is grouped from the best available state:

- unread notifications mean needs input
- sidebar metadata containing running, working, thinking, or busy means working
- sidebar metadata containing idle, done, complete, or completed means completed
- a latest assistant message from Codex/Claude history means needs input
- a latest user message from Codex/Claude history means working

This keeps the UI useful even when an agent does not emit perfect sidebar metadata.

## Optimistic Startup

Submitting a new prompt updates the TUI before cmux finishes creating the workspace:

1. The prompt and images are written to persisted history.
2. A `pending:<timestamp>` workspace appears at the top of the working group.
3. The composer clears so the user can type the next prompt immediately.
4. A background worker calls `workspace.create`.
5. On success, the pending row is replaced with the real workspace id.
6. On failure, the pending row is removed and the prompt remains in history.

This makes enter feel instant while preserving data if the process exits.

## Useful Event API Improvements

These cmux event additions would reduce refreshes and make third-party dashboards easier to write:

- Include a stable `workspace_id` on every workspace, pane, surface, sidebar, and notification event.
- Include a monotonic sequence number or snapshot watermark so clients can detect missed frames.
- Include the post-event workspace title, description, selected state, pinned state, and unread count on workspace and notification events.
- Include changed sidebar metadata keys and final values in one structured payload.
- Include terminal surface tags for active Codex/Claude sessions, such as agent name, session id, cwd, and status.
- Emit a workspace-level latest activity summary when terminal output, notifications, or agent tags change.
- Make event names and payload versions explicit so clients can safely ignore new fields.

`cmux-home` should keep accepting partial event payloads. It is a dogfood client, so it should stay resilient while cmux events evolve.
