import { DoorLockMode } from "zwave-js";

import { waitForCondition } from "../definition-helpers.js";
import type { ExecutableTestDefinition } from "../types.js";

function isUnlocked(mode: number | undefined): boolean {
  return mode != undefined && mode !== DoorLockMode.Secured && mode !== DoorLockMode.Unknown;
}

export const lockBasicDefinition: ExecutableTestDefinition = {
  meta: {
    id: "lock-basic-v1",
    key: "lock-basic",
    name: "门锁基础开关测试",
    deviceType: "door-lock",
    version: 2,
    enabled: true,
    description: "基于 Door Lock CC 执行上锁、解锁、状态轮询与超时断言。",
    inputSchema: {
      repeat: { type: "number", default: 1, min: 1, max: 10 },
      lockTimeoutMs: { type: "number", default: 15000, min: 3000, max: 60000 },
      unlockTimeoutMs: { type: "number", default: 15000, min: 3000, max: 60000 },
    },
  },
  supports(node) {
    return node.commandClasses.includes("Door Lock")
      ? { supported: true }
      : { supported: false, reason: "节点未发现 Door Lock CC。" };
  },
  async run(context) {
    const repeat = Number(context.inputs.repeat ?? 1);
    const lockTimeoutMs = Number(context.inputs.lockTimeoutMs ?? 15000);
    const unlockTimeoutMs = Number(context.inputs.unlockTimeoutMs ?? 15000);

    const capabilities = await context.invokeCcApi({ commandClass: "Door Lock", method: "getCapabilities" }) as Record<string, unknown> | undefined;
    const initialStatus = await context.invokeCcApi({ commandClass: "Door Lock", method: "get" }) as { currentMode?: number } | undefined;

    await context.log("info", "precheck", "Door Lock CC precheck complete", {
      initialStatus,
      capabilities,
      repeat,
      lockTimeoutMs,
      unlockTimeoutMs,
    });

    for (let round = 1; round <= repeat; round += 1) {
      await context.log("info", "lock.command", `第 ${round} 轮下发上锁命令`, { targetMode: DoorLockMode.Secured });
      await context.invokeCcApi({
        commandClass: "Door Lock",
        method: "set",
        args: [DoorLockMode.Secured],
      });

      const lockStatus = await waitForCondition(
        context,
        "lock.wait",
        lockTimeoutMs,
        async () => {
          return context.invokeCcApi({ commandClass: "Door Lock", method: "get" }) as Promise<{ currentMode?: number; targetMode?: number }>;
        },
        (status) => status.currentMode === DoorLockMode.Secured,
        (status) => ({ currentMode: status.currentMode, targetMode: status.targetMode }),
      );

      await context.log("info", "lock.assert", `第 ${round} 轮上锁成功`, lockStatus);

      await context.log("info", "unlock.command", `第 ${round} 轮下发解锁命令`, { targetMode: DoorLockMode.Unsecured });
      await context.invokeCcApi({
        commandClass: "Door Lock",
        method: "set",
        args: [DoorLockMode.Unsecured],
      });

      const unlockStatus = await waitForCondition(
        context,
        "unlock.wait",
        unlockTimeoutMs,
        async () => {
          return context.invokeCcApi({ commandClass: "Door Lock", method: "get" }) as Promise<{ currentMode?: number; targetMode?: number }>;
        },
        (status) => isUnlocked(status.currentMode),
        (status) => ({ currentMode: status.currentMode, targetMode: status.targetMode }),
      );

      await context.log("info", "unlock.assert", `第 ${round} 轮解锁成功`, unlockStatus);
    }

    const finalStatus = await context.invokeCcApi({ commandClass: "Door Lock", method: "get" }) as Record<string, unknown> | undefined;
    const refreshed = await context.refreshNode();

    return {
      repeat,
      lockTimeoutMs,
      unlockTimeoutMs,
      initialStatus,
      finalStatus,
      capabilities,
      finalNodeValueCount: refreshed.values.length,
    };
  },
};
