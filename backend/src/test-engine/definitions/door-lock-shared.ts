import { DoorLockMode } from "zwave-js";

import type { TestExecutionContext } from "../types.js";

export interface DoorLockStatusSnapshot {
  currentMode?: number;
  targetMode?: number;
  boltStatus?: string;
  duration?: unknown;
  outsideHandlesCanOpenDoor?: unknown;
  insideHandlesCanOpenDoor?: unknown;
  latchStatus?: unknown;
  doorStatus?: unknown;
}

export interface DoorLockCommandResult {
  status: DoorLockStatusSnapshot | undefined;
  report?: Record<string, unknown>;
  confirmation: "event" | "poll";
}

export function isUnlocked(mode: number | undefined): boolean {
  return mode != undefined && mode !== DoorLockMode.Secured && mode !== DoorLockMode.Unknown;
}

export function isBoltUnlocked(status: unknown): boolean | undefined {
  if (typeof status !== "string") {
    return undefined;
  }

  if (status === "unlocked") {
    return true;
  }
  if (status === "locked") {
    return false;
  }

  return undefined;
}

export function isModeMatched(mode: number | undefined, targetMode: DoorLockMode): boolean {
  if (mode == undefined) {
    return true;
  }
  if (targetMode === DoorLockMode.Unsecured) {
    return isUnlocked(mode);
  }
  return mode === targetMode;
}

export function expectedBoltStatus(targetMode: DoorLockMode): "locked" | "unlocked" {
  return targetMode === DoorLockMode.Unsecured ? "unlocked" : "locked";
}

export function describeBoltStatus(status: string | undefined): string {
  if (status === "locked") {
    return "已关锁";
  }
  if (status === "unlocked") {
    return "已开锁";
  }
  return status ?? "未知";
}

export async function readDoorLockCapabilities(context: TestExecutionContext): Promise<Record<string, unknown> | undefined> {
  return await context.invokeCcApi({ commandClass: "Door Lock", method: "getCapabilities" }) as Record<string, unknown> | undefined;
}

export async function readDoorLockStatus(context: TestExecutionContext): Promise<DoorLockStatusSnapshot | undefined> {
  return await context.invokeCcApi({ commandClass: "Door Lock", method: "get" }) as DoorLockStatusSnapshot | undefined;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBoltStatusTimeout(error: unknown): boolean {
  return formatErrorMessage(error).includes("Timeout while waiting for Door Lock.boltStatus update.");
}

export async function performDoorLockCommand(
  context: TestExecutionContext,
  options: {
    phaseKey: string;
    actionLabel: string;
    targetMode: DoorLockMode;
    expectedStatus: "locked" | "unlocked";
    reportTimeoutMs: number;
    successMessage: string;
    failureMessage: string;
  },
): Promise<DoorLockCommandResult> {
  const reportPromise = context.waitForValueUpdate({
    commandClass: "Door Lock",
    property: "boltStatus",
    timeoutMs: options.reportTimeoutMs,
    predicate: (payload) => String(payload.newValue ?? "") === options.expectedStatus,
  });

  await context.log("info", `${options.phaseKey}.command`, `发送${options.actionLabel}命令`, {
    targetMode: options.targetMode,
    expectedBoltStatus: options.expectedStatus,
  });
  await context.invokeCcApi({
    commandClass: "Door Lock",
    method: "set",
    args: [options.targetMode],
  });

  let confirmation: DoorLockCommandResult["confirmation"] = "event";
  let report: Record<string, unknown> | undefined;

  try {
    report = await reportPromise;
    await context.log("info", `${options.phaseKey}.report`, `已在 ${options.reportTimeoutMs}ms 内收到目标上报`, report);
  } catch (error) {
    if (!isBoltStatusTimeout(error)) {
      await context.log("error", `${options.phaseKey}.assert`, `${options.failureMessage}（${formatErrorMessage(error)}）`);
      throw error;
    }

    confirmation = "poll";
    await context.log("warn", `${options.phaseKey}.fallback`, `未在 ${options.reportTimeoutMs}ms 内收到 boltStatus 目标上报，改为主动查询门锁状态`, {
      expectedBoltStatus: options.expectedStatus,
      targetMode: options.targetMode,
    });
  }

  try {
    const status = await readDoorLockStatus(context);
    if (confirmation === "poll") {
      await context.log("info", `${options.phaseKey}.fallback`, "主动查询门锁状态完成", status as Record<string, unknown> | undefined);
    }

    if (status?.boltStatus !== options.expectedStatus) {
      throw new Error(`当前 boltStatus 为 ${describeBoltStatus(status?.boltStatus)}，期望 ${describeBoltStatus(options.expectedStatus)}。`);
    }
    if (!isModeMatched(status.currentMode, options.targetMode)) {
      throw new Error(`当前 currentMode=${String(status.currentMode)}，未达到目标模式 ${options.targetMode}。`);
    }

    await context.log(
      "info",
      `${options.phaseKey}.assert`,
      confirmation === "event" ? options.successMessage : `${options.successMessage}（主动查询确认）`,
      {
        ...status,
        reportSource: confirmation,
        report,
      },
    );

    return {
      status,
      report,
      confirmation,
    };
  } catch (error) {
    await context.log("error", `${options.phaseKey}.assert`, `${options.failureMessage}（${formatErrorMessage(error)}）`);
    throw error;
  }
}
