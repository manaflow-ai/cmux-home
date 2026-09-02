import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Freestyle } from "freestyle";
import {
  CMUXD_REMOTE_RELEASE,
  providerFileTransferEnabled,
  redactSecrets,
  shellQuote,
  sha256CheckShell,
} from "../bin/remote-security.mjs";

/**
 * Resolve the cmux CLI to invoke. CMUX_CLI override is honored so we
 * can dogfood a tagged build; falls back to `cmux` on PATH.
 */
export function resolveCmuxCli(): string {
  return process.env.CMUX_CLI?.trim() || "cmux";
}

/** Token/lease shape served by cmuxd-remote's WebSocket attach path. */
export interface WebSocketLease {
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAtUnix: number;
  /**
   * The JSON written to /run/cmuxd/attach-*-lease.json so cmuxd-remote
   * can verify incoming WebSocket connections.
   */
  readonly leaseFile: {
    readonly version: 1;
    readonly token_sha256: string;
    readonly expires_at_unix: number;
    readonly session_id: string;
    readonly single_use: boolean;
  };
}

const CMUXD_WS_LEASE_DIR = "/run/cmuxd";
const CMUXD_WS_LEASE_STAGING_DIR = "/run/cmux-home";
const CMUXD_WS_PTY_LEASE_PATH = `${CMUXD_WS_LEASE_DIR}/attach-pty-lease.json`;
const CMUXD_WS_RPC_LEASE_PATH = `${CMUXD_WS_LEASE_DIR}/attach-rpc-lease.json`;
const CMUXD_WS_PTY_TTL_SECONDS = 5 * 60;
const CMUXD_WS_RPC_TTL_SECONDS = 12 * 60 * 60;
const CODEX_PROMPT_MAX_BYTES = 128 * 1024;
const CODEX_PROMPT_PATH_RE = /^\/run\/cmuxd\/codex-prompt-[A-Fa-f0-9]{32}\.txt$/;

function isSafeVmId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

/** Create a random, fixed-shape path for a one-time Codex prompt file. */
export function createCodexPromptPath(): string {
  return `/run/cmuxd/codex-prompt-${randomBytes(16).toString("hex")}.txt`;
}

function assertCodexPrompt(path: string, prompt: string): void {
  if (!CODEX_PROMPT_PATH_RE.test(path)) {
    throw new Error("Codex prompt path must be a one-time file under /run/cmuxd");
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("Codex prompt must not be empty");
  }
  if (prompt.includes("\0")) {
    throw new Error("Codex prompt contains a NUL byte");
  }
  if (Buffer.byteLength(prompt, "utf8") > CODEX_PROMPT_MAX_BYTES) {
    throw new Error(`Codex prompt exceeds ${CODEX_PROMPT_MAX_BYTES} bytes`);
  }
}

function rootVmFor(freestyle: Freestyle, vmId: string) {
  const vmRef = freestyle.vms.ref({ vmId });
  try {
    // `Vm.user` is part of the Freestyle SDK's public type. Keep this call
    // typed so an SDK contract change fails during compilation instead of
    // being hidden by a double cast at a security boundary.
    return vmRef.user({ username: "root" });
  } catch {
    // A malformed runtime SDK object can still arrive through JavaScript
    // interop. Convert that failure to a stable, fail-closed diagnostic.
    throw new Error("Freestyle SDK must support an explicit root VM file/exec user");
  }
}

/**
 * Transfer a Codex prompt through the provider file API. The VM command only
 * sees the fixed path and verifies mode/ownership before consuming it.
 */
export async function transferCodexPromptFile(
  freestyle: Freestyle,
  vmId: string,
  path: string,
  prompt: string,
): Promise<void> {
  if (!providerFileTransferEnabled()) {
    throw new Error(
      "refusing to transfer Codex prompt; confirm provider request-body redaction before enabling file transfer",
    );
  }
  if (!isSafeVmId(vmId)) throw new Error("invalid Freestyle VM id");
  assertCodexPrompt(path, prompt);
  const vm = rootVmFor(freestyle, vmId);
  let writeAttempted = false;
  try {
    const setup = await vm.exec({
      command: `PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH; test ! -L ${shellQuote(CMUXD_WS_LEASE_DIR)} && install -d -o root -g cmux -m 0710 ${shellQuote(CMUXD_WS_LEASE_DIR)} && test "$(stat -c '%u:%g:%a' ${shellQuote(CMUXD_WS_LEASE_DIR)})" = "0:$(id -g cmux):710" && find ${shellQuote(CMUXD_WS_LEASE_DIR)} -maxdepth 1 -type f -name 'codex-prompt-*.txt' -mmin +10 -delete && test ! -e ${shellQuote(path)}`,
      timeoutMs: 15_000,
    });
    if ((setup.statusCode ?? 0) !== 0) {
      throw new Error("cannot prepare one-time Codex prompt path");
    }
    writeAttempted = true;
    await vm.fs.writeTextFile(path, prompt);
    const verify = await vm.exec({
      command: `PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH; test -f ${shellQuote(path)} && test ! -L ${shellQuote(path)} && chown cmux:cmux ${shellQuote(path)} && chmod 0600 ${shellQuote(path)} && test "$(stat -c '%a:%u:%g' ${shellQuote(path)})" = "600:$(id -u cmux):$(id -g cmux)"`,
      timeoutMs: 15_000,
    });
    if ((verify.statusCode ?? 0) !== 0) {
      throw new Error("Codex prompt file failed ownership or mode verification");
    }
  } catch (error) {
    // Do not delete a pre-existing path when the destination preflight failed
    // before our write. Once a provider write was attempted, remove the path
    // even on an uncertain result so a partial prompt cannot remain readable.
    if (writeAttempted) {
      try { await vm.fs.remove(path); } catch {}
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Codex prompt transfer failed: ${redactSecrets(detail, [prompt])}`);
  }
}

export async function removeCodexPromptFile(
  freestyle: Freestyle,
  vmId: string,
  path: string,
): Promise<void> {
  if (!isSafeVmId(vmId) || !CODEX_PROMPT_PATH_RE.test(path)) return;
  try {
    await rootVmFor(freestyle, vmId).fs.remove(path);
  } catch {}
}

export function mintWebSocketLease(
  label: "pty" | "rpc",
  singleUse: boolean,
  ttlSeconds: number,
): WebSocketLease {
  const token = `cmux-freestyle-${label}-${randomBytes(32).toString("hex")}`;
  const sessionId = randomBytes(16).toString("hex");
  const expiresAtUnix = Math.floor(Date.now() / 1000) + ttlSeconds;
  return {
    token,
    sessionId,
    expiresAtUnix,
    leaseFile: {
      version: 1,
      token_sha256: createHash("sha256").update(token).digest("hex"),
      expires_at_unix: expiresAtUnix,
      session_id: sessionId,
      single_use: singleUse,
    },
  };
}

export interface FreestyleWsAttach {
  readonly domain: string; // <vmId>.vm.freestyle.sh
  readonly pty: WebSocketLease;
  readonly rpc: WebSocketLease;
}

export const CMUXD_REMOTE_RELEASE_TAG = CMUXD_REMOTE_RELEASE.releaseTag ?? "";
export const CMUXD_REMOTE_RELEASE_COMMIT = CMUXD_REMOTE_RELEASE.releaseCommit ?? "";

/** Compare digests without creating a timing side channel for valid lengths. */
export function digestMatches(actual: string, expected: string): boolean {
  const normalizedActual = actual.trim().toLowerCase();
  const normalizedExpected = expected.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedActual) || !/^[0-9a-f]{64}$/.test(normalizedExpected)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(normalizedActual, "ascii"),
    Buffer.from(normalizedExpected, "ascii"),
  );
}

export function buildCmuxdInstallScript(): string {
  const amd64 = CMUXD_REMOTE_RELEASE.assets.amd64;
  const arm64 = CMUXD_REMOTE_RELEASE.assets.arm64;
  if (
    !/^v\d+\.\d+\.\d+$/.test(CMUXD_REMOTE_RELEASE_TAG) ||
    !/^[0-9a-f]{40}$/i.test(CMUXD_REMOTE_RELEASE_COMMIT) ||
    amd64?.name !== "cmuxd-remote-linux-amd64" ||
    arm64?.name !== "cmuxd-remote-linux-arm64" ||
    !/^[0-9a-f]{64}$/i.test(amd64.sha256) ||
    !/^[0-9a-f]{64}$/i.test(arm64.sha256)
  ) {
    throw new Error("cmuxd-remote release metadata is incomplete");
  }
  const releaseTag = shellQuote(CMUXD_REMOTE_RELEASE_TAG);
  const releaseCommit = shellQuote(CMUXD_REMOTE_RELEASE_COMMIT);
  const daemonPath = "/usr/local/libexec/cmuxd-remote";
  const launcherPath = "/usr/local/libexec/cmuxd-ws-launch";
  const releasePath = "/usr/local/libexec/cmuxd-remote.release";
  const unitPath = "/etc/systemd/system/cmuxd-ws.service";
  const serviceUser = "cmux";
  const digestLines = sha256CheckShell("$cmux_download", "$cmux_expected", "cmuxd-remote");
  return [
    "set -euo pipefail",
    "PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH",
    "umask 077",
    `if ! getent group ${serviceUser} >/dev/null 2>&1; then groupadd --system ${serviceUser}; fi`,
    `if ! id -u ${serviceUser} >/dev/null 2>&1; then useradd --system --create-home --gid ${serviceUser} --shell /bin/bash ${serviceUser}; fi`,
    `cmux_uid=$(id -u ${serviceUser})`,
    `cmux_gid=$(getent group ${serviceUser} | awk -F: '{print $3}')`,
    `case "$cmux_uid:$cmux_gid" in ''|0:*|*:0|*[!0-9:]*) echo 'cmuxd-ws: cmux service account must have non-root numeric uid/gid' >&2; exit 1 ;; esac`,
    `cmux_home=$(getent passwd ${serviceUser} | awk -F: '{print $6}')`,
    `case "$cmux_home" in /home/*) ;; *) echo 'cmuxd-ws: cmux home must be under /home' >&2; exit 1 ;; esac`,
    `test ! -L "$cmux_home" || { echo 'cmuxd-ws: cmux home must not be a symlink' >&2; exit 1; }`,
    `install -d -o ${serviceUser} -g ${serviceUser} -m 0750 "$cmux_home"`,
    `test "$(stat -c '%u:%g:%a' "$cmux_home")" = "$cmux_uid:$cmux_gid:750"`,
    `test "$(id -G ${serviceUser})" = "$cmux_gid" || { echo 'cmuxd-ws: cmux account has supplementary groups' >&2; exit 1; }`,
    // Keep the lease directory non-writable by the daemon. The root-side
    // installer can then replace files without a daemon/user TOCTOU attack.
    `test ! -L ${shellQuote(CMUXD_WS_LEASE_DIR)}`,
    `install -d -o root -g ${serviceUser} -m 0710 ${CMUXD_WS_LEASE_DIR}`,
    `test "$(stat -c '%u:%g:%a' ${shellQuote(CMUXD_WS_LEASE_DIR)})" = "0:$cmux_gid:710"`,
    // The release binary, launcher, and provenance marker share this parent.
    // Validate every existing component before install follows the path, then
    // create the target with root ownership and a fixed non-writable mode.
    "test ! -L /usr/local || { echo 'cmuxd-ws: refusing a symlink /usr/local' >&2; exit 1; }",
    "test -d /usr/local || { echo 'cmuxd-ws: /usr/local must be a directory' >&2; exit 1; }",
    "test ! -L /usr/local/libexec || { echo 'cmuxd-ws: refusing a symlink libexec directory' >&2; exit 1; }",
    "install -d -o root -g root -m 0755 /usr/local/libexec",
    "test ! -L /usr/local/libexec || { echo 'cmuxd-ws: libexec directory changed to a symlink' >&2; exit 1; }",
    "test \"$(stat -c '%u:%g:%a' /usr/local/libexec)\" = '0:0:755' || { echo 'cmuxd-ws: libexec directory ownership or mode is unsafe' >&2; exit 1; }",
    "cmux_sha256() {",
    "  if command -v sha256sum >/dev/null 2>&1; then sha256sum \"$1\" | awk '{print tolower($1)}'; return; fi",
    "  if command -v shasum >/dev/null 2>&1; then shasum -a 256 \"$1\" | awk '{print tolower($1)}'; return; fi",
    "  if command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 \"$1\" | sed 's/^.*= //; s/[[:space:]]//g' | tr '[:upper:]' '[:lower:]'; return; fi",
    "  return 127",
    "}",
    "cmux_verify() {",
    "  [ -f \"$1\" ] || return 1",
    "  actual=$(cmux_sha256 \"$1\") || return 1",
    "  [ \"$actual\" = \"$2\" ]",
    "}",
    "cmux_secure_binary() {",
    "  [ -f \"$1\" ] || return 1",
    "  [ ! -L \"$1\" ] || return 1",
    "  [ \"$(stat -c '%u:%g:%a' \"$1\")\" = '0:0:755' ]",
    "}",
    `cmux_release_tag=${releaseTag}`,
    `cmux_release_commit=${releaseCommit}`,
    `cmux_daemon_path=${shellQuote(daemonPath)}`,
    `for cmux_destination in ${shellQuote(daemonPath)} ${shellQuote(releasePath)} ${shellQuote(launcherPath)} ${shellQuote(unitPath)}; do test ! -L "$cmux_destination" || { echo 'cmuxd-ws: refusing a symlink destination' >&2; exit 1; }; done`,
    "cmux_arch=$(uname -m)",
    "case \"$cmux_arch\" in",
    `  x86_64|amd64) cmux_asset=${shellQuote(amd64.name)}; cmux_expected=${shellQuote(amd64.sha256)} ;;`,
    `  aarch64|arm64) cmux_asset=${shellQuote(arm64.name)}; cmux_expected=${shellQuote(arm64.sha256)} ;;`,
    `  *) echo ${shellQuote("cmuxd-remote: unsupported architecture")} >&2; exit 1 ;;`,
    "esac",
    `if ! cmux_verify "$cmux_daemon_path" "$cmux_expected" || ! cmux_secure_binary "$cmux_daemon_path"; then`,
    `  cmux_install_dir=$(mktemp -d "/tmp/cmuxd-remote.XXXXXX")`,
    "  trap 'rm -rf \"$cmux_install_dir\"' EXIT",
    `  cmux_url="https://github.com/manaflow-ai/cmux/releases/download/${CMUXD_REMOTE_RELEASE_TAG}/$cmux_asset"`,
    "  cmux_download=\"$cmux_install_dir/$cmux_asset\"",
    "  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 --retry-all-errors \"$cmux_url\" -o \"$cmux_download\"",
    ...digestLines,
    `  install -o root -g root -m 0755 "$cmux_download" "$cmux_daemon_path"`,
    `  printf '%s\\n%s\\n' "$cmux_release_tag" "$cmux_release_commit" > "$cmux_daemon_path.release.tmp"`,
    `  install -o root -g root -m 0644 "$cmux_daemon_path.release.tmp" ${shellQuote(releasePath)}`,
    "  rm -f \"$cmux_daemon_path.release.tmp\"",
    "  trap - EXIT",
    "  rm -rf \"$cmux_install_dir\"",
    "fi",
    `if ! cmux_verify "$cmux_daemon_path" "$cmux_expected" || ! cmux_secure_binary "$cmux_daemon_path"; then echo ${shellQuote("cmuxd-remote: installed digest or ownership verification failed")} >&2; exit 1; fi`,
    `if [ ! -f ${shellQuote(releasePath)} ] || [ "$(sed -n '1p' ${shellQuote(releasePath)})" != "$cmux_release_tag" ] || [ "$(sed -n '2p' ${shellQuote(releasePath)})" != "$cmux_release_commit" ]; then`,
    `  cmux_marker_tmp=$(mktemp "/tmp/cmuxd-remote.release.XXXXXX")`,
    `  printf '%s\\n%s\\n' "$cmux_release_tag" "$cmux_release_commit" > "$cmux_marker_tmp"`,
    `  install -o root -g root -m 0644 "$cmux_marker_tmp" ${shellQuote(releasePath)}`,
    `  rm -f "$cmux_marker_tmp"`,
    "fi",
    `cmux_launcher_tmp=$(mktemp "/tmp/cmuxd-ws-launch.XXXXXX")`,
    "cat > \"$cmux_launcher_tmp\" <<'LAUNCH'",
    buildCmuxdWsLauncherScript(),
    "LAUNCH",
    `install -o root -g root -m 0755 "$cmux_launcher_tmp" ${shellQuote(launcherPath)}`,
    "rm -f \"$cmux_launcher_tmp\"",
    `cmux_unit_tmp=$(mktemp "/tmp/cmuxd-ws.service.XXXXXX")`,
    "cat > \"$cmux_unit_tmp\" <<'UNIT'",
    "[Unit]",
    "Description=cmuxd websocket daemon",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${serviceUser}`,
    `Group=${serviceUser}`,
    "SupplementaryGroups=",
    `ExecStart=${launcherPath}`,
    // Configuration is intentionally compiled into the launcher. Loading an
    // operator-controlled EnvironmentFile would let a writable file alter the
    // service environment before the daemon starts.
    "PrivateTmp=true",
    "NoNewPrivileges=true",
    "ProtectSystem=full",
    "ProtectKernelTunables=true",
    "ProtectKernelModules=true",
    "ProtectControlGroups=true",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    `ReadOnlyPaths=${CMUXD_WS_LEASE_DIR}`,
    "ReadWritePaths=%h",
    "Restart=always",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "UNIT",
    `install -o root -g root -m 0644 "$cmux_unit_tmp" ${shellQuote(unitPath)}`,
    "rm -f \"$cmux_unit_tmp\"",
    "systemctl daemon-reload",
    "systemctl enable cmuxd-ws.service >/dev/null",
  ].join("\n");
}

/** Return the unprivileged cmuxd launcher installed by the systemd setup. */
export function buildCmuxdWsLauncherScript(): string {
  return [
    "#!/bin/sh",
    "set -eu",
    "listen=\"${CMUXD_WS_LISTEN_ADDR:-}\"",
    "if [ -z \"$listen\" ]; then",
    "  listen=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*[[:space:]]src[[:space:]]\\([0-9.][0-9.]*\\).*/\\1/p' | head -n 1)",
    "fi",
    "cmux_private_ipv4() {",
    "  # shellcheck disable=SC2086",
    "  old_ifs=$IFS; IFS=.; set -- $1; IFS=$old_ifs",
    "  [ $# -eq 4 ] || return 1",
    "  for octet in \"$@\"; do case \"$octet\" in ''|*[!0-9]*) return 1 ;; esac; [ \"$octet\" -le 255 ] 2>/dev/null || return 1; done",
    "  if [ \"$1\" -eq 10 ]; then return 0; fi",
    "  if [ \"$1\" -eq 192 ] && [ \"$2\" -eq 168 ]; then return 0; fi",
    "  if [ \"$1\" -eq 172 ] && [ \"$2\" -ge 16 ] && [ \"$2\" -le 31 ]; then return 0; fi",
    "  if [ \"$1\" -eq 100 ] && [ \"$2\" -ge 64 ] && [ \"$2\" -le 127 ]; then return 0; fi",
    "  return 1",
    "}",
    "if ! cmux_private_ipv4 \"$listen\"; then echo 'cmuxd-ws: a private IPv4 listen address is required' >&2; exit 1; fi",
    "listen_arg=\"$listen:7777\"",
    `${shellQuote("/usr/local/libexec/cmuxd-remote")} serve --ws --listen "$listen_arg" --auth-lease-file ${shellQuote(CMUXD_WS_PTY_LEASE_PATH)} --rpc-auth-lease-file ${shellQuote(CMUXD_WS_RPC_LEASE_PATH)} --shell /bin/bash`,
  ].join("\n");
}

/** Build the root-side lease install command with atomic, private writes. */
export function buildLeaseWriteScript(
  ptyLeaseStagingPath: string,
  rpcLeaseStagingPath: string,
): string {
  const stagingPathPattern =
    /^\/run\/cmux-home\/lease-(?:pty|rpc)-[A-Fa-f0-9]{32}\.json$/;
  if (
    !stagingPathPattern.test(ptyLeaseStagingPath) ||
    !stagingPathPattern.test(rpcLeaseStagingPath) ||
    ptyLeaseStagingPath === rpcLeaseStagingPath
  ) {
    throw new Error("lease staging paths must be unique files under /run/cmux-home");
  }
  return [
    "set -euo pipefail",
    "PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH",
    "umask 077",
    `test ! -L ${shellQuote(CMUXD_WS_LEASE_DIR)}`,
    `install -d -o root -g cmux -m 0710 ${shellQuote(CMUXD_WS_LEASE_DIR)}`,
    `test "$(stat -c '%u:%g:%a' ${shellQuote(CMUXD_WS_LEASE_DIR)})" = "0:$(id -g cmux):710"`,
    "cmux_commit=0",
    "cmux_cleanup() {",
    "  cmux_status=$?",
    `  if [ "$cmux_commit" -ne 1 ]; then rm -f -- ${shellQuote(CMUXD_WS_PTY_LEASE_PATH)} ${shellQuote(CMUXD_WS_RPC_LEASE_PATH)} ${shellQuote(ptyLeaseStagingPath)} ${shellQuote(rpcLeaseStagingPath)}; fi`,
    "  exit \"$cmux_status\"",
    "}",
    "trap cmux_cleanup EXIT",
    `rm -f -- ${shellQuote(CMUXD_WS_PTY_LEASE_PATH)} ${shellQuote(CMUXD_WS_RPC_LEASE_PATH)}`,
    "cmux_install_lease() {",
    "  cmux_source=\"$1\"",
    "  cmux_target=\"$2\"",
    "  test -f \"$cmux_source\"",
    "  test ! -L \"$cmux_source\"",
    "  test ! -L \"$cmux_target\"",
    "  chmod 0600 \"$cmux_source\"",
    "  chown root:root \"$cmux_source\"",
    "  test \"$(stat -c '%a:%u:%g' \"$cmux_source\")\" = '600:0:0'",
    "  mv -f -- \"$cmux_source\" \"$cmux_target\"",
    "  chown cmux:cmux \"$cmux_target\"",
    "  chmod 0600 \"$cmux_target\"",
    "  cmux_uid=$(id -u cmux)",
    "  cmux_gid=$(id -g cmux)",
    "  test \"$(stat -c '%a:%u:%g' \"$cmux_target\")\" = \"600:$cmux_uid:$cmux_gid\"",
    "}",
    `cmux_install_lease ${shellQuote(ptyLeaseStagingPath)} ${shellQuote(CMUXD_WS_PTY_LEASE_PATH)}`,
    `cmux_install_lease ${shellQuote(rpcLeaseStagingPath)} ${shellQuote(CMUXD_WS_RPC_LEASE_PATH)}`,
    // (Re)start the service so it picks up any newly-installed binary
    // and reads the fresh lease files at connection time.
    "systemctl restart cmuxd-ws.service",
    // Best-effort wait for the listener so the first attach does not
    // race the systemd start.
    "for i in 1 2 3 4 5 6 7 8 9 10; do if ss -tln 2>/dev/null | grep -q ':7777'; then break; fi; sleep 0.2; done",
    "cmux_commit=1",
  ].join("\n");
}

/**
 * Ensure cmuxd-remote is installed and `cmuxd-ws.service` is active on
 * the VM, then mint two leases (PTY + RPC) and write their metadata into a
 * root-only staging directory through Freestyle's file API. A fixed-path
 * root command installs mode-0600 files so cmuxd-ws.service can verify
 * incoming WebSocket connections without exposing lease data in command logs.
 *
 * The official cmux-freestyle snapshot bakes cmuxd-remote and the
 * systemd unit at build time, but in the wild we still see snapshots
 * (including freshly-cut ones in some flows) without either. Doing
 * the install idempotently at attach time means cmux-home works
 * against any reasonably-recent ubuntu-based freestyle VM.
 */
export async function prepareFreestyleWsAttach(
  freestyle: Freestyle,
  vmId: string,
): Promise<FreestyleWsAttach> {
  if (!isSafeVmId(vmId)) throw new Error("invalid Freestyle VM id");
  // Lease files contain only a SHA-256 hash of a random, 256-bit token, plus
  // an expiry and session identifier. They do not contain a credential and
  // cannot be used to authenticate without the token held by this process.
  // Transfer this non-secret metadata through the provider file API by
  // default so normal WebSocket attaches do not require a secret-redaction
  // acknowledgement. Secret-bearing transfers (Tailscale keys and Codex
  // prompts) remain gated by providerFileTransferEnabled().
  // The provider's default Linux user is not part of the public contract.
  // Select root explicitly because staging and ownership checks rely on it.
  const vm = rootVmFor(freestyle, vmId);

  // 1. Install a verified cmuxd-remote and a least-privilege systemd unit.
  // The script is intentionally idempotent and rewrites an old insecure unit
  // instead of trusting whatever a previous snapshot installed.
  const installScript = buildCmuxdInstallScript();
  const installResult = await vm.exec({
    command: `bash -e -c ${shellQuote(installScript)}`,
    timeoutMs: 60_000,
  });
  const installStatus = installResult.statusCode ?? 0;
  if (installStatus !== 0) {
    throw new Error(
      `cmuxd-remote install failed (status ${installStatus}): ${redactSecrets(installResult.stderr || installResult.stdout || "no diagnostic")}`,
    );
  }

  // 2. Mint leases + write them in.
  const pty = mintWebSocketLease("pty", true, CMUXD_WS_PTY_TTL_SECONDS);
  const rpc = mintWebSocketLease("rpc", false, CMUXD_WS_RPC_TTL_SECONDS);
  const ptyStagingPath = `${CMUXD_WS_LEASE_STAGING_DIR}/lease-pty-${randomBytes(16).toString("hex")}.json`;
  const rpcStagingPath = `${CMUXD_WS_LEASE_STAGING_DIR}/lease-rpc-${randomBytes(16).toString("hex")}.json`;
  const stagingPaths = [ptyStagingPath, rpcStagingPath];
  try {
    // Lease metadata contains an authentication hash. Send it through the
    // provider file API, never as command text or base64 in vm.exec.
    const stagingSetup = await vm.exec({
      command: `PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH; test ! -L ${shellQuote(CMUXD_WS_LEASE_STAGING_DIR)} && install -d -o root -g root -m 0700 ${shellQuote(CMUXD_WS_LEASE_STAGING_DIR)} && test "$(stat -c '%u:%g:%a' ${shellQuote(CMUXD_WS_LEASE_STAGING_DIR)})" = '0:0:700' && find ${shellQuote(CMUXD_WS_LEASE_STAGING_DIR)} -maxdepth 1 -type f -name 'lease-*.json' -mmin +10 -delete`,
      timeoutMs: 15_000,
    });
    if ((stagingSetup.statusCode ?? 0) !== 0) {
      throw new Error(
        `cannot prepare lease staging directory: ${stagingSetup.stderr || stagingSetup.stdout || "no diagnostic"}`,
      );
    }
    await Promise.all([
      vm.fs.writeTextFile(ptyStagingPath, JSON.stringify(pty.leaseFile)),
      vm.fs.writeTextFile(rpcStagingPath, JSON.stringify(rpc.leaseFile)),
    ]);
    const leaseResult = await vm.exec({
      // Freestyle's exec shell is not part of the public contract. Invoke
      // bash explicitly because the script uses pipefail and strict arrays.
      command: `bash -e -c ${shellQuote(buildLeaseWriteScript(ptyStagingPath, rpcStagingPath))}`,
      timeoutMs: 30_000,
    });
    const leaseStatus = leaseResult.statusCode ?? 0;
    if (leaseStatus !== 0) {
      throw new Error(
        `freestyle vm.exec lease install failed (status ${leaseStatus}): ${leaseResult.stderr || leaseResult.stdout || "no diagnostic"}`,
      );
    }
  } catch (error) {
    await Promise.allSettled([
      ...stagingPaths.map((path) => vm.fs.remove(path)),
      vm.exec({
        command: `rm -f -- ${shellQuote(CMUXD_WS_PTY_LEASE_PATH)} ${shellQuote(CMUXD_WS_RPC_LEASE_PATH)}`,
        timeoutMs: 15_000,
      }),
    ]);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `freestyle lease file transfer failed: ${redactSecrets(detail, [pty.token, rpc.token])}`,
    );
  }

  return { domain: `${vmId}.vm.freestyle.sh`, pty, rpc };
}

/** Remove lease files after a workspace attach fails before it can use them. */
export async function removeFreestyleWsLeases(
  freestyle: Freestyle,
  vmId: string,
): Promise<void> {
  if (!isSafeVmId(vmId)) return;
  try {
    await rootVmFor(freestyle, vmId).exec({
      command: `rm -f -- ${shellQuote(CMUXD_WS_PTY_LEASE_PATH)} ${shellQuote(CMUXD_WS_RPC_LEASE_PATH)}`,
      timeoutMs: 15_000,
    });
  } catch {
    // Lease files are short-lived and the daemon rejects expired entries. A
    // provider outage must not turn cleanup into a second user-visible error.
  }
}

/**
 * Remove resources created for a pending WebSocket workspace. The helper is
 * idempotent and intentionally swallows provider cleanup failures, because a
 * failed attach must not be turned into a second user-visible failure.
 */
export async function cleanupFreestyleWsResources(
  freestyle: Freestyle,
  vmId: string,
  promptPath: string | null = null,
): Promise<void> {
  await Promise.allSettled([
    removeFreestyleWsLeases(freestyle, vmId),
    promptPath ? removeCodexPromptFile(freestyle, vmId, promptPath) : Promise.resolve(),
  ]);
}

export interface OpenWsWorkspaceResult {
  readonly workspaceRef: string;
  readonly stdout: string;
}

/**
 * Create a workspace whose main pane is the cmuxd-ws WebSocket PTY.
 * The local cmux CLI's `vm-pty-connect` subcommand acts as the
 * WebSocket bridge (stdin/stdout ↔ WebSocket frames), and
 * workspace.remote.configure tells the cmux app to treat the
 * workspace as a websocket-transport remote with the daemon endpoint
 * already known. Skips daemon-bootstrap entirely (the VM already
 * runs cmuxd-remote --ws via cmuxd-ws.service).
 */
export type CmuxRpc = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export async function openCmuxWsWorkspace(opts: {
  vmId: string;
  attach: FreestyleWsAttach;
  workspaceName: string;
  /** Send requests over the authenticated Unix socket, never as CLI JSON. */
  rpc: CmuxRpc;
  noFocus?: boolean;
  /** Called to remove remote leases when workspace setup fails. */
  cleanupLeases?: () => Promise<void>;
}): Promise<OpenWsWorkspaceResult> {
  if (!isSafeVmId(opts.vmId)) throw new Error("invalid Freestyle VM id");
  const cli = resolveCmuxCli();
  // The local cmux CLI loads a config file describing the PTY endpoint
  // (URL + token + sessionId). Write it to a tempdir and pass via
  // --config. cmux vm-pty-connect deletes the file after reading.
  const tmpDir = mkdtempSync(join(tmpdir(), "cmux-home-ws-"));
  const configPath = join(tmpDir, "vm-pty.json");
  const ptyUrl = `wss://${opts.attach.domain}/terminal`;
  const config = {
    url: ptyUrl,
    headers: {},
    token: opts.attach.pty.token,
    sessionId: opts.attach.pty.sessionId,
  };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  chmodSync(configPath, 0o600);

  const initialCommand = [
    `${shellQuote(cli)} vm-pty-connect --config ${shellQuote(configPath)} --id ${shellQuote(opts.vmId)}`,
    "cmux_vm_pty_status=$?",
    `rm -rf ${shellQuote(tmpDir)}`,
    "exit $cmux_vm_pty_status",
  ].join("; ");

  try {
    // 1. workspace.create — initial_command is the local-side bridge. It
    // contains only a path, never a lease token.
    const createResp = (await opts.rpc("workspace.create", {
      title: opts.workspaceName,
      initial_command: initialCommand,
      focus: !opts.noFocus,
    })) as Record<string, unknown> | undefined;
    const workspaceId =
      typeof createResp?.workspace_ref === "string"
        ? createResp.workspace_ref
        : typeof createResp?.workspace_id === "string"
          ? createResp.workspace_id
          : "";
    if (!workspaceId) {
      throw new Error(
        `workspace.create returned no workspace_id: ${redactSecrets(JSON.stringify(createResp))}`,
      );
    }

    // 2. workspace.remote.configure contains the RPC lease token. Send it
    // over the already-authenticated Unix socket, not through `cmux rpc`
    // where JSON arguments are visible to process inspection and shell logs.
    const daemonUrl = `wss://${opts.attach.domain}/rpc`;
    await opts.rpc("workspace.remote.configure", {
      workspace_id: workspaceId,
      destination: opts.attach.domain,
      transport: "websocket",
      auto_connect: true,
      skip_daemon_bootstrap: true,
      terminal_startup_command: initialCommand,
      daemon_websocket_url: daemonUrl,
      daemon_websocket_headers: {},
      daemon_websocket_token: opts.attach.rpc.token,
      daemon_websocket_session_id: opts.attach.rpc.sessionId,
      daemon_websocket_expires_at_unix: opts.attach.rpc.expiresAtUnix,
    });

    // 3. workspace.select unless caller opted out.
    if (!opts.noFocus) {
      await opts.rpc("workspace.select", { workspace_id: workspaceId });
    }
    return { workspaceRef: workspaceId, stdout: "" };
  } catch (error) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    try { await opts.cleanupLeases?.(); } catch {}
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecrets(message, [opts.attach.pty.token, opts.attach.rpc.token]));
  }
}
