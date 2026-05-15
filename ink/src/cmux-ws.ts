import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { Freestyle } from "freestyle";

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
   * The JSON written to /tmp/cmux/attach-*-lease.json so cmuxd-remote
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

const CMUXD_WS_PTY_LEASE_PATH = "/tmp/cmux/attach-pty-lease.json";
const CMUXD_WS_RPC_LEASE_PATH = "/tmp/cmux/attach-rpc-lease.json";
const CMUXD_WS_PTY_TTL_SECONDS = 5 * 60;
const CMUXD_WS_RPC_TTL_SECONDS = 12 * 60 * 60;

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

const CMUXD_REMOTE_RELEASE_TAG = "v0.64.5";
const CMUXD_REMOTE_DOWNLOAD_URL = `https://github.com/manaflow-ai/cmux/releases/download/${CMUXD_REMOTE_RELEASE_TAG}/cmuxd-remote-linux-amd64`;

/**
 * Ensure cmuxd-remote is installed and `cmuxd-ws.service` is active on
 * the VM, then mint two leases (PTY + RPC) and write them into the VM
 * via Freestyle's `vm.exec` API so cmuxd-ws.service can verify
 * incoming WebSocket connections.
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
  const vm = freestyle.vms.ref({ vmId });

  // 1. Install cmuxd-remote + systemd unit if missing. Idempotent.
  const installScript = [
    "set -e",
    `if [ ! -x /usr/local/bin/cmuxd-remote ]; then`,
    `  curl -fsSL ${shellQuote(CMUXD_REMOTE_DOWNLOAD_URL)} -o /usr/local/bin/cmuxd-remote.tmp && `,
    `  chmod 0755 /usr/local/bin/cmuxd-remote.tmp && `,
    `  mv /usr/local/bin/cmuxd-remote.tmp /usr/local/bin/cmuxd-remote`,
    `fi`,
    `if [ ! -f /etc/systemd/system/cmuxd-ws.service ]; then`,
    `  cat > /etc/systemd/system/cmuxd-ws.service <<'UNIT'`,
    `[Unit]`,
    `Description=cmuxd websocket daemon`,
    `After=network.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `User=root`,
    `ExecStart=/usr/local/bin/cmuxd-remote serve --ws --listen 0.0.0.0:7777 --auth-lease-file /tmp/cmux/attach-pty-lease.json --rpc-auth-lease-file /tmp/cmux/attach-rpc-lease.json --shell /bin/bash`,
    `Restart=always`,
    `RestartSec=1`,
    ``,
    `[Install]`,
    `WantedBy=multi-user.target`,
    `UNIT`,
    `  systemctl daemon-reload`,
    `  systemctl enable cmuxd-ws.service`,
    `fi`,
    `mkdir -p /tmp/cmux && chmod 700 /tmp/cmux`,
  ].join("\n");
  const installResult = await vm.exec({
    command: `bash -e -c ${shellQuote(installScript)}`,
    timeoutMs: 60_000,
  });
  const installStatus = installResult.statusCode ?? 0;
  if (installStatus !== 0) {
    throw new Error(
      `cmuxd-remote install failed (status ${installStatus}): ${installResult.stderr || installResult.stdout}`,
    );
  }

  // 2. Mint leases + write them in.
  const pty = mintWebSocketLease("pty", true, CMUXD_WS_PTY_TTL_SECONDS);
  const rpc = mintWebSocketLease("rpc", false, CMUXD_WS_RPC_TTL_SECONDS);
  const encodedPty = Buffer.from(JSON.stringify(pty.leaseFile)).toString("base64");
  const encodedRpc = Buffer.from(JSON.stringify(rpc.leaseFile)).toString("base64");
  const leaseCmd = [
    `printf '%s' '${encodedPty}' | base64 -d > ${CMUXD_WS_PTY_LEASE_PATH}`,
    `chmod 600 ${CMUXD_WS_PTY_LEASE_PATH}`,
    `printf '%s' '${encodedRpc}' | base64 -d > ${CMUXD_WS_RPC_LEASE_PATH}`,
    `chmod 600 ${CMUXD_WS_RPC_LEASE_PATH}`,
    // (Re)start the service so it picks up any newly-installed binary
    // and reads the fresh lease files at connection time.
    "systemctl restart cmuxd-ws.service",
    // Best-effort wait for the listener so the first attach doesn't
    // race the systemd start.
    "for i in 1 2 3 4 5 6 7 8 9 10; do if ss -tln 2>/dev/null | grep -q ':7777'; then break; fi; sleep 0.2; done",
  ].join(" && ");
  const leaseResult = await vm.exec({ command: leaseCmd, timeoutMs: 30_000 });
  const leaseStatus = leaseResult.statusCode ?? 0;
  if (leaseStatus !== 0) {
    throw new Error(
      `freestyle vm.exec lease write failed (status ${leaseStatus}): ${leaseResult.stderr || leaseResult.stdout}`,
    );
  }

  return { domain: `${vmId}.vm.freestyle.sh`, pty, rpc };
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
export async function openCmuxWsWorkspace(opts: {
  vmId: string;
  attach: FreestyleWsAttach;
  workspaceName: string;
  noFocus?: boolean;
}): Promise<OpenWsWorkspaceResult> {
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

  const initialCommand = `${shellQuote(cli)} vm-pty-connect --config ${shellQuote(configPath)} --id ${shellQuote(opts.vmId)}`;

  // 1. workspace.create — initial_command is the local-side bridge.
  const createResp = await rpc(cli, "workspace.create", {
    title: opts.workspaceName,
    initial_command: initialCommand,
    focus: !opts.noFocus,
  });
  const workspaceId =
    typeof createResp?.workspace_ref === "string"
      ? createResp.workspace_ref
      : typeof createResp?.workspace_id === "string"
        ? createResp.workspace_id
        : "";
  if (!workspaceId) {
    throw new Error(`workspace.create returned no workspace_id: ${JSON.stringify(createResp)}`);
  }

  // 2. workspace.remote.configure — wire the websocket transport +
  //    daemon endpoint so cmux's sidebar shows ws:connected and the
  //    daemon RPC (proxy / port-forwarding) is reachable.
  const daemonUrl = `wss://${opts.attach.domain}/rpc`;
  await rpc(cli, "workspace.remote.configure", {
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
    await rpc(cli, "workspace.select", { workspace_id: workspaceId });
  }
  return { workspaceRef: workspaceId, stdout: "" };
}

async function rpc(
  cli: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await runCmd(
    cli,
    ["rpc", method, JSON.stringify(params)],
    15_000,
  );
  if (result.code !== 0) {
    throw new Error(
      `cmux rpc ${method} failed (exit ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  // `cmux rpc` prints the unwrapped result as JSON (or throws on error).
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`cmux rpc ${method} returned invalid JSON: ${result.stdout.slice(0, 200)}`);
  }
}

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCmd(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
