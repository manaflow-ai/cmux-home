export interface PinnedAsset {
  readonly name?: string;
  readonly sha256: string;
  readonly tailscaleSha256?: string;
  readonly tailscaledSha256?: string;
}

export interface PinnedRelease {
  readonly releaseTag?: string;
  readonly releaseCommit?: string;
  readonly version?: string;
  readonly assets: Readonly<Record<string, PinnedAsset>>;
}

export interface PinnedRepository {
  readonly url: string;
  readonly commit: string;
}

export const CMUXD_REMOTE_RELEASE: PinnedRelease;
export const TAILSCALE_RELEASE: PinnedRelease;
export const CMUX_REPOSITORY: PinnedRepository;
export const PROVIDER_FILE_TRANSFER_ACK: string;
export const DEFAULT_FREESTYLE_API_BASE_URL: string;
export const TRUSTED_COMMAND_PATH: string;
export function isValidFreestyleHostKeyLine(value: string): boolean;
export function providerFileTransferEnabled(): boolean;
export function freestyleApiBaseUrl(value?: string): string;
export function freestyleKnownHostsPath(): string;
export function ensurePrivateKnownHostsFile(path?: string): string;
export function writePrivateKnownHosts(path: string, content: string): void;
export function trustedExecutable(name: string): string;
export function assertTrustedUnixSocketPath(path: string): string;
export function shellQuote(value: string): string;
export function sha256CheckShell(file: string, expected: string, label?: string): string[];
export function buildSecureInstallDirectoryScript(
  path: string,
  options?: {
    owner?: string;
    group?: string;
    mode?: string;
    label?: string;
  },
): string;
export function redactSecrets(value: string, secrets?: readonly string[]): string;
export function sanitizedEnvironment(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv;
