import { DoorLockMode } from "zwave-js";

import {
  describeBoltStatus,
  expectedBoltStatus,
  isBoltUnlocked,
  isUnlocked,
  readDoorLockStatus,
} from "./door-lock-shared.js";
import type { ExecutableTestDefinition } from "../types.js";

const NOTIFICATION_TIMEOUT_MS = 15000;
const POST_NOTIFICATION_POLL_DELAY_MS = 2000;

interface NotificationEventRecord {
  type?: number;
  event?: number;
  label?: string;
  eventLabel?: string;
  parameters?: Record<string, unknown>;
}

function isAccessControlNotification(payload: Record<string, unknown>, nodeId: number): boolean {
  if (Number(payload.nodeId) !== nodeId) {
    return false;
  }
  if (String(payload.commandClass ?? "") !== "Notification") {
    return false;
  }

  const args = (payload.args ?? {}) as Record<string, unknown>;
  return Number(args.type) === 6 && Number(args.event) > 0;
}

async function readNotificationSupport(context: Parameters<ExecutableTestDefinition["run"]>[0]) {
  const supported = await context.invokeCcApi({
    commandClass: "Notification",
    method: "getSupported",
  }) as { supportedNotificationTypes?: number[]; supportsV1Alarm?: boolean } | undefined;

  const types = Array.isArray(supported?.supportedNotificationTypes)
    ? supported.supportedNotificationTypes.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : [];

  const eventsByType: Record<string, unknown> = {};
  for (const type of types) {
    try {
      const events = await context.invokeCcApi({
        commandClass: "Notification",
        method: "getSupportedEvents",
        args: [type],
      });
      eventsByType[String(type)] = events;
    } catch (error) {
      eventsByType[String(type)] = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    supported,
    eventsByType,
  };
}

async function waitForAccessControlNotification(
  context: Parameters<ExecutableTestDefinition["run"]>[0],
  stepKey: string,
): Promise<NotificationEventRecord> {
  const event = await context.waitForEvent({
    type: "zwave.node.notification",
    timeoutMs: NOTIFICATION_TIMEOUT_MS,
    predicate: (payload) => isAccessControlNotification(payload, context.node.nodeId),
  });

  const args = (event.args ?? {}) as Record<string, unknown>;
  return {
    type: Number(args.type),
    event: Number(args.event),
    label: typeof args.label === "string" ? args.label : undefined,
    eventLabel: typeof args.eventLabel === "string" ? args.eventLabel : undefined,
    parameters: (args.parameters ?? {}) as Record<string, unknown>,
  };
}

async function executeNotificationPhase(
  context: Parameters<ExecutableTestDefinition["run"]>[0],
  input: {
    phaseKey: string;
    actionLabel: string;
    targetMode: DoorLockMode;
    expectedBoltStatus: "locked" | "unlocked";
  },
) {
  await context.log("info", `${input.phaseKey}.command`, `发送${input.actionLabel}命令`, {
    targetMode: input.targetMode,
    expectedBoltStatus: input.expectedBoltStatus,
  });

  await context.invokeCcApi({
    commandClass: "Door Lock",
    method: "set",
    args: [input.targetMode],
  });

  await context.log("info", `${input.phaseKey}.notify.wait`, "等待 Access Control Notification 上报", {
    timeoutMs: NOTIFICATION_TIMEOUT_MS,
  });
  const notification = await waitForAccessControlNotification(context, `${input.phaseKey}.notify.wait`);
  await context.log(
    "info",
    `${input.phaseKey}.notify.received`,
    "已收到 Access Control Notification 上报",
    notification as unknown as Record<string, unknown>,
  );

  await context.wait(POST_NOTIFICATION_POLL_DELAY_MS);
  const status = await readDoorLockStatus(context);
  await context.log("info", `${input.phaseKey}.poll`, "根据 Door Lock 状态确认通知结果", status as Record<string, unknown> | undefined);

  if (status?.boltStatus !== input.expectedBoltStatus) {
    throw new Error(`执行${input.actionLabel}后 boltStatus 为 ${describeBoltStatus(status?.boltStatus)}，期望 ${describeBoltStatus(input.expectedBoltStatus)}。`);
  }

  return {
    notification,
    status,
  };
}

export const doorLockNotificationDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Door Lock", "Notification"],
  meta: {
    id: "door-lock-notification-v1",
    key: "door-lock-notification",
    name: "门锁 Notification 联动测试",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "读取 Notification 能力后，执行门锁开/关动作，验证是否收到 Access Control Notification 上报并与 Door Lock 状态一致。",
    inputSchema: {},
  },
  supports(node) {
    return node.commandClasses.includes("Door Lock") && node.commandClasses.includes("Notification")
      ? { supported: true }
      : { supported: false, reason: "节点未同时发现 Door Lock CC 与 Notification CC。" };
  },
  async run(context) {
    await context.log("info", "precheck.start", "开始读取门锁状态与 Notification 能力");

    const [initialStatus, notificationSupport] = await Promise.all([
      readDoorLockStatus(context),
      readNotificationSupport(context),
    ]);

    const initialUnlocked =
      isBoltUnlocked(initialStatus?.boltStatus) ??
      (initialStatus?.currentMode != undefined ? isUnlocked(initialStatus.currentMode) : undefined);
    if (initialUnlocked == undefined) {
      throw new Error("未读取到门锁当前锁舌状态，无法执行 Notification 联动测试。");
    }

    await context.log("info", "precheck.current", `当前门锁状态：${describeBoltStatus(initialStatus?.boltStatus)}`, {
      initialStatus,
      notificationSupport,
    });

    const firstTargetMode = initialUnlocked ? DoorLockMode.Secured : DoorLockMode.Unsecured;
    const restoreTargetMode = initialUnlocked ? DoorLockMode.Unsecured : DoorLockMode.Secured;

    const firstPhase = await executeNotificationPhase(context, {
      phaseKey: "toggle",
      actionLabel: firstTargetMode === DoorLockMode.Unsecured ? "解锁" : "上锁",
      targetMode: firstTargetMode,
      expectedBoltStatus: expectedBoltStatus(firstTargetMode),
    });

    const restorePhase = await executeNotificationPhase(context, {
      phaseKey: "restore",
      actionLabel: restoreTargetMode === DoorLockMode.Unsecured ? "解锁" : "上锁",
      targetMode: restoreTargetMode,
      expectedBoltStatus: expectedBoltStatus(restoreTargetMode),
    });

    await context.log("info", "result", "门锁 Notification 联动测试通过", {
      firstNotification: firstPhase.notification,
      restoreNotification: restorePhase.notification,
    });

    return {
      initialStatus,
      notificationSupport,
      firstPhase,
      restorePhase,
    };
  },
};
