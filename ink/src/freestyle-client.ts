import { Freestyle } from "freestyle";

export interface FreestyleVm {
  readonly id: string;
  readonly state: "starting" | "running" | "suspending" | "suspended" | "stopped" | "lost";
  readonly snapshotId: string | null;
  readonly createdAtMs: number | null;
  readonly lastActivityMs: number | null;
  readonly persistence: "sticky" | "ephemeral" | "persistent" | null;
  readonly deleted: boolean;
}

export interface FreestyleSummary {
  readonly vms: ReadonlyArray<FreestyleVm>;
  readonly totalCount: number;
  readonly runningCount: number;
  readonly startingCount: number;
  readonly suspendedCount: number;
  readonly stoppedCount: number;
  readonly fetchedAtMs: number;
}

export class FreestyleClient {
  private readonly fs: Freestyle | null;
  readonly apiKey: string | null;

  constructor(apiKey: string | null) {
    this.apiKey = apiKey;
    this.fs = apiKey ? new Freestyle({ apiKey }) : null;
  }

  isEnabled(): boolean {
    return this.fs !== null;
  }

  async list(): Promise<FreestyleSummary | null> {
    if (!this.fs) return null;
    const response = await this.fs.vms.list();
    const vms: FreestyleVm[] = response.vms
      .filter((vm) => !vm.deleted)
      .map((vm) => ({
        id: vm.id,
        state: vm.state,
        snapshotId: vm.snapshotId ?? null,
        createdAtMs: vm.createdAt ? Date.parse(vm.createdAt) : null,
        lastActivityMs: vm.lastNetworkActivity
          ? Date.parse(vm.lastNetworkActivity)
          : null,
        persistence: vm.persistence?.type ?? null,
        deleted: vm.deleted === true,
      }));
    return {
      vms,
      totalCount: response.totalCount,
      runningCount: response.runningCount,
      startingCount: response.startingCount,
      suspendedCount: response.suspendedCount,
      stoppedCount: response.stoppedCount,
      fetchedAtMs: Date.now(),
    };
  }

  async destroy(vmId: string): Promise<void> {
    if (!this.fs) throw new Error("FREESTYLE_API_KEY is not set");
    await this.fs.vms.ref({ vmId }).delete();
  }
}

export function defaultFreestyleApiKey(): string | null {
  const value = process.env.FREESTYLE_API_KEY?.trim();
  return value ? value : null;
}
