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

  /**
   * Underlying SDK for callers that need to mint identities, exec
   * commands on a VM, or other operations not yet wrapped here.
   * Throws when FREESTYLE_API_KEY isn't set.
   */
  get sdk(): Freestyle {
    if (!this.fs) {
      throw new Error("FREESTYLE_API_KEY is not set; freestyle SDK unavailable");
    }
    return this.fs;
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

  async createFromSnapshot(snapshotId: string): Promise<{ vmId: string }> {
    if (!this.fs) throw new Error("FREESTYLE_API_KEY is not set");
    const created = (await (this.fs.vms as unknown as {
      create: (input: unknown) => Promise<{ vmId: string }>;
    }).create({
      snapshotId,
      ports: [{ port: 443, targetPort: 7777 }],
      readySignalTimeoutSeconds: 600,
    }));
    if (!created.vmId) throw new Error("freestyle vms.create did not return vmId");
    return { vmId: created.vmId };
  }

  /**
   * Fork a running VM by snapshotting it and creating a new VM from that
   * snapshot. Returns the new VM id plus the snapshot id (so callers can
   * track parent/child relationships).
   */
  async forkVm(
    parentVmId: string,
    snapshotName?: string,
  ): Promise<{ vmId: string; snapshotId: string }> {
    if (!this.fs) throw new Error("FREESTYLE_API_KEY is not set");
    const ref = this.fs.vms.ref({ vmId: parentVmId });
    const snap = (await ref.snapshot({
      name: snapshotName ?? `fork-${parentVmId.slice(0, 8)}-${Date.now()}`,
    } as Parameters<typeof ref.snapshot>[0])) as { snapshotId?: string };
    const snapshotId = snap.snapshotId ?? "";
    if (!snapshotId) {
      throw new Error("freestyle snapshot did not return snapshotId");
    }
    const { vmId } = await this.createFromSnapshot(snapshotId);
    return { vmId, snapshotId };
  }
}

export function defaultFreestyleApiKey(): string | null {
  const value = process.env.FREESTYLE_API_KEY?.trim();
  return value ? value : null;
}
