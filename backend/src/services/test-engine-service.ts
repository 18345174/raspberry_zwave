import type {
  CreateTestReportInput,
  CreateTestRunInput,
  NodeDetail,
  TestLogRecord,
  TestReportRecord,
  TestReportSummary,
  TestRunRecord,
  TestRunStatus,
} from "../domain/types.js";
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
    const liveNode = await this.tryReadLiveNode(nodeId);
    const supportedCcNode = await this.tryReadSupportedCommandClasses(nodeId);

    return executableDefinitions
      .filter((definition) => {
        for (const candidate of [node, liveNode, supportedCcNode]) {
          if (!candidate) {
            continue;
          }

          if (definition.supports(candidate).supported) {
            return true;
          }
        }
        return false;
      })
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

  public createReport(input: CreateTestReportInput): TestReportSummary {
    const record: TestReportRecord = {
      id: createId("test_report"),
      nodeId: input.nodeId,
      title: input.title,
      status: input.status,
      createdAt: nowIso(),
      sourceRunIds: input.sourceRunIds,
      summaryJson: input.summaryJson,
      htmlContent: input.htmlContent,
      csvContent: input.csvContent,
    };

    this.storage.createTestReport(record);
    return this.storage.listTestReports(record.nodeId).find((item) => item.id === record.id) ?? {
      id: record.id,
      nodeId: record.nodeId,
      title: record.title,
      status: record.status,
      createdAt: record.createdAt,
      sourceRunIds: record.sourceRunIds,
      summaryJson: record.summaryJson,
    };
  }

  public listReports(nodeId?: number): TestReportSummary[] {
    return this.storage.listTestReports(nodeId);
  }

  public getReport(reportId: string): TestReportRecord | undefined {
    return this.storage.getTestReport(reportId);
  }

  public deleteReport(reportId: string): boolean {
    return this.storage.deleteTestReport(reportId);
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
    const blockingRun = this.findBlockingRun();
    if (blockingRun) {
      throw new Error(`已有测试正在执行，请等待当前测试结束后再继续：${blockingRun.testDefinitionId} (${blockingRun.id})`);
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

    let node = await this.requireNode(input.nodeId);
    let support = definition.supports(node);
    if (!support.supported) {
      const liveNode = await this.tryReadLiveNode(input.nodeId);
      if (liveNode) {
        node = liveNode;
        support = definition.supports(node);
      }
    }
    if (!support.supported) {
      const supportedCcNode = await this.tryReadSupportedCommandClasses(input.nodeId);
      if (supportedCcNode) {
        node = supportedCcNode;
        support = definition.supports(node);
      }
    }
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

  public async submitRunUserAction(runId: string, payload: { promptKey: string; action: string }): Promise<void> {
    const run = this.storage.getTestRun(runId);
    if (!run) {
      throw new Error(`Unknown test run: ${runId}`);
    }
    if (run.status !== "queued" && run.status !== "running") {
      throw new Error("The selected test run is not awaiting user interaction.");
    }

    this.eventBus.publish({
      type: "test.run.user-action",
      timestamp: nowIso(),
      payload: {
        runId,
        promptKey: payload.promptKey,
        action: payload.action,
      },
    });
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
    console.info(`[test-engine] [run:${runId}] 已开始执行测试`, JSON.stringify({
      nodeId: run.nodeId,
      testDefinitionId: run.testDefinitionId,
    }));

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
          const suffix = payload ? ` ${JSON.stringify(payload)}` : "";
          console[level](`[test-engine] [run:${runId}] [${stepKey}] ${message}${suffix}`);
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
        waitForEvent: async (match) => {
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
              if (event.type !== match.type || !event.payload || typeof event.payload !== "object") {
                return;
              }

              const payload = event.payload as Record<string, unknown>;
              if (match.predicate && !match.predicate(payload)) {
                return;
              }

              settle(() => resolve(payload));
            });

            const timeoutId = setTimeout(() => {
              settle(() => reject(new Error(`Timeout while waiting for event ${match.type}.`)));
            }, match.timeoutMs);

            const cancelCheckId = setInterval(() => {
              if (this.cancellationFlags.has(runId)) {
                settle(() => reject(new Error(`Test run cancelled while waiting for event ${match.type}.`)));
              }
            }, 200);
          });
        },
        waitForSkippableEvent: async (match) => {
          return await new Promise<{ kind: "event" | "action"; payload: Record<string, unknown> }>((resolve, reject) => {
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
              if (event.type === match.type && event.payload && typeof event.payload === "object") {
                const payload = event.payload as Record<string, unknown>;
                if (match.eventPredicate && !match.eventPredicate(payload)) {
                  return;
                }
                settle(() => resolve({ kind: "event", payload }));
                return;
              }

              if (event.type === "test.run.user-action" && event.payload && typeof event.payload === "object") {
                const payload = event.payload as Record<string, unknown>;
                if (payload.runId !== runId) {
                  return;
                }
                if (match.actionPredicate && !match.actionPredicate(payload)) {
                  return;
                }
                settle(() => resolve({ kind: "action", payload }));
              }
            });

            const timeoutId = setTimeout(() => {
              settle(() => reject(new Error(`Timeout while waiting for event ${match.type}.`)));
            }, match.timeoutMs);

            const cancelCheckId = setInterval(() => {
              if (this.cancellationFlags.has(runId)) {
                settle(() => reject(new Error(`Test run cancelled while waiting for event ${match.type}.`)));
              }
            }, 200);
          });
        },
        waitForMatchingSignal: async (match) => {
          return await new Promise<{ kind: "event" | "action"; eventType?: string; payload: Record<string, unknown> }>((resolve, reject) => {
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
              if (event.payload && typeof event.payload === "object") {
                const payload = event.payload as Record<string, unknown>;
                const matchedEvent = match.events.find((candidate) => {
                  if (event.type !== candidate.type) {
                    return false;
                  }
                  return candidate.predicate ? candidate.predicate(payload) : true;
                });

                if (matchedEvent) {
                  settle(() => resolve({ kind: "event", eventType: matchedEvent.type, payload }));
                  return;
                }
              }

              if (event.type === "test.run.user-action" && event.payload && typeof event.payload === "object") {
                const payload = event.payload as Record<string, unknown>;
                if (payload.runId !== runId) {
                  return;
                }
                if (match.actionPredicate && !match.actionPredicate(payload)) {
                  return;
                }
                settle(() => resolve({ kind: "action", payload }));
              }
            });

            const timeoutId = setTimeout(() => {
              const eventTypes = match.events.map((event) => event.type).join(", ");
              settle(() => reject(new Error(`Timeout while waiting for signal ${eventTypes}.`)));
            }, match.timeoutMs);

            const cancelCheckId = setInterval(() => {
              if (this.cancellationFlags.has(runId)) {
                settle(() => reject(new Error("Test run cancelled while waiting for signal.")));
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
      console.info(`[test-engine] [run:${runId}] 最终测试结果：通过`, JSON.stringify({
        nodeId: run.nodeId,
        testDefinitionId: run.testDefinitionId,
      }));
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
      console[run.status === "cancelled" ? "warn" : "error"](
        `[test-engine] [run:${runId}] 最终测试结果：${run.status === "cancelled" ? "已取消" : "失败"} ${error instanceof Error ? error.message : String(error)}`,
      );
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

  private findBlockingRun(): TestRunRecord | undefined {
    if (this.activeRunId) {
      const activeRun = this.storage.getTestRun(this.activeRunId);
      if (activeRun && (activeRun.status === "queued" || activeRun.status === "running")) {
        return activeRun;
      }
    }

    return this.storage.listTestRuns().find((run) => run.status === "queued" || run.status === "running");
  }

  private async tryReadLiveNode(nodeId: number): Promise<NodeDetail | undefined> {
    try {
      const node = await this.zwaveRuntime.getNode(nodeId);
      this.storage.upsertNodeSnapshot(node);
      return node;
    } catch {
      return undefined;
    }
  }

  private async tryReadSupportedCommandClasses(nodeId: number): Promise<NodeDetail | undefined> {
    try {
      return await this.nodeRegistry.readSupportedCommandClasses(nodeId);
    } catch {
      return undefined;
    }
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
    console.warn(`[test-engine] [run:${run.id}] 最终测试结果：已取消 ${reason}`);
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
