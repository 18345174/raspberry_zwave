import type { AppConfig } from "../domain/config.js";
import type {
  DriverStatus,
  InvokeCcApiInput,
  NodeDetail,
  NodeSummary,
  SecurityGrantInput,
  SerialPortInfo,
  SetValueInput,
} from "../domain/types.js";
import type { IZwaveAdapter } from "../adapters/zwave/interfaces.js";
import { DatabaseService } from "../storage/database.js";

export class ZwaveRuntimeService {
  public constructor(
    private readonly config: AppConfig,
    private readonly storage: DatabaseService,
    private readonly adapter: IZwaveAdapter,
  ) {
    void this.config;
  }

  public async listPorts(): Promise<SerialPortInfo[]> {
    return this.adapter.scanPorts();
  }

  public getSelectedPort(): string | undefined {
    return this.storage.getControllerSelection().selectedPortPath;
  }

  public async saveSelectedPort(path: string, stablePath?: string): Promise<void> {
    const current = this.storage.getControllerSelection();
    let resolvedStablePath = stablePath;

    if (!resolvedStablePath) {
      const ports = await this.adapter.scanPorts();
      resolvedStablePath = ports.find((item) => item.path === path)?.stablePath;
    }

    this.storage.saveControllerSelection({
      ...current,
      selectedPortPath: path,
      selectedStablePath: resolvedStablePath,
    });
  }

  public async connect(): Promise<DriverStatus> {
    const selection = this.storage.getControllerSelection();
    if (!selection.selectedPortPath) {
      throw new Error("No controller port has been selected.");
    }
    await this.adapter.connect(selection.selectedPortPath);
    const status = this.withSelection(await this.adapter.getStatus(), selection.selectedPortPath);
    this.storage.saveControllerSelection({
      ...selection,
      lastConnectedAt: status.updatedAt,
      lastStatus: status.phase,
    });
    this.storage.saveDriverStatus(status);
    return status;
  }

  public async disconnect(): Promise<DriverStatus> {
    await this.adapter.disconnect();
    const status = this.withSelection(
      await this.adapter.getStatus(),
      this.storage.getControllerSelection().selectedPortPath,
    );
    this.storage.saveDriverStatus(status);
    return status;
  }

  public async reconnect(): Promise<DriverStatus> {
    const selection = this.storage.getControllerSelection();
    if (!selection.selectedPortPath) {
      throw new Error("No controller port has been selected.");
    }
    await this.adapter.reconnect(selection.selectedPortPath);
    const status = this.withSelection(await this.adapter.getStatus(), selection.selectedPortPath);
    this.storage.saveDriverStatus(status);
    return status;
  }

  public async getStatus(): Promise<DriverStatus> {
    const status = this.withSelection(
      await this.adapter.getStatus(),
      this.storage.getControllerSelection().selectedPortPath,
    );
    this.storage.saveDriverStatus(status);
    return status;
  }

  public async startInclusion(): Promise<void> {
    await this.adapter.startInclusion();
  }

  public async stopInclusion(): Promise<void> {
    await this.adapter.stopInclusion();
  }

  public async startExclusion(): Promise<void> {
    await this.adapter.startExclusion();
  }

  public async stopExclusion(): Promise<void> {
    await this.adapter.stopExclusion();
  }

  public async grantSecurity(requestId: string, payload: SecurityGrantInput): Promise<void> {
    await this.adapter.grantSecurity(requestId, payload);
  }

  public async validateDsk(requestId: string, pin: string): Promise<void> {
    await this.adapter.validateDsk(requestId, pin);
  }

  public async listNodes(): Promise<NodeSummary[]> {
    return this.adapter.listNodes();
  }

  public async getNode(nodeId: number): Promise<NodeDetail> {
    return this.adapter.getNode(nodeId);
  }

  public async refreshNode(nodeId: number): Promise<NodeDetail> {
    return this.adapter.refreshNode(nodeId);
  }

  public async pingNode(nodeId: number): Promise<boolean> {
    return this.adapter.pingNode(nodeId);
  }

  public async healNode(nodeId: number): Promise<unknown> {
    return this.adapter.healNode(nodeId);
  }

  public async setValue(input: SetValueInput): Promise<void> {
    await this.adapter.setValue(input);
  }

  public async invokeCcApi(input: InvokeCcApiInput): Promise<unknown> {
    return this.adapter.invokeCcApi(input);
  }

  private withSelection(status: DriverStatus, selectedPortPath?: string): DriverStatus {
    return {
      ...status,
      selectedPortPath: selectedPortPath ?? status.selectedPortPath,
    };
  }
}
