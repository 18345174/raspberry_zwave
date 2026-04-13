import { DoorLockMode } from "zwave-js";

import type { ExecutableTestDefinition } from "../types.js";

function isUnlocked(mode: number | undefined): boolean {
  return mode != undefined && mode !== DoorLockMode.Secured && mode !== DoorLockMode.Unknown;
}

function isBoltUnlocked(status: unknown): boolean | undefined {
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

function isModeMatched(mode: number | undefined, targetMode: DoorLockMode): boolean {
  if (targetMode === DoorLockMode.Unsecured) {
    return isUnlocked(mode);
  }
  return mode === targetMode;
}

function expectedBoltStatus(targetMode: DoorLockMode): "locked" | "unlocked" {
  return targetMode === DoorLockMode.Unsecured ? "unlocked" : "locked";
}

export const lockBasicDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Door Lock"],
  meta: {
    id: "lock-basic-v1",
    key: "lock-basic",
    name: "门锁开关门测试",
    deviceType: "door-lock",
    version: 5,
    enabled: true,
    description: "先读取门锁当前锁舌状态，先切到相反状态并校验，通过后再切回初始状态，两个步骤都以 boltStatus 为准。",
    inputSchema: {
      reportTimeoutMs: { type: "number", default: 5000, min: 1000, max: 10000 },
    },
  },
  supports(node) {
    return node.commandClasses.includes("Door Lock")
      ? { supported: true }
      : { supported: false, reason: "节点未发现 Door Lock CC。" };
  },
  async run(context) {
    const reportTimeoutMs = Number(context.inputs.reportTimeoutMs ?? 5000);

    const capabilities = await context.invokeCcApi({ commandClass: "Door Lock", method: "getCapabilities" }) as Record<string, unknown> | undefined;
    const initialStatus = await context.invokeCcApi({ commandClass: "Door Lock", method: "get" }) as {
      currentMode?: number;
      boltStatus?: string;
    } | undefined;
    const initialMode = initialStatus?.currentMode;
    const initialBoltStatus = initialStatus?.boltStatus;
    const initialUnlocked =
      isBoltUnlocked(initialBoltStatus) ??
      (initialMode != undefined ? isUnlocked(initialMode) : undefined);

    if (initialUnlocked == undefined) {
      throw new Error("未读取到门锁当前锁舌状态，无法执行自动开关门测试。");
    }

    const firstTargetMode = initialUnlocked ? DoorLockMode.Secured : DoorLockMode.Unsecured;
    const restoreTargetMode = initialUnlocked ? DoorLockMode.Unsecured : DoorLockMode.Secured;
    const firstActionLabel = firstTargetMode === DoorLockMode.Unsecured ? "解锁" : "上锁";
    const restoreActionLabel = restoreTargetMode === DoorLockMode.Unsecured ? "解锁" : "上锁";
    const firstExpectedBoltStatus = expectedBoltStatus(firstTargetMode);
    const restoreExpectedBoltStatus = expectedBoltStatus(restoreTargetMode);

    await context.log("info", "precheck", "Door Lock CC precheck complete", {
      initialStatus,
      capabilities,
      reportTimeoutMs,
      initialBoltStatus,
      initialUnlocked,
      firstTargetMode,
      firstExpectedBoltStatus,
      restoreTargetMode,
      restoreExpectedBoltStatus,
    });

    const firstReportPromise = context.waitForValueUpdate({
      commandClass: "Door Lock",
      property: "boltStatus",
      timeoutMs: reportTimeoutMs,
      predicate: (payload) =>
        String(payload.newValue ?? "") === firstExpectedBoltStatus &&
        String(payload.prevValue ?? "") !== firstExpectedBoltStatus,
    });

    await context.log("info", "toggle.command", `下发门锁${firstActionLabel}命令`, {
      targetMode: firstTargetMode,
      expectedBoltStatus: firstExpectedBoltStatus,
    });
    await context.invokeCcApi({
      commandClass: "Door Lock",
      method: "set",
      args: [firstTargetMode],
    });

    const firstReport = await firstReportPromise;

    await context.log("info", "toggle.report", `已在 ${reportTimeoutMs}ms 内收到门锁${firstActionLabel}后的 boltStatus 上报`, firstReport);

    const toggledStatus = await context.invokeCcApi({ commandClass: "Door Lock", method: "get" }) as {
      currentMode?: number;
      targetMode?: number;
      boltStatus?: string;
    } | undefined;
    if (toggledStatus?.boltStatus !== firstExpectedBoltStatus) {
      throw new Error(`门锁${firstActionLabel}后 boltStatus 校验失败。`);
    }
    if (!isModeMatched(toggledStatus.currentMode, firstTargetMode)) {
      throw new Error(`门锁${firstActionLabel}后 currentMode 校验失败。`);
    }

    await context.log("info", "toggle.assert", `门锁${firstActionLabel}状态校验通过`, {
      ...toggledStatus,
      boltStatus: firstReport.newValue,
    });

    const restoreReportPromise = context.waitForValueUpdate({
      commandClass: "Door Lock",
      property: "boltStatus",
      timeoutMs: reportTimeoutMs,
      predicate: (payload) =>
        String(payload.newValue ?? "") === restoreExpectedBoltStatus &&
        String(payload.prevValue ?? "") !== restoreExpectedBoltStatus,
    });

    await context.log("info", "restore.command", `下发门锁${restoreActionLabel}命令，恢复初始状态`, {
      targetMode: restoreTargetMode,
      expectedBoltStatus: restoreExpectedBoltStatus,
    });
    await context.invokeCcApi({
      commandClass: "Door Lock",
      method: "set",
      args: [restoreTargetMode],
    });

    const restoreReport = await restoreReportPromise;

    await context.log("info", "restore.report", `已在 ${reportTimeoutMs}ms 内收到门锁${restoreActionLabel}后的 boltStatus 上报`, restoreReport);

    const finalStatus = await context.invokeCcApi({ commandClass: "Door Lock", method: "get" }) as {
      currentMode?: number;
      targetMode?: number;
      boltStatus?: string;
    } | undefined;
    if (finalStatus?.boltStatus !== restoreExpectedBoltStatus) {
      throw new Error("门锁恢复初始状态 boltStatus 校验失败。");
    }
    if (!isModeMatched(finalStatus.currentMode, restoreTargetMode)) {
      throw new Error("门锁恢复初始状态 currentMode 校验失败。");
    }

    await context.log("info", "restore.assert", "门锁恢复初始状态校验通过", {
      ...finalStatus,
      boltStatus: restoreReport.newValue,
    });

    const refreshed = await context.refreshNode();

    return {
      reportTimeoutMs,
      initialStatus,
      toggledStatus,
      firstBoltStatus: firstReport.newValue,
      finalStatus,
      finalBoltStatus: restoreReport.newValue,
      capabilities,
      finalNodeValueCount: refreshed.values.length,
    };
  },
};
