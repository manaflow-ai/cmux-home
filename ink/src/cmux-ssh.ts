import { spawn } from "node:child_process";
import {
  ensurePrivateKnownHostsFile,
  freestyleKnownHostsPath as managedFreestyleKnownHostsPath,
  redactSecrets,
  sanitizedEnvironment,
  writePrivateKnownHosts,
} from "../bin/remote-security.mjs";

const APPROVED_SUBROUTER_HOST = "subrouter-team.tail41290.ts.net";

function credentialFreeSubrouterUrl(value: string, allowUntrusted: boolean): string {
  if (value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new Error("subrouter URL must be a non-empty HTTP(S) URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("subrouter URL is invalid");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|tskey-[A-Za-z0-9-]{16,}|(?:token|secret|api[-_]?key)[=/_-][A-Za-z0-9._~-]{8,})/i.test(url.pathname)
  ) {
    throw new Error("subrouter URL must not contain credentials or a secret-shaped path");
  }
  if (!allowUntrusted && url.hostname.toLowerCase() !== APPROVED_SUBROUTER_HOST) {
    throw new Error("subrouter URL host is not approved");
  }
  return url.href;
}

function isSafeFreestyleDestination(value: string): boolean {
  // The cmux CLI parses the destination alongside its flags. Keep this
  // helper's destination grammar narrower than the CLI grammar so a caller
  // cannot smuggle an option or shell control character through the final
  // positional argument. This path is only used for Freestyle's gateway.
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\+[A-Za-z_][A-Za-z0-9._-]{0,31}@vm-ssh\.freestyle\.sh$/.test(value);
}

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
  /** SSH destination without credentials, for example `user@host`. */
  readonly destination: string;
  /** Workspace title in the cmux sidebar. */
  readonly name: string;
  /** Pass true to NOT switch focus to the new workspace. */
  readonly noFocus?: boolean;
  /**
   * Mac-side `ssh -L` forwards baked into the cmux ssh session.
   * Each entry forwards localhost:`macPort` → 127.0.0.1:`vmPort` on
   * the remote. Needed because tailscale userspace networking (the
   * only mode that works on freestyle russh gateways) doesn't accept
   * inbound TCP, so the browser pane can't reach VM-side services
   * through the tailnet.
   */
  readonly localForwards?: ReadonlyArray<{ macPort: number; vmPort: number }>;
  /**
   * Reserved for a future cmux CLI credential-file flag. The current CLI does
   * not expose one, so passing it fails closed instead of putting a password in
   * argv or an environment variable.
   */
  readonly passwordFile?: string;
}

export interface CmuxSshResult {
  readonly workspaceRef: string;
  readonly target: string;
  readonly state: string;
  readonly stdout: string;
  readonly stderr: string;
}

/** Return a private, persistent known_hosts path for Freestyle's gateway. */
export function freestyleKnownHostsPath(): string {
  return managedFreestyleKnownHostsPath();
}

/**
 * Build host-key options with TOFU backed by a private persistent file. A
 * caller may pin an exact known-hosts line with CMUX_FREESTYLE_SSH_HOST_KEY;
 * otherwise OpenSSH accepts a key only on first use and rejects changes.
 */
export function freestyleHostKeyOptions(): string[] {
  const path = ensurePrivateKnownHostsFile(managedFreestyleKnownHostsPath());
  const pinned = process.env.CMUX_FREESTYLE_SSH_HOST_KEY?.trim();
  if (pinned) {
    if (!/^(?:vm-ssh\.freestyle\.sh|\[vm-ssh\.freestyle\.sh\]:22)\s+ssh-(?:ed25519|rsa|ecdsa)\s+\S+$/.test(pinned)) {
      throw new Error("CMUX_FREESTYLE_SSH_HOST_KEY must be a single vm-ssh.freestyle.sh known_hosts line");
    }
    writePrivateKnownHosts(path, `${pinned}\n`);
    return ["StrictHostKeyChecking=yes", `UserKnownHostsFile=${path}`];
  }
  return ["StrictHostKeyChecking=accept-new", `UserKnownHostsFile=${path}`];
}

export function hasEmbeddedCredential(destination: string): boolean {
  const at = destination.lastIndexOf("@");
  const user = at >= 0 ? destination.slice(0, at) : destination;
  return user.includes(":");
}

/**
 * Invoke `cmux ssh` to create a new workspace whose main pane is an
 * **interactive** ssh shell into a forwarding-only gateway
 * (Freestyle's russh, etc). Requires the cmux build to have
 * `--no-daemon-bootstrap` (see manaflow-ai/cmux#feat-ssh-no-daemon-bootstrap).
 *
 * IMPORTANT: we do NOT pass `-- <remote-command>` here. The russh
 * freestyle gateway forwards "shell-request" channels (interactive
 * shells) but rejects "exec" channels (ssh + remote command), even
 * with `RequestTTY=force`. Trying it gives an infinite
 *   `exec request failed on channel 0; reconnecting (attempt N/20)`
 * loop. Instead we open an interactive shell, then send the bootstrap
 * as typed text via surface.send_text once the workspace exists.
 */
export async function openCmuxSshWorkspace(
  opts: CmuxSshOptions,
): Promise<CmuxSshResult> {
  const cli = resolveCmuxCli();
  if (!isSafeFreestyleDestination(opts.destination)) {
    throw new Error("cmux ssh destination must be a Freestyle vmId+user@vm-ssh.freestyle.sh value");
  }
  if (hasEmbeddedCredential(opts.destination)) {
    throw new Error("cmux ssh destination must not contain an embedded credential");
  }
  if (opts.passwordFile) {
    throw new Error(
      "cmux ssh cannot consume a password file in this build; refusing to expose the credential in argv or env",
    );
  }
  const hostKeyOptions = freestyleHostKeyOptions();
  if (process.env.CMUX_HOME_DEBUG?.trim()) {
    process.stderr.write(`[cmux-ssh] using CLI: ${cli}\n`);
  }
  const args = [
    "ssh",
    // Keep the destination parser from seeing a caller-controlled option. The
    // destination is validated above and cmux currently accepts it as the
    // final positional argument after all fixed flags.
    "--port", "22",
    "--no-daemon-bootstrap",
    "--ssh-option", "PreferredAuthentications=none",
    "--ssh-option", "IdentitiesOnly=yes",
    "--ssh-option", "IdentityFile=/dev/null",
    "--ssh-option", "ProxyCommand=none",
    "--ssh-option", "LocalCommand=none",
    "--ssh-option", "PermitLocalCommand=no",
    "--ssh-option", "ForwardAgent=no",
    "--ssh-option", "CanonicalizeHostname=no",
    "--ssh-option", hostKeyOptions[0]!,
    "--ssh-option", hostKeyOptions[1]!,
    "--ssh-option", "ControlMaster=no",
    "--ssh-option", "LogLevel=ERROR",
    "--ssh-option", "ServerAliveInterval=30",
    "--ssh-option", "ServerAliveCountMax=4",
    // Don't fail the session if a forward port is already bound on
    // the mac side (concurrent VMs that hashed to the same port).
    "--ssh-option", "ExitOnForwardFailure=no",
    "--name", opts.name,
  ];
  for (const fwd of opts.localForwards ?? []) {
    args.push("--ssh-option", `LocalForward=${fwd.macPort} 127.0.0.1:${fwd.vmPort}`);
  }
  if (opts.noFocus) args.push("--no-focus");
  args.push(opts.destination);

  const result = await runCmd(cli, args, 30_000);
  if (result.code !== 0) {
    throw new Error(
      `cmux ssh failed (exit ${result.code}): ${redactSecrets(result.stderr || result.stdout || "no diagnostic")}`,
    );
  }
  const m = result.stdout.match(/^OK workspace=(\S+) target=(\S+) state=(\S+)/m);
  if (!m) {
    throw new Error(`cmux ssh: could not parse OK line: ${redactSecrets(result.stdout)}`);
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
  /** Credential-free destination, useful for diagnostics only. */
  readonly destination: string;
  readonly identityId: string | null;
  readonly remoteCommand: string;
}

/**
 * Invoke the freestyle-vm-ssh helper in --print-bootstrap mode. The helper
 * builds the remote bootstrap without minting an SSH credential. The command
 * is sent over the WebSocket PTY, so a password-bearing destination is not
 * needed and must never be serialized.
 */
export async function prepareFreestyleBootstrap(opts: {
  helperPath: string;
  vmId: string;
  cloneCmux?: boolean;
  /** One-time remote prompt path. Prompt text never crosses process argv. */
  codexPromptFile?: string | null;
  subrouterAccountId?: string | null;
  subrouterUrl?: string | null;
  subrouterUserEmail?: string | null;
  allowUntrustedSubrouter?: boolean;
}): Promise<FreestyleBootstrap> {
  const args = [opts.helperPath, opts.vmId, "--print-bootstrap", "--no-ssh-credential"];
  if (opts.cloneCmux) args.push("--clone-cmux");
  if (opts.subrouterAccountId) {
    args.push("--subrouter-account-id", opts.subrouterAccountId);
  }
  if (opts.subrouterUrl) {
    args.push(
      "--subrouter-url",
      credentialFreeSubrouterUrl(opts.subrouterUrl.trim(), opts.allowUntrustedSubrouter === true),
    );
  }
  if (opts.subrouterUserEmail) {
    const email = opts.subrouterUserEmail.trim();
    if (!/^[^\s@\r\n]{1,320}@[^\s@\r\n]{1,320}$/.test(email)) {
      throw new Error("subrouter user email is invalid");
    }
    args.push("--subrouter-user-email", email);
  }
  if (opts.allowUntrustedSubrouter) args.push("--allow-untrusted-subrouter");
  if (opts.codexPromptFile) {
    args.push("--codex-prompt-file", opts.codexPromptFile);
  }
  // Credential-free bootstrap mode does not need the provider API. Keep the
  // Freestyle key out of the child process entirely, including temp files.
  const result = await runCmd(process.execPath, args, 30_000);
  if (result.code !== 0) {
    throw new Error(
      `freestyle-vm-ssh --print-bootstrap failed (exit ${result.code}): ${redactSecrets(result.stderr || result.stdout || "no diagnostic")}`,
    );
  }
  const line = result.stdout.trim().split(/\r?\n/).pop() ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(
      `freestyle-vm-ssh --print-bootstrap: invalid JSON on stdout: ${redactSecrets(line).slice(0, 200)}`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  const destination = typeof obj.destination === "string" ? obj.destination : "";
  const identityId = typeof obj.identityId === "string" ? obj.identityId : null;
  const remoteCommand = typeof obj.remoteCommand === "string" ? obj.remoteCommand : "";
  if (!destination || hasEmbeddedCredential(destination) || !remoteCommand) {
    throw new Error(
      `freestyle-vm-ssh --print-bootstrap: invalid credential-free JSON: ${redactSecrets(line).slice(0, 200)}`,
    );
  }
  return { destination, identityId, remoteCommand };
}

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCmd(
  cmd: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv = sanitizedEnvironment(),
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const maxOutputBytes = 256 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      detached: true,
    });
    const append = (current: string, chunk: string): string => {
      if (Buffer.byteLength(current, "utf8") >= maxOutputBytes) return current;
      const remaining = maxOutputBytes - Buffer.byteLength(current, "utf8");
      const bytes = Buffer.from(chunk, "utf8");
      return current + bytes.subarray(0, remaining).toString("utf8");
    };
    const killGroup = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup();
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout = append(stdout, c); });
    child.stderr.on("data", (c) => { stderr = append(stderr, c); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr),
      });
    });
  });
}
