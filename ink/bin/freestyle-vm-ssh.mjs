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
    // Reverse-forward the local subrouter so the VM can reach the local
    // AI gateway at 127.0.0.1:<subrouterPort>.
    "-R", `${args.subrouterPort}:127.0.0.1:${args.subrouterPort}`,
  ];
  for (const port of args.forwardPorts) {
    baseSshArgs.push("-L", `${port}:127.0.0.1:${port}`);
  }

  let remoteCommand = "";
  if (args.codexConfigPath !== null) {
    const remoteConfigPath = args.codexConfigPath ?? "$HOME/.codex/config.toml";
    const remoteConfigDir = "$HOME/.codex";
    const codexConfigBody =
      `# Written by freestyle-vm-ssh so codex routes through the local subrouter\n` +
      `# via the SSH reverse forward on 127.0.0.1:${args.subrouterPort}.\n` +
      `openai_base_url = "http://127.0.0.1:${args.subrouterPort}/v1"\n`;
    const encodedConfig = Buffer.from(codexConfigBody, "utf8").toString("base64");
    remoteCommand =
      `mkdir -p ${shellQuote(remoteConfigDir)} && ` +
      `printf '%s' ${shellQuote(encodedConfig)} | base64 -d > ${shellQuote(remoteConfigPath)} && ` +
      `chmod 600 ${shellQuote(remoteConfigPath)} && ` +
      `printf '\\n[freestyle-vm-ssh] codex configured to use subrouter at 127.0.0.1:${args.subrouterPort}\\n' && ` +
      `printf '[freestyle-vm-ssh] forwarded local ports: ${args.forwardPorts.join(",")}\\n\\n' && ` +
      `exec bash -l`;
  } else {
    remoteCommand = "exec bash -l";
  }

  const finalArgs = ["-e", "ssh", ...baseSshArgs, "-t", remoteHost, remoteCommand];

  process.stderr.write(
    `[freestyle-vm-ssh] ssh -R ${args.subrouterPort}:127.0.0.1:${args.subrouterPort} ` +
      args.forwardPorts.map((p) => `-L ${p}:127.0.0.1:${p}`).join(" ") +
      ` ${remoteHost}\n`,
  );

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
      "  --subrouter-port <port>  Local subrouter port (default: 31415)",
      "  --forward <port>         Forward local port; can be repeated.",
      "                           Defaults to 3000 5173 8000 8080.",
      "  --codex-config <path>    Path to write codex config inside the VM",
      "                           (default: $HOME/.codex/config.toml)",
      "  --no-codex-config        Don't touch codex config inside the VM",
      "",
      "Env:",
      "  FREESTYLE_API_KEY        required",
      "",
    ].join("\n"),
  );
}
