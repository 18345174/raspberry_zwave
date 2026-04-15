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
  confirmation: "poll";
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

export async function performDoorLockCommand(
  context: TestExecutionContext,
  options: {
    phaseKey: string;
    actionLabel: string;
    targetMode: DoorLockMode;
    expectedStatus: "locked" | "unlocked";
    successMessage: string;
    failureMessage: string;
  },
): Promise<DoorLockCommandResult> {
  await context.log("info", `${options.phaseKey}.command`, `发送${options.actionLabel}命令`, {
    targetMode: options.targetMode,
    expectedBoltStatus: options.expectedStatus,
  });
  await context.invokeCcApi({
    commandClass: "Door Lock",
    method: "set",
    args: [options.targetMode],
  });

  try {
    await context.log("info", `${options.phaseKey}.poll`, "命令已发送，立即主动查询门锁状态", {
      expectedBoltStatus: options.expectedStatus,
      targetMode: options.targetMode,
    });
    const status = await readDoorLockStatus(context);
    await context.log("info", `${options.phaseKey}.poll`, "主动查询门锁状态完成", status as Record<string, unknown> | undefined);

    if (status?.boltStatus !== options.expectedStatus) {
      throw new Error(`当前 boltStatus 为 ${describeBoltStatus(status?.boltStatus)}，期望 ${describeBoltStatus(options.expectedStatus)}。`);
    }
    if (!isModeMatched(status.currentMode, options.targetMode)) {
      throw new Error(`当前 currentMode=${String(status.currentMode)}，未达到目标模式 ${options.targetMode}。`);
    }

    await context.log(
      "info",
      `${options.phaseKey}.assert`,
      `${options.successMessage}（主动查询确认）`,
      {
        ...status,
        reportSource: "poll",
      },
    );

    return {
      status,
      confirmation: "poll",
    };
  } catch (error) {
    await context.log("error", `${options.phaseKey}.assert`, `${options.failureMessage}（${formatErrorMessage(error)}）`);
    throw error;
  }
}
