#!/usr/bin/env node
// SSH into a Freestyle VM with reverse-forward to the local subrouter and
// local-forwards for common dev ports.
//
//   FREESTYLE_API_KEY=... freestyle-vm-ssh <vmId> [--user cmux]
//                                          [--subrouter-port 31415]
//                                          [--forward 3000 --forward 5173 ...]
//                                          [--codex-config /absolute/or/relative/path]
//                                          [--no-codex-config]
//
// On exit, the script revokes the freestyle identity it created.

import { spawn } from "node:child_process";
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

  process.stderr.write(`[freestyle-vm-ssh] minting identity for ${args.vmId}…\n`);
  const created = await fs.identities.create({});
  identityId = created.identityId;
  const identity = created.identity;
  await identity.permissions.vms.grant({ vmId: args.vmId, allowedUsers: [args.user] });
  const tok = await identity.tokens.create();
  const token = typeof tok === "string" ? tok : tok.token;
  if (!token) throw new Error("failed to mint freestyle token");

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
  //   1. --subrouter-url <url>  (explicit override; recommended for Tailscale
  //                              or any reachable public/private gateway).
  //   2. SUBROUTER_REMOTE_URL env (same idea, env-driven).
  //   3. --reverse-subrouter    (try the SSH -R path: subrouter on the local
  //                              mac, exposed inside the VM as
  //                              http://127.0.0.1:<port>/v1).
  //   4. Otherwise: skip writing codex config and warn the user.
  const subrouterUrlForVm =
    args.subrouterUrl
      ?? process.env.SUBROUTER_REMOTE_URL?.trim()
      ?? (args.useReverseForward ? `http://127.0.0.1:${args.subrouterPort}/v1` : null);

  let remoteCommand = "";
  if (args.codexConfigPath !== null && subrouterUrlForVm) {
    const remoteConfigPath = args.codexConfigPath ?? "$HOME/.codex/config.toml";
    const remoteConfigDir = "$HOME/.codex";
    const codexConfigBody =
      `# Written by freestyle-vm-ssh so codex routes through Subrouter.\n` +
      `openai_base_url = "${subrouterUrlForVm}"\n`;
    const encodedConfig = Buffer.from(codexConfigBody, "utf8").toString("base64");
    remoteCommand =
      `mkdir -p ${shellQuote(remoteConfigDir)} && ` +
      `printf '%s' ${shellQuote(encodedConfig)} | base64 -d > ${shellQuote(remoteConfigPath)} && ` +
      `chmod 600 ${shellQuote(remoteConfigPath)} && ` +
      `printf '\\n[freestyle-vm-ssh] codex configured to use subrouter at ${subrouterUrlForVm}\\n' && ` +
      `printf '[freestyle-vm-ssh] forwarded local ports: ${args.forwardPorts.join(",")}\\n\\n' && ` +
      `exec bash -l`;
  } else {
    const note = args.codexConfigPath === null
      ? "(codex config write disabled via --no-codex-config)"
      : "(no subrouter URL: pass --subrouter-url <url>, set SUBROUTER_REMOTE_URL, or --reverse-subrouter on hosts that allow it)";
    remoteCommand =
      `printf '\\n[freestyle-vm-ssh] no codex routing configured ${note}.\\n' && ` +
      `printf '[freestyle-vm-ssh] forwarded local ports: ${args.forwardPorts.join(",")}\\n\\n' && ` +
      `exec bash -l`;
  }

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

function printHelp() {
  process.stderr.write(
    [
      "freestyle-vm-ssh <vmId> [options]",
      "  --user <name>            Linux user (default: cmux)",
      "  --subrouter-port <port>  Local subrouter port (default: 31415, used",
      "                           with --reverse-subrouter)",
      "  --subrouter-url <url>    Subrouter base URL to bake into the VM's",
      "                           codex config (e.g. http://100.x.y.z:31415/v1",
      "                           for a tailnet-hosted gateway).",
      "  --reverse-subrouter      Add `-R <port>:127.0.0.1:<port>` to forward",
      "                           a local subrouter into the VM. Note: the",
      "                           Freestyle SSH gateway currently rejects",
      "                           reverse forwards, so this only works for",
      "                           ordinary Linux/macOS sshd hosts.",
      "  --forward <port>         Local-forward port; can be repeated.",
      "                           Defaults to 3000 5173 8000 8080.",
      "  --codex-config <path>    Path to write codex config inside the VM",
      "                           (default: $HOME/.codex/config.toml).",
      "  --no-codex-config        Don't touch codex config inside the VM.",
      "",
      "Env:",
      "  FREESTYLE_API_KEY        required",
      "  SUBROUTER_REMOTE_URL     used as --subrouter-url when not provided",
      "",
    ].join("\n"),
  );
}
