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
    version: 9,
    enabled: true,
    description: "先读取门锁当前锁舌状态，发送第一次命令后等待 5 秒再主动查询当前状态；确认成功后继续执行第二步恢复，并再次等待 5 秒后主动查询状态。",
    inputSchema: {},
  },
  supports(node) {
    return node.commandClasses.includes("Door Lock")
      ? { supported: true }
      : { supported: false, reason: "节点未发现 Door Lock CC。" };
  },
  async run(context) {
    await context.log("info", "precheck.start", "正在检查门锁状态");

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
      successMessage: "第一次判定结果：通过",
      failureMessage: "第一次判定结果：失败",
    });

    await context.log("info", "restore.prepare", `第一次命令已确认通过，开始发送第二次${restoreActionLabel}命令`, {
      firstConfirmation: firstResult.confirmation,
      firstBoltStatus: firstResult.status?.boltStatus,
      restoreTargetMode,
      restoreExpectedBoltStatus,
    });

    const restoreResult = await performDoorLockCommand(context, {
      phaseKey: "restore",
      actionLabel: `第二次${restoreActionLabel}`,
      targetMode: restoreTargetMode,
      expectedStatus: restoreExpectedBoltStatus,
      successMessage: "第二次判定结果：通过",
      failureMessage: "第二次判定结果：失败",
    });

    await context.log("info", "result", "最终测试结果：通过", {
      initialBoltStatus,
      firstBoltStatus: firstResult.status?.boltStatus,
      finalBoltStatus: restoreResult.status?.boltStatus,
      firstConfirmation: firstResult.confirmation,
      restoreConfirmation: restoreResult.confirmation,
    });

    const refreshed = await context.refreshNode();

    return {
      initialStatus,
      toggledStatus: firstResult.status,
      firstBoltStatus: firstResult.status?.boltStatus,
      finalStatus: restoreResult.status,
      finalBoltStatus: restoreResult.status?.boltStatus,
      firstConfirmation: firstResult.confirmation,
      restoreConfirmation: restoreResult.confirmation,
      capabilities,
      finalNodeValueCount: refreshed.values.length,
    };
  },
};
