import { DoorLockMode } from "zwave-js";

import {
  describeBoltStatus,
  expectedBoltStatus,
  performDoorLockCommand,
  readDoorLockCapabilities,
  readDoorLockStatus,
} from "./door-lock-shared.js";
import type { ExecutableTestDefinition } from "../types.js";

function createDoorLockCommandDefinition(input: {
  id: string;
  key: string;
  name: string;
  description: string;
  targetMode: DoorLockMode;
  actionLabel: string;
}): ExecutableTestDefinition {
  const expectedStatus = expectedBoltStatus(input.targetMode);

  return {
    traceCommandClasses: ["Door Lock"],
    meta: {
      id: input.id,
      key: input.key,
      name: input.name,
      deviceType: "door-lock",
      version: 1,
      enabled: true,
      description: input.description,
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
        targetMode: input.targetMode,
        expectedBoltStatus: expectedStatus,
      });

      const [capabilities, initialStatus] = await Promise.all([
        readDoorLockCapabilities(context),
        readDoorLockStatus(context),
      ]);

      await context.log("info", "precheck.current", `当前门锁状态：${describeBoltStatus(initialStatus?.boltStatus)}`, {
        initialStatus,
        capabilities,
        reportTimeoutMs,
        targetMode: input.targetMode,
        expectedBoltStatus: expectedStatus,
      });

      const result = await performDoorLockCommand(context, {
        phaseKey: "action",
        actionLabel: input.actionLabel,
        targetMode: input.targetMode,
        expectedStatus,
        reportTimeoutMs,
        successMessage: "单次命令判定结果：通过",
        failureMessage: "单次命令判定结果：失败",
      });

      await context.log("info", "result", "最终测试结果：通过", {
        initialBoltStatus: initialStatus?.boltStatus,
        finalBoltStatus: result.status?.boltStatus ?? result.report?.newValue,
        confirmation: result.confirmation,
      });

      return {
        reportTimeoutMs,
        targetMode: input.targetMode,
        expectedBoltStatus: expectedStatus,
        initialStatus,
        finalStatus: result.status,
        confirmation: result.confirmation,
        capabilities,
      };
    },
  };
}

export const lockUnlockDefinition = createDoorLockCommandDefinition({
  id: "lock-unlock-v1",
  key: "lock-unlock",
  name: "单独开锁",
  description: "单独向 Door Lock CC 发送开锁命令，并校验最终锁舌状态是否为已开锁。",
  targetMode: DoorLockMode.Unsecured,
  actionLabel: "开锁",
});

export const lockLockDefinition = createDoorLockCommandDefinition({
  id: "lock-lock-v1",
  key: "lock-lock",
  name: "单独关锁",
  description: "单独向 Door Lock CC 发送关锁命令，并校验最终锁舌状态是否为已关锁。",
  targetMode: DoorLockMode.Secured,
  actionLabel: "关锁",
});
