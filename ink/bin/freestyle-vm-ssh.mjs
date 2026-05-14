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
//     [--tailscale-authkey <key>]        # explicit; else mint via `tsadmin api POST /tailnet/-/keys`
//     [--tailscale-hostname <name>]      # default: fs-<vmid-short>
//
// On exit, the script revokes the freestyle identity it created.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Freestyle } from "freestyle";

const DEFAULT_TAILNET_SUBROUTER_URL = "http://subrouter-team.tail41290.ts.net:31415/v1";
const DEFAULT_TAILSCALE_TAGS = ["tag:server"];
const DEFAULT_TAILSCALE_PROXY_PORT = 1055;

if (!process.env.FREESTYLE_API_KEY?.trim()) {
  // Search common dotenv-style files. We deliberately do NOT pull from
  // process.env in upstream callers if the var is unset, so the TUI can spawn
  // `node freestyle-vm-ssh.mjs <vmId>` without baking the key into the
  // workspace initial_command (which would leak into cmux logs / ps).
  const candidateFiles = [
    process.env.FREESTYLE_ENV_FILE,
    join(homedir(), ".secrets", "cmux.env"),
    join(homedir(), ".secrets", "cmuxterm.env"),
    join(homedir(), ".secrets", "cmuxterm-dev.env"),
    join(homedir(), ".freestyle", "env"),
  ].filter(Boolean);
  for (const file of candidateFiles) {
    if (!existsSync(file)) continue;
    try {
      const body = readFileSync(file, "utf8");
      const match = body.match(/^\s*FREESTYLE_API_KEY\s*=\s*(.+?)\s*$/m);
      if (match) {
        const raw = match[1].trim().replace(/^['"]|['"]$/g, "");
        if (raw) {
          process.env.FREESTYLE_API_KEY = raw;
          process.stderr.write(`[freestyle-vm-ssh] using FREESTYLE_API_KEY from ${file}\n`);
          break;
        }
      }
    } catch {}
  }
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
  printHelp();
  process.exit(argv.length === 0 ? 1 : 0);
}

const args = parseArgs(argv);
if (!args.vmId) {
  printHelp();
  process.exit(1);
}
if (!process.env.FREESTYLE_API_KEY?.trim()) {
  process.stderr.write("error: FREESTYLE_API_KEY is required\n");
  process.exit(1);
}

const fs = new Freestyle();

let identityId = "";
let tmpDir = "";

const cleanup = async () => {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    tmpDir = "";
  }
  if (identityId) {
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

  process.stderr.write(`[freestyle-vm-ssh] minting credentials for ${args.vmId}…\n`);

  // Mint the Freestyle SSH credentials and the Tailscale preauth key in
  // parallel. Each independent SDK call is ~200-400ms; doing them serially
  // costs ~1s, in parallel it costs ~the longer of the two.
  const freestyleP = (async () => {
    const created = await fs.identities.create({});
    identityId = created.identityId;
    const identity = created.identity;
    await identity.permissions.vms.grant({ vmId: args.vmId, allowedUsers: [args.user] });
    const tok = await identity.tokens.create();
    const token = typeof tok === "string" ? tok : tok.token;
    if (!token) throw new Error("failed to mint freestyle token");
    return token;
  })();

  let tailscalePreauthKeyP = Promise.resolve(null);
  if (args.tailscale && !args.tailscaleAuthkey && !process.env.TAILSCALE_AUTHKEY?.trim()) {
    tailscalePreauthKeyP = Promise.resolve().then(() =>
      mintTailscaleAuthKey({
        tags: DEFAULT_TAILSCALE_TAGS,
        description: `freestyle-vm ${args.vmId}`,
      }),
    );
  }
  const [token, mintedTailscaleKey] = await Promise.all([freestyleP, tailscalePreauthKeyP]);

  tmpDir = mkdtempSync(join(tmpdir(), "freestyle-vm-ssh-"));
  const passFile = join(tmpDir, "pass");
  writeFileSync(passFile, token, { mode: 0o600 });
  chmodSync(passFile, 0o600);

  const sshArgs = [
    "-p", String(args.passwordFile ? passFile : ""), // placeholder, replaced below
  ];

  const remoteHost = `${args.vmId}+${args.user}@vm-ssh.freestyle.sh`;
  const baseSshArgs = [
    "-p", "22",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "UserKnownHostsFile=/tmp/freestyle-known-hosts",
    "-o", "LogLevel=ERROR",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=4",
  ];
  if (args.useReverseForward) {
    // Reverse-forward the local subrouter so the VM can reach the local
    // AI gateway at 127.0.0.1:<subrouterPort>. The Freestyle SSH gateway
    // currently rejects this (`remote port forwarding failed`); pass
    // --reverse-subrouter to opt in on hosts that allow it (e.g. an
    // ordinary cmux Linux/macOS box behind a normal sshd).
    baseSshArgs.push("-R", `${args.subrouterPort}:127.0.0.1:${args.subrouterPort}`);
  }
  for (const port of args.forwardPorts) {
    baseSshArgs.push("-L", `${port}:127.0.0.1:${port}`);
  }

  // Decide which subrouter URL to bake into the codex config inside the VM.
  // Priority:
  //   1. --subrouter-url <url>  (explicit override).
  //   2. SUBROUTER_REMOTE_URL env.
  //   3. --reverse-subrouter    (try the SSH -R path; only works for non-
  //                              Freestyle sshd).
  //   4. --tailscale enabled    (default): use the well-known tailnet subrouter.
  const subrouterUrlForVm =
    args.subrouterUrl
      ?? process.env.SUBROUTER_REMOTE_URL?.trim()
      ?? (args.useReverseForward ? `http://127.0.0.1:${args.subrouterPort}/v1` : null)
      ?? (args.tailscale ? DEFAULT_TAILNET_SUBROUTER_URL : null);

  // Resolve the tailscale auth key, preferring (in order) the explicit flag,
  // env, then the key we minted in parallel above.
  let tailscaleAuthKey = null;
  if (args.tailscale) {
    tailscaleAuthKey =
      args.tailscaleAuthkey
      ?? process.env.TAILSCALE_AUTHKEY?.trim()
      ?? mintedTailscaleKey;
    if (!tailscaleAuthKey) {
      process.stderr.write(
        "[freestyle-vm-ssh] could not mint a tailscale auth key; pass --no-tailscale to skip the join, --tailscale-authkey <key>, or set TAILSCALE_AUTHKEY in env\n",
      );
      args.tailscale = false;
    }
  }

  const remoteSteps = [];
  if (args.tailscale && tailscaleAuthKey) {
    const tsHostname = args.tailscaleHostname ?? `fs-${args.vmId.slice(0, 8)}`;
    const tsScript = buildTailscaleBootstrap({
      authKey: tailscaleAuthKey,
      hostname: tsHostname,
      proxyPort: DEFAULT_TAILSCALE_PROXY_PORT,
    });
    const encoded = Buffer.from(tsScript, "utf8").toString("base64");
    remoteSteps.push(
      `printf '%s' ${shellQuote(encoded)} | base64 -d | sudo bash -e`,
    );
  }
  if (args.codexConfigPath !== null && subrouterUrlForVm) {
    const remoteConfigPath = args.codexConfigPath ?? "$HOME/.codex/config.toml";
    // Derive the dir from the path. Paths containing `$HOME` or other shell
    // variables stay UNQUOTED so the remote shell expands them; literal
    // absolute paths get single-quoted.
    const needsExpand = /\$/.test(remoteConfigPath);
    const remoteConfigDir = remoteConfigPath.replace(/\/[^/]+$/, "");
    const pathRendered = needsExpand
      ? `"${remoteConfigPath}"`
      : shellQuote(remoteConfigPath);
    const dirRendered = needsExpand
      ? `"${remoteConfigDir}"`
      : shellQuote(remoteConfigDir);
    const codexConfigBody =
      `# Written by freestyle-vm-ssh so codex routes through Subrouter.\n` +
      `openai_base_url = "${subrouterUrlForVm}"\n`;
    const encodedConfig = Buffer.from(codexConfigBody, "utf8").toString("base64");
    remoteSteps.push(
      `mkdir -p ${dirRendered}`,
      `printf '%s' ${shellQuote(encodedConfig)} | base64 -d > ${pathRendered}`,
      `chmod 600 ${pathRendered}`,
      `printf '\\n[freestyle-vm-ssh] codex configured to use subrouter at ${subrouterUrlForVm}\\n'`,
    );
  } else {
    const note = args.codexConfigPath === null
      ? "codex config write disabled via --no-codex-config"
      : "no subrouter URL configured";
    remoteSteps.push(`printf '\\n[freestyle-vm-ssh] %s\\n' ${shellQuote(note)}`);
  }
  remoteSteps.push(
    `printf '[freestyle-vm-ssh] forwarded local ports: ${args.forwardPorts.join(",")}\\n\\n'`,
    `exec bash -l`,
  );
  const remoteCommand = remoteSteps.join(" && ");

  const finalArgs = ["-e", "ssh", ...baseSshArgs, "-t", remoteHost, remoteCommand];

  const reverseLog = args.useReverseForward
    ? `-R ${args.subrouterPort}:127.0.0.1:${args.subrouterPort} `
    : "";
  const forwardLog = args.forwardPorts.map((p) => `-L ${p}:127.0.0.1:${p}`).join(" ");
  process.stderr.write(`[freestyle-vm-ssh] ssh ${reverseLog}${forwardLog} ${remoteHost}\n`);

  const child = spawn("sshpass", finalArgs, {
    stdio: "inherit",
    env: { ...process.env, SSHPASS: token },
  });
  child.on("exit", async (code, signal) => {
    await cleanup();
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  child.on("error", async (err) => {
    process.stderr.write(`sshpass exec failed: ${err.message}\n`);
    if (err.message.includes("ENOENT")) {
      process.stderr.write(
        "Install sshpass first: brew install hudochenkov/sshpass/sshpass\n",
      );
    }
    await cleanup();
    process.exit(127);
  });
} catch (err) {
  process.stderr.write(`[freestyle-vm-ssh] error: ${(err && err.message) || err}\n`);
  await cleanup();
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    vmId: null,
    user: "cmux",
    subrouterPort: 31415,
    forwardPorts: [],
    codexConfigPath: undefined,
    useReverseForward: false,
    subrouterUrl: null,
    passwordFile: true,
    tailscale: true,
    tailscaleAuthkey: null,
    tailscaleHostname: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--") && !out.vmId) {
      out.vmId = a;
      continue;
    }
    switch (a) {
      case "--user":
        out.user = argv[++i] ?? out.user;
        break;
      case "--subrouter-port":
        out.subrouterPort = Number.parseInt(argv[++i] ?? "31415", 10) || 31415;
        break;
      case "--subrouter-url":
        out.subrouterUrl = argv[++i] ?? null;
        break;
      case "--reverse-subrouter":
        out.useReverseForward = true;
        break;
      case "--forward":
      case "-L": {
        const v = argv[++i];
        if (v) {
          const n = Number.parseInt(v, 10);
          if (Number.isInteger(n) && n > 0 && n < 65536) out.forwardPorts.push(n);
        }
        break;
      }
      case "--codex-config":
        out.codexConfigPath = argv[++i] ?? null;
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
        out.tailscaleAuthkey = argv[++i] ?? null;
        break;
      case "--tailscale-hostname":
        out.tailscaleHostname = argv[++i] ?? null;
        break;
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

function mintTailscaleAuthKey({ tags, description }) {
  // Shell out to `tsadmin api POST /tailnet/-/keys ...`. Requires tsadmin to
  // be on PATH and the user to have logged in to it. Returns the key value
  // or null on any failure.
  const body = JSON.stringify({
    capabilities: {
      devices: {
        create: {
          reusable: false,
          ephemeral: true,
          preauthorized: true,
          tags,
        },
      },
    },
    expirySeconds: 3600,
    description,
  });
  const result = spawnSync(
    "tsadmin",
    ["api", "POST", "/tailnet/-/keys", body],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    process.stderr.write(
      `[freestyle-vm-ssh] tsadmin mint failed${result.error ? `: ${result.error.message}` : `: exit ${result.status}`}\n` +
        (result.stderr ? `${result.stderr.trim()}\n` : ""),
    );
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const key = typeof parsed.key === "string" ? parsed.key : null;
    if (!key) {
      process.stderr.write(
        `[freestyle-vm-ssh] tsadmin response missing key field: ${result.stdout.slice(0, 200)}\n`,
      );
    }
    return key;
  } catch (err) {
    process.stderr.write(
      `[freestyle-vm-ssh] could not parse tsadmin response: ${err.message}\n${result.stdout.slice(0, 200)}\n`,
    );
    return null;
  }
}

function buildTailscaleBootstrap({ authKey, hostname, proxyPort }) {
  // Idempotent installer + join inside the freestyle VM. The cmux-freestyle
  // snapshot ships the apt-managed tailscale package today. Freestyle VMs
  // have no /dev/net/tun, so tailscaled runs with --tun=userspace-networking
  // and exposes an HTTP proxy + SOCKS5 server on 127.0.0.1:<proxyPort>. We
  // write /etc/profile.d so HTTP_PROXY/HTTPS_PROXY/NO_PROXY are set for every
  // login shell.
  //
  // Warm-path fast: if tailscaled is already running with the expected FLAGS
  // and the node is already Online with the same hostname, the only work
  // we do is re-write the profile.d shim and the codex config (in the outer
  // chain). This brings sub-second re-attach.
  const port = String(proxyPort);
  const wantFlags = `--tun=userspace-networking --outbound-http-proxy-listen=127.0.0.1:${port} --socks5-server=127.0.0.1:${port}`;
  return [
    "set -e",
    'export DEBIAN_FRONTEND=noninteractive',
    'if ! command -v tailscale >/dev/null 2>&1; then',
    '  echo "[freestyle-vm-ssh] installing tailscale (static tarball)…"',
    "  mkdir -p /tmp/cmux-ts-install && cd /tmp/cmux-ts-install",
    '  arch="$(uname -m)"',
    '  case "$arch" in',
    '    x86_64|amd64) tsarch="amd64" ;;',
    '    aarch64|arm64) tsarch="arm64" ;;',
    '    *) echo "[freestyle-vm-ssh] unsupported arch $arch" >&2; exit 1 ;;',
    '  esac',
    '  url="https://pkgs.tailscale.com/stable/tailscale_latest_${tsarch}.tgz"',
    "  curl -fsSL --retry 5 -o ts.tgz \"$url\"",
    "  tar -xzf ts.tgz --strip-components=1",
    "  install -m 0755 tailscale /usr/sbin/tailscale",
    "  install -m 0755 tailscaled /usr/sbin/tailscaled",
    "  cp systemd/tailscaled.service /lib/systemd/system/tailscaled.service",
    "  install -m 0644 systemd/tailscaled.defaults /etc/default/tailscaled",
    "  cd / && rm -rf /tmp/cmux-ts-install",
    "  systemctl daemon-reload",
    "fi",
    // Conditionally update FLAGS in /etc/default/tailscaled. Only restart
    // tailscaled when the file actually changes; otherwise we're paying ~1s
    // for nothing on warm sessions.
    "touch /etc/default/tailscaled",
    `WANT_FLAGS='${wantFlags}'`,
    `CUR_FLAGS=\"$(grep '^FLAGS=' /etc/default/tailscaled | head -1 | sed 's|^FLAGS=||' | tr -d '\"')\"`,
    `if [ \"$CUR_FLAGS\" != \"$WANT_FLAGS\" ]; then`,
    `  if grep -q '^FLAGS=' /etc/default/tailscaled; then`,
    `    sed -i 's|^FLAGS=.*|FLAGS=\"'\"$WANT_FLAGS\"'\"|' /etc/default/tailscaled`,
    "  else",
    `    echo 'FLAGS=\"'\"$WANT_FLAGS\"'\"' >> /etc/default/tailscaled`,
    "  fi",
    "  systemctl reset-failed tailscaled >/dev/null 2>&1 || true",
    "  systemctl restart tailscaled",
    "elif ! pidof tailscaled >/dev/null 2>&1; then",
    "  systemctl reset-failed tailscaled >/dev/null 2>&1 || true",
    "  systemctl start tailscaled",
    "fi",
    // Tighter backend-ready loop: 60 × 100ms ≤ 6s. Most of the time the
    // backend is up in 1-2 iterations on warm path.
    "for i in $(seq 1 60); do",
    "  if tailscale --socket=/run/tailscale/tailscaled.sock status >/dev/null 2>&1; then break; fi",
    "  sleep 0.1",
    "done",
    // Decide whether we need `tailscale up`. Skip it entirely if we're
    // already Online AND the configured hostname matches. Otherwise bring
    // up without --reset so we don't blow away existing state.
    `TS_STATUS_JSON=$(tailscale --socket=/run/tailscale/tailscaled.sock status --self=true --peers=false --json 2>/dev/null || echo '{}')`,
    `TS_ONLINE=$(printf '%s' "$TS_STATUS_JSON" | grep -o '\"Online\": *true' | head -1 || true)`,
    `TS_HOST=$(printf '%s' "$TS_STATUS_JSON" | grep -o '\"HostName\": *\"[^\"]*\"' | head -1 | sed -E 's/.*\"HostName\": *\"([^\"]*)\".*/\\1/' || true)`,
    `if [ -z \"$TS_ONLINE\" ] || [ \"$TS_HOST\" != \"${hostname}\" ]; then`,
    `  echo \"[freestyle-vm-ssh] joining tailnet as ${hostname}…\"`,
    `  tailscale --socket=/run/tailscale/tailscaled.sock up --authkey=${shellQuote(authKey)} --hostname=${shellQuote(hostname)} --ssh=false >/dev/null`,
    "fi",
    // Write the proxy shim every time (cheap, idempotent).
    `cat > /etc/profile.d/cmux-tailnet-proxy.sh <<'PROF'`,
    `export HTTP_PROXY=http://127.0.0.1:${port}`,
    `export HTTPS_PROXY=http://127.0.0.1:${port}`,
    `export http_proxy=http://127.0.0.1:${port}`,
    `export https_proxy=http://127.0.0.1:${port}`,
    `export NO_PROXY=localhost,127.0.0.1,::1`,
    `export no_proxy=localhost,127.0.0.1,::1`,
    `PROF`,
    "chmod 0644 /etc/profile.d/cmux-tailnet-proxy.sh",
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
      "                            key minted via `tsadmin api POST",
      "                            /tailnet/-/keys`. With --no-tailscale,",
      "                            skip the join entirely.",
      "  --tailscale-authkey <k>   Explicit auth key; falls back to",
      "                            $TAILSCALE_AUTHKEY then to a fresh tsadmin",
      "                            mint with tags=tag:server.",
      "  --tailscale-hostname <n>  Default: fs-<vmid[:8]>",
      "  --subrouter-url <url>     Subrouter base URL written into the VM's",
      `                            codex config. Default when --tailscale is`,
      `                            on: ${DEFAULT_TAILNET_SUBROUTER_URL}`,
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
      "",
      "Env:",
      "  FREESTYLE_API_KEY         required",
      "  SUBROUTER_REMOTE_URL      used as --subrouter-url when not provided",
      "  TAILSCALE_AUTHKEY         used as --tailscale-authkey when not provided",
      "",
    ].join("\n"),
  );
}
