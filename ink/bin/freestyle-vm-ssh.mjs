#!/usr/bin/env node
// SSH into a Freestyle VM and (by default) wire the VM to the user's
// Tailscale-hosted Subrouter so codex inside the VM routes through the AI
// gateway.
//
//   FREESTYLE_API_KEY=... freestyle-vm-ssh <vmId>
//     [--user cmux]
//     [--subrouter-port 31415]
//     [--subrouter-url <url>]            # default: http://subrouter-team.tail41290.ts.net:31415/v1
//     [--reverse-subrouter]              # add -R; only works on non-Freestyle sshd
//     [--forward 3000 --forward 5173 ...]
//     [--codex-config /absolute/or/relative/path]
//     [--no-codex-config]
//     [--tailscale | --no-tailscale]     # default: --tailscale (install + join via tsadmin auth-key)
//     [--tailscale-authkey-file <path>] # opt-in provider file transfer only
//     [--tailscale-hostname <name>]      # default: fs-<vmid-short>
//     [--codex-prompt-file <path>]       # one-time 0600 file consumed by codex exec
//
// On exit, the script revokes the freestyle identity it created.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  fstatSync,
  openSync,
  closeSync,
  constants as fsConstants,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Freestyle } from "freestyle";
import {
  CMUX_REPOSITORY,
  TAILSCALE_RELEASE,
  freestyleApiBaseUrl,
  ensurePrivateKnownHostsFile,
  trustedExecutable,
  writePrivateKnownHosts,
  providerFileTransferEnabled,
  redactSecrets,
  sanitizedEnvironment,
  sha256CheckShell,
} from "./remote-security.mjs";

const DEFAULT_TAILNET_SUBROUTER_URL = "http://subrouter-team.tail41290.ts.net:31415/v1";
const APPROVED_SUBROUTER_HOST = "subrouter-team.tail41290.ts.net";
const DEFAULT_TAILSCALE_DNS_SUFFIX = "tail41290.ts.net";
const DEFAULT_TAILSCALE_PROXY_PORT = 1055;
const IDENTITY_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;
const CODEX_PROMPT_FILE_RE = /^\/run\/cmuxd\/codex-prompt-[A-Fa-f0-9]{32}\.txt$/;
const TAILSCALE_DNS_SUFFIX_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

export function providerSecretTransferEnabled() {
  return providerFileTransferEnabled();
}

export function localSecretFromFile(path) {
  if (typeof path !== "string" || path.length === 0) return null;
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error("Tailscale auth-key file must be a regular file");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("Tailscale auth-key file must be owned by the current user");
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error("Tailscale auth-key file must not be group/world readable");
    }
    if (stat.size > 4096) {
      throw new Error("Tailscale auth-key file is too large");
    }
    const value = readFileSync(fd, "utf8").trim();
    if (!value) throw new Error("Tailscale auth-key file is empty");
    if (/[\0\r\n]/.test(value)) {
      throw new Error("Tailscale auth-key file contains invalid control characters");
    }
    return value;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function localPrivateTextFile(path, maxBytes = 64 * 1024) {
  if (typeof path !== "string" || path.length === 0 || /[\0\r\n]/.test(path)) return null;
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | noFollow);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return null;
    if ((stat.mode & 0o077) !== 0 || stat.size > maxBytes) return null;
    return readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function remoteSecretPath() {
  return `/run/cmux-home/ts-auth-${randomBytes(16).toString("hex")}`;
}

/** Build an sshpass invocation that reads the password from a private file. */
export function buildSshpassArgs(passFile, sshArgs) {
  if (typeof passFile !== "string" || passFile.length === 0) {
    throw new Error("sshpass password file is required");
  }
  // Do not let sshpass resolve `ssh` through PATH. A writable PATH entry
  // could replace it with a wrapper that reads the password file. The caller
  // still supplies ordinary ssh arguments, but the executable is fixed to a
  // system-owned path by trustedExecutable().
  return ["-f", passFile, trustedExecutable("ssh"), ...sshArgs];
}

export async function transferProviderSecret(vm, secret) {
  if (!providerSecretTransferEnabled()) {
    throw new Error(
      "refusing to transfer a Tailscale auth key; use a pre-authenticated VM or explicitly acknowledge the provider file API redaction contract",
    );
  }
  if (
    typeof secret !== "string" ||
    secret.trim().length === 0 ||
    /[\0\r\n]/.test(secret) ||
    secret.length > 4096
  ) {
    throw new Error("refusing an invalid Tailscale auth key");
  }
  const path = remoteSecretPath();
  const expectedDigest = createHash("sha256").update(secret, "utf8").digest("hex");
  const setup = await vm.exec({
    command: "PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH; test ! -L /run/cmux-home && install -d -o root -g root -m 0700 /run/cmux-home && test \"$(stat -c '%u:%g:%a' /run/cmux-home)\" = '0:0:700' && find /run/cmux-home -maxdepth 1 -type f -name 'ts-auth-*' -mmin +10 -delete",
    timeoutMs: 15_000,
  });
  if ((setup.statusCode ?? 0) !== 0) {
    throw new Error(`cannot prepare provider secret directory: ${redactSecrets(setup.stderr || setup.stdout || "unknown error")}`);
  }
  try {
    await vm.fs.writeTextFile(path, secret);
    const verify = await vm.exec({
      // Verify the provider wrote exactly the intended value. The digest is
      // safe to put in command text because the auth key itself is random and
      // never appears in argv, stdout, stderr, or the inherited environment.
      command: `PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH; test -f ${shellQuote(path)} && test ! -L ${shellQuote(path)} && chmod 0600 ${shellQuote(path)} && chown root:root ${shellQuote(path)} && test "$(stat -c '%a:%u:%g' ${shellQuote(path)})" = '600:0:0' && test "$(sha256sum ${shellQuote(path)} | awk '{print tolower($1)}')" = ${shellQuote(expectedDigest)}`,
      timeoutMs: 15_000,
    });
    if ((verify.statusCode ?? 0) !== 0) {
      throw new Error(verify.stderr || verify.stdout || "unknown error");
    }
    return path;
  } catch (error) {
    try { await vm.fs.remove(path); } catch {}
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`provider secret file could not be secured: ${redactSecrets(detail, [secret])}`);
  }
}

const needsFreestyleIdentity = (parsedArgs) =>
  !(parsedArgs.printBootstrap && parsedArgs.noSshCredential);

function ensureKnownHostsFile(path) {
  return ensurePrivateKnownHostsFile(path);
}

function sshHostKeyOptions() {
  const path = ensurePrivateKnownHostsFile();
  ensureKnownHostsFile(path);
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

function buildSshTransportArgs(args, hostKeyOptions) {
  const options = [
    "-F", "/dev/null",
    "-p", "22",
    "-o", hostKeyOptions[0],
    "-o", hostKeyOptions[1],
    "-o", "LogLevel=ERROR",
    "-o", "ProxyCommand=none",
    "-o", "LocalCommand=none",
    "-o", "PermitLocalCommand=no",
    "-o", "ForwardAgent=no",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=4",
  ];
  if (args.useReverseForward) {
    options.push("-R", `${args.subrouterPort}:127.0.0.1:${args.subrouterPort}`);
  }
  if (args.devServerMacPort) {
    options.push("-L", `${args.devServerMacPort}:127.0.0.1:3000`);
  } else {
    for (const port of args.forwardPorts) {
      options.push("-L", `${port}:127.0.0.1:${port}`);
    }
  }
  return options;
}

function isSafeVmId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function isSafeLinuxUser(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/.test(value);
}

function renderRemotePath(path) {
  if (typeof path !== "string" || path.length === 0 || /[\0\r\n]/.test(path)) {
    throw new Error("codex config path must be a non-empty path");
  }
  // Only expand the documented $HOME prefix. Allowing arbitrary shell
  // expansion here would turn a config-path option into a remote command
  // injection primitive.
  if (path.includes("$")) {
    if (!/^\$HOME(?:\/[A-Za-z0-9._+@%=-]+)*$/.test(path)) {
      throw new Error("codex config path may only use the $HOME prefix");
    }
    return `"${path}"`;
  }
  return shellQuote(path);
}

function safeSubrouterUrl(value, { allowLoopback = false, allowUntrusted = false } = {}) {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new Error("subrouter URL must be a non-empty HTTP(S) URL");
  }
  let url;
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
    url.hash
  ) {
    throw new Error("subrouter URL must not contain credentials, query, or fragment");
  }
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  const approvedTailnet = hostname === APPROVED_SUBROUTER_HOST;
  if (loopback) {
    if (!allowLoopback) {
      throw new Error("loopback subrouter URL requires --reverse-subrouter");
    }
  } else if (!approvedTailnet && !allowUntrusted) {
    throw new Error(
      "subrouter URL host is not approved; use the team tailnet URL or explicitly pass --allow-untrusted-subrouter",
    );
  }
  if (!loopback && url.protocol === "http:" && !approvedTailnet && !allowUntrusted) {
    throw new Error("non-tailnet subrouter URLs must use HTTPS");
  }
  if (
    /(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|tskey-[A-Za-z0-9-]{16,}|(?:token|secret|api[-_]?key)[=/_-][A-Za-z0-9._~-]{8,})/i.test(
      url.pathname,
    )
  ) {
    throw new Error("subrouter URL path looks like a secret-shaped path; pass a credential-free endpoint");
  }
  return url.href;
}

async function main() {
const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
  printHelp();
  process.exit(argv.length === 0 ? 1 : 0);
}

let args;
try {
  args = parseArgs(argv);
} catch (error) {
  const message = error instanceof Error ? error.message : "invalid command-line arguments";
  process.stderr.write(`error: ${redactSecrets(message)}\n`);
  process.exit(2);
}
if (!args.vmId) {
  printHelp();
  process.exit(1);
}
if (!isSafeVmId(args.vmId) || !isSafeLinuxUser(args.user)) {
  process.stderr.write("error: vmId and user must be simple Linux identifiers\n");
  process.exit(2);
}
if (args.printBootstrap && !args.noSshCredential) {
  process.stderr.write(
    "error: --print-bootstrap requires --no-ssh-credential; credentials are never serialized\n",
  );
  process.exit(2);
}
if (args.tailscaleAuthkey !== null) {
  process.stderr.write(
    "error: --tailscale-authkey is rejected because command-line credentials are observable; use --tailscale-authkey-file with the reviewed provider file transfer or pre-authenticate the VM\n",
  );
  process.exit(2);
}
if (args.codexPrompt !== null) {
  process.stderr.write(
    "error: --codex-prompt is rejected because prompt text is observable in argv; use --codex-prompt-file\n",
  );
  process.exit(2);
}
if (
  args.codexPromptFile !== null &&
  !CODEX_PROMPT_FILE_RE.test(args.codexPromptFile)
) {
  process.stderr.write("error: --codex-prompt-file must be a one-time file under /run/cmuxd\n");
  process.exit(2);
}
const allowProviderFileTransfer =
  !args.printBootstrap && providerSecretTransferEnabled();
const needsProviderApi =
  needsFreestyleIdentity(args) || allowProviderFileTransfer;

// Credential-free bootstrap mode must not read a provider key at all. Load it
// only after argument validation proves that this invocation needs the API.
let freestyleApiKey = needsProviderApi
  ? process.env.FREESTYLE_API_KEY?.trim() || null
  : null;
if (needsProviderApi && !freestyleApiKey) {
  const candidateFiles = [
    process.env.FREESTYLE_ENV_FILE,
    join(homedir(), ".secrets", "cmux.env"),
    join(homedir(), ".secrets", "cmuxterm.env"),
    join(homedir(), ".secrets", "cmuxterm-dev.env"),
    join(homedir(), ".freestyle", "env"),
  ].filter(Boolean);
  for (const file of candidateFiles) {
    if (!existsSync(file)) continue;
    const body = localPrivateTextFile(file);
    const match = body?.match(/^\s*FREESTYLE_API_KEY\s*=\s*(.+?)\s*$/m);
    if (match) {
      const raw = match[1].trim().replace(/^['"]|['"]$/g, "");
      if (raw) {
        freestyleApiKey = raw;
        process.stderr.write("[freestyle-vm-ssh] using FREESTYLE_API_KEY from a private env file\n");
        break;
      }
    }
  }
}

// Neither child commands nor a credential-free bootstrap need these inputs.
// Keep both the value and the dotenv pointer out of inherited environments.
delete process.env.FREESTYLE_API_KEY;
delete process.env.FREESTYLE_ENV_FILE;

if (needsProviderApi && !freestyleApiKey) {
  process.stderr.write("error: FREESTYLE_API_KEY is required\n");
  process.exit(1);
}
if (freestyleApiKey && /[\0\r\n]/.test(freestyleApiKey)) {
  process.stderr.write("error: FREESTYLE_API_KEY contains an invalid control character\n");
  process.exit(2);
}

// Pass the key directly to the SDK. The inherited environment was cleared
// above before any child process can be started.
const fs = needsProviderApi
  ? new Freestyle({ apiKey: freestyleApiKey, baseUrl: freestyleApiBaseUrl() })
  : null;
delete process.env.FREESTYLE_API_KEY;

let identityId = "";
let identityTokenId = "";
let identityExpiryTimer = null;
let tmpDir = "";
const sensitiveValues = [];
if (freestyleApiKey) sensitiveValues.push(freestyleApiKey);
const remoteSecretFiles = [];

const cleanup = async () => {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    tmpDir = "";
  }
  while (remoteSecretFiles.length > 0) {
    const entry = remoteSecretFiles.pop();
    if (!entry) continue;
    try { await entry.vm.fs.remove(entry.path); } catch {}
  }
  if (identityExpiryTimer) {
    clearTimeout(identityExpiryTimer);
    identityExpiryTimer = null;
  }
  if (identityId && fs) {
    if (identityTokenId) {
      try {
        await fs.identities.ref({ identityId }).tokens.revoke({ tokenId: identityTokenId });
      } catch {}
      identityTokenId = "";
    }
    try { await fs.identities.delete({ identityId }); } catch {}
    identityId = "";
  }
};

const installCleanup = () => {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => { void cleanup().finally(() => process.exit(0)); });
  }
  process.on("exit", () => { /* sync cleanup already happened */ });
};

try {
  installCleanup();

  process.stderr.write(
    `[freestyle-vm-ssh] ${fs ? "minting credentials" : "building credential-free bootstrap"} for ${args.vmId}…\n`,
  );

  // Validate all user-controlled routing inputs before minting any provider
  // identity. This keeps malformed URLs from creating short-lived credentials.
  const subrouterUrlForVm =
    args.subrouterUrl
      ?? process.env.SUBROUTER_REMOTE_URL?.trim()
      ?? (args.useReverseForward ? `http://127.0.0.1:${args.subrouterPort}/v1` : null)
      ?? (args.tailscale ? DEFAULT_TAILNET_SUBROUTER_URL : null);
  const validatedSubrouterUrl = subrouterUrlForVm
    ? safeSubrouterUrl(subrouterUrlForVm, {
        allowLoopback: args.useReverseForward,
        allowUntrusted: args.allowUntrustedSubrouter,
      })
    : null;

  const configuredTailnetDnsSuffix =
    process.env.CMUX_HOME_TAILSCALE_DNS_SUFFIX?.trim() || DEFAULT_TAILSCALE_DNS_SUFFIX;
  if (!TAILSCALE_DNS_SUFFIX_RE.test(configuredTailnetDnsSuffix)) {
    throw new Error("CMUX_HOME_TAILSCALE_DNS_SUFFIX is invalid");
  }

  const directAttach = ["dev-start", "dev-tail", "shell-attach"].includes(args.attachMode);
  const configuredTailscaleKey = process.env.TAILSCALE_AUTHKEY?.trim() || null;
  // Do not leave a credential in the environment inherited by sshpass or any
  // command run by this helper. Capture it only after all argument validation
  // has completed, and never pass it to a child process.
  delete process.env.TAILSCALE_AUTHKEY;
  const allowProviderFileTransfer =
    !args.printBootstrap && providerSecretTransferEnabled();
  if (
    !args.printBootstrap &&
    !directAttach &&
    args.tailscale &&
    configuredTailscaleKey &&
    !allowProviderFileTransfer
  ) {
    throw new Error(
      "TAILSCALE_AUTHKEY is set, but provider secret transfer is disabled; pre-authenticate the VM or explicitly acknowledge the provider file API redaction contract",
    );
  }
  if (args.tailscaleAuthkeyFile &&
      (!args.tailscale || args.printBootstrap || directAttach || !allowProviderFileTransfer)) {
    throw new Error(
      "--tailscale-authkey-file requires the reviewed provider file transfer; pre-authenticate the VM or set CMUX_HOME_ALLOW_PROVIDER_SECRET_FILE_TRANSFER=1 with CMUX_HOME_PROVIDER_SECRET_REDACTION_ACK=freestyle-file-api-v1",
    );
  }
  // Read and validate the local key before starting an identity request. If a
  // path is stale, a symlink, or has weak permissions, fail before creating a
  // provider identity that could otherwise be orphaned by this early error.
  let tailscaleAuthKey = null;
  if (args.tailscale && !args.printBootstrap && !directAttach && allowProviderFileTransfer) {
    tailscaleAuthKey =
      (args.tailscaleAuthkeyFile ? localSecretFromFile(args.tailscaleAuthkeyFile) : null) ??
      configuredTailscaleKey;
  }

  // Mint the Freestyle SSH credentials and the Tailscale preauth key in
  // parallel. Each independent SDK call is ~200-400ms; doing them serially
  // costs ~1s, in parallel it costs ~the longer of the two.
  const freestyleP = fs
    ? (async () => {
        const created = await fs.identities.create({});
        identityId = created.identityId;
        const identity = created.identity;
        await identity.permissions.vms.grant({ vmId: args.vmId, allowedUsers: [args.user] });
        const tok = await identity.tokens.create();
        const token = typeof tok === "string" ? tok : tok.token;
        if (typeof tok !== "string" && tok.tokenId) identityTokenId = tok.tokenId;
        if (!token) throw new Error("failed to mint freestyle token");
        return token;
      })()
    : Promise.resolve(null);

  // Never mint a Tailscale key from the local tsadmin CLI. That CLI places its
  // API bearer in a child curl argv. Require an already-authenticated VM or an
  // explicitly supplied key file under the provider redaction contract.
  const token = await freestyleP;

  if (identityId && fs) {
    // Freestyle identity tokens do not currently expose a server-side TTL.
    // Bound this process's lease and revoke the token before deleting the
    // identity. A crash can still leave a provider-side identity until its
    // reaper runs, so operators should keep the provider reaper enabled.
    identityExpiryTimer = setTimeout(() => { void cleanup(); }, IDENTITY_MAX_LIFETIME_MS);
    identityExpiryTimer.unref?.();
  }

  if (token) {
    // Keep credentials in a mode-0600 file. sshpass reads this file directly,
    // so the token never appears in argv, SSHPASS, or inherited environment.
    sensitiveValues.push(token);
  }

  if (token) {
    tmpDir = mkdtempSync(join(tmpdir(), "freestyle-vm-ssh-"));
  }
  const passFile = token ? join(tmpDir, "pass") : null;
  if (token && passFile) {
    writeFileSync(passFile, token, { mode: 0o600 });
    chmodSync(passFile, 0o600);
  }

  const remoteHost = `${args.vmId}+${args.user}@vm-ssh.freestyle.sh`;
  let baseSshArgs = null;

  // Resolve a Tailscale auth key only when the reviewed provider file transfer
  // is enabled. Without it, the generated command requires an already joined
  // VM and never contains a recoverable credential.
  let tailscaleAuthKeyPath = null;
  if (!args.printBootstrap && !directAttach && args.tailscale && allowProviderFileTransfer) {
    if (tailscaleAuthKey) {
      sensitiveValues.push(tailscaleAuthKey);
      if (!fs) throw new Error("provider file transfer requires the Freestyle API");
      const vmRef = fs.vms.ref({ vmId: args.vmId });
      if (typeof vmRef.user !== "function") {
        throw new Error("Freestyle SDK must support an explicit root VM file/exec user");
      }
      const rootVm = vmRef.user({ username: "root" });
      tailscaleAuthKeyPath = await transferProviderSecret(rootVm, tailscaleAuthKey);
      remoteSecretFiles.push({ vm: rootVm, path: tailscaleAuthKeyPath });
    }
  }

  const remoteSteps = [];
  // Install cleanup before any bootstrap step. A failed Tailscale, config, or
  // repository step must not leave private prompt text under /run/cmuxd. The
  // final nested shell installs its own trap because it replaces this shell.
  const promptPath = args.codexPromptFile ? shellQuote(args.codexPromptFile) : null;
  if (promptPath) {
    remoteSteps.push(
      `prompt_file=${promptPath}; cleanup_prompt() { rm -f -- "$prompt_file"; }; trap cleanup_prompt EXIT`,
    );
  }

  // Lightweight attach modes that skip the full bootstrap: just SSH into
  // the VM and run a single fire-and-forget remote command.
  //   --attach-dev-start: run `bun dev` in the foreground inside
  //                       ~/cmux/web (visible logs, Ctrl-C restartable).
  //                       Waits for the cmux clone to land if the main
  //                       codex pane is still bootstrapping.
  //   --attach-shell:     drop into bash, cwd ~/cmux when it exists.
  if (
    args.attachMode === "dev-start" ||
    args.attachMode === "dev-tail" ||
    args.attachMode === "shell-attach"
  ) {
    if (!token || !passFile) {
      throw new Error("an SSH credential is required for direct attach mode");
    }
    const hostKeyOptions = sshHostKeyOptions();
    baseSshArgs = buildSshTransportArgs(args, hostKeyOptions);
    const remoteHost = `${args.vmId}+${args.user}@vm-ssh.freestyle.sh`;
    const remoteCmd =
      args.attachMode === "dev-start"
        ? // Wait for cmux/web/package.json to appear (the codex pane's
          // bootstrap clones + runs bun install), ensure the
          // ~/.secrets/cmuxterm-dev.env stub exists (dev-local.sh errors
          // out without it), then exec bun dev in the foreground.
          // The browser reaches this service through cmuxd's authenticated
          // proxy, so keep it on loopback instead of exposing all interfaces.
          // exec replaces the bash so Ctrl-C goes straight to bun.
          `printf '[freestyle-vm-ssh] waiting for ~/cmux/web…\\n' && ` +
          `while [ ! -f $HOME/cmux/web/package.json ]; do sleep 1; done && ` +
          `mkdir -p $HOME/.secrets && ` +
          `if [ ! -f $HOME/.secrets/cmuxterm-dev.env ]; then ` +
          `  printf '%s\\n' ` +
          // Use single-quoted echo args; each is a literal KEY=VALUE
          // line for cmux web's dev-local.sh. These are stub values so
          // the dev server boots and public pages render; routes that
          // hit Stack Auth / Convex will 500 but that is fine for
          // demo / browse use.
          `    'STACK_SECRET_SERVER_KEY=dev-stub' ` +
          `    'NEXT_PUBLIC_STACK_PROJECT_ID=dev-stub' ` +
          `    'NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY=dev-stub' ` +
          `    'NEXT_PUBLIC_CONVEX_URL=https://dev-stub.convex.cloud' ` +
          `    'CONVEX_DEPLOYMENT=dev:dev-stub' ` +
          `    'RESEND_API_KEY=cmux-local-dev' ` +
          `    'CMUX_FEEDBACK_FROM_EMAIL=dev@example.invalid' ` +
          `    'CMUX_FEEDBACK_RATE_LIMIT_ID=cmux-feedback-local' ` +
          `    > $HOME/.secrets/cmuxterm-dev.env; ` +
          `fi && ` +
          `cd $HOME/cmux/web && ` +
          `printf '[freestyle-vm-ssh] starting bun dev on :3000\\n\\n' && ` +
          `exec env CMUX_PORT=3000 HOSTNAME=127.0.0.1 HOST=127.0.0.1 ` +
          `CMUX_DEV_START_DB=0 CMUX_DEV_STOP_DB_ON_EXIT=0 bun dev --hostname 127.0.0.1`
        : args.attachMode === "dev-tail"
          ? `printf '%s\\n\\n' ${shellQuote(`[freestyle-vm-ssh] tailing /tmp/cmux-dev.log on ${args.vmId}`)} && ` +
            `while [ ! -f /tmp/cmux-dev.log ]; do sleep 0.5; done && ` +
            `tail -n 500 -F /tmp/cmux-dev.log`
          : // shell-attach: cd ~/cmux when it exists, else $HOME.
            `cd $HOME/cmux 2>/dev/null || cd $HOME; exec bash -l`;
    const finalArgs = [...baseSshArgs, "-tt", remoteHost, remoteCmd];
    const child = spawn(trustedExecutable("sshpass"), buildSshpassArgs(passFile, finalArgs), {
      stdio: "inherit",
      env: sanitizedEnvironment(),
    });
    child.on("exit", async (code, signal) => {
      await cleanup();
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 0);
    });
    child.on("error", async (err) => {
      process.stderr.write(`sshpass exec failed: ${redactSecrets(err.message, sensitiveValues)}\n`);
      await cleanup();
      process.exit(127);
    });
    return; // skip the normal bootstrap path
  }

  if (args.tailscale && !directAttach) {
    const tsHostname = args.tailscaleHostname ?? `fs-${args.vmId.slice(0, 8)}`;
    const tsScript = buildTailscaleBootstrap({
      authKeyPath: tailscaleAuthKeyPath,
      hostname: tsHostname,
      proxyPort: DEFAULT_TAILSCALE_PROXY_PORT,
      tailnetDnsSuffix: configuredTailnetDnsSuffix,
    });
    const encoded = Buffer.from(tsScript, "utf8").toString("base64");
    remoteSteps.push(
      `printf '%s' ${shellQuote(encoded)} | base64 -d | sudo bash -e`,
    );
  }
  if (args.codexConfigPath !== null && validatedSubrouterUrl) {
    const remoteConfigPath = args.codexConfigPath ?? "$HOME/.codex/config.toml";
    // Derive the directory from the path. Only the documented `$HOME` prefix
    // is expanded; all other paths are passed as single-quoted literals.
    const lastSlash = remoteConfigPath.lastIndexOf("/");
    const remoteConfigDir = lastSlash > 0 ? remoteConfigPath.slice(0, lastSlash) : ".";
    const pathRendered = renderRemotePath(remoteConfigPath);
    const dirRendered = renderRemotePath(remoteConfigDir);
    // Build a codex config that defines a custom `subrouter` provider. This
    // matters because (1) it uses the wire-protocol Subrouter expects
    // (`responses`) and (2) it gives us a place to set HTTP headers, which is
    // the only way to force a specific Subrouter account from inside the VM
    // (the `subrouter codex` wrapper isn't available here).
    const forcedAccount =
      args.subrouterAccountId
      ?? process.env.SUBROUTER_CODEX_ACCOUNT_ID?.trim()
      ?? null;
    if (forcedAccount && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(forcedAccount)) {
      throw new Error("subrouter account id contains unsupported characters");
    }
    const userEmail =
      args.subrouterUserEmail ?? process.env.SUBROUTER_CODEX_USER_EMAIL?.trim() ?? null;
    if (userEmail && /[\0\r\n]/.test(userEmail)) {
      throw new Error("subrouter user email contains an invalid control character");
    }
    if (userEmail && !/^[^\s@\r\n]{1,320}@[^\s@\r\n]{1,320}$/.test(userEmail)) {
      throw new Error("subrouter user email is invalid");
    }
    const headerLines = [];
    if (forcedAccount) {
      headerLines.push(
        `X-Subrouter-Account-ID = ${JSON.stringify(forcedAccount)}`,
      );
    }
    if (userEmail) {
      headerLines.push(
        `X-Subrouter-User-Email = ${JSON.stringify(userEmail)}`,
      );
    }
    const headersBlock =
      headerLines.length === 0
        ? ""
        : `\n[model_providers.subrouter.http_headers]\n${headerLines.join("\n")}\n`;
    // Pre-trust the directories the helper sets cwd to so codex doesn't
    // halt at the "Do you trust the contents of this directory?" prompt
    // every time we exec it. Trusts the cmux repo root (when --clone-cmux
    // is set) and the user's home dir as a defensive default.
    const trustedPaths = ["/home/cmux", "/home/cmux/cmux"];
    const trustBlock = trustedPaths
      .map((p) => `\n[projects."${p}"]\ntrust_level = "trusted"\n`)
      .join("");
    const codexConfigBody =
      `# Written by freestyle-vm-ssh so codex routes through Subrouter.\n` +
      `model_provider = "subrouter"\n` +
      `\n` +
      `[model_providers.subrouter]\n` +
      `name = "Subrouter"\n` +
      `base_url = ${JSON.stringify(validatedSubrouterUrl)}\n` +
      `wire_api = "responses"\n` +
      headersBlock +
      trustBlock;
    const encodedConfig = Buffer.from(codexConfigBody, "utf8").toString("base64");
    const subrouterOrigin = new URL(validatedSubrouterUrl).origin;
    remoteSteps.push(
      `mkdir -p ${dirRendered}`,
      `printf '%s' ${shellQuote(encodedConfig)} | base64 -d > ${pathRendered}`,
      `chmod 600 ${pathRendered}`,
      `printf '%s\\n' ${shellQuote(`[freestyle-vm-ssh] codex configured to use subrouter origin ${subrouterOrigin}`)}`,
    );
    if (forcedAccount) {
      remoteSteps.push(
        `printf '%s\\n' '[freestyle-vm-ssh] codex forced subrouter account configured'`,
      );
    }
  } else {
    const note = args.codexConfigPath === null
      ? "codex config write disabled via --no-codex-config"
      : "no subrouter URL configured";
    remoteSteps.push(`printf '\\n[freestyle-vm-ssh] %s\\n' ${shellQuote(note)}`);
  }
  remoteSteps.push(
    `printf '[freestyle-vm-ssh] forwarded local ports: ${args.forwardPorts.join(",")}\\n\\n'`,
  );

  let codexCwd = "$HOME";
  if (args.cloneCmux) {
    const cloneScript = buildCmuxCloneBootstrap();
    const encodedClone = Buffer.from(cloneScript, "utf8").toString("base64");
    remoteSteps.push(
      `printf '%s' ${shellQuote(encodedClone)} | base64 -d | bash`,
    );
    codexCwd = "$HOME/cmux/web";
  }

  if (args.codexPromptFile) {
    // Read the prompt from a one-time mode-0600 file. `codex exec -` consumes
    // stdin, so prompt text never appears in argv, shell history, or the JSON
    // bootstrap. The file is removed by the command and its EXIT trap.
    const previewLine = "[freestyle-vm-ssh] launching codex with prompt";
    remoteSteps.push(
      `printf '%s\\n\\n' ${shellQuote(previewLine)}`,
      `test -f ${promptPath} && test ! -L ${promptPath} && test "$(stat -c '%a:%u:%g' ${promptPath})" = "600:$(id -u):$(id -g)"`,
      `cd ${codexCwd} && exec bash -lc 'prompt_file="$2"; cleanup_prompt() { rm -f -- "$prompt_file"; }; trap cleanup_prompt EXIT; cd "$1" && codex exec - < "$prompt_file" || true; cleanup_prompt; trap - EXIT; exec bash -l' cmux-home ${codexCwd} ${promptPath}`,
    );
  } else {
    remoteSteps.push(`cd ${codexCwd} && exec bash -l`);
  }
  const remoteCommandBody = remoteSteps.join(" && ");
  // Run prompt-bearing bootstraps in a subshell. The command is entered into
  // an interactive PTY, where an EXIT trap in the parent shell would not run
  // when an && chain fails and returns to the prompt.
  const remoteCommand = args.codexPromptFile
    ? `( ${remoteCommandBody} )`
    : remoteCommandBody;

  // --print-bootstrap is used by cmux-home's WebSocket path. It deliberately
  // emits no credential or identity. The remote command runs in the already
  // authenticated PTY and therefore does not need SSH password auth.
  if (args.printBootstrap) {
    process.stdout.write(
      JSON.stringify({
        version: 2,
        destination: `${args.vmId}+${args.user}@vm-ssh.freestyle.sh`,
        identityId: null,
        remoteCommand,
      }) + "\n",
    );
    process.exit(0);
  }

  if (!token || !passFile) {
    throw new Error("an SSH credential is required for direct attach mode");
  }
  const hostKeyOptions = sshHostKeyOptions();
  baseSshArgs = buildSshTransportArgs(args, hostKeyOptions);

  // Force TTY allocation. Single -t downgrades to no TTY when our stdin
  // isn't a terminal (it isn't, when called from cmux's workspace
  // initial_command since cmux pipes through). -tt forces it; the remote
  // bash chain (and codex once running) expects a TTY.
  const finalArgs = [...baseSshArgs, "-tt", remoteHost, remoteCommand];

  const reverseLog = args.useReverseForward
    ? `-R ${args.subrouterPort}:127.0.0.1:${args.subrouterPort} `
    : "";
  const forwardLog = args.forwardPorts.map((p) => `-L ${p}:127.0.0.1:${p}`).join(" ");
  process.stderr.write(`[freestyle-vm-ssh] ssh ${reverseLog}${forwardLog} ${remoteHost}\n`);

  const child = spawn(trustedExecutable("sshpass"), buildSshpassArgs(passFile, finalArgs), {
    stdio: "inherit",
    env: sanitizedEnvironment(),
  });
  child.on("exit", async (code, signal) => {
    await cleanup();
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  child.on("error", async (err) => {
    process.stderr.write(`sshpass exec failed: ${redactSecrets(err.message, sensitiveValues)}\n`);
    if (err.message.includes("ENOENT")) {
      process.stderr.write(
        "Install sshpass first: brew install hudochenkov/sshpass/sshpass\n",
      );
    }
    await cleanup();
    process.exit(127);
  });
} catch (err) {
  const detail = err && typeof err === "object" && "message" in err ? err.message : String(err);
  process.stderr.write(`[freestyle-vm-ssh] error: ${redactSecrets(detail, sensitiveValues)}\n`);
  await cleanup();
  process.exit(1);
}
}

if (isMain) {
  await main();
}

export function parseArgs(argv) {
  const out = {
    vmId: null,
    user: "cmux",
    subrouterPort: 31415,
    forwardPorts: [],
    codexConfigPath: undefined,
    useReverseForward: false,
    subrouterUrl: null,
    allowUntrustedSubrouter: false,
    subrouterUserEmail: null,
    passwordFile: true,
    tailscale: true,
    tailscaleAuthkey: null,
    tailscaleAuthkeyFile: null,
    tailscaleHostname: null,
    subrouterAccountId: null,
    codexPrompt: null,
    codexPromptFile: null,
    cloneCmux: false,
    devServerMacPort: null,
    attachMode: "shell",
    printBootstrap: false,
    noSshCredential: false,
  };
  const valueFor = (flag, index) => {
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  const portFor = (flag, index) => {
    const value = valueFor(flag, index);
    if (!/^\d+$/.test(value)) throw new Error(`${flag} must be an integer from 1 to 65535`);
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`${flag} must be an integer from 1 to 65535`);
    }
    return port;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--") && !out.vmId) {
      out.vmId = a;
      continue;
    }
    if (!a.startsWith("-")) {
      throw new Error(`unexpected positional argument: ${a}`);
    }
    switch (a) {
      case "--user":
        out.user = valueFor(a, i);
        i += 1;
        break;
      case "--subrouter-port":
        out.subrouterPort = portFor(a, i);
        i += 1;
        break;
      case "--subrouter-url":
        out.subrouterUrl = valueFor(a, i);
        i += 1;
        break;
      case "--allow-untrusted-subrouter":
        out.allowUntrustedSubrouter = true;
        break;
      case "--subrouter-user-email":
        out.subrouterUserEmail = valueFor(a, i);
        i += 1;
        break;
      case "--reverse-subrouter":
        out.useReverseForward = true;
        break;
      case "--forward":
      case "-L": {
        out.forwardPorts.push(portFor(a, i));
        i += 1;
        break;
      }
      case "--codex-config":
        out.codexConfigPath = valueFor(a, i);
        i += 1;
        break;
      case "--no-codex-config":
        out.codexConfigPath = null;
        break;
      case "--tailscale":
        out.tailscale = true;
        break;
      case "--no-tailscale":
        out.tailscale = false;
        break;
      case "--tailscale-authkey":
        out.tailscaleAuthkey = valueFor(a, i);
        i += 1;
        break;
      case "--tailscale-authkey-file":
        out.tailscaleAuthkeyFile = valueFor(a, i);
        i += 1;
        break;
      case "--tailscale-hostname":
        out.tailscaleHostname = valueFor(a, i);
        i += 1;
        break;
      case "--subrouter-account-id":
        out.subrouterAccountId = valueFor(a, i);
        i += 1;
        break;
      case "--codex-prompt":
        out.codexPrompt = valueFor(a, i);
        i += 1;
        break;
      case "--codex-prompt-file":
        out.codexPromptFile = valueFor(a, i);
        i += 1;
        break;
      case "--clone-cmux":
        out.cloneCmux = true;
        break;
      case "--dev-server-mac-port": {
        out.devServerMacPort = portFor(a, i);
        i += 1;
        break;
      }
      case "--attach-dev-tail":
        out.attachMode = "dev-tail";
        break;
      case "--attach-dev-start":
        out.attachMode = "dev-start";
        break;
      case "--attach-shell":
        out.attachMode = "shell-attach";
        break;
      case "--print-bootstrap":
        out.printBootstrap = true;
        break;
      case "--no-ssh-credential":
        out.noSshCredential = true;
        break;
      default:
        throw new Error(`unknown option: ${a}`);
    }
  }
  if (out.forwardPorts.length === 0) {
    out.forwardPorts = [3000, 5173, 8000, 8080];
  }
  if (out.codexConfigPath === undefined) {
    out.codexConfigPath = "$HOME/.codex/config.toml";
  }
  return out;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function buildCmuxCloneBootstrap() {
  const repository = CMUX_REPOSITORY;
  if (
    !repository ||
    repository.url !== "https://github.com/manaflow-ai/cmux.git" ||
    !/^[0-9a-f]{40}$/i.test(repository.commit)
  ) {
    throw new Error("cmux repository metadata is incomplete");
  }
  const repoUrl = shellQuote(repository.url);
  const repoCommit = shellQuote(repository.commit.toLowerCase());
  // Idempotent: fetches one reviewed commit into ~/cmux and checks out a
  // detached worktree. Mutable branch names are never used. Writes a stub
  // ~/.secrets/cmuxterm-dev.env so cmux's dev-local.sh script doesn't bail
  // on missing secrets, then installs locked web dependencies without
  // lifecycle scripts before the dedicated dev-server pane runs `bun dev`.
  //
  // We deliberately do NOT start the dev server here anymore: cmux-home's
  // task workspace dedicates a foreground pane to `bun dev` via the
  // --attach-dev-start helper mode, so the user can see live logs +
  // restart with Ctrl-C instead of tailing a backgrounded log file.
  return [
    "set -eu",
    // The remote shell is part of the trust boundary. Validate HOME before
    // expanding it in any path, and reject a symlink or a directory writable
    // by another account.
    'cmux_private_mode() { case "$1" in *[2367][0-7]|*[0-7][2367]) return 1 ;; esac; return 0; }; cmux_secret_mode() { case "$1" in ""|*[!0-7]*|*[1-7][0-7]|*[0-7][1-7]) return 1 ;; esac; return 0; }; cmux_home="${HOME:-}"; case "$cmux_home" in /*) ;; *) echo "[freestyle-vm-ssh] remote HOME must be absolute" >&2; exit 1 ;; esac; test -d "$cmux_home" && test ! -L "$cmux_home"; cmux_private_mode "$(stat -c \'%a\' "$cmux_home")"; test "$(stat -c \'%u\' "$cmux_home")" = "$(id -u)"',
    'export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0',
    // Every Git operation uses a fixed command policy. This disables hooks,
    // credential helpers, filters, proxies, protocol extensions, and SSH
    // command overrides that may be present in a pre-existing .git/config.
    'cmux_git() { /usr/bin/git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.sshCommand=/usr/bin/false -c credential.helper= -c http.proxy= -c https.proxy= -c protocol.ext.allow=never -c protocol.file.allow=never -c protocol.https.allow=always -c protocol.allow=never -c fetch.fsckObjects=true -c transfer.fsckObjects=true "$@"; }',
    'if [ -e "$cmux_home/cmux" ] && { test -L "$cmux_home/cmux" || test ! -d "$cmux_home/cmux"; }; then',
    '  echo "[freestyle-vm-ssh] refusing to replace a non-git ~/cmux directory" >&2; exit 1',
    "fi",
    'if [ -d "$cmux_home/cmux/.git" ] && { test -L "$cmux_home/cmux/.git" || test ! -f "$cmux_home/cmux/.git/config"; }; then',
    '  echo "[freestyle-vm-ssh] refusing an unsafe ~/cmux git directory" >&2; exit 1',
    "fi",
    'if [ -d "$cmux_home/cmux/.git" ]; then',
    '  test "$(stat -c \'%u\' "$cmux_home/cmux")" = "$(id -u)"; cmux_private_mode "$(stat -c \'%a\' "$cmux_home/cmux")"',
    "fi",
    'if [ ! -d "$cmux_home/cmux/.git" ]; then',
    '  echo "[freestyle-vm-ssh] cloning manaflow-ai/cmux…"',
    '  cmux_git init --quiet "$cmux_home/cmux"',
    `  cmux_git -C "$cmux_home/cmux" remote add origin ${repoUrl}`,
    "fi",
    `if ! cmux_git -C "$cmux_home/cmux" remote get-url origin >/dev/null 2>&1; then cmux_git -C "$cmux_home/cmux" remote add origin ${repoUrl}; fi`,
    `cmux_origin=$(cmux_git -C "$cmux_home/cmux" remote get-url origin 2>/dev/null || true)`,
    `test "$cmux_origin" = ${repoUrl} || { echo "[freestyle-vm-ssh] ~/cmux origin is not the reviewed repository" >&2; exit 1; }`,
    `test -z "$(cmux_git -C "$cmux_home/cmux" status --porcelain)" || { echo "[freestyle-vm-ssh] refusing to overwrite a dirty ~/cmux checkout" >&2; exit 1; }`,
    `cmux_git -C "$cmux_home/cmux" fetch --quiet --no-tags --depth 1 origin ${repoCommit}`,
    `cmux_git -C "$cmux_home/cmux" cat-file -e ${repoCommit}^{commit}`,
    `cmux_git -C "$cmux_home/cmux" checkout --quiet --detach ${repoCommit}`,
    `test "$(cmux_git -C "$cmux_home/cmux" rev-parse HEAD)" = ${repoCommit}`,
    // Create the dev dotenv file atomically. Existing symlinks, foreign
    // ownership, and group/world writable modes are rejected before a write.
    'cmux_secrets_dir="$cmux_home/.secrets"; if [ -e "$cmux_secrets_dir" ] && test ! -d "$cmux_secrets_dir"; then echo "[freestyle-vm-ssh] refusing an unsafe secrets directory" >&2; exit 1; fi; if [ -e "$cmux_secrets_dir" ] && test -L "$cmux_secrets_dir"; then echo "[freestyle-vm-ssh] refusing a symlink secrets directory" >&2; exit 1; fi; install -d -m 0700 "$cmux_secrets_dir"; test "$(stat -c \'%u\' "$cmux_secrets_dir")" = "$(id -u)"; cmux_secret_mode "$(stat -c \'%a\' "$cmux_secrets_dir")"',
    'cmux_env_file="$cmux_secrets_dir/cmuxterm-dev.env"; if [ -e "$cmux_env_file" ] && test -L "$cmux_env_file"; then echo "[freestyle-vm-ssh] refusing a symlink dev env file" >&2; exit 1; fi; if [ -e "$cmux_env_file" ]; then test -f "$cmux_env_file"; test "$(stat -c \'%u\' "$cmux_env_file")" = "$(id -u)"; cmux_secret_mode "$(stat -c \'%a\' "$cmux_env_file")"; else umask 077; cmux_env_tmp=$(mktemp "$cmux_secrets_dir/.cmuxterm-dev.env.XXXXXX"); cat > "$cmux_env_tmp" <<\'STUB\'',
    "# Stub written by freestyle-vm-ssh so cmux web's dev-local.sh proceeds.",
    "# Most routes will 500 without real Stack Auth + Convex secrets, but the",
    "# top-level Next.js dev server still binds and renders public pages.",
    "STACK_SECRET_SERVER_KEY=stub",
    "NEXT_PUBLIC_STACK_PROJECT_ID=stub",
    "NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY=stub",
    "STUB",
    '  chmod 0600 "$cmux_env_tmp"; mv -f -- "$cmux_env_tmp" "$cmux_env_file"; fi',
    'echo "[freestyle-vm-ssh] bun install in cmux/web (so dev pane starts fast)…"',
    'cd "$cmux_home/cmux/web" && env -i HOME="$cmux_home" PATH="/usr/local/bin:/usr/bin:/bin" bun install --frozen-lockfile --ignore-scripts --silent >/dev/null 2>&1 || { echo "[freestyle-vm-ssh] locked dependency install failed" >&2; exit 1; }',
  ].join("\n");
}

export function buildTailscaleBootstrap(options) {
  const {
    authKeyPath = null,
    hostname,
    proxyPort,
    tailnetDnsSuffix = DEFAULT_TAILSCALE_DNS_SUFFIX,
  } = options ?? {};
  if (Object.prototype.hasOwnProperty.call(options ?? {}, "authKey")) {
    throw new Error("raw Tailscale auth keys are not accepted; use authKeyPath");
  }
  if (
    authKeyPath !== null &&
    (typeof authKeyPath !== "string" ||
      !/^\/run\/cmux-home\/ts-auth-[A-Za-z0-9._-]+$/.test(authKeyPath))
  ) {
    throw new Error("authKeyPath must be a one-time file under /run/cmux-home");
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(String(hostname))) {
    throw new Error("invalid Tailscale hostname");
  }
  if (
    typeof tailnetDnsSuffix !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(tailnetDnsSuffix)
  ) {
    throw new Error("invalid Tailscale DNS suffix");
  }
  const port = Number(proxyPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid Tailscale proxy port");
  }
  const version = TAILSCALE_RELEASE.version;
  const amd64 = TAILSCALE_RELEASE.assets.amd64;
  const arm64 = TAILSCALE_RELEASE.assets.arm64;
  if (
    !/^\d+\.\d+\.\d+$/.test(String(version)) ||
    !/^[0-9a-f]{64}$/i.test(amd64?.sha256 ?? "") ||
    !/^[0-9a-f]{64}$/i.test(amd64?.tailscaleSha256 ?? "") ||
    !/^[0-9a-f]{64}$/i.test(amd64?.tailscaledSha256 ?? "") ||
    !/^[0-9a-f]{64}$/i.test(arm64?.sha256 ?? "") ||
    !/^[0-9a-f]{64}$/i.test(arm64?.tailscaleSha256 ?? "") ||
    !/^[0-9a-f]{64}$/i.test(arm64?.tailscaledSha256 ?? "")
  ) {
    throw new Error("Tailscale release metadata is incomplete");
  }
  const digestLines = sha256CheckShell("$ts_archive", "$ts_expected", "tailscale");
  const wantFlags = `--tun=userspace-networking --outbound-http-proxy-listen=127.0.0.1:${port} --socks5-server=127.0.0.1:${port}`;
  const authCleanupLines = [
    `ts_auth_file=${authKeyPath ? shellQuote(authKeyPath) : ""}`,
    "ts_install_dir=",
    "ts_cleanup() {",
    '  if [ -n "$ts_auth_file" ]; then rm -f -- "$ts_auth_file"; fi',
    '  if [ -n "$ts_install_dir" ]; then rm -rf -- "$ts_install_dir"; fi',
    "}",
    "trap ts_cleanup EXIT",
  ];
  const joinLines = authKeyPath
    ? [
        '  if [ ! -f "$ts_auth_file" ]; then echo "[freestyle-vm-ssh] Tailscale auth file is missing" >&2; exit 1; fi',
        '  chmod 0600 "$ts_auth_file"',
        `  if ! tailscale --socket=/run/tailscale/tailscaled.sock up --auth-key="file:$ts_auth_file" --hostname=${shellQuote(hostname)} --ssh=false >/dev/null 2>&1; then echo '[freestyle-vm-ssh] Tailscale join failed' >&2; exit 1; fi`,
        '  rm -f "$ts_auth_file"',
      ]
    : [
        '  echo "[freestyle-vm-ssh] Tailscale is offline and no auth file was supplied; pre-authenticate the VM or enable the reviewed provider file transfer" >&2',
        '  exit 1',
      ];
  return [
    "set -euo pipefail",
    "PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH",
    "umask 077",
    "export DEBIAN_FRONTEND=noninteractive",
    ...authCleanupLines,
    "cmux_sha256() {",
    "  if command -v sha256sum >/dev/null 2>&1; then sha256sum \"$1\" | awk '{print tolower($1)}'; return; fi",
    "  if command -v shasum >/dev/null 2>&1; then shasum -a 256 \"$1\" | awk '{print tolower($1)}'; return; fi",
    "  if command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 \"$1\" | sed 's/^.*= //; s/[[:space:]]//g' | tr '[:upper:]' '[:lower:]'; return; fi",
    "  return 127",
    "}",
    "cmux_verify() {",
    "  [ -f \"$1\" ] || return 1",
    "  cmux_actual=$(cmux_sha256 \"$1\") || return 1",
    "  [ \"$cmux_actual\" = \"$2\" ]",
    "}",
    "cmux_secure_binary() {",
    "  [ -f \"$1\" ] || return 1",
    "  [ ! -L \"$1\" ] || return 1",
    "  [ \"$(stat -c '%u:%g:%a' \"$1\")\" = '0:0:755' ]",
    "}",
    "cmux_secure_marker() {",
    "  [ -f \"$1\" ] || return 1",
    "  [ ! -L \"$1\" ] || return 1",
    "  [ \"$(stat -c '%u:%g:%a' \"$1\")\" = '0:0:644' ]",
    "}",
    // Keep the shared provenance marker under a root-owned, non-writable
    // directory. Check the parent before any install can follow it.
    "test ! -L /usr/local || { echo '[freestyle-vm-ssh] refusing a symlink /usr/local' >&2; exit 1; }",
    "test -d /usr/local || { echo '[freestyle-vm-ssh] /usr/local must be a directory' >&2; exit 1; }",
    "test ! -L /usr/local/libexec || { echo '[freestyle-vm-ssh] refusing a symlink libexec directory' >&2; exit 1; }",
    "install -d -o root -g root -m 0755 /usr/local/libexec",
    "test ! -L /usr/local/libexec || { echo '[freestyle-vm-ssh] libexec directory changed to a symlink' >&2; exit 1; }",
    "test \"$(stat -c '%u:%g:%a' /usr/local/libexec)\" = '0:0:755' || { echo '[freestyle-vm-ssh] libexec directory ownership or mode is unsafe' >&2; exit 1; }",
    `ts_version=${shellQuote(version)}`,
    `ts_tailnet_dns_suffix=${shellQuote(tailnetDnsSuffix.toLowerCase())}`,
    'ts_arch="$(uname -m)"',
    'case "$ts_arch" in',
    `  x86_64|amd64) ts_asset="tailscale_${version}_amd64.tgz"; ts_expected=${shellQuote(amd64.sha256)}; ts_bin_expected=${shellQuote(amd64.tailscaleSha256)}; tsd_bin_expected=${shellQuote(amd64.tailscaledSha256)} ;;`,
    `  aarch64|arm64) ts_asset="tailscale_${version}_arm64.tgz"; ts_expected=${shellQuote(arm64.sha256)}; ts_bin_expected=${shellQuote(arm64.tailscaleSha256)}; tsd_bin_expected=${shellQuote(arm64.tailscaledSha256)} ;;`,
    '  *) echo "[freestyle-vm-ssh] unsupported architecture" >&2; exit 1 ;;',
    'esac',
    "if ! cmux_secure_binary /usr/sbin/tailscale || ! cmux_secure_binary /usr/sbin/tailscaled || ! cmux_secure_marker /usr/local/libexec/tailscale.release; then",
    '  echo "[freestyle-vm-ssh] installing pinned tailscale release…"',
    '  ts_dir="$(mktemp -d "/tmp/cmux-ts-install.XXXXXX")"',
    '  ts_install_dir="$ts_dir"',
    '  ts_archive="$ts_dir/$ts_asset"',
    `  ts_url="https://pkgs.tailscale.com/stable/$ts_asset"`,
    '  curl --proto \'=https\' --tlsv1.2 --fail --silent --show-error --location --retry 3 --retry-all-errors "$ts_url" -o "$ts_archive"',
    ...digestLines.map((line) => `  ${line}`),
    '  tar -xzf "$ts_archive" --strip-components=1 -C "$ts_dir"',
    '  cmux_verify "$ts_dir/tailscale" "$ts_bin_expected" || { echo "[freestyle-vm-ssh] tailscale binary digest mismatch" >&2; exit 1; }',
    '  cmux_verify "$ts_dir/tailscaled" "$tsd_bin_expected" || { echo "[freestyle-vm-ssh] tailscaled binary digest mismatch" >&2; exit 1; }',
    '  install -o root -g root -m 0755 "$ts_dir/tailscale" /usr/sbin/tailscale',
    '  install -o root -g root -m 0755 "$ts_dir/tailscaled" /usr/sbin/tailscaled',
    '  test ! -L /lib/systemd/system/tailscaled.service || { echo "[freestyle-vm-ssh] refusing a symlink tailscaled service" >&2; exit 1; }',
    '  install -o root -g root -m 0644 "$ts_dir/systemd/tailscaled.service" /lib/systemd/system/tailscaled.service',
    '  printf "%s\\n%s\\n%s\\n" "$ts_version" "$ts_bin_expected" "$tsd_bin_expected" > "$ts_dir/tailscale.release"',
    '  install -o root -g root -m 0644 "$ts_dir/tailscale.release" /usr/local/libexec/tailscale.release',
    '  rm -rf -- "$ts_dir"',
    '  ts_install_dir=',
    '  systemctl daemon-reload',
    'fi',
    'if ! cmux_secure_marker /usr/local/libexec/tailscale.release || [ "$(sed -n \'1p\' /usr/local/libexec/tailscale.release)" != "$ts_version" ] || [ "$(sed -n \'2p\' /usr/local/libexec/tailscale.release)" != "$ts_bin_expected" ] || [ "$(sed -n \'3p\' /usr/local/libexec/tailscale.release)" != "$tsd_bin_expected" ] || ! cmux_verify /usr/sbin/tailscale "$ts_bin_expected" || ! cmux_secure_binary /usr/sbin/tailscale || ! cmux_verify /usr/sbin/tailscaled "$tsd_bin_expected" || ! cmux_secure_binary /usr/sbin/tailscaled; then',
    '  echo "[freestyle-vm-ssh] installed tailscale failed provenance verification" >&2',
    '  exit 1',
    'fi',
    `WANT_FLAGS=${shellQuote(wantFlags)}`,
    'cmux_defaults_dir=/etc/default',
    'test -d "$cmux_defaults_dir" && test ! -L "$cmux_defaults_dir"',
    // Check the destination before reading or replacing it. In particular,
    // never let grep follow a symlink supplied by a compromised snapshot.
    'if [ -e /etc/default/tailscaled ] && { test ! -f /etc/default/tailscaled || test -L /etc/default/tailscaled || test "$(stat -c \'%u:%g:%a\' /etc/default/tailscaled)" != "0:0:644"; }; then echo "[freestyle-vm-ssh] refusing insecure tailscaled defaults" >&2; exit 1; fi',
    'cmux_defaults_tmp=$(mktemp /etc/default/.tailscaled.XXXXXX)',
    'printf \'FLAGS="%s"\\nPORT="41641"\\n\' "$WANT_FLAGS" > "$cmux_defaults_tmp"',
    'chown root:root "$cmux_defaults_tmp" && chmod 0644 "$cmux_defaults_tmp"',
    'mv -f -- "$cmux_defaults_tmp" /etc/default/tailscaled',
    'rm -f -- "$cmux_defaults_tmp"',
    'systemctl reset-failed tailscaled >/dev/null 2>&1 || true',
    'if pidof tailscaled >/dev/null 2>&1; then systemctl restart tailscaled; else',
    '  systemctl start tailscaled',
    'fi',
    'i=0',
    'while [ "$i" -lt 60 ]; do',
    '  if tailscale --socket=/run/tailscale/tailscaled.sock status >/dev/null 2>&1; then break; fi',
    '  sleep 0.1',
    '  i=$((i + 1))',
    'done',
    `TS_STATUS_JSON=$(tailscale --socket=/run/tailscale/tailscaled.sock status --self=true --peers=false --json 2>/dev/null || echo '{}')`,
    `TS_ONLINE=$(printf '%s' "$TS_STATUS_JSON" | grep -o '"Online": *true' | head -1 || true)`,
    // An already-authenticated VM may carry a snapshot-specific hostname.
    // Keep that session rather than forcing a new auth key just to rename it.
    'if [ -z "$TS_ONLINE" ]; then',
    `  echo "[freestyle-vm-ssh] joining tailnet as ${hostname}…"`,
    ...joinLines,
    'fi',
    // Refresh status after a join. The first status snapshot can be empty
    // while tailscaled is starting, and must not be used for identity checks.
    `TS_STATUS_JSON=$(tailscale --socket=/run/tailscale/tailscaled.sock status --self=true --peers=false --json 2>/dev/null || echo '{}')`,
    'TS_SELF_DNS=$(printf "%s" "$TS_STATUS_JSON" | sed -n \'s/.*"DNSName"[[:space:]]*:[[:space:]]*"\\([^"\\]*\\)".*/\\1/p\' | head -1)',
    'case "$TS_SELF_DNS" in *."$ts_tailnet_dns_suffix"|*."$ts_tailnet_dns_suffix".) ;; *) echo "[freestyle-vm-ssh] Tailscale identity is not on the approved tailnet" >&2; exit 1 ;; esac',
    'test -d /etc/profile.d && test ! -L /etc/profile.d',
    'cmux_profile_tmp=$(mktemp /etc/profile.d/.cmux-tailnet-proxy.XXXXXX)',
    `printf '%s\\n' 'export HTTP_PROXY=http://127.0.0.1:${port}' 'export HTTPS_PROXY=http://127.0.0.1:${port}' 'export http_proxy=http://127.0.0.1:${port}' 'export https_proxy=http://127.0.0.1:${port}' 'export NO_PROXY=localhost,127.0.0.1,::1' 'export no_proxy=localhost,127.0.0.1,::1' > "$cmux_profile_tmp"`,
    'chown root:root "$cmux_profile_tmp" && chmod 0644 "$cmux_profile_tmp"',
    'if [ -e /etc/profile.d/cmux-tailnet-proxy.sh ] && { test ! -f /etc/profile.d/cmux-tailnet-proxy.sh || test -L /etc/profile.d/cmux-tailnet-proxy.sh || test "$(stat -c \'%u:%g:%a\' /etc/profile.d/cmux-tailnet-proxy.sh)" != "0:0:644"; }; then echo "[freestyle-vm-ssh] refusing insecure proxy profile" >&2; exit 1; fi',
    'mv -f -- "$cmux_profile_tmp" /etc/profile.d/cmux-tailnet-proxy.sh',
    'rm -f -- "$cmux_profile_tmp"',
    `printf '[freestyle-vm-ssh] tailscale ip: %s\\n' "$(tailscale --socket=/run/tailscale/tailscaled.sock ip -4 2>/dev/null | head -1)"`,
    `printf '[freestyle-vm-ssh] http proxy: 127.0.0.1:${port} (HTTP_PROXY exported via /etc/profile.d/cmux-tailnet-proxy.sh)\\n'`,
  ].join("\n");
}

function printHelp() {
  process.stderr.write(
    [
      "freestyle-vm-ssh <vmId> [options]",
      "  --user <name>             Linux user (default: cmux)",
      "  --tailscale|--no-tailscale  Default: --tailscale. Installs tailscale",
      "                            inside the VM (idempotent) and joins the",
      "                            user's tailnet using an ephemeral preauth",
      "                            pre-authenticated VM state. With",
      "                            --no-tailscale, skip the join entirely.",
      "  --tailscale-authkey <k>   Rejected. Credentials in argv are never",
      "                            accepted. Use --tailscale-authkey-file",
      "                            with the reviewed provider file transfer.",
      "  --tailscale-authkey-file <path>",
      "                            Read a mode-0600 local key and transfer it",
      "                            only when the provider redaction opt-in is set.",
      "  --tailscale-hostname <n>  Default: fs-<vmid[:8]>",
      "  --subrouter-url <url>     Subrouter base URL written into the VM's",
      `                            codex config. Default when --tailscale is`,
      `                            on: ${DEFAULT_TAILNET_SUBROUTER_URL}`,
      "  --allow-untrusted-subrouter",
      "                            Explicitly allow a non-team HTTPS/HTTP",
      "                            endpoint. Use only for a reviewed gateway.",
      "  --subrouter-account-id <id>",
      "                            Force a specific Subrouter codex account",
      "                            (e.g. apikey:lawrence-codex-1). Written",
      "                            into the codex provider's http_headers as",
      "                            X-Subrouter-Account-ID. Without this,",
      "                            Subrouter auto-selects an account.",
      "  --subrouter-port <port>   Local subrouter port for --reverse-subrouter",
      "                            (default: 31415)",
      "  --reverse-subrouter       Add `-R <port>:127.0.0.1:<port>` for a",
      "                            local subrouter. Note: the Freestyle SSH",
      "                            gateway rejects this; only works for",
      "                            ordinary Linux/macOS sshd hosts.",
      "  --forward <port>          Local-forward port; can be repeated.",
      "                            Defaults to 3000 5173 8000 8080.",
      "  --codex-config <path>     Path to write codex config inside the VM",
      "                            (default: $HOME/.codex/config.toml).",
      "  --no-codex-config         Don't touch codex config inside the VM.",
      "  --codex-prompt-file <path>",
      "                            Consume a one-time mode-0600 prompt file",
      "                            under /run/cmuxd via `codex exec -`.",
      "  --no-ssh-credential       Internal credential-free bootstrap mode;",
      "                            required with --print-bootstrap.",
      "",
      "Env:",
      "  FREESTYLE_API_KEY         required",
      "  SUBROUTER_REMOTE_URL      used as --subrouter-url when not provided",
      "  SUBROUTER_CODEX_ACCOUNT_ID used as --subrouter-account-id when not provided",
      "  SUBROUTER_CODEX_USER_EMAIL added as X-Subrouter-User-Email header",
      "  CMUX_HOME_ALLOW_UNTRUSTED_SUBROUTER=1",
      "                            required for a custom endpoint outside",
      "                            the approved team tailnet host",
      "  TAILSCALE_AUTHKEY         accepted only with provider file transfer opt-in",
      "  CMUX_HOME_ALLOW_PROVIDER_SECRET_FILE_TRANSFER=1",
      "                            required for any key transfer",
      "  CMUX_HOME_PROVIDER_SECRET_REDACTION_ACK=freestyle-file-api-v1",
      "                            confirms the provider's request-body redaction contract",
      "",
    ].join("\n"),
  );
}
