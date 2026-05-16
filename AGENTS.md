# cmux-home

Build and test Rust changes with the release profile:

```bash
cargo test --release --manifest-path cmux-home/Cargo.toml
cargo build --release --manifest-path cmux-home/Cargo.toml
```

When working from the `cmuxterm-hq` checkout, reload the dogfood workspace before handoff:

```bash
CMUX_HOME_FOCUS=false ./scripts/dogfood-cmux-home.sh
```

Use the existing right-side helper pane, preserve focus, and verify the new surface with `cmux read-screen`.
