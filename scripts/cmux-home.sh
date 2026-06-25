#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
manifest="$repo_root/Cargo.toml"
binary="$repo_root/target/release/cmux-home"

if [[ ! -f "$manifest" ]]; then
  echo "cmux-home manifest is missing: $manifest" >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required to run cmux-home" >&2
  exit 127
fi

explicit_socket=""
explicit_workspace_cwd=""
explicit_config=""
parse_args=("$@")
index=0
while ((index < ${#parse_args[@]})); do
  arg="${parse_args[$index]}"
  case "$arg" in
    --socket)
      if ((index + 1 < ${#parse_args[@]})); then
        explicit_socket="${parse_args[$((index + 1))]}"
      fi
      index=$((index + 2))
      ;;
    --socket=*)
      explicit_socket="${arg#--socket=}"
      index=$((index + 1))
      ;;
    --workspace-cwd)
      if ((index + 1 < ${#parse_args[@]})); then
        explicit_workspace_cwd="${parse_args[$((index + 1))]}"
      fi
      index=$((index + 2))
      ;;
    --workspace-cwd=*)
      explicit_workspace_cwd="${arg#--workspace-cwd=}"
      index=$((index + 1))
      ;;
    --config)
      if ((index + 1 < ${#parse_args[@]})); then
        explicit_config="${parse_args[$((index + 1))]}"
      fi
      index=$((index + 2))
      ;;
    --config=*)
      explicit_config="${arg#--config=}"
      index=$((index + 1))
      ;;
    --)
      break
      ;;
    *)
      index=$((index + 1))
      ;;
  esac
done

workspace_cwd="${explicit_workspace_cwd:-${CMUX_HOME_WORKSPACE_CWD:-${CMUX_AGENT_TUI_WORKSPACE_CWD:-$PWD}}}"

socket_works() {
  local candidate="$1"
  [[ -n "$candidate" && -S "$candidate" ]] || return 1
  command -v cmux >/dev/null 2>&1 || return 1
  env \
    -u CMUX_SOCKET_PATH \
    -u CMUX_SOCKET \
    -u CMUX_WORKSPACE_ID \
    -u CMUX_SURFACE_ID \
    -u CMUX_TAB_ID \
    -u CMUX_PANEL_ID \
    CMUX_CLI_SENTRY_DISABLED=1 \
    CMUXTERM_CLI_RESPONSE_TIMEOUT_SEC="${CMUX_HOME_SOCKET_PROBE_TIMEOUT_SEC:-0.5}" \
    cmux --socket "$candidate" ping >/dev/null 2>&1
}

socket_works_after_retry() {
  local candidate="$1"
  local attempts="${2:-3}"
  local delay="${3:-0.1}"
  local i
  for ((i = 0; i < attempts; i++)); do
    if socket_works "$candidate"; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

clear_stale_caller_context() {
  unset CMUX_WORKSPACE_ID
  unset CMUX_SURFACE_ID
  unset CMUX_TAB_ID
  unset CMUX_PANEL_ID
}

caller_context_works() {
  local candidate="$1"
  [[ -n "${CMUX_WORKSPACE_ID:-}" || -n "${CMUX_SURFACE_ID:-}" ]] || return 1

  local output
  output="$(env \
    -u CMUX_SOCKET_PATH \
    -u CMUX_SOCKET \
    CMUX_CLI_SENTRY_DISABLED=1 \
    CMUXTERM_CLI_RESPONSE_TIMEOUT_SEC="${CMUX_HOME_SOCKET_PROBE_TIMEOUT_SEC:-0.5}" \
    cmux --socket "$candidate" --id-format both identify --json 2>/dev/null)" || return 1

  CALLER_CONTEXT_JSON="$output" python3 - "${CMUX_WORKSPACE_ID:-}" "${CMUX_SURFACE_ID:-}" <<'PY'
import json
import os
import sys

wanted_workspace, wanted_surface = sys.argv[1:3]
try:
    payload = json.loads(os.environ.get("CALLER_CONTEXT_JSON", ""))
except json.JSONDecodeError:
    sys.exit(1)
caller = payload.get("caller") or {}

def matches(value, *candidates):
    return bool(value) and any(value == candidate for candidate in candidates if candidate)

if wanted_workspace and not matches(
    wanted_workspace,
    caller.get("workspace_id"),
    caller.get("workspace_ref"),
):
    sys.exit(1)
if wanted_surface and not matches(
    wanted_surface,
    caller.get("surface_id"),
    caller.get("surface_ref"),
    caller.get("tab_id"),
    caller.get("tab_ref"),
):
    sys.exit(1)
PY
}

sanitize_socket_slug() {
  printf '%s' "$1" |
    tr '[:upper:]' '[:lower:]' |
    sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

socket_family() {
  case "${CMUX_BUNDLE_ID:-}" in
    com.cmuxterm.app)
      printf 'stable\n'
      ;;
    com.cmuxterm.app.nightly | com.cmuxterm.app.nightly.*)
      printf 'nightly\n'
      ;;
    com.cmuxterm.app.staging | com.cmuxterm.app.staging.*)
      printf 'staging\n'
      ;;
    com.cmuxterm.app.debug | com.cmuxterm.app.debug.*)
      printf 'dev\n'
      ;;
    *)
      if [[ -n "${CMUX_TAG:-}" ]]; then
        printf 'dev\n'
      else
        printf 'stable\n'
      fi
      ;;
  esac
}

socket_slug() {
  case "${CMUX_BUNDLE_ID:-}" in
    com.cmuxterm.app | com.cmuxterm.app.nightly | com.cmuxterm.app.staging)
      printf '\n'
      ;;
    com.cmuxterm.app.nightly.*)
      sanitize_socket_slug "${CMUX_BUNDLE_ID#com.cmuxterm.app.nightly.}"
      ;;
    com.cmuxterm.app.staging.*)
      sanitize_socket_slug "${CMUX_BUNDLE_ID#com.cmuxterm.app.staging.}"
      ;;
    com.cmuxterm.app.debug.*)
      sanitize_socket_slug "${CMUX_BUNDLE_ID#com.cmuxterm.app.debug.}"
      ;;
    com.cmuxterm.app.debug)
      sanitize_socket_slug "${CMUX_TAG:-}"
      ;;
    *)
      sanitize_socket_slug "${CMUX_TAG:-}"
      ;;
  esac
}

socket_marker_files() {
  local family="$1"
  local slug="$2"
  local app_support="$HOME/Library/Application Support/cmux"
  case "$family" in
    stable)
      printf '%s\n' "$app_support/last-socket-path" /tmp/cmux-last-socket-path
      ;;
    nightly)
      if [[ -n "$slug" ]]; then
        printf '%s\n' "$app_support/nightly-${slug}-last-socket-path" "/tmp/cmux-nightly-${slug}-last-socket-path"
      else
        printf '%s\n' "$app_support/nightly-last-socket-path" /tmp/cmux-nightly-last-socket-path
      fi
      ;;
    staging)
      if [[ -n "$slug" ]]; then
        printf '%s\n' "$app_support/staging-${slug}-last-socket-path" "/tmp/cmux-staging-${slug}-last-socket-path"
      else
        printf '%s\n' "$app_support/staging-last-socket-path" /tmp/cmux-staging-last-socket-path
      fi
      ;;
    dev)
      if [[ -n "$slug" ]]; then
        printf '%s\n' "$app_support/dev-${slug}-last-socket-path" "/tmp/cmux-dev-${slug}-last-socket-path"
      else
        printf '%s\n' "$app_support/dev-last-socket-path" /tmp/cmux-dev-last-socket-path
      fi
      ;;
  esac
}

default_socket_candidates() {
  local family="$1"
  local slug="$2"
  case "$family" in
    stable)
      printf '%s\n' \
        "$HOME/Library/Application Support/cmux/cmux.sock" \
        "$HOME/Library/Application Support/cmux/cmux-$(id -u).sock" \
        /tmp/cmux.sock
      ;;
    nightly)
      if [[ -n "$slug" ]]; then
        printf '%s\n' "/tmp/cmux-nightly-${slug}.sock"
      else
        printf '%s\n' /tmp/cmux-nightly.sock
      fi
      ;;
    staging)
      if [[ -n "$slug" ]]; then
        printf '%s\n' "/tmp/cmux-staging-${slug}.sock"
      else
        printf '%s\n' /tmp/cmux-staging.sock
      fi
      ;;
    dev)
      if [[ -n "$slug" ]]; then
        printf '%s\n' "/tmp/cmux-debug-${slug}.sock"
      fi
      printf '%s\n' /tmp/cmux-debug.sock
      ;;
  esac
}

should_discover_debug_sockets() {
  [[ "$(socket_family)" == "dev" ]]
}

path_is_debug_socket() {
  case "$1" in
    /tmp/cmux-debug*.sock | /private/tmp/cmux-debug*.sock)
      return 0
      ;;
  esac
  return 1
}

choose_socket() {
  if [[ -n "$explicit_socket" ]]; then
    export CMUX_SOCKET_PATH="$explicit_socket"
    unset CMUX_SOCKET
    if [[ -n "${CMUX_WORKSPACE_ID:-}" || -n "${CMUX_SURFACE_ID:-}" ]]; then
      if ! caller_context_works "$explicit_socket"; then
        clear_stale_caller_context
      fi
    fi
    return
  fi

  local inherited="${CMUX_SOCKET_PATH:-${CMUX_SOCKET:-}}"
  if socket_works_after_retry "$inherited"; then
    export CMUX_SOCKET_PATH="$inherited"
    unset CMUX_SOCKET
    return
  fi

  local family
  local slug
  family="$(socket_family)"
  slug="$(socket_slug)"
  local candidates=()
  local marker_file
  while IFS= read -r marker_file; do
    [[ -f "$marker_file" ]] || continue
    local last_socket
    last_socket="$(tr -d '\r\n' < "$marker_file")"
    if should_discover_debug_sockets || ! path_is_debug_socket "$last_socket"; then
      candidates+=("$last_socket")
    fi
  done < <(socket_marker_files "$family" "$slug")
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    candidates+=("$candidate")
  done < <(default_socket_candidates "$family" "$slug")

  if should_discover_debug_sockets; then
    local debug_candidates=()
    for candidate in /tmp/cmux-debug-*.sock /private/tmp/cmux-debug-*.sock; do
      [[ -S "$candidate" ]] || continue
      debug_candidates+=("$candidate")
    done
    if ((${#debug_candidates[@]})); then
      while IFS= read -r candidate; do
        candidates+=("$candidate")
      done < <(
        stat -f '%m %N' "${debug_candidates[@]}" 2>/dev/null |
        sort -rn |
        sed 's/^[0-9][0-9]* //'
      )
    fi
  fi

  if [[ -n "$inherited" ]]; then
    if [[ -n "${CMUX_WORKSPACE_ID:-}" || -n "${CMUX_SURFACE_ID:-}" ]]; then
      local fallback_candidate=""
      for candidate in "${candidates[@]}"; do
        if socket_works "$candidate"; then
          if caller_context_works "$candidate"; then
            printf 'cmux-home: caller cmux socket is unavailable: %s\n' "$inherited" >&2
            printf 'cmux-home: using %s with existing caller context\n' "$candidate" >&2
            export CMUX_SOCKET_PATH="$candidate"
            unset CMUX_SOCKET
            return
          fi
          [[ -n "$fallback_candidate" ]] || fallback_candidate="$candidate"
        fi
      done
      if [[ -n "$fallback_candidate" ]]; then
        printf 'cmux-home: caller cmux socket is unavailable: %s\n' "$inherited" >&2
        printf 'cmux-home: clearing stale caller context and using %s\n' "$fallback_candidate" >&2
        clear_stale_caller_context
        export CMUX_SOCKET_PATH="$fallback_candidate"
        unset CMUX_SOCKET
        return
      fi
      printf 'cmux-home: caller cmux socket is unavailable: %s\n' "$inherited" >&2
      printf 'cmux-home: no fallback cmux socket is available\n' >&2
      exit 1
    fi
    printf 'cmux-home: ignoring unavailable cmux socket: %s\n' "$inherited" >&2
  fi

  for candidate in "${candidates[@]}"; do
    if socket_works "$candidate"; then
      export CMUX_SOCKET_PATH="$candidate"
      unset CMUX_SOCKET
      return
    fi
  done
}

choose_socket

register_surface_resume() {
  if [[ "${CMUX_HOME_RESUME:-true}" == "false" ]]; then
    return
  fi
  if [[ -z "${CMUX_SOCKET_PATH:-}" || -z "${CMUX_SURFACE_ID:-}" ]]; then
    return
  fi
  if ! command -v cmux >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
    return
  fi

  local params
  if ! params="$(
    python3 - "$workspace_cwd" "$script_dir/cmux-home.sh" "$CMUX_SURFACE_ID" "$@" <<'PY'
import json
import os
import shlex
import sys

cwd, script_path, surface_id, *args = sys.argv[1:]
argv = [script_path] + args
command = "exec " + " ".join(shlex.quote(part) for part in argv)
environment = {}
for key in [
    "CMUX_HOME_CONFIG",
    "CMUX_HOME_WORKSPACE_CWD",
    "CMUX_AGENT_TUI_WORKSPACE_CWD",
    "CMUX_AGENT_TUI_CODEX_COMMAND",
    "CMUX_AGENT_TUI_CODEX_PLAN_COMMAND",
    "CMUX_AGENT_TUI_CLAUDE_COMMAND",
    "CMUX_AGENT_TUI_CLAUDE_PLAN_COMMAND",
    "CMUX_HOME_CODEX_BIN",
    "CMUX_HOME_CLAUDE_BIN",
]:
    value = os.environ.get(key)
    if value is not None:
        environment[key] = value

params = {
    "surface_id": surface_id,
    "name": "cmux home",
    "kind": "cmux-home",
    "checkpoint_id": "cmux-home",
    "source": "agent-hook",
    "command": command,
    "cwd": cwd,
    "auto_resume": True,
}
if environment:
    params["environment"] = environment
print(json.dumps(params, separators=(",", ":")))
PY
  )"; then
    return
  fi

  if ! cmux --socket "$CMUX_SOCKET_PATH" rpc surface.resume.set "$params" >/dev/null 2>&1; then
    if [[ -n "${CMUX_HOME_DEBUG:-}" ]]; then
      printf 'cmux-home: failed to register surface resume binding\n' >&2
    fi
  fi
}

register_surface_resume "$@"

cargo build --quiet --release --manifest-path "$manifest"

auto_config=""
if [[ -z "$explicit_config" && -z "${CMUX_HOME_CONFIG:-}" && -f "$workspace_cwd/cmux-home.json" ]]; then
  auto_config="$workspace_cwd/cmux-home.json"
fi

if [[ -n "$explicit_workspace_cwd" && -n "$auto_config" ]]; then
  exec "$binary" --config "$auto_config" "$@"
elif [[ -n "$explicit_workspace_cwd" ]]; then
  exec "$binary" "$@"
elif [[ -n "$auto_config" ]]; then
  exec "$binary" --workspace-cwd "$workspace_cwd" --config "$auto_config" "$@"
else
  exec "$binary" --workspace-cwd "$workspace_cwd" "$@"
fi
