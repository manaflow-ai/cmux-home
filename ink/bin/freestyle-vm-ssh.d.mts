export function devServerMacPortForVm(vmId: string): number;
export function devServerBrowserUrlForVm(vmId: string): string;
export function buildGitConfigIsolationScript(options?: {
  allowFileOrigin?: boolean;
}): string;
