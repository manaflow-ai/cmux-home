import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildCmuxdInstallScript,
  buildCmuxdWsLauncherScript,
  buildLeaseWriteScript,
  createCodexPromptPath,
  digestMatches,
  openCmuxWsWorkspace,
  prepareFreestyleWsAttach,
  removeCodexPromptFile,
  transferCodexPromptFile,
} from "../src/cmux-ws.ts";
import {
  freestyleHostKeyOptions,
  hasEmbeddedCredential,
} from "../src/cmux-ssh.ts";
import {
  redactSecrets,
  sanitizedEnvironment,
  sha256CheckShell,
} from "../bin/remote-security.mjs";
import {
  buildTailscaleBootstrap,
  buildCmuxCloneBootstrap,
  buildSshpassArgs,
  localSecretFromFile,
  providerSecretTransferEnabled,
  transferProviderSecret,
} from "../bin/freestyle-vm-ssh.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helper = resolve(root, "bin", "freestyle-vm-ssh.mjs");

test("digest verification rejects malformed and mismatched artifacts", () => {
  const digest = "a".repeat(64);
  assert.equal(digestMatches(digest, digest.toUpperCase()), true);
  assert.equal(digestMatches(digest, "b".repeat(64)), false);
  assert.equal(digestMatches(`${digest}0`, digest), false);
  assert.equal(digestMatches("not-a-digest", digest), false);
});

test("cmuxd installer pins both architecture digests and least privilege", () => {
  const script = buildCmuxdInstallScript();
  assert.match(script, /cmuxd-remote-linux-amd64/);
  assert.match(script, /cmuxd-remote-linux-arm64/);
  assert.match(script, /6e3b1714f02dc8e417452ac85c702e4f1fdf3ee753d38d9c7ddea430115eeddd/);
  assert.match(script, /01cb21153f1dac5bec7608df603a98cd28cbb804278b76b23be22fa3f10950bf/);
  assert.match(script, /User=cmux/);
  assert.match(script, /Group=cmux/);
  assert.match(script, /cmux service account must have non-root numeric uid\/gid/);
  assert.match(script, /cmux account has supplementary groups/);
  assert.match(script, /SupplementaryGroups=/);
  assert.match(script, /ReadWritePaths=.*%h/);
  assert.match(script, /NoNewPrivileges=true/);
  assert.match(script, /ReadOnlyPaths=\/run\/cmuxd/);
  assert.doesNotMatch(script, /EnvironmentFile=.*cmuxd-ws/);
  assert.doesNotMatch(script, /User=root/);
  assert.doesNotMatch(script, /0\.0\.0\.0/);
  assert.match(script, /cmux_private_ipv4/);
  execFileSync("bash", ["-n", "-c", script]);
});

test("cmux clone bootstrap checks out only the reviewed commit", () => {
  const script = buildCmuxCloneBootstrap();
  assert.match(script, /0247f51a1f30308df595606d0951c802ec038550/);
  assert.match(script, /cmux_git -C .*fetch --quiet --no-tags --depth 1 origin/);
  assert.match(script, /protocol\.https\.allow=always/);
  assert.match(script, /cat-file -e/);
  assert.match(script, /checkout --quiet --detach/);
  assert.match(script, /--frozen-lockfile --ignore-scripts/);
  assert.doesNotMatch(script, /git -C .*pull .*origin main/);
  execFileSync("bash", ["-n", "-c", script]);
});

test("cmuxd launcher rejects public listeners and accepts a private interface", () => {
  const launcher = buildCmuxdWsLauncherScript();
  execFileSync("bash", ["-n", "-c", launcher]);
  const dir = mkdtempSync(join(tmpdir(), "cmux-home-launcher-"));
  try {
    const stub = join(dir, "cmuxd-remote");
    writeFileSync(stub, "#!/bin/sh\nprintf '%s\\n' \"$*\"\n", { mode: 0o700 });
    chmodSync(stub, 0o700);
    const runnable = launcher.replace("'/usr/local/libexec/cmuxd-remote'", shellQuoteForTest(stub));
    const privateRun = spawnSync("bash", ["-c", runnable], {
      encoding: "utf8",
      env: { ...process.env, CMUXD_WS_LISTEN_ADDR: "10.23.4.8" },
    });
    assert.equal(privateRun.status, 0, privateRun.stderr);
    assert.match(privateRun.stdout, /--listen 10\.23\.4\.8:7777/);

    const publicRun = spawnSync("bash", ["-c", runnable], {
      encoding: "utf8",
      env: { ...process.env, CMUXD_WS_LISTEN_ADDR: "8.8.8.8" },
    });
    assert.notEqual(publicRun.status, 0);
    assert.match(publicRun.stderr, /private IPv4 listen address is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lease writer is valid shell and does not put raw lease tokens in commands", () => {
  const ptyPath = `/run/cmux-home/lease-pty-${"a".repeat(32)}.json`;
  const rpcPath = `/run/cmux-home/lease-rpc-${"b".repeat(32)}.json`;
  const script = buildLeaseWriteScript(ptyPath, rpcPath);
  execFileSync("bash", ["-n", "-c", script]);
  assert.match(script, /chmod 0600/);
  assert.match(script, /mv -f/);
  assert.match(script, /stat -c/);
  assert.match(script, new RegExp(ptyPath.replaceAll("/", "\\/")));
  assert.match(script, new RegExp(rpcPath.replaceAll("/", "\\/")));
  assert.doesNotMatch(script, /base64 -d/);
  assert.throws(
    () => buildLeaseWriteScript("eyJ0b2tlbiI6Imhhc2gifQ==", rpcPath),
    /staging paths/,
  );
});

test("WebSocket workspace bootstrap keeps lease tokens out of initial commands", async () => {
  const ptyToken = "cmux-freestyle-pty-secret";
  const rpcToken = "cmux-freestyle-rpc-secret";
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    return method === "workspace.create" ? { workspace_id: "workspace-1" } : {};
  };
  const result = await openCmuxWsWorkspace({
    vmId: "vm-test",
    attach: {
      domain: "vm-test.vm.freestyle.sh",
      pty: {
        token: ptyToken,
        sessionId: "pty-session",
        expiresAtUnix: 2_000_000_000,
        leaseFile: {
          version: 1,
          token_sha256: "a".repeat(64),
          expires_at_unix: 2_000_000_000,
          session_id: "pty-session",
          single_use: true,
        },
      },
      rpc: {
        token: rpcToken,
        sessionId: "rpc-session",
        expiresAtUnix: 2_000_000_000,
        leaseFile: {
          version: 1,
          token_sha256: "b".repeat(64),
          expires_at_unix: 2_000_000_000,
          session_id: "rpc-session",
          single_use: false,
        },
      },
    },
    workspaceName: "security test",
    rpc,
    noFocus: true,
  });
  assert.equal(result.workspaceRef, "workspace-1");
  const create = calls.find(({ method }) => method === "workspace.create");
  const configure = calls.find(({ method }) => method === "workspace.remote.configure");
  assert.ok(create);
  assert.ok(configure);
  assert.doesNotMatch(String(create.params.initial_command), new RegExp(`${ptyToken}|${rpcToken}`));
  assert.equal(configure.params.daemon_websocket_token, rpcToken);

  // The bridge removes this directory after it reads the config. The fake
  // RPC above never starts that bridge, so clean the test fixture explicitly.
  const configMatch = String(create.params.initial_command).match(/--config '([^']+)'/);
  if (configMatch) rmSync(resolve(configMatch[1], ".."), { recursive: true, force: true });
});

test("WebSocket lease transfer uses file API and never serializes lease payloads in commands", async () => {
  const previous = {
    CMUX_HOME_ALLOW_PROVIDER_SECRET_FILE_TRANSFER:
      process.env.CMUX_HOME_ALLOW_PROVIDER_SECRET_FILE_TRANSFER,
    CMUX_HOME_PROVIDER_SECRET_REDACTION_ACK:
      process.env.CMUX_HOME_PROVIDER_SECRET_REDACTION_ACK,
  };
  const calls = [];
  const writes = [];
  const vm = {
    exec: async ({ command }) => {
      calls.push(command);
      return { statusCode: 0, stdout: "", stderr: "" };
    },
    fs: {
      writeTextFile: async (path, content) => writes.push({ path, content }),
      remove: async (path) => calls.push(`remove ${path}`),
    },
  };
  const fakeFreestyle = { vms: { ref: () => ({ user: () => vm }) } };
  try {
    process.env.CMUX_HOME_ALLOW_PROVIDER_SECRET_FILE_TRANSFER = "1";
    process.env.CMUX_HOME_PROVIDER_SECRET_REDACTION_ACK = "freestyle-file-api-v1";
    const attach = await prepareFreestyleWsAttach(fakeFreestyle, "vm-test");
    assert.equal(writes.length, 2);
    assert.equal(calls.length, 3);
    assert.match(calls[2], /^bash -e -c /);
    assert.match(calls[2], /stat -c/);
    assert.match(calls[1], /test ! -L/);
    assert.match(calls[1], /0:0:700/);
    assert.doesNotMatch(calls[2], /cmux-freestyle-(?:pty|rpc)-/);
    assert.ok(writes.every(({ path }) => /^\/run\/cmux-home\/lease-(?:pty|rpc)-[a-f0-9]{32}\.json$/.test(path)));
    assert.ok(writes.every(({ content }) => !content.includes(attach.pty.token) && !content.includes(attach.rpc.token)));
    assert.ok(writes.every(({ content }) => /token_sha256/.test(content)));
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("Codex prompt transfer is opt-in, path-bound, and non-disclosing", async () => {
  const previous = {
    CMUX_HOME_ALLOW_PROVIDER_SECRET_FILE_TRANSFER:
      process.env.CMUX_HOME_ALLOW_PROVIDER_SECRET_FILE_TRANSFER,
    CMUX_HOME_PROVIDER_SECRET_REDACTION_ACK:
      process.env.CMUX_HOME_PROVIDER_SECRET_REDACTION_ACK,
  };
  const prompt = "deploy this change; do not print this prompt in diagnostics";
  const path = createCodexPromptPath();
  assert.match(path, /^\/run\/cmuxd\/codex-prompt-[a-f0-9]{32}\.txt$/);
  const calls = [];
  const writes = [];
  const removed = [];
  let selectedUser = null;
  const vm = {
    exec: async ({ command }) => {
      calls.push(command);
      return { statusCode: 0, stdout: "", stderr: "" };
    },
    fs: {
      writeTextFile: async (filePath, content) => writes.push({ filePath, content }),
      remove: async (filePath) => removed.push(filePath),
    },
  };
  const freestyle = {
    vms: {
      ref: ({ vmId }) => {
        assert.equal(vmId, "vm-test");
        return {
          user: ({ username }) => {
            selectedUser = username;
            return vm;
          },
        };
      },
    },
  };
  try {
    delete process.env.CMUX_HOME_ALLOW_PROVIDER_SECRET_FILE_TRANSFER;
    delete process.env.CMUX_HOME_PROVIDER_SECRET_REDACTION_ACK;
    await assert.rejects(
      () => transferCodexPromptFile(freestyle, "vm-test", path, prompt),
      /confirm provider request-body redaction/,
    );
    assert.equal(calls.length, 0);

    process.env.CMUX_HOME_ALLOW_PROVIDER_SECRET_FILE_TRANSFER = "1";
    process.env.CMUX_HOME_PROVIDER_SECRET_REDACTION_ACK = "freestyle-file-api-v1";
    await transferCodexPromptFile(freestyle, "vm-test", path, prompt);
    assert.equal(selectedUser, "root");
    assert.deepEqual(writes, [{ filePath: path, content: prompt }]);
    assert.equal(calls.every((command) => !command.includes(prompt)), true);
    assert.match(calls[0], /test ! -e/);
    assert.match(calls[0], /0:.*:710/);
    assert.match(calls[1], /chown cmux:cmux/);
    assert.equal(removed.length, 0);

    await removeCodexPromptFile(freestyle, "vm-test", path);
    assert.deepEqual(removed, [path]);
    await assert.rejects(
      () => transferCodexPromptFile(freestyle, "vm-test", "/run/cmuxd/codex-prompt-bad.txt", prompt),
      /one-time file under \/run\/cmuxd/,
    );
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("Codex prompt transfer redacts provider errors and removes partial files", async () => {
  const previous = {
    CMUX_HOME_ALLOW_PROVIDER_SECRET_FILE_TRANSFER:
      process.env.CMUX_HOME_ALLOW_PROVIDER_SECRET_FILE_TRANSFER,
    CMUX_HOME_PROVIDER_SECRET_REDACTION_ACK:
      process.env.CMUX_HOME_PROVIDER_SECRET_REDACTION_ACK,
  };
  const prompt = "private prompt value that must not escape";
  const path = createCodexPromptPath();
  const removed = [];
  const vm = {
    exec: async () => ({ statusCode: 0, stdout: "", stderr: "" }),
    fs: {
      writeTextFile: async () => {
        throw new Error(`provider body rejected: ${prompt}`);
      },
      remove: async (filePath) => removed.push(filePath),
    },
  };
  const freestyle = { vms: { ref: () => ({ user: () => vm }) } };
  try {
    process.env.CMUX_HOME_ALLOW_PROVIDER_SECRET_FILE_TRANSFER = "1";
    process.env.CMUX_HOME_PROVIDER_SECRET_REDACTION_ACK = "freestyle-file-api-v1";
    await assert.rejects(
      () => transferCodexPromptFile(freestyle, "vm-test", path, prompt),
      (error) => {
        assert.match(error.message, /Codex prompt transfer failed/);
        assert.doesNotMatch(error.message, new RegExp(prompt));
        return true;
      },
    );
    assert.deepEqual(removed, [path]);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("WebSocket attach cleans lease files when authenticated RPC setup fails", async () => {
  const ptyToken = "cmux-freestyle-pty-secret-for-cleanup";
  const rpcToken = "cmux-freestyle-rpc-secret-for-cleanup";
  let cleanupCount = 0;
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "workspace.create") return { workspace_id: "workspace-fails" };
    throw new Error(`RPC failed while handling ${rpcToken}`);
  };
  await assert.rejects(
    () => openCmuxWsWorkspace({
      vmId: "vm-test",
      attach: {
        domain: "vm-test.vm.freestyle.sh",
        pty: {
          token: ptyToken,
          sessionId: "pty-session",
          expiresAtUnix: 2_000_000_000,
          leaseFile: {
            version: 1,
            token_sha256: "a".repeat(64),
            expires_at_unix: 2_000_000_000,
            session_id: "pty-session",
            single_use: true,
          },
        },
        rpc: {
          token: rpcToken,
          sessionId: "rpc-session",
          expiresAtUnix: 2_000_000_000,
          leaseFile: {
            version: 1,
            token_sha256: "b".repeat(64),
            expires_at_unix: 2_000_000_000,
            session_id: "rpc-session",
            single_use: false,
          },
        },
      },
      workspaceName: "cleanup test",
      rpc,
      noFocus: true,
      cleanupLeases: async () => {
        cleanupCount += 1;
      },
    }),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(rpcToken));
      assert.doesNotMatch(error.message, new RegExp(ptyToken));
      return true;
    },
  );
  assert.equal(cleanupCount, 1);
  const create = calls.find(({ method }) => method === "workspace.create");
  assert.ok(create);
  assert.doesNotMatch(String(create.params.initial_command), new RegExp(`${ptyToken}|${rpcToken}`));
  const configMatch = String(create.params.initial_command).match(/--config '([^']+)'/);
  if (configMatch) assert.equal(existsSync(configMatch[1]), false);
});

test("credential-free bootstrap consumes prompt by file path only", () => {
  const promptPath = "/run/cmuxd/codex-prompt-0123456789abcdef0123456789abcdef.txt";
  const result = spawnSync(process.execPath, [
    helper,
    "vm-test",
    "--print-bootstrap",
    "--no-ssh-credential",
    "--no-tailscale",
    "--no-codex-config",
    "--codex-prompt-file",
    promptPath,
  ], { encoding: "utf8", env: sanitizedEnvironment() });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
  assert.match(
    payload.remoteCommand,
    /^prompt_file='[^']+'; cleanup_prompt\(\) \{ rm -f -- "\$prompt_file"; \}; trap cleanup_prompt EXIT && /,
  );
  assert.match(payload.remoteCommand, /codex exec -/);
  assert.match(payload.remoteCommand, new RegExp(promptPath.replaceAll("/", "\\/")));
  assert.match(payload.remoteCommand, /codex exec -[^;]*; cleanup_prompt; trap - EXIT; exec bash -l/);
  assert.doesNotMatch(payload.remoteCommand, /--codex-prompt(?:=|\s)/);
  execFileSync("bash", ["-n", "-c", payload.remoteCommand]);
});

test("credential-free bootstrap removes the prompt after Codex consumes it", () => {
  const home = mkdtempSync(join(tmpdir(), "cmux-home-prompt-run-"));
  const bin = join(home, "bin");
  const prompt = join(home, "prompt.txt");
  const marker = join(home, "codex-ran");
  const promptPath = "/run/cmuxd/codex-prompt-0123456789abcdef0123456789abcdef.txt";
  const uid = process.getuid?.() ?? 501;
  const gid = process.getgid?.() ?? 20;
  try {
    mkdirSync(bin);
    mkdirSync(join(home, "cmux"));
    writeFileSync(prompt, "one-time prompt", { mode: 0o600 });
    writeFileSync(join(home, ".bash_profile"), `export PATH=${shellQuoteForTest(bin)}:/usr/bin:/bin\n`);
    writeFileSync(
      join(bin, "id"),
      `#!/bin/sh\ncase "$1:$2" in -u:|-u:cmux) echo ${uid} ;; -g:|-g:cmux) echo ${gid} ;; *) exec /usr/bin/id "$@" ;; esac\n`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(bin, "stat"),
      `#!/bin/sh\nif [ "$1" = "-c" ] && [ "$2" = "%a:%u:%g" ]; then printf '600:${uid}:${gid}\\n'; else exec /usr/bin/stat "$@"; fi\n`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(bin, "codex"),
      `#!/bin/sh\n[ "$1" = exec ] && [ "$2" = - ] || exit 2\nwc -c >/dev/null\n: > ${shellQuoteForTest(marker)}\n`,
      { mode: 0o700 },
    );
    const helperRun = spawnSync(process.execPath, [
      helper,
      "vm-test",
      "--print-bootstrap",
      "--no-ssh-credential",
      "--no-tailscale",
      "--no-codex-config",
      "--codex-prompt-file",
      promptPath,
    ], { encoding: "utf8", env: sanitizedEnvironment() });
    assert.equal(helperRun.status, 0, helperRun.stderr);
    const payload = JSON.parse(helperRun.stdout.trim().split(/\r?\n/).pop());
    const remoteCommand = payload.remoteCommand.replaceAll(promptPath, prompt);
    const run = spawnSync("bash", ["--noprofile", "--norc", "-c", remoteCommand], {
      encoding: "utf8",
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TERM: "xterm" },
      input: "",
      timeout: 5_000,
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(prompt), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("credential-free bootstrap removes the prompt when an earlier step fails", () => {
  const home = mkdtempSync(join(tmpdir(), "cmux-home-prompt-failure-"));
  const prompt = join(home, "prompt.txt");
  const promptPath = "/run/cmuxd/codex-prompt-0123456789abcdef0123456789abcdef.txt";
  try {
    writeFileSync(prompt, "private prompt that must be removed", { mode: 0o600 });
    const helperRun = spawnSync(process.execPath, [
      helper,
      "vm-test",
      "--print-bootstrap",
      "--no-ssh-credential",
      "--no-tailscale",
      "--no-codex-config",
      "--codex-prompt-file",
      promptPath,
    ], { encoding: "utf8", env: sanitizedEnvironment() });
    assert.equal(helperRun.status, 0, helperRun.stderr);
    const payload = JSON.parse(helperRun.stdout.trim().split(/\r?\n/).pop());
    const remoteCommand = payload.remoteCommand.replaceAll(promptPath, prompt);
    const separator = remoteCommand.indexOf(" && ");
    assert.ok(separator > 0, "prompt cleanup must precede bootstrap steps");
    const failingCommand = `${remoteCommand.slice(0, separator)} && false && ${remoteCommand.slice(separator + 4)}`;
    const run = spawnSync("bash", ["--noprofile", "--norc", "-c", failingCommand], {
      encoding: "utf8",
      env: { HOME: home, PATH: "/usr/bin:/bin", TERM: "xterm" },
      timeout: 5_000,
    });
    assert.notEqual(run.status, 0);
    assert.equal(existsSync(prompt), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sha256 shell check fails closed on a digest mismatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "cmux-home-test-"));
  try {
    const file = join(dir, "artifact");
    writeFileSync(file, "known content");
    const script = [
      "set -eu",
      `cmux_download=${shellQuoteForTest(file)}`,
      `cmux_expected=${shellQuoteForTest("0".repeat(64))}`,
      ...sha256CheckShell("$cmux_download", "$cmux_expected", "test-artifact"),
    ].join("\n");
    const result = spawnSync("bash", ["-euc", script], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /digest mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Tailscale bootstrap contains no credential and requires a file path", () => {
  const script = buildTailscaleBootstrap({ hostname: "fs-test", proxyPort: 1055 });
  assert.doesNotMatch(script, /auth-key=.*[A-Za-z0-9]{12,}/);
  assert.doesNotMatch(script, /base64.*key/);
  assert.match(script, /pre-authenticate the VM/);
  const withFile = buildTailscaleBootstrap({
    authKeyPath: "/run/cmux-home/ts-auth-test",
    hostname: "fs-test",
    proxyPort: 1055,
  });
  assert.match(withFile, /--auth-key="file:\$ts_auth_file"/);
  assert.match(withFile, /chmod 0600/);
  assert.match(withFile, /sed -n/);
  assert.match(withFile, /rm -f "\$ts_auth_file"/);
  assert.doesNotMatch(withFile, /SECRET|authKeyB64/);
  assert.doesNotMatch(withFile, /TS_HOST/);
  assert.throws(
    () => buildTailscaleBootstrap({ authKey: "secret", hostname: "fs-test", proxyPort: 1055 }),
    /raw Tailscale auth keys are not accepted/,
  );
});

test("helper print mode never emits a credential or wildcard listener", () => {
  const secret = "tskey-test-SECRET-123456";
  const result = spawnSync(process.execPath, [
    helper,
    "vm-test",
    "--print-bootstrap",
    "--no-ssh-credential",
    "--no-codex-config",
    "--no-tailscale",
  ], {
    encoding: "utf8",
    env: {
      ...sanitizedEnvironment(),
      FREESTYLE_API_KEY: "test-api-key",
      TAILSCALE_AUTHKEY: secret,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.doesNotMatch(result.stdout, /0\.0\.0\.0/);
  assert.match(result.stdout, /"identityId":null/);

  const inline = spawnSync(process.execPath, [
    helper,
    "vm-test",
    "--print-bootstrap",
    "--no-ssh-credential",
    "--tailscale-authkey",
    secret,
  ], { encoding: "utf8", env: sanitizedEnvironment() });
  assert.equal(inline.status, 2);
  assert.doesNotMatch(inline.stderr, new RegExp(secret));
});

test("sshpass reads the private file without combining password sources", () => {
  const args = buildSshpassArgs("/tmp/private-pass", ["-p", "22", "host"]);
  assert.deepEqual(args, ["-f", "/tmp/private-pass", "/usr/bin/ssh", "-p", "22", "host"]);
  assert.equal(args.includes("-e"), false);
});

test("helper rejects shell-expansion paths and quotes diagnostic inputs", () => {
  const rejected = spawnSync(process.execPath, [
    helper,
    "vm-test",
    "--print-bootstrap",
    "--no-ssh-credential",
    "--no-tailscale",
    "--subrouter-url",
    "https://subrouter-team.tail41290.ts.net/v1; touch /tmp/cmux-home-pwned",
    "--codex-config",
    "$HOME/$(touch /tmp/cmux-home-pwned)/config.toml",
  ], { encoding: "utf8", env: sanitizedEnvironment() });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /may only use the \$HOME prefix/);

  const safe = spawnSync(process.execPath, [
    helper,
    "vm-test",
    "--print-bootstrap",
    "--no-ssh-credential",
    "--no-tailscale",
    "--subrouter-url",
    "https://subrouter-team.tail41290.ts.net/v1; printf hacked",
  ], { encoding: "utf8", env: sanitizedEnvironment() });
  assert.equal(safe.status, 0, safe.stderr);
  const payload = JSON.parse(safe.stdout.trim().split(/\r?\n/).pop());
  execFileSync("bash", ["-n", "-c", payload.remoteCommand]);
  assert.doesNotMatch(payload.remoteCommand, /printf hacked/);

  const untrusted = spawnSync(process.execPath, [
    helper,
    "vm-test",
    "--print-bootstrap",
    "--no-ssh-credential",
    "--no-tailscale",
    "--subrouter-url",
    "https://subrouter.invalid/v1",
  ], { encoding: "utf8", env: sanitizedEnvironment() });
  assert.notEqual(untrusted.status, 0);
  assert.match(untrusted.stderr, /host is not approved/);

  const optedIn = spawnSync(process.execPath, [
    helper,
    "vm-test",
    "--print-bootstrap",
    "--no-ssh-credential",
    "--no-tailscale",
    "--allow-untrusted-subrouter",
    "--subrouter-url",
    "https://subrouter.invalid/v1",
  ], { encoding: "utf8", env: sanitizedEnvironment() });
  assert.equal(optedIn.status, 0, optedIn.stderr);

  const pathSecret = spawnSync(process.execPath, [
    helper,
    "vm-test",
    "--print-bootstrap",
    "--no-ssh-credential",
    "--no-tailscale",
    "--subrouter-url",
    "https://subrouter-team.tail41290.ts.net/v1/token/sk-12345678901234567890",
  ], { encoding: "utf8", env: sanitizedEnvironment() });
  assert.notEqual(pathSecret.status, 0);
  assert.match(pathSecret.stderr, /secret-shaped path/);
});

test("SSH host policy uses a private known_hosts file and rejects embedded credentials", () => {
  const state = mkdtempSync(join(tmpdir(), "cmux-home-known-hosts-"));
  const previous = {
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    CMUX_FREESTYLE_SSH_KNOWN_HOSTS: process.env.CMUX_FREESTYLE_SSH_KNOWN_HOSTS,
    CMUX_FREESTYLE_SSH_HOST_KEY: process.env.CMUX_FREESTYLE_SSH_HOST_KEY,
  };
  try {
    process.env.XDG_STATE_HOME = state;
    delete process.env.CMUX_FREESTYLE_SSH_KNOWN_HOSTS;
    delete process.env.CMUX_FREESTYLE_SSH_HOST_KEY;
    const options = freestyleHostKeyOptions();
    assert.deepEqual(options, [
      "StrictHostKeyChecking=accept-new",
      `UserKnownHostsFile=${join(state, "cmux-home", "freestyle-known-hosts")}`,
    ]);
    assert.equal(hasEmbeddedCredential("vm-test+cmux@vm-ssh.freestyle.sh"), false);
    assert.equal(hasEmbeddedCredential("vm-test+cmux:secret@vm-ssh.freestyle.sh"), true);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(state, { recursive: true, force: true });
  }
});

test("secret redaction removes exact values and credential-shaped fields", () => {
  assert.equal(redactSecrets("key=very-secret", ["very-secret"]), "key=<redacted>");
  assert.equal(redactSecrets("TAILSCALE_AUTHKEY=very-secret"), "TAILSCALE_AUTHKEY=<redacted>");
  const diagnostic = redactSecrets(
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature x-api-key: abcdefghijklmnop?access_token=long-secret",
  );
  assert.doesNotMatch(diagnostic, /eyJhbGci|abcdefghijklmnop|long-secret/);
  assert.match(diagnostic, /Bearer\s+<redacted>/);
  const previous = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    TSADMIN_ACCOUNT: process.env.TSADMIN_ACCOUNT,
    TSADMIN_API_BASE: process.env.TSADMIN_API_BASE,
    TSADMIN_TOKEN: process.env.TSADMIN_TOKEN,
  };
  process.env.OPENAI_API_KEY = "openai-secret";
  process.env.GITHUB_TOKEN = "github-secret";
  process.env.AWS_SECRET_ACCESS_KEY = "aws-secret";
  process.env.TSADMIN_ACCOUNT = "work";
  process.env.TSADMIN_API_BASE = "https://api.tailscale.com/api/v2";
  process.env.TSADMIN_TOKEN = "tsadmin-secret";
  const env = sanitizedEnvironment({ TEST_VALUE: "ok", PATH: "/safe/bin" });
  assert.equal(env.FREESTYLE_API_KEY, undefined);
  assert.equal(env.TAILSCALE_AUTHKEY, undefined);
  assert.equal(env.SSHPASS, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.TSADMIN_TOKEN, undefined);
  assert.equal(env.TSADMIN_ACCOUNT, "work");
  assert.equal(env.TSADMIN_API_BASE, "https://api.tailscale.com/api/v2");
  assert.equal(env.TEST_VALUE, undefined);
  assert.equal(env.PATH, "/usr/sbin:/usr/bin:/sbin:/bin");
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("local auth-key files must be private regular files", () => {
  const dir = mkdtempSync(join(tmpdir(), "cmux-home-key-"));
  try {
    const path = join(dir, "key");
    writeFileSync(path, "tskey-file");
    chmodSync(path, 0o600);
    assert.equal(localSecretFromFile(path), "tskey-file");
    chmodSync(path, 0o644);
    assert.throws(() => localSecretFromFile(path), /must not be group\/world readable/);
    chmodSync(path, 0o600);
    writeFileSync(path, "x".repeat(4097));
    assert.throws(() => localSecretFromFile(path), /too large/);
    writeFileSync(path, "tskey-file");
    chmodSync(path, 0o600);
    writeFileSync(path, "tskey-file\nforged");
    assert.throws(() => localSecretFromFile(path), /control characters/);
    writeFileSync(path, "tskey-file");
    chmodSync(path, 0o600);
    const link = join(dir, "link");
    symlinkSync(path, link);
    assert.throws(() => localSecretFromFile(link), /regular file|ELOOP/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider secret transfer requires explicit opt-in and cleans up failures", async () => {
  const previous = {
    CMUX_HOME_ALLOW_PROVIDER_SECRET_FILE_TRANSFER:
      process.env.CMUX_HOME_ALLOW_PROVIDER_SECRET_FILE_TRANSFER,
    CMUX_HOME_PROVIDER_SECRET_REDACTION_ACK:
      process.env.CMUX_HOME_PROVIDER_SECRET_REDACTION_ACK,
  };
  const secret = "tskey-transfer-secret";
  const commands = [];
  const removed = [];
  const vm = {
    exec: async ({ command }) => {
      commands.push(command);
      return { statusCode: 0 };
    },
    fs: {
      writeTextFile: async (_path, value) => {
        assert.equal(value, secret);
        throw new Error("simulated write failure");
      },
      remove: async (path) => { removed.push(path); },
    },
  };
  try {
    delete process.env.CMUX_HOME_ALLOW_PROVIDER_SECRET_FILE_TRANSFER;
    delete process.env.CMUX_HOME_PROVIDER_SECRET_REDACTION_ACK;
    assert.equal(providerSecretTransferEnabled(), false);
    await assert.rejects(
      () => transferProviderSecret(vm, secret),
      /refusing to transfer a Tailscale auth key/,
    );

    process.env.CMUX_HOME_ALLOW_PROVIDER_SECRET_FILE_TRANSFER = "1";
    process.env.CMUX_HOME_PROVIDER_SECRET_REDACTION_ACK = "freestyle-file-api-v1";
    assert.equal(providerSecretTransferEnabled(), true);
    await assert.rejects(() => transferProviderSecret(vm, secret), /could not be secured/);
    assert.equal(commands.every((command) => !command.includes(secret)), true);
    assert.equal(removed.length, 1);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

function shellQuoteForTest(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
