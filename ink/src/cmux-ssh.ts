import { spawn } from "node:child_process";

/**
 * Resolve the cmux CLI to invoke for `cmux ssh`. Defaults to whatever is
 * on PATH. Override with CMUX_CLI when dogfooding a tagged build that
 * has the `--no-daemon-bootstrap` flag (added in
 * manaflow-ai/cmux#feat-ssh-no-daemon-bootstrap).
 *
 *   CMUX_CLI="/Users/me/Library/Developer/Xcode/DerivedData/cmux-ssh-nodb/Build/Products/Debug/cmux DEV ssh-nodb.app/Contents/Resources/bin/cmux"
 */
export function resolveCmuxCli(): string {
  return process.env.CMUX_CLI?.trim() || "cmux";
}

export interface CmuxSshOptions {
  /** Already-prepared destination string: `vmid+user:token@host`. */
  readonly destination: string;
  /** Workspace title in the cmux sidebar. */
  readonly name: string;
  /** Pass true to NOT switch focus to the new workspace. */
  readonly noFocus?: boolean;
  /**
   * Remote command to exec after the ssh handshake. Wrapped as
   * `bash -l -c '<remoteCommand>'` so the user's login PATH and
   * /etc/profile.d sourcing kick in.
   */
  readonly remoteCommand?: string;
}

export interface CmuxSshResult {
  readonly workspaceRef: string;
  readonly target: string;
  readonly state: string;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Invoke `cmux ssh` to create a new workspace whose main pane is an
 * ssh session to a forwarding-only gateway (Freestyle's russh, etc).
 * Requires the cmux build to have `--no-daemon-bootstrap` (see
 * manaflow-ai/cmux#feat-ssh-no-daemon-bootstrap). Returns the new
 * workspace ref.
 */
export async function openCmuxSshWorkspace(
  opts: CmuxSshOptions,
): Promise<CmuxSshResult> {
  const cli = resolveCmuxCli();
  if (process.env.CMUX_HOME_DEBUG?.trim()) {
    process.stderr.write(`[cmux-ssh] using CLI: ${cli}\n`);
  }
  const args = [
    "ssh",
    "--port", "22",
    "--no-daemon-bootstrap",
    "--ssh-option", "PreferredAuthentications=none",
    "--ssh-option", "IdentitiesOnly=yes",
    "--ssh-option", "IdentityFile=/dev/null",
    "--ssh-option", "StrictHostKeyChecking=no",
    "--ssh-option", "UserKnownHostsFile=/dev/null",
    "--ssh-option", "ControlMaster=no",
    "--ssh-option", "LogLevel=ERROR",
    "--ssh-option", "ServerAliveInterval=30",
    "--ssh-option", "ServerAliveCountMax=4",
    "--name", opts.name,
  ];
  if (opts.noFocus) args.push("--no-focus");
  args.push(opts.destination);
  if (opts.remoteCommand) args.push("--", "bash", "-l", "-c", opts.remoteCommand);

  const result = await runCmd(cli, args, 30_000);
  if (result.code !== 0) {
    throw new Error(
      `cmux ssh failed (exit ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  const m = result.stdout.match(/^OK workspace=(\S+) target=(\S+) state=(\S+)/m);
  if (!m) {
    throw new Error(`cmux ssh: could not parse OK line: ${result.stdout}`);
  }
  return {
    workspaceRef: m[1]!,
    target: m[2]!,
    state: m[3]!,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export interface FreestyleBootstrap {
  readonly destination: string;
  readonly identityId: string;
  readonly remoteCommand: string;
}

/**
 * Invoke the freestyle-vm-ssh helper in --print-bootstrap mode. It
 * mints a freestyle identity + ssh token, builds the full remote
 * bootstrap (tailscale + clone + dev server + codex), and prints the
 * package as JSON so we can hand it to cmux ssh.
 */
export async function prepareFreestyleBootstrap(opts: {
  helperPath: string;
  vmId: string;
  cloneCmux?: boolean;
  codexPrompt?: string | null;
  subrouterAccountId?: string | null;
}): Promise<FreestyleBootstrap> {
  const args = [opts.helperPath, opts.vmId, "--print-bootstrap"];
  if (opts.cloneCmux) args.push("--clone-cmux");
  if (opts.subrouterAccountId) {
    args.push("--subrouter-account-id", opts.subrouterAccountId);
  }
  if (opts.codexPrompt && opts.codexPrompt.trim()) {
    args.push("--codex-prompt", opts.codexPrompt.trim());
  }
  const result = await runCmd("node", args, 30_000);
  if (result.code !== 0) {
    throw new Error(
      `freestyle-vm-ssh --print-bootstrap failed (exit ${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  const line = result.stdout.trim().split(/\r?\n/).pop() ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new Error(
      `freestyle-vm-ssh --print-bootstrap: invalid JSON on stdout: ${line.slice(0, 200)}`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  const destination = typeof obj.destination === "string" ? obj.destination : "";
  const identityId = typeof obj.identityId === "string" ? obj.identityId : "";
  const remoteCommand = typeof obj.remoteCommand === "string" ? obj.remoteCommand : "";
  if (!destination || !identityId || !remoteCommand) {
    throw new Error(
      `freestyle-vm-ssh --print-bootstrap: missing fields in JSON: ${line.slice(0, 200)}`,
    );
  }
  return { destination, identityId, remoteCommand };
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
