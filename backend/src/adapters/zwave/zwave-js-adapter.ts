import { EventEmitter } from "node:events";
import { CommandClasses, SecurityClass, getCCName } from "@zwave-js/core";

import type { AppConfig } from "../../domain/config.js";
import type {
  DriverStatus,
  EndpointSnapshot,
  InvokeCcApiInput,
  NodeDetail,
  NodeSummary,
  NodeValueSnapshot,
  SecurityGrantInput,
  SerialPortInfo,
  SetValueInput,
  ValueIdInput,
  ZwaveEvent,
} from "../../domain/types.js";
import { createId } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import { SerialDiscoveryService } from "../../services/serial-discovery-service.js";
import type { IZwaveAdapter } from "./interfaces.js";

type PendingGrantRequest = {
  type: "grant_security_classes";
  resolve: (value: unknown) => void;
};

type PendingDskRequest = {
  type: "validate_dsk";
  resolve: (value: unknown) => void;
};

type PendingRequest = PendingGrantRequest | PendingDskRequest;

type ZwaveModule = typeof import("zwave-js");

export class ZwaveJsDirectAdapter implements IZwaveAdapter {
  private readonly serialDiscovery = new SerialDiscoveryService();
  private readonly emitter = new EventEmitter();
  private readonly pendingInclusionRequests = new Map<string, PendingRequest>();
  private readonly status: DriverStatus = {
    phase: "idle",
    isInclusionActive: false,
    isExclusionActive: false,
    hasReadyDriver: false,
    updatedAt: nowIso(),
  };

  private modulePromise?: Promise<ZwaveModule>;
  private driver?: any;

  public constructor(private readonly appConfig: AppConfig) {}

  public onEvent(listener: (event: ZwaveEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  public async scanPorts(): Promise<SerialPortInfo[]> {
    return this.serialDiscovery.scanPorts();
  }

  public async connect(portPath: string): Promise<void> {
    if (this.driver) {
      throw new Error("Z-Wave driver is already running.");
    }

    const zwave = await this.loadModule();
    const driver = new zwave.Driver(portPath, this.createDriverOptions());

    this.driver = driver;
    this.updateStatus({
      phase: "connecting",
      selectedPortPath: portPath,
      connectedPortPath: portPath,
      hasReadyDriver: false,
      lastError: undefined,
    });

    this.attachDriverEvents(driver, zwave);

    try {
      await driver.start();
      this.updateStatus({
        phase: driver.ready ? "ready" : "connecting",
        connectedPortPath: portPath,
        selectedPortPath: portPath,
        hasReadyDriver: Boolean(driver.ready),
      });
    } catch (error) {
      await this.safeDestroyDriver();
      this.updateStatus({
        phase: "error",
        connectedPortPath: undefined,
        hasReadyDriver: false,
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    if (!this.driver) {
      return;
    }
    this.updateStatus({ phase: "disconnecting" });
    await this.safeDestroyDriver();
    this.updateStatus({
      phase: "idle",
      connectedPortPath: undefined,
      controllerId: undefined,
      homeId: undefined,
      hasReadyDriver: false,
      isInclusionActive: false,
      isExclusionActive: false,
    });
  }

  public async reconnect(portPath: string): Promise<void> {
    await this.disconnect();
    await this.connect(portPath);
  }

  public async getStatus(): Promise<DriverStatus> {
    return { ...this.status };
  }

  public async startInclusion(): Promise<void> {
    this.ensureDriverReady();
    const zwave = await this.loadModule();
    const started = await this.driver.controller.beginInclusion({
      strategy: zwave.InclusionStrategy.Default,
      userCallbacks: this.createInclusionCallbacks(),
    });
    if (!started) {
      throw new Error("Failed to start inclusion or inclusion is already active.");
    }
    this.updateStatus({ isInclusionActive: true, isExclusionActive: false });
    this.publish({ type: "zwave.inclusion.started", payload: { portPath: this.status.connectedPortPath } });
  }

  public async stopInclusion(): Promise<void> {
    this.ensureDriverReady();
    await this.driver.controller.stopInclusion();
    this.updateStatus({ isInclusionActive: false });
    this.publish({ type: "zwave.inclusion.stopped", payload: {} });
  }

  public async startExclusion(): Promise<void> {
    this.ensureDriverReady();
    const zwave = await this.loadModule();
    const started = await this.driver.controller.beginExclusion({
      strategy: zwave.ExclusionStrategy.ExcludeOnly,
    });
    if (!started) {
      throw new Error("Failed to start exclusion or exclusion is already active.");
    }
    this.updateStatus({ isExclusionActive: true, isInclusionActive: false });
    this.publish({ type: "zwave.exclusion.started", payload: {} });
  }

  public async stopExclusion(): Promise<void> {
    this.ensureDriverReady();
    await this.driver.controller.stopExclusion();
    this.updateStatus({ isExclusionActive: false });
    this.publish({ type: "zwave.exclusion.stopped", payload: {} });
  }

  public async grantSecurity(requestId: string, payload: SecurityGrantInput): Promise<void> {
    const pending = this.pendingInclusionRequests.get(requestId);
    if (!pending || pending.type !== "grant_security_classes") {
      throw new Error(`Unknown security grant request: ${requestId}`);
    }
    this.pendingInclusionRequests.delete(requestId);
    pending.resolve({
      securityClasses: payload.grant.map((name) => SecurityClass[name]),
      clientSideAuth: payload.clientSideAuth,
    });
  }

  public async validateDsk(requestId: string, pin: string): Promise<void> {
    const pending = this.pendingInclusionRequests.get(requestId);
    if (!pending || pending.type !== "validate_dsk") {
      throw new Error(`Unknown DSK validation request: ${requestId}`);
    }
    this.pendingInclusionRequests.delete(requestId);
    pending.resolve(pin);
  }

  public async listNodes(): Promise<NodeSummary[]> {
    this.ensureDriverReady();
    return Array.from(this.driver.controller.nodes.values()).map((node: any) => this.toNodeSummary(node));
  }

  public async getNode(nodeId: number): Promise<NodeDetail> {
    this.ensureDriverReady();
    const node = this.driver.controller.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found.`);
    }
    return this.toNodeDetail(node);
  }

  public async refreshNode(nodeId: number): Promise<NodeDetail> {
    this.ensureDriverReady();
    const node = this.driver.controller.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found.`);
    }
    await node.refreshInfo();
    return this.toNodeDetail(node);
  }

  public async pingNode(nodeId: number): Promise<boolean> {
    this.ensureDriverReady();
    const node = this.driver.controller.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found.`);
    }
    return node.ping();
  }

  public async healNode(nodeId: number): Promise<unknown> {
    this.ensureDriverReady();
    const node = this.driver.controller.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found.`);
    }
    return node.checkLifelineHealth(3);
  }

  public async setValue(input: SetValueInput): Promise<void> {
    this.ensureDriverReady();
    const node = this.driver.controller.nodes.get(input.nodeId);
    if (!node) {
      throw new Error(`Node ${input.nodeId} not found.`);
    }
    await node.setValue(this.buildValueId(input.valueId), input.value);
  }

  public async invokeCcApi(input: InvokeCcApiInput): Promise<unknown> {
    this.ensureDriverReady();
    const node = this.driver.controller.nodes.get(input.nodeId);
    if (!node) {
      throw new Error(`Node ${input.nodeId} not found.`);
    }
    const endpoint = node.getEndpoint(input.endpoint ?? 0) ?? node;
    const cc = typeof input.commandClass === "number"
      ? input.commandClass
      : CommandClasses[input.commandClass as keyof typeof CommandClasses];
    if (cc == undefined) {
      throw new Error(`Unknown command class: ${String(input.commandClass)}`);
    }
    return endpoint.invokeCCAPI(cc, input.method, ...(input.args ?? []));
  }

  private async loadModule(): Promise<ZwaveModule> {
    this.modulePromise ??= import("zwave-js");
    return this.modulePromise;
  }

  private createDriverOptions(): Record<string, unknown> {
    const securityKeys = Object.fromEntries(
      Object.entries(this.appConfig.securityKeys)
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
        .map(([key, value]) => [key, Buffer.from(value, "hex")]),
    );

    return {
      storage: {
        cacheDir: this.appConfig.zwaveCacheDir,
        throttle: "normal",
        deviceConfigPriorityDir: this.appConfig.zwaveDeviceConfigDir,
      },
      securityKeys: Object.keys(securityKeys).length > 0 ? securityKeys : undefined,
      emitValueUpdateAfterSetValue: true,
    };
  }

  private createInclusionCallbacks(): Record<string, (...args: unknown[]) => Promise<unknown> | void> {
    return {
      grantSecurityClasses: async (requested: any) => {
        const requestId = createId("inc_req");
        this.publish({
          type: "zwave.inclusion.challenge",
          payload: {
            requestId,
            challengeType: "grant_security_classes",
            requested: requested.securityClasses.map((item: number) => this.getSecurityClassName(item)),
            clientSideAuth: requested.clientSideAuth,
          },
        });
        return new Promise((resolve) => {
          this.pendingInclusionRequests.set(requestId, { type: "grant_security_classes", resolve });
        });
      },
      validateDSKAndEnterPIN: async (...args: unknown[]) => {
        const dsk = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
        const requestId = createId("inc_req");
        this.publish({
          type: "zwave.inclusion.challenge",
          payload: {
            requestId,
            challengeType: "validate_dsk",
            dsk,
          },
        });
        return new Promise((resolve) => {
          this.pendingInclusionRequests.set(requestId, { type: "validate_dsk", resolve });
        });
      },
      abort: () => {
        this.pendingInclusionRequests.clear();
        this.publish({ type: "zwave.inclusion.challenge.aborted", payload: {} });
      },
    };
  }

  private attachDriverEvents(driver: any, zwave: ZwaveModule): void {
    driver.on("error", (error: unknown) => {
      this.updateStatus({
        phase: "error",
        hasReadyDriver: false,
        lastError: error instanceof Error ? error.message : String(error),
      });
      this.publish({
        type: "zwave.driver.log",
        payload: { level: "error", message: this.status.lastError },
      });
    });

    driver.on("driver ready", () => {
      this.updateStatus({
        phase: "ready",
        hasReadyDriver: true,
        controllerId: driver.controller?.ownNodeId,
        homeId: driver.controller?.homeId != undefined ? `0x${driver.controller.homeId.toString(16)}` : undefined,
      });
      this.publish({
        type: "zwave.status.changed",
        payload: this.status,
      });
    });

    driver.on("all nodes ready", () => {
      this.publish({ type: "zwave.controller.updated", payload: { nodesReady: true } });
    });

    driver.on("ready", (node: any) => {
      this.publish({ type: "zwave.node.updated", payload: this.toNodeDetail(node) });
    });

    driver.on("node added", (node: any, result: unknown) => {
      this.updateStatus({ isInclusionActive: false });
      this.publish({ type: "zwave.node.added", payload: { node: this.toNodeDetail(node), result } });
    });

    driver.on("node removed", (node: any, reason: unknown) => {
      this.publish({ type: "zwave.node.removed", payload: { nodeId: node.id, reason } });
    });

    const forwardValueEvent = (type: string) => (node: any, args: any) => {
      this.publish({ type, payload: { nodeId: node.id, ...args } });
    };

    driver.on("value added", forwardValueEvent("zwave.value.updated"));
    driver.on("value updated", forwardValueEvent("zwave.value.updated"));
    driver.on("value removed", forwardValueEvent("zwave.value.updated"));
    driver.on("metadata updated", forwardValueEvent("zwave.value.updated"));
    driver.on("notification", (node: any, ccId: number, args: unknown) => {
      this.publish({
        type: "zwave.driver.log",
        payload: {
          level: "info",
          message: `Notification from node ${node.id}`,
          ccId: this.getCommandClassName(ccId),
          args,
        },
      });
    });

    driver.controller.on?.("inclusion stopped", () => {
      this.updateStatus({ isInclusionActive: false });
      this.publish({ type: "zwave.inclusion.stopped", payload: {} });
    });

    driver.controller.on?.("exclusion stopped", () => {
      this.updateStatus({ isExclusionActive: false });
      this.publish({ type: "zwave.exclusion.stopped", payload: {} });
    });

    void zwave;
  }

  private buildValueId(valueId: ValueIdInput): ValueIdInput {
    return {
      commandClass: valueId.commandClass,
      endpoint: valueId.endpoint ?? 0,
      property: valueId.property,
      propertyKey: valueId.propertyKey,
    };
  }

  private toNodeSummary(node: any): NodeSummary {
    const detail = this.toNodeDetail(node);
    const { endpoints, values, ...summary } = detail;
    void endpoints;
    void values;
    return summary;
  }

  private toNodeDetail(node: any): NodeDetail {
    const endpoints = this.getEndpoints(node);
    const values = this.getValues(node);
    const commandClasses = Array.from(new Set(endpoints.flatMap((endpoint) => endpoint.commandClasses)));
    const securityClasses = this.getNodeSecurityClasses(node);

    return {
      nodeId: node.id,
      name: node.name,
      manufacturer: node.manufacturer || node.deviceConfig?.manufacturer,
      product: node.productLabel || node.deviceConfig?.label,
      productCode: node.productCode,
      firmwareVersion: node.firmwareVersion,
      status: node.status != undefined ? String(node.status) : undefined,
      interviewStage: node.interviewStage != undefined ? String(node.interviewStage) : undefined,
      securityClasses,
      isSecure: Boolean(node.isSecure),
      isListening: Boolean(node.isListening),
      lastSeenAt: node.lastSeen ? new Date(node.lastSeen).toISOString() : undefined,
      commandClasses,
      endpoints,
      values,
    };
  }

  private getEndpoints(node: any): EndpointSnapshot[] {
    const indices = typeof node.getEndpointIndizes === "function" ? node.getEndpointIndizes() : [0];
    return Array.from(new Set([0, ...indices]))
      .map((index) => node.getEndpoint(index) ?? (index === 0 ? node : undefined))
      .filter(Boolean)
      .map((endpoint: any) => ({
        index: endpoint.index ?? 0,
        label: endpoint.endpointLabel,
        commandClasses: Array.from(endpoint.implementedCommandClasses?.keys?.() ?? []).map((ccId) =>
          this.getCommandClassName(Number(ccId)),
        ),
      }));
  }

  private getValues(node: any): NodeValueSnapshot[] {
    if (typeof node.getDefinedValueIDs !== "function") {
      return [];
    }

    return node.getDefinedValueIDs().map((valueId: any) => {
      const metadata = node.getValueMetadata(valueId) ?? {};
      const timestamp = node.getValueTimestamp(valueId);
      return {
        nodeId: node.id,
        endpoint: valueId.endpoint ?? 0,
        commandClass: this.getCommandClassName(valueId.commandClass),
        property: String(valueId.property),
        propertyKey: valueId.propertyKey != undefined ? String(valueId.propertyKey) : undefined,
        value: node.getValue(valueId),
        unit: metadata.unit,
        label: metadata.label,
        lastUpdatedAt: timestamp ? new Date(timestamp).toISOString() : undefined,
        valueId: {
          commandClass: valueId.commandClass,
          endpoint: valueId.endpoint ?? 0,
          property: valueId.property,
          propertyKey: valueId.propertyKey,
        },
      } satisfies NodeValueSnapshot;
    });
  }

  private getNodeSecurityClasses(node: any): string[] {
    if (!node?.securityClasses) {
      return [];
    }

    if (Array.isArray(node.securityClasses)) {
      return node.securityClasses.map((item: number) => this.getSecurityClassName(item));
    }

    if (typeof node.securityClasses[Symbol.iterator] === "function") {
      return Array.from(node.securityClasses as Iterable<number>).map((item) => this.getSecurityClassName(item));
    }

    return [];
  }

  private getCommandClassName(commandClass: number): string {
    return CommandClasses[commandClass] ?? getCCName(commandClass) ?? `CC_${commandClass}`;
  }

  private getSecurityClassName(securityClass: number): string {
    return SecurityClass[securityClass] ?? String(securityClass);
  }

  private updateStatus(partial: Partial<DriverStatus>): void {
    Object.assign(this.status, partial, { updatedAt: nowIso() });
    this.publish({ type: "zwave.status.changed", payload: { ...this.status } });
  }

  private ensureDriverReady(): void {
    if (!this.driver || this.status.hasReadyDriver !== true) {
      throw new Error("Z-Wave driver is not ready.");
    }
  }

  private publish<T>(input: Omit<ZwaveEvent<T>, "timestamp">): void {
    this.emitter.emit("event", { ...input, timestamp: nowIso() } satisfies ZwaveEvent<T>);
  }

  private async safeDestroyDriver(): Promise<void> {
    if (!this.driver) {
      return;
    }
    const current = this.driver;
    this.driver = undefined;
    this.pendingInclusionRequests.clear();
    await current.destroy();
  }
}
