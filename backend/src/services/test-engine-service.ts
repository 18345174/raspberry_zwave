import type { CreateTestRunInput, NodeDetail, TestLogRecord, TestRunRecord, TestRunStatus } from "../domain/types.js";
import { DatabaseService } from "../storage/database.js";
import { EventBus } from "./event-bus.js";
import { NodeRegistryService } from "./node-registry-service.js";
import { ZwaveRuntimeService } from "./zwave-runtime-service.js";
import { createId } from "../utils/id.js";
import { durationMs, nowIso } from "../utils/time.js";
import { executableDefinitions } from "../test-engine/registry.js";

export class TestEngineService {
  private activeRunId?: string;
  private readonly cancellationFlags = new Set<string>();

  public constructor(
    private readonly storage: DatabaseService,
    private readonly eventBus: EventBus,
    private readonly nodeRegistry: NodeRegistryService,
    private readonly zwaveRuntime: ZwaveRuntimeService,
  ) {
    this.storage.saveTestDefinitions(executableDefinitions.map((definition) => definition.meta));
  }

  public listDefinitions() {
    return this.storage.listTestDefinitions();
  }

  public getDefinition(id: string) {
    return this.storage.getTestDefinition(id);
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
    this.cancellationFlags.add(runId);
  }

  private async executeRun(runId: string, inputs: Record<string, unknown>, definitionId: string): Promise<void> {
    const definition = executableDefinitions.find((item) => item.meta.id === definitionId);
    const run = this.storage.getTestRun(runId);
    if (!definition || !run) {
      return;
    }

    const startedMs = Date.now();
    this.activeRunId = runId;
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
}
