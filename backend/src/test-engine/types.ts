import type { CreateTestRunInput, NodeDetail, TestDefinition } from "../domain/types.js";

export interface TestExecutionContext {
  runId: string;
  definition: TestDefinition;
  node: NodeDetail;
  inputs: Record<string, unknown>;
  log(level: "info" | "warn" | "error", stepKey: string, message: string, payload?: Record<string, unknown>): Promise<void>;
  refreshNode(): Promise<NodeDetail>;
  setValue(input: {
    endpoint?: number;
    commandClass: string | number;
    property: string | number;
    propertyKey?: string | number;
    value: unknown;
  }): Promise<void>;
  invokeCcApi(input: {
    endpoint?: number;
    commandClass: string | number;
    method: string;
    args?: unknown[];
  }): Promise<unknown>;
  pingNode(): Promise<boolean>;
  checkNodeHealth(): Promise<unknown>;
  wait(ms: number): Promise<void>;
  isCancelled(): boolean;
}

export interface ExecutableTestDefinition {
  meta: TestDefinition;
  supports(node: NodeDetail): { supported: boolean; reason?: string };
  run(context: TestExecutionContext): Promise<Record<string, unknown>>;
}

export type CreateTestRunRequest = CreateTestRunInput;
