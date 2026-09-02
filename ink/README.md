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

## Remote VM security assumptions

The Freestyle attach path installs `cmuxd-remote` and Tailscale only from
reviewed, versioned artifacts in `remote-artifacts.json`. The optional cmux
checkout also uses a reviewed commit from that file, never a moving branch.
Each download is
rejected unless its embedded SHA-256 digest matches the architecture-specific
value. The WebSocket daemon runs as the `cmux` user and binds to the private
IPv4 address selected by the route to the public network. Wildcard, loopback,
public, and IPv6 listeners are rejected. The launcher has no operator-writable
environment-file override, so a deployment that needs a different interface
must update the reviewed launcher and redeploy it as a root-owned file.

Task browser previews use a deterministic loopback port in the 30000-39999
range for each VM. The dev pane opens an authenticated SSH forward from
`127.0.0.1:<port>` on the Mac to `127.0.0.1:3000` on the VM with
`ExitOnForwardFailure`; the browser split sets `bypass_remote_proxy` so the
loopback URL uses that forward. A local port collision fails closed. Do not
run two task workspaces for the same VM at the same time.

The default WebSocket bootstrap requires the VM to already be authenticated to
Tailscale. This is deliberate: an auth key must never appear in a generated
command, process argument list, shell history, or log. To transfer a one-time
key through Freestyle's file API, set both variables below only after
confirming that your provider contract does not retain request bodies:

```sh
CMUX_HOME_ALLOW_PROVIDER_SECRET_FILE_TRANSFER=1
CMUX_HOME_PROVIDER_SECRET_REDACTION_ACK=freestyle-file-api-v1
```

The helper then writes a random `/run/cmux-home/ts-auth-*` file with mode 0600,
uses Tailscale's `file:` auth-key form, and removes it with a trap. Inline
`--tailscale-authkey` values are rejected. WebSocket lease metadata is
different: it contains only a SHA-256 hash of a random lease token, not the
token itself. It is written through the provider file API into a root-only
staging directory and moved atomically to `/run/cmuxd` with mode 0600 and
owner `cmux`. No lease token or base64 payload is sent in a command. If the
provider cannot make the redaction guarantee for the auth-key or prompt file,
leave the opt-in unset and pre-authenticate the VM, or use a transport that
does not require this extension.

SSH host verification uses a private persistent `known_hosts` file with
`accept-new` (TOFU) by default. Set `CMUX_FREESTYLE_SSH_HOST_KEY` to pin a
specific `vm-ssh.freestyle.sh` key. SSH and cmux RPC credentials use protected
files or the authenticated Unix socket, and child processes receive a
sanitized environment.

Subrouter configuration accepts the approved team tailnet endpoint by default.
Loopback is allowed only with `--reverse-subrouter`. A custom endpoint needs
`--allow-untrusted-subrouter` (or `CMUX_HOME_ALLOW_UNTRUSTED_SUBROUTER=1`) and
must still be reviewed by the operator. URLs with credentials, query strings,
fragments, or secret-shaped path segments are rejected. Diagnostics print only
the origin, not the configured path.

The deployment script expects an Ubuntu-like Freestyle image with `systemd`,
`useradd`, `groupadd`, `getent`, `curl`, `base64`, `stat`, a SHA-256 utility,
`tar`, `ip`, and `ss`. It needs permission to install root-owned files and
restart services. A pre-existing non-root `cmux` account is reused; otherwise
the script creates it with `/home/cmux`. The installer creates `/run/cmuxd` as
a root-owned, `cmux`-traversable runtime directory. It is normally cleared on
reboot, and the attach path removes stale lease and prompt files before each
use.

When a prompt is supplied, cmux-home writes it as a one-time 0600
`/run/cmuxd/codex-prompt-<random>.txt` file through the provider file API. The
remote bootstrap validates ownership and mode, feeds the file to `codex exec -`
through standard input, and removes it with an exit trap. Prompt text is never
placed in helper argv, the generated shell command, or diagnostics. This path
requires the same explicit provider redaction acknowledgement as other
secret-bearing file transfers.

## Relationship to the Rust crate

The Rust crate at the repo root is the source of truth for the feature set today. This Ink port covers the most common path (browse → compose → submit) so that JavaScript-only environments can dogfood cmux without a Rust toolchain. The Rust crate stays in place; both can coexist until one is preferred.
