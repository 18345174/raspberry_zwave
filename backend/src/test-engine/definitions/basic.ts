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

export const basicDoorLockVersionDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Basic", "Door Lock", "Security 2"],
  meta: {
    id: "basic-door-lock-version-v1",
    key: "basic-door-lock-version",
    name: "Basic CC 版本与必选能力",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "根据 Lock DT 要求检查门锁是否支持 Basic v2、Door Lock v4，并记录安全加入信息。",
    inputSchema: {},
  },
  supports: supportsBasicDoorLock,
  async run(context) {
    const basic = await readCcPrecheck(context, "Basic");
    const doorLock = await readCcPrecheck(context, "Door Lock");
    if ((basic.version ?? 0) < 2) {
      throw new Error(`Lock DT 要求 Basic CC v2，当前为 v${String(basic.version ?? "unknown")}。`);
    }
    if ((doorLock.version ?? 0) < 4) {
      throw new Error(`Lock DT 要求 Door Lock CC v4，当前为 v${String(doorLock.version ?? "unknown")}。`);
    }
    if (!context.node.isSecure) {
      await context.log("warn", "basic.security", "门锁当前未显示为安全加入；Lock DT 通常应使用 Access Control 安全级别。", {
        securityClasses: context.node.securityClasses,
      });
    }
    await context.log("info", "result", "最终测试结果：通过 Basic CC 版本与 Lock DT 必选能力检查", {
      basicVersion: basic.version,
      doorLockVersion: doorLock.version,
      isSecure: context.node.isSecure,
      securityClasses: context.node.securityClasses,
    });
    return { basic, doorLock, isSecure: context.node.isSecure, securityClasses: context.node.securityClasses };
  },
};
export const basicGetReportDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Basic"],
  meta: {
    id: "basic-get-report-v1",
    key: "basic-get-report",
    name: "Basic Get/Report 响应",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "发送 Basic Get，验证设备返回可解析的 Basic Report Current Value。",
    inputSchema: {},
  },
  supports: supportsCommandClass("Basic"),
  async run(context) {
    const precheck = await readCcPrecheck(context, "Basic");
    const report = await readBasicReport(context);
    assertValidBasicValue(report.currentValue, "Basic Current Value");
    await context.log("info", "result", "最终测试结果：通过 Basic Get/Report 响应检查", { report });
    return { ...precheck, report };
  },
};
export const basicReportValueDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Basic"],
  meta: {
    id: "basic-report-value-legality-v1",
    key: "basic-report-value-legality",
    name: "Basic Report 字段合法性",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "检查 Basic Report Current/Target Value 不使用保留值，Duration 不使用 0xFF 保留编码。",
    inputSchema: {},
  },
  supports: supportsCommandClass("Basic"),
  async run(context) {
    const precheck = await readCcPrecheck(context, "Basic");
    const report = await readBasicReport(context);
    assertValidBasicValue(report.currentValue, "Basic Current Value");
    assertOptionalValidBasicValue(report.targetValue, "Basic Target Value");
    assertValidReportDuration(report.duration, "Basic Duration");
    await context.log("info", "result", "最终测试结果：通过 Basic Report 字段合法性检查", { report });
    return { ...precheck, report };
  },
};
export const basicDoorLockMappingDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Basic", "Door Lock"],
  meta: {
    id: "basic-door-lock-mapping-v1",
    key: "basic-door-lock-mapping",
    name: "Basic Report 门锁映射",
    deviceType: "door-lock",
    version: 2,
    enabled: true,
    description: "读取 Basic Report 与 Door Lock Operation Report，验证 0x00/0xFF 与门锁解锁/上锁状态映射。",
    inputSchema: {},
  },
  supports: supportsBasicDoorLock,
  async run(context) {
    const precheck = await readCcPrecheck(context, "Basic");
    const basic = await readBasicReport(context);
    const doorLock = await readDoorLockReport(context);
    assertBasicDoorLockMapping(basic.currentValue, doorLock);
    await context.log("info", "result", "最终测试结果：通过 Basic Report 与 Door Lock 状态映射检查", { basic, doorLock });
    return { ...precheck, basic, doorLock };
  },
};
export const basicSetSecuredMappingDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Basic", "Door Lock"],
  meta: {
    id: "basic-set-secured-mapping-v1",
    key: "basic-set-secured-mapping",
    name: "Basic Set 上锁映射",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "发送 Basic Set(0xFF)，验证 Door Lock 状态变为上锁，并尽量恢复测试前状态。",
    inputSchema: {},
  },
  supports: supportsBasicDoorLock,
  async run(context) {
    const beforeDoorLock = await readDoorLockReportWithCache(context, "basic.set.secured.before");
    const originalMode = optionalNumber(beforeDoorLock.currentMode);
    await context.log("warn", "basic.set.secured.start", "即将发送 Basic Set(0xFF) 上锁命令，测试结束会尽量恢复原门锁状态。", { beforeDoorLock });
    let afterDoorLock: AnyRecord | undefined;
    let afterBasic: BasicReportSnapshot | undefined;
    try {
      const modeUpdatePromise = waitForDoorLockModeUpdate(context, DOOR_LOCK_MODE_SECURED, "basic.set.secured.after");
      await context.invokeCcApi({ commandClass: "Basic", method: "set", args: [BASIC_VALUE_ON] });
      await context.wait(BASIC_SET_WAIT_MS);
      afterDoorLock = await readDoorLockReportWithCache(context, "basic.set.secured.after", modeUpdatePromise);
      afterBasic = await tryReadBasicReport(context, "basic.set.secured.after");
      assertDoorLockReached(afterDoorLock, DOOR_LOCK_MODE_SECURED, "Basic Set(0xFF)");
      if (afterBasic) {
        assertBasicDoorLockMapping(afterBasic.currentValue, afterDoorLock);
      }
      await context.log("info", "result", "最终测试结果：通过 Basic Set(0xFF) 上锁映射检查", { beforeDoorLock, afterDoorLock, afterBasic });
      return { beforeDoorLock, afterDoorLock, afterBasic };
    } finally {
      await restoreDoorLockMode(context, originalMode, DOOR_LOCK_MODE_SECURED);
    }
  },
};
export const basicSetUnsecuredMappingDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Basic", "Door Lock"],
  meta: {
    id: "basic-set-unsecured-mapping-v1",
    key: "basic-set-unsecured-mapping",
    name: "Basic Set 解锁映射",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "发送 Basic Set(0x00)，验证 Door Lock 状态变为解锁，并尽量恢复测试前状态；测试会短暂解锁门锁。",
    inputSchema: {},
  },
  supports: supportsBasicDoorLock,
  async run(context) {
    const beforeDoorLock = await readDoorLockReportWithCache(context, "basic.set.unsecured.before");
    const originalMode = optionalNumber(beforeDoorLock.currentMode);
    await context.log("warn", "basic.set.unsecured.start", "即将发送 Basic Set(0x00) 解锁命令，测试会短暂解锁门锁，结束后会尽量恢复原状态。", { beforeDoorLock });
    try {
      const modeUpdatePromise = waitForDoorLockModeUpdate(context, DOOR_LOCK_MODE_UNSECURED, "basic.set.unsecured.after");
      await context.invokeCcApi({ commandClass: "Basic", method: "set", args: [BASIC_VALUE_OFF] });
      await context.wait(BASIC_SET_WAIT_MS);
      const afterDoorLock = await readDoorLockReportWithCache(context, "basic.set.unsecured.after", modeUpdatePromise);
      const afterBasic = await tryReadBasicReport(context, "basic.set.unsecured.after");
      assertDoorLockReached(afterDoorLock, DOOR_LOCK_MODE_UNSECURED, "Basic Set(0x00)");
      if (afterBasic) {
        assertBasicDoorLockMapping(afterBasic.currentValue, afterDoorLock);
      }
      await context.log("info", "result", "最终测试结果：通过 Basic Set(0x00) 解锁映射检查", { beforeDoorLock, afterDoorLock, afterBasic });
      return { beforeDoorLock, afterDoorLock, afterBasic };
    } finally {
      await restoreDoorLockMode(context, originalMode, DOOR_LOCK_MODE_SECURED);
    }
  },
};
export const basicV2TargetDurationDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Basic", "Door Lock"],
  meta: {
    id: "basic-v2-target-duration-v1",
    key: "basic-v2-target-duration",
    name: "Basic v2 Target/Duration",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "Basic v2 写入后读取 Report，验证 Target Value 反映最近一次 Basic Set，Duration 编码合法，并恢复原门锁状态。",
    inputSchema: {},
  },
  supports: supportsBasicDoorLockV2,
  async run(context) {
    const beforeDoorLock = await readDoorLockReport(context);
    const originalMode = optionalNumber(beforeDoorLock.currentMode);
    const targetValue = originalMode === DOOR_LOCK_MODE_UNSECURED ? BASIC_VALUE_ON : BASIC_VALUE_OFF;
    await context.log("warn", "basic.v2.target.start", "即将发送 Basic Set 以验证 v2 Target Value/Duration，测试结束会尽量恢复原门锁状态。", {
      beforeDoorLock,
      targetValue,
    });
    try {
      await context.invokeCcApi({ commandClass: "Basic", method: "set", args: [targetValue] });
      await context.wait(WAIT_SHORT_MS);
      const reportDuringTransition = await readBasicReport(context);
      assertValidBasicValue(reportDuringTransition.currentValue, "Basic Current Value");
      assertOptionalValidBasicValue(reportDuringTransition.targetValue, "Basic Target Value");
      assertValidReportDuration(reportDuringTransition.duration, "Basic Duration");
      if (reportDuringTransition.targetValue == undefined) {
        throw new Error("Basic v2 Report 未返回 Target Value，无法证明其反映最近一次 Basic Set。");
      }
      const targetValueExactMatch = reportDuringTransition.targetValue === targetValue;
      if (!isEquivalentBasicTargetValue(reportDuringTransition.targetValue, targetValue)) {
        throw new Error(`Basic Target Value=${reportDuringTransition.targetValue}，期望最近一次 Basic Set 值 ${targetValue} 或等价 On 值。`);
      }
      if (!targetValueExactMatch) {
        await context.log("warn", "basic.v2.target.normalized", "Basic v2 Target Value 未精确回报原始 Set 值，但为等价 On 值，按门锁语义继续验证。", {
          actualTargetValue: reportDuringTransition.targetValue,
          expectedTargetValue: targetValue,
        });
      }
      await context.wait(BASIC_SET_WAIT_MS);
      const finalBasic = await readBasicReport(context);
      const finalDoorLock = await readDoorLockReport(context);
      assertBasicDoorLockMapping(finalBasic.currentValue, finalDoorLock);
      await context.log("info", "result", "最终测试结果：通过 Basic v2 Target Value/Duration 检查", {
        beforeDoorLock,
        reportDuringTransition,
        finalBasic,
        finalDoorLock,
      });
      return { beforeDoorLock, reportDuringTransition, finalBasic, finalDoorLock, targetValue, targetValueExactMatch };
    } finally {
      await restoreDoorLockMode(context, originalMode, DOOR_LOCK_MODE_SECURED);
    }
  },
};
