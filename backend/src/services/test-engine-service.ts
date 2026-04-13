import type { CreateTestRunInput, NodeDetail, TestLogRecord, TestRunRecord, TestRunStatus } from "../domain/types.js";
import { CommandClasses, getCCName } from "@zwave-js/core";
import { DatabaseService } from "../storage/database.js";
import { EventBus } from "./event-bus.js";
import { NodeRegistryService } from "./node-registry-service.js";
import { ZwaveRuntimeService } from "./zwave-runtime-service.js";
import { createId } from "../utils/id.js";
import { durationMs, nowIso } from "../utils/time.js";
import { executableDefinitions } from "../test-engine/registry.js";

export class TestEngineService {
  private activeRunId?: string;
  private activeTraceContext?: {
    nodeId: number;
    commandClasses?: string[];
  };
  private readonly cancellationFlags = new Set<string>();

  public constructor(
    private readonly storage: DatabaseService,
    private readonly eventBus: EventBus,
    private readonly nodeRegistry: NodeRegistryService,
    private readonly zwaveRuntime: ZwaveRuntimeService,
  ) {
    this.storage.saveTestDefinitions(executableDefinitions.map((definition) => definition.meta));
    this.recoverInterruptedRuns();
  }

  public listDefinitions() {
    return this.storage.listTestDefinitions();
  }

  public getDefinition(id: string) {
    return this.storage.getTestDefinition(id);
  }

  public async listSupportedDefinitions(nodeId: number) {
    const node = await this.requireNode(nodeId);
    return executableDefinitions
      .filter((definition) => definition.supports(node).supported)
      .map((definition) => definition.meta);
  }

  public listRuns(): TestRunRecord[] {
    return this.storage.listTestRuns();
  }

  public getRun(runId: string): TestRunRecord | undefined {
    return this.storage.getTestRun(runId);
  }

  public getRunLogs(runId: string): TestLogRecord[] {
    return this.storage.listTestLogs(runId);
  }

  public getActiveRunId(): string | undefined {
    return this.activeRunId;
  }

  public shouldConsoleLogValueUpdate(payload: { nodeId?: unknown; commandClass?: unknown }): boolean {
    if (!this.activeTraceContext) {
      return true;
    }

    if (payload.nodeId !== this.activeTraceContext.nodeId) {
      return false;
    }

    if (!this.activeTraceContext.commandClasses?.length) {
      return true;
    }

    const normalizedCommandClass = this.normalizeCommandClass(payload.commandClass);
    return this.activeTraceContext.commandClasses.some((item) => this.normalizeCommandClass(item) === normalizedCommandClass);
  }

  public async createRun(input: CreateTestRunInput): Promise<TestRunRecord> {
    if (this.activeRunId) {
      throw new Error("Only one formal test run is allowed at a time.");
    }

    const runtimeStatus = await this.zwaveRuntime.getStatus();
    if (!runtimeStatus.hasReadyDriver) {
      throw new Error("Z-Wave driver is not ready.");
    }
    if (runtimeStatus.isInclusionActive || runtimeStatus.isExclusionActive) {
      throw new Error("Formal tests are blocked while inclusion or exclusion is active.");
    }

    const definition = executableDefinitions.find((item) => item.meta.id === input.testDefinitionId);
    if (!definition) {
      throw new Error(`Unknown test definition: ${input.testDefinitionId}`);
    }

    const node = await this.requireNode(input.nodeId);
    const support = definition.supports(node);
    if (!support.supported) {
      throw new Error(support.reason ?? "The selected node does not support this test.");
    }

    const run: TestRunRecord = {
      id: createId("test_run"),
      testDefinitionId: input.testDefinitionId,
      nodeId: input.nodeId,
      status: "queued",
    };

    this.storage.createTestRun(run);
    this.eventBus.publish({ type: "test.run.created", timestamp: nowIso(), payload: run });
    void this.executeRun(run.id, input.inputs, definition.meta.id);
    return run;
  }

  public async cancelRun(runId: string): Promise<void> {
    const run = this.storage.getTestRun(runId);
    if (!run) {
      throw new Error(`Unknown test run: ${runId}`);
    }
    if (run.status === "passed" || run.status === "failed" || run.status === "cancelled") {
      return;
    }

    if (!this.activeRunId || this.activeRunId !== runId) {
      this.markRunCancelled(run, "Run cancelled before execution completed.");
      return;
    }

    this.cancellationFlags.add(runId);
  }

  private async executeRun(runId: string, inputs: Record<string, unknown>, definitionId: string): Promise<void> {
    const definition = executableDefinitions.find((item) => item.meta.id === definitionId);
    const run = this.storage.getTestRun(runId);
    if (!definition || !run) {
      return;
    }
    if (run.status === "cancelled") {
      return;
    }

    const startedMs = Date.now();
    this.activeRunId = runId;
    this.activeTraceContext = {
      nodeId: run.nodeId,
      commandClasses: definition.traceCommandClasses,
    };
    run.status = "running";
    run.startedAt = nowIso();
    this.storage.updateTestRun(run);
    this.eventBus.publish({ type: "test.run.started", timestamp: nowIso(), payload: run });

    try {
      let currentNode = await this.requireNode(run.nodeId);
      const result = await definition.run({
        runId,
        definition: definition.meta,
        node: currentNode,
        inputs,
        log: async (level, stepKey, message, payload) => {
          const log: TestLogRecord = {
            id: createId("test_log"),
            testRunId: runId,
            timestamp: nowIso(),
            level,
            stepKey,
            message,
            payloadJson: payload,
          };
          this.storage.appendTestLog(log);
          this.eventBus.publish({ type: "test.run.log", timestamp: log.timestamp, payload: log });
        },
        refreshNode: async () => {
          currentNode = await this.nodeRegistry.refreshNode(run.nodeId);
          return currentNode;
        },
        setValue: async (input) => {
          await this.zwaveRuntime.setValue({
            nodeId: run.nodeId,
            valueId: {
              commandClass: input.commandClass,
              endpoint: input.endpoint,
              property: input.property,
              propertyKey: input.propertyKey,
            },
            value: input.value,
          });
        },
        invokeCcApi: async (input) => {
          return this.zwaveRuntime.invokeCcApi({
            nodeId: run.nodeId,
            endpoint: input.endpoint,
            commandClass: input.commandClass,
            method: input.method,
            args: input.args,
          });
        },
        pingNode: async () => this.zwaveRuntime.pingNode(run.nodeId),
        checkNodeHealth: async () => this.zwaveRuntime.healNode(run.nodeId),
        waitForValueUpdate: async (match) => {
          return await new Promise<Record<string, unknown>>((resolve, reject) => {
            let settled = false;

            const cleanup = (): void => {
              unsubscribe();
              clearTimeout(timeoutId);
              clearInterval(cancelCheckId);
            };

            const settle = (handler: () => void): void => {
              if (settled) {
                return;
              }
              settled = true;
              cleanup();
              handler();
            };

            const unsubscribe = this.eventBus.subscribe((event) => {
              if (event.type !== "zwave.value.updated" || !event.payload || typeof event.payload !== "object") {
                return;
              }

              const payload = event.payload as Record<string, unknown>;
              if (!this.matchesValueUpdatePayload(run.nodeId, payload, match)) {
                return;
              }

              settle(() => resolve(payload));
            });

            const timeoutId = setTimeout(() => {
              settle(() => reject(new Error(`Timeout while waiting for ${match.commandClass}.${match.property} update.`)));
            }, match.timeoutMs);

            const cancelCheckId = setInterval(() => {
              if (this.cancellationFlags.has(runId)) {
                settle(() => reject(new Error("Test run cancelled while waiting for value update.")));
              }
            }, 200);
          });
        },
        wait: async (ms) => {
          await new Promise((resolve) => setTimeout(resolve, ms));
        },
        isCancelled: () => this.cancellationFlags.has(runId),
      });

      run.status = this.cancellationFlags.has(runId) ? "cancelled" : "passed";
      run.finishedAt = nowIso();
      run.durationMs = durationMs(startedMs);
      run.summaryJson = {
        status: run.status,
        nodeId: run.nodeId,
        testDefinitionId: run.testDefinitionId,
      };
      run.resultJson = result;
    } catch (error) {
      run.status = this.cancellationFlags.has(runId) ? "cancelled" : "failed";
      run.finishedAt = nowIso();
      run.durationMs = durationMs(startedMs);
      run.summaryJson = {
        status: run.status,
        message: error instanceof Error ? error.message : String(error),
      };
      run.resultJson = {
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.cancellationFlags.delete(runId);
      this.activeRunId = undefined;
      this.activeTraceContext = undefined;
      this.storage.updateTestRun(run);
      this.eventBus.publish({ type: "test.run.finished", timestamp: nowIso(), payload: run });
    }
  }

  private async requireNode(nodeId: number): Promise<NodeDetail> {
    const node = await this.nodeRegistry.getNode(nodeId);
    if (!node) {
      const refreshed = await this.zwaveRuntime.getNode(nodeId);
      this.storage.upsertNodeSnapshot(refreshed);
      return refreshed;
    }
    return node;
  }

  private recoverInterruptedRuns(): void {
    for (const run of this.storage.listTestRuns()) {
      if (run.status === "queued" || run.status === "running") {
        this.markRunCancelled(run, "Run interrupted by service restart.");
      }
    }
  }

  private markRunCancelled(run: TestRunRecord, reason: string): void {
    run.status = "cancelled";
    run.finishedAt = run.finishedAt ?? nowIso();
    if (run.startedAt) {
      run.durationMs = durationMs(Date.parse(run.startedAt));
    }
    run.summaryJson = {
      status: run.status,
      message: reason,
    };
    run.resultJson = {
      cancelled: true,
      reason,
    };
    this.storage.updateTestRun(run);
    this.eventBus.publish({ type: "test.run.finished", timestamp: nowIso(), payload: run });
  }

  private matchesValueUpdatePayload(
    nodeId: number,
    payload: Record<string, unknown>,
    match: {
      commandClass: string;
      property: string;
      endpoint?: number;
      propertyKey?: string;
      predicate?: (payload: Record<string, unknown>) => boolean;
    },
  ): boolean {
    if (payload.nodeId !== nodeId) {
      return false;
    }

    if (this.normalizeCommandClass(payload.commandClass) !== this.normalizeCommandClass(match.commandClass)) {
      return false;
    }

    if (String(payload.property ?? "") !== match.property) {
      return false;
    }

    if ((payload.endpoint ?? 0) !== (match.endpoint ?? 0)) {
      return false;
    }

    if ((payload.propertyKey != undefined ? String(payload.propertyKey) : undefined) !== match.propertyKey) {
      return false;
    }

    return match.predicate ? match.predicate(payload) : true;
  }

  private normalizeCommandClass(commandClass: unknown): string {
    if (typeof commandClass === "number") {
      return String(CommandClasses[commandClass] ?? getCCName(commandClass) ?? commandClass);
    }
    if (typeof commandClass === "string") {
      return commandClass;
    }
    return "";
  }
}
