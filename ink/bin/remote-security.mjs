import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const metadataPath = fileURLToPath(new URL("../remote-artifacts.json", import.meta.url));
const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));

/**
 * Release metadata is checked into the launcher so a mutable CDN or release
 * tag cannot silently replace an executable. Updating either entry requires a
 * reviewed change to this file and the corresponding release commit.
 */
export const CMUXD_REMOTE_RELEASE = Object.freeze(metadata.cmuxdRemote);
export const TAILSCALE_RELEASE = Object.freeze(metadata.tailscale);
export const CMUX_REPOSITORY = Object.freeze(metadata.cmuxRepository);
export const PROVIDER_FILE_TRANSFER_ACK = "freestyle-file-api-v1";
export const DEFAULT_FREESTYLE_API_BASE_URL = "https://api.freestyle.sh";

// Keep child command lookup deterministic. A caller-controlled PATH can point
// sshpass or ssh at a wrapper that reads the password file. The helper resolves
// sensitive executables separately, so this path only needs standard tools.
export const TRUSTED_COMMAND_PATH =
  "/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Provider file writes carry content in an API request body. Keep this opt-in
 * until the provider contract explicitly guarantees that request bodies are
 * not retained in logs or traces.
 */
export function providerFileTransferEnabled() {
  return (
    process.env.CMUX_HOME_ALLOW_PROVIDER_SECRET_FILE_TRANSFER === "1" &&
    process.env.CMUX_HOME_PROVIDER_SECRET_REDACTION_ACK === PROVIDER_FILE_TRANSFER_ACK
  );
}

/**
 * Return the only Freestyle API origin that may receive the API key. The SDK
 * reads FREESTYLE_API_URL implicitly, so validate it before construction and
 * pass the resulting base URL explicitly at every call site.
 */
export function freestyleApiBaseUrl(value = process.env.FREESTYLE_API_URL) {
  if (value === undefined || value.trim() === "") return DEFAULT_FREESTYLE_API_BASE_URL;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("FREESTYLE_API_URL must be the official HTTPS Freestyle API URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "api.freestyle.sh" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("FREESTYLE_API_URL must be exactly https://api.freestyle.sh");
  }
  return DEFAULT_FREESTYLE_API_BASE_URL;
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function modeIsPrivate(mode) {
  return (mode & 0o077) === 0;
}

function modeHasNoGroupOrOtherWrite(mode) {
  return (mode & 0o022) === 0;
}

function pathComponentsHaveNoSymlinks(path) {
  const absolute = resolve(path);
  const parsedRoot = absolute.startsWith(sep) ? sep : "";
  let cursor = parsedRoot;
  for (const component of absolute.slice(parsedRoot.length).split(sep)) {
    if (!component) continue;
    cursor = cursor ? join(cursor, component) : component;
    if (!existsSync(cursor)) continue;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      // macOS exposes common system directories through stable /private
      // aliases. Permit only those documented aliases, and reject every
      // user-created symlink in a security-sensitive path.
      const target = realpathSync(cursor);
      const allowedAlias =
        (cursor === "/var" && target === "/private/var") ||
        (cursor === "/tmp" && target === "/private/tmp") ||
        (cursor === "/etc" && target === "/private/etc") ||
        (cursor === "/dev" && target === "/private/dev");
      if (allowedAlias) continue;
      throw new Error(`refusing symlink in security-sensitive path: ${cursor}`);
    }
  }
}

function ensurePrivateDirectory(path) {
  pathComponentsHaveNoSymlinks(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  pathComponentsHaveNoSymlinks(path);
  const stat = lstatSync(path);
  const uid = currentUid();
  if (!stat.isDirectory() || (uid !== null && stat.uid !== uid) || !modeIsPrivate(stat.mode)) {
    throw new Error(`security-sensitive directory must be user-owned and private: ${path}`);
  }
  return path;
}

/** Return the managed state path used for host-key persistence. */
export function freestyleKnownHostsPath() {
  const stateHome = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  if (!stateHome.startsWith(sep) || /[\0\r\n]/.test(stateHome)) {
    throw new Error("XDG_STATE_HOME must be an absolute path without control characters");
  }
  const managedDir = join(stateHome, "cmux-home");
  const expected = join(managedDir, "freestyle-known-hosts");
  const override = process.env.CMUX_FREESTYLE_SSH_KNOWN_HOSTS?.trim();
  if (override && resolve(override) !== resolve(expected)) {
    throw new Error("CMUX_FREESTYLE_SSH_KNOWN_HOSTS must point to the managed cmux-home state file");
  }
  ensurePrivateDirectory(managedDir);
  return expected;
}

/** Ensure the managed known_hosts file is private and resistant to symlinks. */
export function ensurePrivateKnownHostsFile(path = freestyleKnownHostsPath()) {
  const expected = freestyleKnownHostsPath();
  if (resolve(path) !== resolve(expected)) {
    throw new Error("SSH known_hosts path is outside the managed cmux-home state directory");
  }
  const parent = dirname(expected);
  ensurePrivateDirectory(parent);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let fd;
  try {
    fd = openSync(
      expected,
      fsConstants.O_CREAT | fsConstants.O_RDWR | noFollow,
      0o600,
    );
    const stat = fstatSync(fd);
    const uid = currentUid();
    if (!stat.isFile() || (uid !== null && stat.uid !== uid) || !modeIsPrivate(stat.mode)) {
      throw new Error(`SSH known_hosts file must be user-owned and private: ${expected}`);
    }
    fchmodSync(fd, 0o600);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return expected;
}

/** Write a pinned host key without following a pre-existing symlink. */
export function writePrivateKnownHosts(path, content) {
  const expected = ensurePrivateKnownHostsFile(path);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let fd;
  try {
    fd = openSync(expected, fsConstants.O_WRONLY | fsConstants.O_TRUNC | noFollow, 0o600);
    fchmodSync(fd, 0o600);
    writeSync(fd, content);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function secureExecutable(path) {
  try {
    const resolved = realpathSync(path);
    const stat = lstatSync(resolved);
    const uid = currentUid();
    if (
      !stat.isFile() ||
      !modeHasNoGroupOrOtherWrite(stat.mode) ||
      (stat.mode & 0o111) === 0 ||
      (uid !== null && stat.uid !== 0 && stat.uid !== uid)
    ) return null;
    pathComponentsHaveNoSymlinks(resolved);
    return resolved;
  } catch {
    return null;
  }
}

/** Resolve a sensitive local executable from fixed, validated locations. */
export function trustedExecutable(name) {
  if (name !== "sshpass" && name !== "ssh") {
    throw new Error(`no trusted executable policy for ${name}`);
  }
  // Do not accept an executable path from the environment. An override would
  // let a caller deliberately point sshpass at a password-stealing wrapper.
  const candidates = name === "ssh"
    ? ["/usr/bin/ssh", "/bin/ssh"]
    : [
        // Homebrew is accepted only after secureExecutable verifies that the
        // resolved file is root-owned (or owned by this user) and not writable
        // by a group or other account.
        "/opt/homebrew/bin/sshpass",
        "/usr/local/bin/sshpass",
        "/usr/bin/sshpass",
        "/bin/sshpass",
      ];
  for (const candidate of candidates) {
    const resolved = secureExecutable(candidate);
    if (resolved) return resolved;
  }
  throw new Error(`no trusted ${name} executable found; install it in a standard system path`);
}

/**
 * Check a cmux Unix socket before connecting. A socket is a local authority
 * boundary: accepting a symlink, a non-socket, or a group/world-writable path
 * could send RPC requests (including short-lived lease tokens) to another
 * process. ENOENT is allowed because cmux may create the socket immediately
 * after the TUI starts; the connect call will report a normal startup error.
 */
export function assertTrustedUnixSocketPath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || /[\0\r\n]/.test(path)) {
    throw new Error("cmux socket path must be absolute and free of control characters");
  }
  try {
    const stat = lstatSync(path);
    const uid = currentUid();
    if (
      !stat.isSocket() ||
      stat.isSymbolicLink() ||
      (uid !== null && stat.uid !== uid) ||
      !modeHasNoGroupOrOtherWrite(stat.mode)
    ) {
      throw new Error("cmux socket must be a user-owned, non-writable Unix socket");
    }
  } catch (error) {
    if (error?.code === "ENOENT") return path;
    if (error instanceof Error && error.message.startsWith("cmux socket must")) throw error;
    throw new Error("cannot inspect cmux socket securely");
  }
  return path;
}

/**
 * Return a portable, fail-closed SHA-256 check. The expected digest is a
 * literal supplied by reviewed metadata, never downloaded from the server.
 */
export function sha256CheckShell(file, expected, label = "artifact") {
  const quotedFile = /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(file)
    ? `"${file}"`
    : shellQuote(file);
  const quotedExpected = /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(expected)
    ? `"${expected}"`
    : shellQuote(expected.toLowerCase());
  return [
    `cmux_sha256_file=${quotedFile}`,
    `cmux_sha256_expected=${quotedExpected}`,
    "if command -v sha256sum >/dev/null 2>&1; then",
    "  cmux_sha256_actual=$(sha256sum \"$cmux_sha256_file\" | awk '{print tolower($1)}')",
    "elif command -v shasum >/dev/null 2>&1; then",
    "  cmux_sha256_actual=$(shasum -a 256 \"$cmux_sha256_file\" | awk '{print tolower($1)}')",
    "elif command -v openssl >/dev/null 2>&1; then",
    "  cmux_sha256_actual=$(openssl dgst -sha256 \"$cmux_sha256_file\" | sed 's/^.*= //; s/[[:space:]]//g' | tr '[:upper:]' '[:lower:]')",
    "else",
    `  echo ${shellQuote(`${label}: no SHA-256 implementation is available`)} >&2; exit 1`,
    "fi",
    "if [ \"$cmux_sha256_actual\" != \"$cmux_sha256_expected\" ]; then",
    `  echo ${shellQuote(`${label}: SHA-256 digest mismatch`)} >&2; exit 1`,
    "fi",
    "unset cmux_sha256_file cmux_sha256_expected cmux_sha256_actual",
  ];
}

/**
 * Build a fail-closed shell guard for a root-owned install directory.
 *
 * The caller supplies only reviewed absolute paths and account names. The
 * generated commands reject an existing symlink or non-directory parent,
 * create the directory with the requested owner and mode, then verify the
 * resulting inode before any caller writes a marker or executable below it.
 * Optional owner/group/mode values make the same guard executable in an
 * unprivileged, isolated test fixture; production callers keep the defaults.
 */
export function buildSecureInstallDirectoryScript(
  path,
  { owner = "root", group = "root", mode = "0755", label = "install directory" } = {},
) {
  if (
    typeof path !== "string" ||
    !/^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(path) ||
    path.split("/").some((component) => component === "." || component === "..")
  ) {
    throw new Error("secure install directory path must be an absolute POSIX path");
  }
  const accountPattern = /^(?:[A-Za-z_][A-Za-z0-9._-]{0,31}|[0-9]+)$/;
  if (
    typeof owner !== "string" ||
    typeof group !== "string" ||
    !accountPattern.test(owner) ||
    !accountPattern.test(group)
  ) {
    throw new Error("secure install directory owner and group are invalid");
  }
  if (typeof mode !== "string" || !/^[0-7]{3,4}$/.test(mode)) {
    throw new Error("secure install directory mode is invalid");
  }
  if (typeof label !== "string" || label.length === 0 || /[\0\r\n]/.test(label)) {
    throw new Error("secure install directory label is invalid");
  }
  const quotedPath = shellQuote(path);
  const components = [];
  for (let cursor = path; cursor !== "/"; cursor = dirname(cursor)) {
    components.unshift(cursor);
  }
  const quotedOwner = shellQuote(owner);
  const quotedGroup = shellQuote(group);
  const normalizedMode = mode.replace(/^0+/, "") || "0";
  const ownerId = /^\d+$/.test(owner) ? owner : `$(id -u ${quotedOwner})`;
  const groupId = /^\d+$/.test(group) ? group : `$(id -g ${quotedGroup})`;
  const fail = (message) =>
    `{ echo ${shellQuote(`${label}: ${message}`)} >&2; exit 1; }`;
  return [
    ...components.map((component) => {
      const quotedComponent = shellQuote(component);
      return `if test -L ${quotedComponent} || { test -e ${quotedComponent} && test ! -d ${quotedComponent}; }; then ${fail("path component is not a real directory")}; fi`;
    }),
    `install -d -o ${quotedOwner} -g ${quotedGroup} -m ${mode} ${quotedPath}`,
    `test ! -L ${quotedPath} || ${fail("secure install directory became a symlink")}`,
    `test -d ${quotedPath} || ${fail("secure install directory is not a directory")}`,
    `test "$(stat -c '%u:%g:%a' ${quotedPath})" = "${ownerId}:${groupId}:${normalizedMode}" || ${fail("secure install directory ownership or mode is unsafe")}`,
  ].join("\n");
}

/** Redact exact credentials before writing diagnostics. */
export function redactSecrets(value, secrets = []) {
  let result = String(value);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      result = result.split(secret).join("<redacted>");
    }
  }
  // Remove PEM material before line-oriented assignment matching. This also
  // covers multiline private keys emitted by a dependency.
  result = result.replace(
    /-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/gi,
    "<redacted private key>",
  );
  result = result
    .replace(/(\bAuthorization\s*:\s*)(Bearer|Basic)\s+[^\s,;]+/gi, "$1$2 <redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer <redacted>")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, "Basic <redacted>")
    .replace(/(\bCookie\s*:\s*)[^\r\n]+/gi, "$1<redacted>")
    .replace(/(https?:\/\/[^\s/@:]+:)[^\s/@]+(@)/gi, "$1<redacted>$2")
    .replace(
      /([?&](?:api[-_]?key|auth(?:[-_]?key)?|access[-_]?token|token|password|secret|credential)=)(?:%[0-9a-f]{2}|[^&\s])+/gi,
      "$1<redacted>",
    )
    .replace(
      /(\b(?:FREESTYLE_API_KEY|TAILSCALE_AUTHKEY|SSHPASS|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|DATABASE_URL|CONNECTION_STRING|CLIENT_SECRET|PRIVATE[_-]?KEY|(?:API|AUTH|ACCESS|CLIENT|GITHUB|NPM|SLACK|OPENAI|RESEND|STRIPE)[_-]?(?:KEY|TOKEN|SECRET)|(?:api[-_]?key|auth(?:[-_]?key)?|access[-_]?token|token|password|passwd|pass|secret|credential|cookie))\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      "$1<redacted>",
    )
    .replace(
      /(["']?(?:api[-_]?key|auth(?:[-_]?key)?|access[-_]?token|client[_-]?secret|private[_-]?key|token|password|passwd|secret|credential|cookie)["']?\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\s]+)/gi,
      "$1<redacted>",
    );
  return result;
}

// A child process gets only process settings needed for command lookup and
// terminal behaviour. Inheriting the full environment is unsafe because
// callers commonly keep unrelated provider, cloud, and model credentials in
// it. In particular, do not pass SSH_AUTH_SOCK, which would re-enable agent
// authentication despite the explicit IdentityFile=/dev/null policy.
const SAFE_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  "TERM_PROGRAM",
  "COLORTERM",
  "TMPDIR",
  "TZ",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  // Non-secret tsadmin selectors. Credential-bearing TSADMIN_* names are
  // intentionally absent below and are rejected by the same pattern.
  "TSADMIN_ACCOUNT",
  "TSADMIN_TAILNET",
  "TSADMIN_API_BASE",
  "TSADMIN_KEYCHAIN_SERVICE",
  "TSADMIN_ACCOUNT_FILE",
  "TSADMIN_MANIFEST",
  "TSADMIN_BUILDER_HOST",
  "TSADMIN_BUILDER_USER",
  "MACFLEET_ACCOUNT",
  "MACFLEET_TAILNET",
  "MACFLEET_API_BASE",
  "MACFLEET_KEYCHAIN_SERVICE",
  "MACFLEET_ACCOUNT_FILE",
  "MACFLEET_MANIFEST",
]);

const CREDENTIAL_ENV_NAME =
  /(?:^|_)(?:API[_-]?KEY|AUTH(?:ORIZATION|[_-]?KEY)?|ACCESS[_-]?TOKEN|TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE[_-]?KEY|CREDENTIALS?)(?:$|_)/i;

function safeConfigEnvironmentValue(name, value) {
  if (/^(?:TSADMIN|MACFLEET)_(?:ACCOUNT|TAILNET|KEYCHAIN_SERVICE)$/.test(name)) {
    return /^[A-Za-z0-9._:@/-]{1,128}$/.test(value) ? value : null;
  }
  if (/^(?:TSADMIN|MACFLEET)_(?:ACCOUNT_FILE|MANIFEST|BUILDER_HOST|BUILDER_USER)$/.test(name)) {
    return /^[^\0\r\n]{1,1024}$/.test(value) ? value : null;
  }
  if (/^(?:TSADMIN|MACFLEET)_API_BASE$/.test(name)) {
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "api.tailscale.com" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) return null;
      return value;
    } catch {
      return null;
    }
  }
  return value;
}

/** Return a minimal child-process environment with credentials excluded. */
export function sanitizedEnvironment(extra = {}) {
  const env = {};
  for (const name of SAFE_ENV_NAMES) {
    const value = process.env[name];
    if (typeof value === "string" && name !== "PATH") {
      const safeValue = safeConfigEnvironmentValue(name, value);
      if (safeValue !== null) env[name] = safeValue;
    }
  }
  // Never inherit a caller-controlled PATH. Sensitive tools are resolved by
  // trustedExecutable(), and ordinary child tools use these fixed locations.
  env.PATH = TRUSTED_COMMAND_PATH;
  for (const [name, value] of Object.entries(extra)) {
    if (
      SAFE_ENV_NAMES.has(name) &&
      !CREDENTIAL_ENV_NAME.test(name) &&
      typeof value === "string" && name !== "PATH"
    ) {
      const safeValue = safeConfigEnvironmentValue(name, value);
      if (safeValue !== null) env[name] = safeValue;
    }
  }
  return env;
}
