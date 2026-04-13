import { EventEmitter } from "node:events";
import { CommandClasses, SecurityClass, getCCName } from "@zwave-js/core";

import type { AppConfig } from "../../domain/config.js";
import type {
  DriverStatus,
  EndpointSnapshot,
  InclusionChallenge,
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
  private readonly publishedReadyNodeIds = new Set<number>();
  private readonly status: DriverStatus = {
    phase: "idle",
    isInclusionActive: false,
    isExclusionActive: false,
    hasReadyDriver: false,
    updatedAt: nowIso(),
  };

  private modulePromise?: Promise<ZwaveModule>;
  private driver?: any;
  private controllerEventsAttached = false;
  private inclusionChallenge: InclusionChallenge | null = null;
  private valueUpdateConsoleFilter?: (payload: { nodeId?: unknown; commandClass?: unknown }) => boolean;

  public constructor(private readonly appConfig: AppConfig) {}

  public onEvent(listener: (event: ZwaveEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  public setValueUpdateConsoleFilter(filter: (payload: { nodeId?: unknown; commandClass?: unknown }) => boolean): void {
    this.valueUpdateConsoleFilter = filter;
  }

  public async scanPorts(): Promise<SerialPortInfo[]> {
    return this.serialDiscovery.scanPorts();
  }

  public async connect(portPath: string): Promise<void> {
    if (this.driver) {
      this.log("warn", "[driver] Connect skipped because driver instance already exists", {
        portPath,
        phase: this.status.phase,
        connectedPortPath: this.status.connectedPortPath,
      });
      throw new Error("Z-Wave driver is already running.");
    }

    const zwave = await this.loadModule();
    this.publishedReadyNodeIds.clear();
    this.log("info", "[driver] Creating Z-Wave driver", {
      portPath,
      cacheDir: this.appConfig.zwaveCacheDir,
      deviceConfigDir: this.appConfig.zwaveDeviceConfigDir,
    });
    const driver = new zwave.Driver(portPath, this.createDriverOptions());

    this.driver = driver;
    this.controllerEventsAttached = false;
    this.updateStatus({
      phase: "connecting",
      selectedPortPath: portPath,
      connectedPortPath: portPath,
      hasReadyDriver: false,
      lastError: undefined,
    });

    this.attachDriverEvents(driver, zwave);

    try {
      this.log("info", "[driver] Starting Z-Wave driver", { portPath });
      await driver.start();
      this.updateStatus({
        phase: driver.ready ? "ready" : "connecting",
        connectedPortPath: portPath,
        selectedPortPath: portPath,
        hasReadyDriver: Boolean(driver.ready),
      });
      this.log("info", "[driver] Driver start returned", {
        portPath,
        ready: Boolean(driver.ready),
        phase: this.status.phase,
      });
    } catch (error) {
      await this.safeDestroyDriver();
      this.updateStatus({
        phase: "error",
        connectedPortPath: undefined,
        hasReadyDriver: false,
        lastError: error instanceof Error ? error.message : String(error),
      });
      this.log("error", "[driver] Driver start failed", {
        portPath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    if (!this.driver) {
      this.log("info", "[driver] Disconnect skipped because no driver instance exists");
      return;
    }
    this.log("info", "[driver] Destroying Z-Wave driver", {
      connectedPortPath: this.status.connectedPortPath,
    });
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
    this.log("info", "[driver] Driver destroyed");
  }

  public async reconnect(portPath: string): Promise<void> {
    await this.disconnect();
    await this.connect(portPath);
  }

  public async getStatus(): Promise<DriverStatus> {
    return { ...this.status };
  }

  public async getInclusionChallenge(): Promise<InclusionChallenge | null> {
    return this.inclusionChallenge ? { ...this.inclusionChallenge } : null;
  }

  public async startInclusion(): Promise<void> {
    this.ensureDriverReady();
    const zwave = await this.loadModule();
    this.log("info", "[include] Starting inclusion mode", {
      strategy: "Default",
      connectedPortPath: this.status.connectedPortPath,
    });
    const started = await this.driver.controller.beginInclusion({
      strategy: zwave.InclusionStrategy.Default,
      userCallbacks: this.createInclusionCallbacks(),
    });
    if (!started) {
      this.log("warn", "[include] Inclusion did not start", {
        connectedPortPath: this.status.connectedPortPath,
        reason: "already_active_or_rejected",
      });
      throw new Error("Failed to start inclusion or inclusion is already active.");
    }
    this.updateStatus({ isInclusionActive: true, isExclusionActive: false });
    this.log("info", "[include] Inclusion mode active", {
      connectedPortPath: this.status.connectedPortPath,
    });
    this.publish({ type: "zwave.inclusion.started", payload: { portPath: this.status.connectedPortPath } });
  }

  public async stopInclusion(): Promise<void> {
    this.ensureDriverReady();
    this.log("info", "[include] Stopping inclusion mode", {
      connectedPortPath: this.status.connectedPortPath,
    });
    await this.driver.controller.stopInclusion();
    this.updateStatus({ isInclusionActive: false });
    this.log("info", "[include] Inclusion mode stopped", {
      connectedPortPath: this.status.connectedPortPath,
    });
    this.publish({ type: "zwave.inclusion.stopped", payload: {} });
  }

  public async startExclusion(): Promise<void> {
    this.ensureDriverReady();
    const zwave = await this.loadModule();
    this.log("info", "[exclude] Starting exclusion mode", {
      strategy: "ExcludeOnly",
      connectedPortPath: this.status.connectedPortPath,
    });
    const started = await this.driver.controller.beginExclusion({
      strategy: zwave.ExclusionStrategy.ExcludeOnly,
    });
    if (!started) {
      this.log("warn", "[exclude] Exclusion did not start", {
        connectedPortPath: this.status.connectedPortPath,
        reason: "already_active_or_rejected",
      });
      throw new Error("Failed to start exclusion or exclusion is already active.");
    }
    this.updateStatus({ isExclusionActive: true, isInclusionActive: false });
    this.log("info", "[exclude] Exclusion mode active", {
      connectedPortPath: this.status.connectedPortPath,
    });
    this.publish({ type: "zwave.exclusion.started", payload: {} });
  }

  public async stopExclusion(): Promise<void> {
    this.ensureDriverReady();
    this.log("info", "[exclude] Stopping exclusion mode", {
      connectedPortPath: this.status.connectedPortPath,
    });
    await this.driver.controller.stopExclusion();
    this.updateStatus({ isExclusionActive: false });
    this.log("info", "[exclude] Exclusion mode stopped", {
      connectedPortPath: this.status.connectedPortPath,
    });
    this.publish({ type: "zwave.exclusion.stopped", payload: {} });
  }

  public async hardResetController(): Promise<void> {
    this.ensureDriverReady();
    this.log("warn", "[controller] Performing hard reset", {
      connectedPortPath: this.status.connectedPortPath,
      controllerId: this.status.controllerId,
      homeId: this.status.homeId,
    });
    this.pendingInclusionRequests.clear();
    this.inclusionChallenge = null;
    this.publishedReadyNodeIds.clear();
    this.controllerEventsAttached = false;
    this.updateStatus({
      phase: "connecting",
      hasReadyDriver: false,
      isInclusionActive: false,
      isExclusionActive: false,
      controllerId: undefined,
      homeId: undefined,
      lastError: undefined,
    });

    try {
      await this.driver.hardReset();
      this.log("warn", "[controller] Hard reset command accepted; waiting for reinitialization", {
        connectedPortPath: this.status.connectedPortPath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isExpectedHardResetTeardownError(error)) {
        this.log("warn", "[controller] Hard reset is tearing down the old controller instance", {
          error: message,
        });
        return;
      }
      this.log("error", "[controller] Hard reset failed", {
        error: message,
      });
      this.updateStatus({
        phase: this.driver?.ready ? "ready" : "error",
        hasReadyDriver: Boolean(this.driver?.ready),
        lastError: message,
      });
      throw error;
    }
  }

  public async grantSecurity(requestId: string, payload: SecurityGrantInput): Promise<void> {
    const pending = this.pendingInclusionRequests.get(requestId);
    if (!pending || pending.type !== "grant_security_classes") {
      throw new Error(`Unknown security grant request: ${requestId}`);
    }
    this.pendingInclusionRequests.delete(requestId);
    this.inclusionChallenge = null;
    this.log("info", "[security] Submitting granted security classes", {
      requestId,
      securityClasses: payload.grant,
      clientSideAuth: payload.clientSideAuth,
    });
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
    this.inclusionChallenge = null;
    this.log("info", "[dsk] Submitting DSK PIN for inclusion", {
      requestId,
      pinLength: pin.length,
    });
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
      logConfig: {
        enabled: true,
        level: "debug",
        forceConsole: true,
        logToFile: false,
        showLogo: false,
      },
      securityKeys: Object.keys(securityKeys).length > 0 ? securityKeys : undefined,
      emitValueUpdateAfterSetValue: true,
    };
  }

  private createInclusionCallbacks(): Record<string, (...args: unknown[]) => Promise<unknown> | void> {
    return {
      grantSecurityClasses: async (requested: any) => {
        const requestId = createId("inc_req");
        this.log("info", "[security] Received security class grant challenge", {
          requestId,
          requestedSecurityClasses: requested.securityClasses.map((item: number) => this.getSecurityClassName(item)),
          clientSideAuth: requested.clientSideAuth,
        });
        this.inclusionChallenge = {
          requestId,
          challengeType: "grant_security_classes",
          requested: requested.securityClasses.map((item: number) => this.getSecurityClassName(item)) as SecurityGrantInput["grant"],
          clientSideAuth: requested.clientSideAuth,
        };
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
        this.log("info", "[dsk] Received DSK validation challenge", {
          requestId,
          dsk,
        });
        this.inclusionChallenge = {
          requestId,
          challengeType: "validate_dsk",
          dsk,
        };
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
        this.log("warn", "[include] Inclusion challenge flow aborted by controller");
        this.inclusionChallenge = null;
        this.pendingInclusionRequests.clear();
        this.publish({ type: "zwave.inclusion.challenge.aborted", payload: {} });
      },
    };
  }

  private attachDriverEvents(driver: any, zwave: ZwaveModule): void {
    driver.on("error", (error: unknown) => {
      this.log("error", "[driver] Driver emitted error", {
        error: error instanceof Error ? error.message : String(error),
      });
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
      this.attachControllerEvents(driver);
      this.log("info", "[controller] Controller reported ready", {
        controllerId: driver.controller?.ownNodeId,
        homeId: driver.controller?.homeId != undefined ? `0x${driver.controller.homeId.toString(16)}` : undefined,
      });
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
      this.log("info", "[controller] All nodes ready", {
        nodeCount: driver.controller?.nodes?.size,
      });
      this.publish({ type: "zwave.controller.updated", payload: { nodesReady: true } });
    });

    driver.on("node interview completed", (node: any) => {
      this.log("info", "[node] Node interview completed", {
        nodeId: node.id,
        interviewStage: node.interviewStage != undefined ? String(node.interviewStage) : undefined,
        ready: Boolean(node.ready),
      });
      this.publishNodeUpdated(node);
      this.publishNodeReadyIfEligible(node, "interview_completed");
    });

    driver.on("node ready", (node: any) => {
      this.log("info", "[node] Node interview ready", {
        nodeId: node.id,
        interviewStage: node.interviewStage != undefined ? String(node.interviewStage) : undefined,
        status: node.status != undefined ? String(node.status) : undefined,
      });
      this.publishNodeUpdated(node);
      this.publishNodeReadyIfEligible(node, "ready");
    });

    const forwardValueEvent = (type: string, message: string) => (node: any, args: any) => {
      const payload = {
        nodeId: node.id,
        ...this.summarizeValueArgs(args),
      };
      if (this.valueUpdateConsoleFilter?.(payload) ?? true) {
        this.log("info", message, payload);
      }
      this.publish({ type, payload: { nodeId: node.id, ...args } });
    };

    driver.on("node value added", forwardValueEvent("zwave.value.updated", "[value] Value added"));
    driver.on("node value updated", forwardValueEvent("zwave.value.updated", "[value] Value updated"));
    driver.on("node value removed", forwardValueEvent("zwave.value.updated", "[value] Value removed"));
    driver.on("node metadata updated", forwardValueEvent("zwave.value.updated", "[value] Metadata updated"));
    driver.on("node notification", (node: any, ccId: number, args: unknown) => {
      this.log("info", "[notify] Notification received", {
        nodeId: node.id,
        commandClass: this.getCommandClassName(ccId),
        args: this.summarizeUnknown(args),
      });
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

    void zwave;
  }

  private attachControllerEvents(driver: any): void {
    if (this.controllerEventsAttached) {
      return;
    }

    const controller = driver.controller;
    controller.on?.("inclusion stopped", () => {
      this.updateStatus({ isInclusionActive: false });
      this.inclusionChallenge = null;
      this.log("info", "[include] Controller reported inclusion stopped");
      this.publish({ type: "zwave.inclusion.stopped", payload: {} });
    });

    controller.on?.("node found", (payload: any) => {
      const nodeId =
        payload?.node?.id ??
        payload?.node?.nodeId ??
        payload?.nodeId;
      this.log("info", "[include] Controller found candidate node", {
        nodeId,
      });
      this.publish({ type: "zwave.node.found", payload: { nodeId } });
    });

    controller.on?.("node added", (node: any, result: unknown) => {
      this.log("info", "[node] Node added", {
        nodeId: node.id,
        result: this.summarizeUnknown(result),
      });
      this.inclusionChallenge = null;
      this.updateStatus({ isInclusionActive: false });
      this.publish({ type: "zwave.node.added", payload: { node: this.toNodeDetail(node), result } });
      this.publishNodeUpdated(node);
      this.publishNodeReadyIfEligible(node, "node_added");
    });

    controller.on?.("node removed", (node: any, reason: unknown) => {
      this.log("warn", "[node] Node removed", {
        nodeId: node.id,
        reason,
      });
      this.publishedReadyNodeIds.delete(node.id);
      this.publish({ type: "zwave.node.removed", payload: { nodeId: node.id, reason } });
    });

    controller.on?.("exclusion stopped", () => {
      this.updateStatus({ isExclusionActive: false });
      this.inclusionChallenge = null;
      this.log("info", "[exclude] Controller reported exclusion stopped");
      this.publish({ type: "zwave.exclusion.stopped", payload: {} });
    });

    this.controllerEventsAttached = true;
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
      deviceType: this.getNodeDeviceType(node),
      manufacturer: node.manufacturer || node.deviceConfig?.manufacturer,
      product: node.productLabel || node.deviceConfig?.label,
      productCode: node.productCode,
      firmwareVersion: node.firmwareVersion,
      status: node.status != undefined ? String(node.status) : undefined,
      interviewStage: node.interviewStage != undefined ? String(node.interviewStage) : undefined,
      ready: Boolean(node.ready),
      securityClasses,
      isSecure: Boolean(node.isSecure),
      isListening: Boolean(node.isListening),
      lastSeenAt: node.lastSeen ? new Date(node.lastSeen).toISOString() : undefined,
      commandClasses,
      endpoints,
      values,
    };
  }

  private getNodeDeviceType(node: any): string | undefined {
    const specificLabel = node?.deviceClass?.specific?.label;
    if (typeof specificLabel === "string" && specificLabel.trim() && specificLabel !== "Unused") {
      return specificLabel.trim();
    }

    const genericLabel = node?.deviceClass?.generic?.label;
    if (typeof genericLabel === "string" && genericLabel.trim()) {
      return genericLabel.trim();
    }

    if (node?.id === this.status.controllerId) {
      return "Controller";
    }

    return undefined;
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

  private summarizeValueArgs(args: any): Record<string, unknown> {
    if (!args || typeof args !== "object") {
      return { payload: this.summarizeUnknown(args) };
    }

    return {
      commandClass: args.commandClass != undefined ? this.getCommandClassName(Number(args.commandClass)) : undefined,
      endpoint: args.endpoint ?? 0,
      property: args.property != undefined ? String(args.property) : undefined,
      propertyKey: args.propertyKey != undefined ? String(args.propertyKey) : undefined,
      newValue: "newValue" in args ? this.summarizeUnknown(args.newValue) : undefined,
      prevValue: "prevValue" in args ? this.summarizeUnknown(args.prevValue) : undefined,
      internal: "internal" in args ? Boolean(args.internal) : undefined,
    };
  }

  private summarizeUnknown(input: unknown): unknown {
    if (input == undefined || typeof input === "number" || typeof input === "boolean") {
      return input;
    }
    if (typeof input === "string") {
      return input.length > 160 ? `${input.slice(0, 157)}...` : input;
    }
    try {
      const json = JSON.stringify(input);
      return json.length > 240 ? `${json.slice(0, 237)}...` : JSON.parse(json);
    } catch {
      return String(input);
    }
  }

  private updateStatus(partial: Partial<DriverStatus>): void {
    Object.assign(this.status, partial, { updatedAt: nowIso() });
    this.publish({ type: "zwave.status.changed", payload: { ...this.status } });
  }

  private isExpectedHardResetTeardownError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }
    const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
    const message = error instanceof Error ? error.message : String(error);
    return code === "Driver_TaskRemoved" || message.includes("controller instance is being destroyed");
  }

  private publishNodeUpdated(node: any): void {
    this.publish({ type: "zwave.node.updated", payload: this.toNodeDetail(node) });
  }

  private publishNodeReadyIfEligible(node: any, source: string): void {
    const detail = this.toNodeDetail(node);
    const interviewComplete = Boolean(detail.ready) || String(detail.interviewStage ?? "").toLowerCase() === "complete";
    if (!interviewComplete) {
      return;
    }
    if (this.publishedReadyNodeIds.has(detail.nodeId)) {
      return;
    }
    this.publishedReadyNodeIds.add(detail.nodeId);
    this.log("info", "[node] Publishing node ready event", {
      nodeId: detail.nodeId,
      source,
      interviewStage: detail.interviewStage,
      ready: detail.ready,
    });
    this.publish({ type: "zwave.node.ready", payload: detail });
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
    this.controllerEventsAttached = false;
    this.publishedReadyNodeIds.clear();
    this.pendingInclusionRequests.clear();
    this.inclusionChallenge = null;
    await current.destroy();
  }

  private log(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void {
    const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
    console[level](`[zwave-adapter] ${message}${suffix}`);
  }
}
