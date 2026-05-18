# cmux-home

Build and test Rust changes with the release profile:

```bash
cargo test --release --manifest-path cmux-home/Cargo.toml
cargo build --release --manifest-path cmux-home/Cargo.toml
```

When working from the `cmuxterm-hq` checkout, every change must reload
`$cmux-workspace` before handoff, including docs and skill changes:

```bash
CMUX_HOME_FOCUS=false ./scripts/dogfood-cmux-home.sh
```

Use the current caller workspace from `CMUX_WORKSPACE_ID` / `cmux identify`,
reuse the existing right-side helper pane, preserve focus, and verify the new
surface with `cmux read-screen`, `cmux surface-health`, and `cmux top`.

If the non-focus launch creates an unattached terminal surface, clean it up.
For this cmux-home reload handoff only, briefly materialize the caller
workspace to attach the TUI, verify it, then restore the workspace and surface
that were focused before the reload.
