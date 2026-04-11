import type { InclusionChallenge, SecurityGrantInput } from "../domain/types.js";
import { ZwaveRuntimeService } from "./zwave-runtime-service.js";

export class InclusionService {
  public constructor(private readonly zwaveRuntime: ZwaveRuntimeService) {}

  public async startInclusion(): Promise<void> {
    await this.zwaveRuntime.startInclusion();
  }

  public async stopInclusion(): Promise<void> {
    await this.zwaveRuntime.stopInclusion();
  }

  public async startExclusion(): Promise<void> {
    await this.zwaveRuntime.startExclusion();
  }

  public async stopExclusion(): Promise<void> {
    await this.zwaveRuntime.stopExclusion();
  }

  public async getInclusionChallenge(): Promise<InclusionChallenge | null> {
    return this.zwaveRuntime.getInclusionChallenge();
  }

  public async grantSecurity(requestId: string, payload: SecurityGrantInput): Promise<void> {
    await this.zwaveRuntime.grantSecurity(requestId, payload);
  }

  public async validateDsk(requestId: string, pin: string): Promise<void> {
    await this.zwaveRuntime.validateDsk(requestId, pin);
  }
}
