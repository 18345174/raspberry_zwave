import { DoorLockMode } from "zwave-js";

import {
  describeBoltStatus,
  expectedBoltStatus,
  isBoltUnlocked,
  isUnlocked,
  performDoorLockCommand,
  readDoorLockCapabilities,
  readDoorLockStatus,
} from "./door-lock-shared.js";
import type { ExecutableTestDefinition } from "../types.js";

export const lockBasicDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Door Lock"],
  meta: {
    id: "lock-basic-v1",
    key: "lock-basic",
    name: "门锁开关门测试",
    deviceType: "door-lock",
    version: 6,
    enabled: true,
    description: "先读取门锁当前锁舌状态，先切到相反状态并校验，通过后再切回初始状态；优先等待 boltStatus 上报，超时后主动查询当前状态。",
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

    await context.log("info", "precheck.start", "正在检查门锁状态", {
      reportTimeoutMs,
    });

    const [capabilities, initialStatus] = await Promise.all([
      readDoorLockCapabilities(context),
      readDoorLockStatus(context),
    ]);
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

    await context.log("info", "precheck.current", `当前门锁状态：${describeBoltStatus(initialBoltStatus)}`, {
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

    const firstResult = await performDoorLockCommand(context, {
      phaseKey: "toggle",
      actionLabel: `第一次${firstActionLabel}`,
      targetMode: firstTargetMode,
      expectedStatus: firstExpectedBoltStatus,
      reportTimeoutMs,
      successMessage: "第一次判定结果：通过",
      failureMessage: "第一次判定结果：失败",
    });

    const restoreResult = await performDoorLockCommand(context, {
      phaseKey: "restore",
      actionLabel: `第二次${restoreActionLabel}`,
      targetMode: restoreTargetMode,
      expectedStatus: restoreExpectedBoltStatus,
      reportTimeoutMs,
      successMessage: "第二次判定结果：通过",
      failureMessage: "第二次判定结果：失败",
    });

    await context.log("info", "result", "最终测试结果：通过", {
      initialBoltStatus,
      firstBoltStatus: firstResult.status?.boltStatus ?? firstResult.report?.newValue,
      finalBoltStatus: restoreResult.status?.boltStatus ?? restoreResult.report?.newValue,
      firstConfirmation: firstResult.confirmation,
      restoreConfirmation: restoreResult.confirmation,
    });

    const refreshed = await context.refreshNode();

    return {
      reportTimeoutMs,
      initialStatus,
      toggledStatus: firstResult.status,
      firstBoltStatus: firstResult.status?.boltStatus ?? firstResult.report?.newValue,
      finalStatus: restoreResult.status,
      finalBoltStatus: restoreResult.status?.boltStatus ?? restoreResult.report?.newValue,
      firstConfirmation: firstResult.confirmation,
      restoreConfirmation: restoreResult.confirmation,
      capabilities,
      finalNodeValueCount: refreshed.values.length,
    };
  },
};
