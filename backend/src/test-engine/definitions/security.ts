import type { AnyRecord, BasicReportSnapshot, ExecutableTestDefinition, ScheduleKind } from "./cc-compliance-shared.js";
import {
  BASIC_SET_WAIT_MS,
  BASIC_VALUE_OFF,
  BASIC_VALUE_ON,
  BASIC_VALUE_UNKNOWN,
  DOOR_LOCK_MODE_SECURED,
  DOOR_LOCK_MODE_UNKNOWN,
  DOOR_LOCK_MODE_UNSECURED,
  SCHEDULE_AUTH_WAIT_MS,
  WAIT_SHORT_MS,
  assertBasicDoorLockMapping,
  assertDailyRepeatingSchedule,
  assertDateRecord,
  assertDoorLockReached,
  assertIntegerRange,
  assertOptionalIntegerRange,
  assertOptionalValidBasicValue,
  assertScheduleErased,
  assertScheduleFieldsMatch,
  assertScheduleSlotCount,
  assertScheduleTimeFields,
  assertSupervisionAccepted,
  assertTimeRecord,
  assertTimezoneMatches,
  assertTimezoneOffset,
  assertValidBasicValue,
  assertValidReportDuration,
  assertWeekDaySchedule,
  assertYearDaySchedule,
  compareDeviceTime,
  compareDeviceTimeForOffset,
  eraseScheduleByKind,
  getErrorMessage,
  getScheduleByKind,
  getScheduleSlotCount,
  hasDoorLockState,
  invokeOptional,
  isBasicOnValue,
  isDoorLockUnlocked,
  isEquivalentBasicTargetValue,
  isErasedSchedule,
  isExpectedDoorLockModeUpdate,
  isIntegerInRange,
  isKnownBoltStatus,
  isRecord,
  isRestorableDoorLockMode,
  isValidBasicValue,
  makeDailyRepeatingSchedule,
  makeFutureYearDaySchedule,
  makeInactiveWeekDaySchedule,
  makeScheduleEntryLockTimezone,
  makeTimeCcTimezone,
  makeWeekDaySchedule,
  makeYearDaySchedule,
  nodeCcVersion,
  nodeValues,
  normalizeBasicReport,
  normalizeDoorLockReport,
  numberOrZero,
  optionalNumber,
  parseTimezoneOffsets,
  pickNumber,
  readBasicReport,
  readCcPrecheck,
  readDoorLockReport,
  readDoorLockReportWithCache,
  requireNumber,
  requireScheduleSlots,
  restoreDoorLockMode,
  scheduleSlotInput,
  setDailyRepeatingSchedule,
  setScheduleEntryLockEnabled,
  setWeekDaySchedule,
  setYearDaySchedule,
  snapshotValues,
  supportedCcVersion,
  supportsBasicDoorLock,
  supportsBasicDoorLockV2,
  supportsCommandClass,
  supportsScheduleEntryLockDoorLock,
  timezoneMatches,
  tryReadBasicReport,
  valueSnapshot,
  valuesForCommandClass,
  waitForDoorLockModeUpdate,
  waitForDoorLockStillLocked,
  waitForDoorLockUnlocked,
  writeScheduleByKind,
} from "./cc-compliance-shared.js";

export const securitySchemeDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Security", "Security 2", "Door Lock", "User Credential"],
  meta: {
    id: "security-scheme-v1",
    key: "security-scheme",
    name: "Security / Security 2 安全等级",
    deviceType: "generic-node",
    version: 1,
    enabled: true,
    description: "确认节点安全加入状态、安全等级，以及门锁敏感 CC 是否在安全上下文中可用。",
    inputSchema: {},
  },
  supports(node) {
    return node.commandClasses.includes("Security") || node.commandClasses.includes("Security 2")
      ? { supported: true }
      : { supported: false, reason: "节点未发现 Security/Security 2 CC。" };
  },
  async run(context) {
    const s0 = context.node.commandClasses.includes("Security") ? await readCcPrecheck(context, "Security") : undefined;
    const s2 = context.node.commandClasses.includes("Security 2") ? await readCcPrecheck(context, "Security 2") : undefined;
    const securityClasses = context.node.securityClasses;
    const hasAccessControl = securityClasses.includes("S2_AccessControl") || securityClasses.includes("S0_Legacy");
    if (!context.node.isSecure) {
      throw new Error("节点声明 Security/Security 2 CC，但当前节点未标记为 secure。 ");
    }
    if (context.node.commandClasses.includes("Door Lock") && !hasAccessControl) {
      throw new Error(`门锁敏感命令应以 Access Control/S0 安全级别加入，当前 securityClasses=${securityClasses.join(",") || "(none)"}。`);
    }
    const doorLock = context.node.commandClasses.includes("Door Lock") ? await invokeOptional(context, "Door Lock", "get") : undefined;
    return { s0, s2, securityClasses, isSecure: context.node.isSecure, doorLock };
  },
};
