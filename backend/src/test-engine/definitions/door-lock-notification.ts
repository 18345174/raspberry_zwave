import { DoorLockMode, UserIDStatus } from "zwave-js";

import {
  describeBoltStatus,
  isBoltUnlocked,
  isUnlocked,
  readDoorLockStatus,
} from "./door-lock-shared.js";
import type { ExecutableTestDefinition, TestExecutionContext } from "../types.js";

const ACCESS_CONTROL_NOTIFICATION_TYPE = 6;
const NOTIFICATION_WAIT_TIMEOUT_MS = 45 * 1000;
const POST_NOTIFICATION_POLL_DELAY_MS = 2000;
const USER_CODE_SYNC_DELAY_MS = 1200;

const ACCESS_CONTROL_EVENTS = {
  manualLock: 1,
  manualUnlock: 2,
  rfLock: 3,
  rfUnlock: 4,
  keypadLock: 5,
  keypadUnlock: 6,
  autoLock: 9,
  jammed: 11,
} as const;

interface NotificationEventRecord {
  type?: number;
  event?: number;
  label?: string;
  eventLabel?: string;
  parameters?: Record<string, unknown>;
}

interface NotificationSupportSummary {
  supported?: {
    supportedNotificationTypes?: number[];
    supportsV1Alarm?: boolean;
  };
  eventsByType: Record<string, unknown>;
  accessControlSupportedEvents: number[];
}

interface UserCodeReport {
  userId?: number;
  userIdStatus?: number;
  userCode?: string | Uint8Array;
}

interface TemporaryUserCodeReservation {
  userId: number;
  code: string;
  previousReport?: UserCodeReport;
}

interface AccessControlSignalResult {
  notification: NotificationEventRecord;
  source: "notification" | "value-update";
}

function isAccessControlNotification(payload: Record<string, unknown>, nodeId: number): boolean {
  if (Number(payload.nodeId) !== nodeId) {
    return false;
  }
  if (String(payload.commandClass ?? "") !== "Notification") {
    return false;
  }

  const args = (payload.args ?? {}) as Record<string, unknown>;
  return Number(args.type) === ACCESS_CONTROL_NOTIFICATION_TYPE && Number(args.event) > 0;
}

function extractNotificationRecord(payload: Record<string, unknown>): NotificationEventRecord {
  const args = (payload.args ?? {}) as Record<string, unknown>;
  return {
    type: Number(args.type),
    event: Number(args.event),
    label: typeof args.label === "string" ? args.label : undefined,
    eventLabel: typeof args.eventLabel === "string" ? args.eventLabel : undefined,
    parameters: (args.parameters ?? {}) as Record<string, unknown>,
  };
}

function buildNotificationRecordFromValueUpdate(
  payload: Record<string, unknown>,
  expectedEvent: number,
): NotificationEventRecord {
  return {
    type: ACCESS_CONTROL_NOTIFICATION_TYPE,
    event: expectedEvent,
    label: "Access Control",
    eventLabel: describeEvent(expectedEvent),
    parameters: {
      source: "zwave.value.updated",
      property: payload.property,
      propertyKey: payload.propertyKey,
      newValue: payload.newValue,
      prevValue: payload.prevValue,
    },
  };
}

function normalizeSupportedEvents(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0))];
}

function normalizeReportCode(value: string | Uint8Array | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("ascii");
  }
  return undefined;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTempUserCode(userId: number): string {
  return String(((userId % 9000) + 1357)).padStart(4, "0").slice(0, 4);
}

function describeEvent(event: number): string {
  switch (event) {
    case ACCESS_CONTROL_EVENTS.manualLock:
      return "手动上锁";
    case ACCESS_CONTROL_EVENTS.manualUnlock:
      return "手动解锁";
    case ACCESS_CONTROL_EVENTS.rfLock:
      return "RF 上锁";
    case ACCESS_CONTROL_EVENTS.rfUnlock:
      return "RF 解锁";
    case ACCESS_CONTROL_EVENTS.keypadLock:
      return "键盘上锁";
    case ACCESS_CONTROL_EVENTS.keypadUnlock:
      return "键盘解锁";
    case ACCESS_CONTROL_EVENTS.autoLock:
      return "自动上锁";
    case ACCESS_CONTROL_EVENTS.jammed:
      return "堵转";
    default:
      return `事件 ${event}`;
  }
}

function expectedModeForBoltStatus(status: "locked" | "unlocked"): DoorLockMode {
  return status === "locked" ? DoorLockMode.Secured : DoorLockMode.Unsecured;
}

function isAccessControlValueUpdate(
  payload: Record<string, unknown>,
  nodeId: number,
  expectedEvent: number,
): boolean {
  return Number(payload.nodeId) === nodeId
    && String(payload.commandClass ?? "") === "Notification"
    && String(payload.property ?? "") === "Access Control"
    && Number(payload.newValue) === expectedEvent;
}

async function readNotificationSupport(context: TestExecutionContext): Promise<NotificationSupportSummary> {
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
      eventsByType[String(type)] = await context.invokeCcApi({
        commandClass: "Notification",
        method: "getSupportedEvents",
        args: [type],
      });
    } catch (error) {
      eventsByType[String(type)] = {
        error: formatErrorMessage(error),
      };
    }
  }

  return {
    supported,
    eventsByType,
    accessControlSupportedEvents: normalizeSupportedEvents(eventsByType[String(ACCESS_CONTROL_NOTIFICATION_TYPE)]),
  };
}

async function readUserCodeReport(context: TestExecutionContext, userId: number): Promise<UserCodeReport | undefined> {
  return await context.invokeCcApi({
    commandClass: "User Code",
    method: "get",
    args: [userId],
  }) as UserCodeReport | undefined;
}

async function prepareTemporaryUserCode(context: TestExecutionContext): Promise<TemporaryUserCodeReservation | undefined> {
  if (!context.node.commandClasses.includes("User Code")) {
    await context.log("warn", "keypad.setup.skip", "节点未发现 User Code CC，跳过键盘开关消息测试");
    return undefined;
  }

  const supportedUsersRaw = await context.invokeCcApi({
    commandClass: "User Code",
    method: "getUsersCount",
  });
  const supportedUsers = Number(supportedUsersRaw);

  if (!Number.isInteger(supportedUsers) || supportedUsers <= 0) {
    await context.log("warn", "keypad.setup.skip", "设备返回的 User Code 用户数量无效，跳过键盘开关消息测试", {
      supportedUsers: supportedUsersRaw,
    });
    return undefined;
  }

  const userId = supportedUsers;
  const code = formatTempUserCode(userId);
  const previousReport = await readUserCodeReport(context, userId);

  await context.invokeCcApi({
    commandClass: "User Code",
    method: "set",
    args: [userId, UserIDStatus.Enabled, code],
  });

  await context.wait(USER_CODE_SYNC_DELAY_MS);
  const confirmedReport = await readUserCodeReport(context, userId);
  const confirmedCode = normalizeReportCode(confirmedReport?.userCode) ?? "";

  if (confirmedReport?.userIdStatus !== UserIDStatus.Enabled || confirmedCode !== code) {
    throw new Error(`临时 User Code 配置失败：User ID ${userId} 期望 ${code}，实际 ${confirmedCode || "(empty)"}。`);
  }

  await context.log("info", "keypad.setup.ready", `已配置临时 User Code：${code}`, {
    userId,
    code,
  });

  return {
    userId,
    code,
    previousReport,
  };
}

async function restoreTemporaryUserCode(
  context: TestExecutionContext,
  reservation: TemporaryUserCodeReservation,
): Promise<void> {
  try {
    const previousCode = normalizeReportCode(reservation.previousReport?.userCode) ?? "";
    if (reservation.previousReport?.userIdStatus === UserIDStatus.Enabled && previousCode) {
      await context.invokeCcApi({
        commandClass: "User Code",
        method: "set",
        args: [reservation.userId, UserIDStatus.Enabled, previousCode],
      });
      await context.log("info", "keypad.cleanup", "已恢复临时 User Code 对应用户位原值", {
        userId: reservation.userId,
      });
      return;
    }

    await context.invokeCcApi({
      commandClass: "User Code",
      method: "clear",
      args: [reservation.userId],
    });
    await context.log("info", "keypad.cleanup", "已清理临时 User Code", {
      userId: reservation.userId,
    });
  } catch (error) {
    await context.log("warn", "keypad.cleanup", "恢复临时 User Code 失败，请手动检查设备用户位", {
      userId: reservation.userId,
      error: formatErrorMessage(error),
    });
  }
}

async function ensureDoorState(
  context: TestExecutionContext,
  input: {
    phaseKey: string;
    phaseLabel: string;
    expectedBoltStatus: "locked" | "unlocked";
  },
): Promise<Record<string, unknown> | undefined> {
  const currentStatus = await readDoorLockStatus(context);
  if (currentStatus?.boltStatus === input.expectedBoltStatus) {
    return currentStatus as Record<string, unknown> | undefined;
  }

  await context.log(
    "info",
    `${input.phaseKey}.prepare`,
    `为执行${input.phaseLabel}，先将门锁调整为${describeBoltStatus(input.expectedBoltStatus)}`,
    {
      currentStatus,
      expectedBoltStatus: input.expectedBoltStatus,
    },
  );

  await context.invokeCcApi({
    commandClass: "Door Lock",
    method: "set",
    args: [expectedModeForBoltStatus(input.expectedBoltStatus)],
  });

  await context.wait(POST_NOTIFICATION_POLL_DELAY_MS);
  const preparedStatus = await readDoorLockStatus(context);
  if (preparedStatus?.boltStatus !== input.expectedBoltStatus) {
    throw new Error(`执行${input.phaseLabel}前无法将门锁调整为${describeBoltStatus(input.expectedBoltStatus)}。`);
  }

  return preparedStatus as Record<string, unknown> | undefined;
}

async function confirmDoorState(
  context: TestExecutionContext,
  input: {
    phaseKey: string;
    phaseLabel: string;
    expectedBoltStatus: "locked" | "unlocked";
  },
): Promise<Record<string, unknown> | undefined> {
  await context.wait(POST_NOTIFICATION_POLL_DELAY_MS);
  const status = await readDoorLockStatus(context);
  if (status?.boltStatus !== input.expectedBoltStatus) {
    throw new Error(`${input.phaseLabel}后门锁状态异常：当前 ${describeBoltStatus(status?.boltStatus)}，期望 ${describeBoltStatus(input.expectedBoltStatus)}。`);
  }
  return status as Record<string, unknown> | undefined;
}

async function waitForAccessControlSignal(
  context: TestExecutionContext,
  input: {
    expectedEvent: number;
    timeoutMs: number;
    expectedUserId?: number;
    promptKey?: string;
  },
): Promise<AccessControlSignalResult | { skipped: true }> {
  const result = await context.waitForMatchingSignal({
    timeoutMs: input.timeoutMs,
    events: [
      {
        type: "zwave.node.notification",
        predicate: (payload) => {
          if (!isAccessControlNotification(payload, context.node.nodeId)) {
            return false;
          }

          const args = (payload.args ?? {}) as Record<string, unknown>;
          if (Number(args.event) !== input.expectedEvent) {
            return false;
          }

          if (input.expectedUserId == undefined) {
            return true;
          }

          const parameters = (args.parameters ?? {}) as Record<string, unknown>;
          const actualUserId = Number(parameters.userId);
          return !Number.isFinite(actualUserId) || actualUserId === input.expectedUserId;
        },
      },
      {
        type: "zwave.value.updated",
        predicate: (payload) => isAccessControlValueUpdate(payload, context.node.nodeId, input.expectedEvent),
      },
    ],
    actionPredicate: input.promptKey
      ? (payload) => payload.promptKey === input.promptKey && payload.action === "skip"
      : undefined,
  });

  if (result.kind === "action") {
    return { skipped: true };
  }

  if (result.eventType === "zwave.value.updated") {
    return {
      source: "value-update",
      notification: buildNotificationRecordFromValueUpdate(result.payload, input.expectedEvent),
    };
  }

  return {
    source: "notification",
    notification: extractNotificationRecord(result.payload),
  };
}

async function executeRfNotificationPhase(
  context: TestExecutionContext,
  input: {
    phaseKey: string;
    phaseLabel: string;
    targetMode: DoorLockMode;
    expectedEvent: number;
    expectedBoltStatus: "locked" | "unlocked";
  },
): Promise<{ notification: NotificationEventRecord; status?: Record<string, unknown> }> {
  await context.log("info", `${input.phaseKey}.start`, `开始验证${input.phaseLabel}消息`, {
    expectedEvent: input.expectedEvent,
    expectedEventLabel: describeEvent(input.expectedEvent),
    timeoutMs: NOTIFICATION_WAIT_TIMEOUT_MS,
  });

  await context.invokeCcApi({
    commandClass: "Door Lock",
    method: "set",
    args: [input.targetMode],
  });

  const signal = await waitForAccessControlSignal(context, {
    expectedEvent: input.expectedEvent,
    timeoutMs: NOTIFICATION_WAIT_TIMEOUT_MS,
  });
  if ("skipped" in signal) {
    throw new Error(`${input.phaseLabel}不应被跳过。`);
  }
  const notification = signal.notification;
  const status = await confirmDoorState(context, input);

  await context.log("info", `${input.phaseKey}.result`, `${input.phaseLabel}消息验证通过`, {
    notification,
    status,
    signalSource: signal.source,
  });

  return {
    notification,
    status,
  };
}

async function executePromptedNotificationPhase(
  context: TestExecutionContext,
  input: {
    phaseKey: string;
    phaseLabel: string;
    expectedEvent: number;
    timeoutMs: number;
    promptMessage: string;
    promptMeta?: string;
    expectedBoltStatus?: "locked" | "unlocked";
    expectedUserId?: number;
  },
): Promise<{ skipped: boolean; notification?: NotificationEventRecord; status?: Record<string, unknown> }> {
  const promptKey = `${input.phaseKey}.prompt`;

  await context.log("info", `${input.phaseKey}.start`, `开始验证${input.phaseLabel}消息`, {
    expectedEvent: input.expectedEvent,
    expectedEventLabel: describeEvent(input.expectedEvent),
    timeoutMs: input.timeoutMs,
  });

  await context.log("info", "manual.wait", input.promptMessage, {
    promptKey,
    promptTitle: `${input.phaseLabel}测试`,
    promptMessage: input.promptMessage,
    promptMeta: input.promptMeta,
    canSkip: true,
    skipButtonLabel: "跳过此消息测试",
    phaseKey: input.phaseKey,
  });

  const result = await waitForAccessControlSignal(context, {
    expectedEvent: input.expectedEvent,
    timeoutMs: input.timeoutMs,
    expectedUserId: input.expectedUserId,
    promptKey,
  });

  if ("skipped" in result) {
    await context.log("warn", `${input.phaseKey}.skip`, `${input.phaseLabel}消息测试已跳过`, {
      promptKey,
    });
    await context.log("info", "manual.done", `${input.phaseLabel}消息测试已跳过`, {
      promptKey,
      skipped: true,
    });
    return { skipped: true };
  }

  const notification = result.notification;
  const status = input.expectedBoltStatus
    ? await confirmDoorState(context, {
      phaseKey: input.phaseKey,
      phaseLabel: input.phaseLabel,
      expectedBoltStatus: input.expectedBoltStatus,
    })
    : undefined;

  await context.log("info", "manual.done", `${input.phaseLabel}消息测试完成`, {
    promptKey,
    skipped: false,
  });
  await context.log("info", `${input.phaseKey}.result`, `${input.phaseLabel}消息验证通过`, {
    notification,
    status,
    signalSource: result.source,
  });

  return {
    skipped: false,
    notification,
    status,
  };
}

export const doorLockNotificationDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Door Lock", "Notification", "User Code"],
  meta: {
    id: "door-lock-notification-v2",
    key: "door-lock-notification",
    name: "门锁 Notification 联动测试",
    deviceType: "door-lock",
    version: 2,
    enabled: true,
    description: "验证 RF、手动、键盘、自动上锁和堵转等门锁消息，并支持在前端弹窗中跳过不支持的通知场景。",
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

    await context.log("info", "precheck.ready", `当前门锁状态：${describeBoltStatus(initialStatus?.boltStatus)}`, {
      initialStatus,
      accessControlSupportedEvents: notificationSupport.accessControlSupportedEvents,
      notificationSupport,
    });

    let temporaryUserCode: TemporaryUserCodeReservation | undefined;

    try {
      await ensureDoorState(context, {
        phaseKey: "rf.unlock",
        phaseLabel: "RF 解锁消息测试",
        expectedBoltStatus: "locked",
      });
      const rfUnlock = await executeRfNotificationPhase(context, {
        phaseKey: "rf.unlock",
        phaseLabel: "RF 解锁",
        targetMode: DoorLockMode.Unsecured,
        expectedEvent: ACCESS_CONTROL_EVENTS.rfUnlock,
        expectedBoltStatus: "unlocked",
      });

      await ensureDoorState(context, {
        phaseKey: "rf.lock",
        phaseLabel: "RF 上锁消息测试",
        expectedBoltStatus: "unlocked",
      });
      const rfLock = await executeRfNotificationPhase(context, {
        phaseKey: "rf.lock",
        phaseLabel: "RF 上锁",
        targetMode: DoorLockMode.Secured,
        expectedEvent: ACCESS_CONTROL_EVENTS.rfLock,
        expectedBoltStatus: "locked",
      });

      await ensureDoorState(context, {
        phaseKey: "manual.unlock",
        phaseLabel: "手动解锁消息测试",
        expectedBoltStatus: "locked",
      });
      const manualUnlock = await executePromptedNotificationPhase(context, {
        phaseKey: "manual.unlock",
        phaseLabel: "手动解锁",
        expectedEvent: ACCESS_CONTROL_EVENTS.manualUnlock,
        expectedBoltStatus: "unlocked",
        timeoutMs: NOTIFICATION_WAIT_TIMEOUT_MS,
        promptMessage: "请手动解锁设备，检测到手动解锁消息后会自动继续。",
        promptMeta: "如果设备不支持该消息，请点击“跳过此消息测试”。",
      });

      await ensureDoorState(context, {
        phaseKey: "manual.lock",
        phaseLabel: "手动上锁消息测试",
        expectedBoltStatus: "unlocked",
      });
      const manualLock = await executePromptedNotificationPhase(context, {
        phaseKey: "manual.lock",
        phaseLabel: "手动上锁",
        expectedEvent: ACCESS_CONTROL_EVENTS.manualLock,
        expectedBoltStatus: "locked",
        timeoutMs: NOTIFICATION_WAIT_TIMEOUT_MS,
        promptMessage: "请手动上锁设备，检测到手动上锁消息后会自动继续。",
        promptMeta: "如果设备不支持该消息，请点击“跳过此消息测试”。",
      });

      try {
        temporaryUserCode = await prepareTemporaryUserCode(context);
      } catch (error) {
        await context.log("warn", "keypad.setup.skip", "临时 User Code 准备失败，跳过键盘开关消息测试", {
          error: formatErrorMessage(error),
        });
      }
      let keypadUnlock: { skipped: boolean; notification?: NotificationEventRecord; status?: Record<string, unknown> } | undefined;
      let keypadLock: { skipped: boolean; notification?: NotificationEventRecord; status?: Record<string, unknown> } | undefined;

      if (temporaryUserCode) {
        await ensureDoorState(context, {
          phaseKey: "keypad.unlock",
          phaseLabel: "键盘解锁消息测试",
          expectedBoltStatus: "locked",
        });
        keypadUnlock = await executePromptedNotificationPhase(context, {
          phaseKey: "keypad.unlock",
          phaseLabel: "键盘解锁",
          expectedEvent: ACCESS_CONTROL_EVENTS.keypadUnlock,
          expectedBoltStatus: "unlocked",
          expectedUserId: temporaryUserCode.userId,
          timeoutMs: NOTIFICATION_WAIT_TIMEOUT_MS,
          promptMessage: `请使用 User Code：${temporaryUserCode.code} 解锁设备，检测到键盘解锁消息后会自动继续。`,
          promptMeta: `临时 User ID：${temporaryUserCode.userId}。如果设备不支持该消息，请点击“跳过此消息测试”。`,
        });

        await ensureDoorState(context, {
          phaseKey: "keypad.lock",
          phaseLabel: "键盘上锁消息测试",
          expectedBoltStatus: "unlocked",
        });
        keypadLock = await executePromptedNotificationPhase(context, {
          phaseKey: "keypad.lock",
          phaseLabel: "键盘上锁",
          expectedEvent: ACCESS_CONTROL_EVENTS.keypadLock,
          expectedBoltStatus: "locked",
          timeoutMs: NOTIFICATION_WAIT_TIMEOUT_MS,
          promptMessage: "请使用门锁键盘/面板完成上锁，检测到键盘上锁消息后会自动继续。",
          promptMeta: "如果设备不支持该消息，请点击“跳过此消息测试”。",
        });
      } else {
        await context.log("warn", "keypad.skip", "已跳过键盘开关消息测试，原因是无法准备临时 User Code");
      }

      await ensureDoorState(context, {
        phaseKey: "auto-lock.prepare",
        phaseLabel: "自动上锁消息测试",
        expectedBoltStatus: "locked",
      });
      const autoLock = await executePromptedNotificationPhase(context, {
        phaseKey: "auto-lock",
        phaseLabel: "自动上锁",
        expectedEvent: ACCESS_CONTROL_EVENTS.autoLock,
        expectedBoltStatus: "locked",
        timeoutMs: NOTIFICATION_WAIT_TIMEOUT_MS,
        promptMessage: "请先解锁设备，并等待设备自动上锁；检测到自动上锁消息后会自动继续。",
        promptMeta: "如果设备未开启 Auto Lock 或不支持该消息，请点击“跳过此消息测试”。",
      });

      const jammed = await executePromptedNotificationPhase(context, {
        phaseKey: "jammed",
        phaseLabel: "堵转",
        expectedEvent: ACCESS_CONTROL_EVENTS.jammed,
        timeoutMs: NOTIFICATION_WAIT_TIMEOUT_MS,
        promptMessage: "请触发设备堵转状态，检测到堵转消息后会自动继续。",
        promptMeta: "如果设备不支持该消息，请点击“跳过此消息测试”。",
      });

      await context.log("info", "result", "门锁 Notification 联动测试完成", {
        rfUnlock,
        rfLock,
        manualUnlock,
        manualLock,
        keypadUnlock,
        keypadLock,
        autoLock,
        jammed,
      });

      return {
        initialStatus,
        notificationSupport,
        rfUnlock,
        rfLock,
        manualUnlock,
        manualLock,
        keypadUnlock,
        keypadLock,
        autoLock,
        jammed,
      };
    } finally {
      if (temporaryUserCode) {
        await restoreTemporaryUserCode(context, temporaryUserCode);
      }
    }
  },
};
