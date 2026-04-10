import type { AppConfig } from "../domain/config.js";
import type { SystemHealth } from "../domain/types.js";
import { DatabaseService } from "../storage/database.js";
import { TestEngineService } from "./test-engine-service.js";
import { ZwaveRuntimeService } from "./zwave-runtime-service.js";

export class SystemService {
  private webSocketClients = 0;

  public constructor(
    public readonly config: AppConfig,
    private readonly storage: DatabaseService,
    private readonly zwaveRuntime: ZwaveRuntimeService,
    private readonly testEngine: TestEngineService,
    private readonly startedAt = Date.now(),
  ) {}

  public attachWebSocket(): void {
    this.webSocketClients += 1;
  }

  public detachWebSocket(): void {
    this.webSocketClients = Math.max(this.webSocketClients - 1, 0);
  }

  public async getHealth(): Promise<SystemHealth> {
    return {
      ok: true,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      version: "0.1.0",
      driverStatus: await this.zwaveRuntime.getStatus(),
      activeWebSocketClients: this.webSocketClients,
      activeTestRunId: this.testEngine.getActiveRunId(),
    };
  }

  public getConfig() {
    return this.storage.getConfig();
  }

  public updateConfig(payload: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(payload)) {
      this.storage.upsertConfig(key, value);
    }
  }
}
