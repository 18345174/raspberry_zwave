import type { AppConfig } from "../domain/config.js";
import type {
  DriverStatus,
  InclusionChallenge,
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
    this.log("info", "Controller port selected", {
      path,
      stablePath: resolvedStablePath,
    });
  }

  public async connect(): Promise<DriverStatus> {
    const selection = this.storage.getControllerSelection();
    if (!selection.selectedPortPath) {
      this.log("warn", "Connect requested without a selected controller port");
      throw new Error("No controller port has been selected.");
    }
    const currentStatus = this.withSelection(await this.adapter.getStatus(), selection.selectedPortPath);
    if (
      currentStatus.connectedPortPath === selection.selectedPortPath &&
      (currentStatus.phase === "connecting" || currentStatus.phase === "ready")
    ) {
      this.log("info", "Connect request re-used current driver state", {
        phase: currentStatus.phase,
        portPath: selection.selectedPortPath,
      });
      this.storage.saveDriverStatus(currentStatus);
      return currentStatus;
    }
    this.log("info", "Connecting controller", {
      portPath: selection.selectedPortPath,
      stablePath: selection.selectedStablePath,
    });
    await this.adapter.connect(selection.selectedPortPath);
    const status = this.withSelection(await this.adapter.getStatus(), selection.selectedPortPath);
    this.storage.saveControllerSelection({
      ...selection,
      lastConnectedAt: status.updatedAt,
      lastStatus: status.phase,
    });
    this.storage.saveDriverStatus(status);
    this.log("info", "Connect finished", {
      phase: status.phase,
      portPath: status.connectedPortPath,
      hasReadyDriver: status.hasReadyDriver,
      controllerId: status.controllerId,
      homeId: status.homeId,
      lastError: status.lastError,
    });
    return status;
  }

  public async disconnect(): Promise<DriverStatus> {
    this.log("info", "Disconnecting controller", {
      portPath: this.storage.getControllerSelection().selectedPortPath,
    });
    await this.adapter.disconnect();
    const status = this.withSelection(
      await this.adapter.getStatus(),
      this.storage.getControllerSelection().selectedPortPath,
    );
    this.storage.saveDriverStatus(status);
    this.log("info", "Disconnect finished", {
      phase: status.phase,
      portPath: status.connectedPortPath,
      hasReadyDriver: status.hasReadyDriver,
    });
    return status;
  }

  public async reconnect(): Promise<DriverStatus> {
    const selection = this.storage.getControllerSelection();
    if (!selection.selectedPortPath) {
      this.log("warn", "Reconnect requested without a selected controller port");
      throw new Error("No controller port has been selected.");
    }
    const currentStatus = this.withSelection(await this.adapter.getStatus(), selection.selectedPortPath);
    if (currentStatus.phase === "connecting") {
      this.log("info", "Reconnect request ignored while driver is still connecting", {
        portPath: selection.selectedPortPath,
      });
      this.storage.saveDriverStatus(currentStatus);
      return currentStatus;
    }
    this.log("info", "Reconnecting controller", {
      portPath: selection.selectedPortPath,
      stablePath: selection.selectedStablePath,
    });
    await this.adapter.reconnect(selection.selectedPortPath);
    const status = this.withSelection(await this.adapter.getStatus(), selection.selectedPortPath);
    this.storage.saveDriverStatus(status);
    this.log("info", "Reconnect finished", {
      phase: status.phase,
      portPath: status.connectedPortPath,
      hasReadyDriver: status.hasReadyDriver,
      controllerId: status.controllerId,
      homeId: status.homeId,
      lastError: status.lastError,
    });
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

  public async getInclusionChallenge(): Promise<InclusionChallenge | null> {
    return this.adapter.getInclusionChallenge();
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

  public async hardResetController(): Promise<DriverStatus> {
    this.log("warn", "Hard reset controller requested", {
      portPath: this.storage.getControllerSelection().selectedPortPath,
    });
    await this.adapter.hardResetController();
    const status = this.withSelection(
      await this.adapter.getStatus(),
      this.storage.getControllerSelection().selectedPortPath,
    );
    this.storage.saveDriverStatus(status);
    return status;
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

  private log(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void {
    const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
    console[level](`[zwave-runtime] ${message}${suffix}`);
  }
}
