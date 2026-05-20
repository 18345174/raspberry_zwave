import { UserIDStatus } from "zwave-js";

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

interface ScheduleUserCodeReport {
  userId?: number;
  userIdStatus?: number;
  userCode?: string | Uint8Array;
}

function supportsScheduleEntryLockUserCode(node: { commandClasses: string[] }): { supported: boolean; reason?: string } {
  if (!node.commandClasses.includes("Schedule Entry Lock")) return { supported: false, reason: "节点未发现 Schedule Entry Lock CC。" };
  if (!node.commandClasses.includes("User Code")) return { supported: false, reason: "Schedule Entry Lock 写入用例需要先通过 User Code CC 建立有效用户。" };
  return { supported: true };
}

function supportsScheduleEntryLockUserCodeDoorLock(node: { commandClasses: string[] }): { supported: boolean; reason?: string } {
  const doorLockSupport = supportsScheduleEntryLockDoorLock(node);
  if (!doorLockSupport.supported) return doorLockSupport;
  if (!node.commandClasses.includes("User Code")) return { supported: false, reason: "Schedule Entry Lock 实际生效验证需要 User Code CC 准备可输入 PIN。" };
  return { supported: true };
}

function normalizeScheduleUserCode(value: string | Uint8Array | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("ascii");
  return undefined;
}

function formatScheduleUserCode(userId: number): string {
  return String(userId).padStart(Math.max(4, String(userId).length), "0");
}

async function getScheduleUserCodeReport(
  context: Parameters<ExecutableTestDefinition["run"]>[0],
  userId: number,
): Promise<ScheduleUserCodeReport | undefined> {
  return await context.invokeCcApi({
    commandClass: "User Code",
    method: "get",
    args: [userId],
  }) as ScheduleUserCodeReport | undefined;
}

async function ensureScheduleUserCode(
  context: Parameters<ExecutableTestDefinition["run"]>[0],
  userId: number,
  reason: string,
): Promise<{ userId: number; code: string; before?: ScheduleUserCodeReport; after?: ScheduleUserCodeReport; overwritten: boolean }> {
  const userCount = Number(await context.invokeCcApi({ commandClass: "User Code", method: "getUsersCount" }));
  if (!Number.isInteger(userCount) || userCount <= 0) {
    throw new Error(`User Code CC 返回的用户数量无效：${String(userCount)}。`);
  }
  if (userId > userCount) {
    throw new Error(`userId=${userId} 超过 User Code 支持范围 1..${userCount}，无法为 Schedule Entry Lock 准备有效用户。`);
  }

  const code = formatScheduleUserCode(userId);
  const before = await getScheduleUserCodeReport(context, userId);
  const beforeCode = normalizeScheduleUserCode(before?.userCode);
  const alreadyReady = before?.userIdStatus === UserIDStatus.Enabled && beforeCode === code;
  if (!alreadyReady) {
    await context.log("info", "schedule.user-code.prepare", `为 ${reason} 准备 User ID=${userId} 的有效 User Code。`, {
      userId,
      code,
      beforeStatus: before?.userIdStatus,
      beforeCode,
    });
    const setResult = await context.invokeCcApi({
      commandClass: "User Code",
      method: "set",
      args: [userId, UserIDStatus.Enabled, code],
    });
    assertSupervisionAccepted(setResult, `User Code Set userId=${userId}`);
    await context.wait(WAIT_SHORT_MS);
  }

  const after = await getScheduleUserCodeReport(context, userId);
  const afterCode = normalizeScheduleUserCode(after?.userCode);
  if (after?.userIdStatus !== UserIDStatus.Enabled) {
    throw new Error(`Schedule Entry Lock 写入前无法建立有效 User Code：userId=${userId} 状态=${String(after?.userIdStatus)}。`);
  }
  if (afterCode != undefined && afterCode !== code) {
    throw new Error(`Schedule Entry Lock 写入前 User Code 回读不匹配：userId=${userId} 期望 ${code}，实际 ${afterCode}。`);
  }

  const prepared = { userId, code, before, after, overwritten: !alreadyReady };
  await context.log("info", "schedule.user-code.ready", `User ID=${userId} 已可用于 Schedule Entry Lock 写入。`, prepared);
  return prepared;
}

function isScheduleEntryLockWriteRejectedError(error: unknown): boolean {
  const message = getErrorMessage(error);
  if (!message.includes("被设备 Supervision 拒绝")) return false;
  return [
    "Week Day Schedule",
    "Year Day Schedule",
    "Daily Repeating Schedule",
    "Enable userId",
    "Enable All",
  ].some((label) => message.includes(label));
}

async function handleScheduleEntryLockWriteUnsupported(
  context: Parameters<ExecutableTestDefinition["run"]>[0],
  label: string,
  error: unknown,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!isScheduleEntryLockWriteRejectedError(error)) {
    throw error;
  }

  const errorMessage = getErrorMessage(error);
  const reason = "设备支持 Schedule Entry Lock CC 的读取/能力上报，但拒绝 Set/Erase/Enable 写入类命令，判定为 0x4E 写入不支持。";
  const result = {
    ...payload,
    skipped: true,
    writeSupported: false,
    unsupportedReason: reason,
    error: errorMessage,
  };
  await context.log("warn", "schedule.write.unsupported", `最终测试结果：不适用 ${label}：${reason}`, result);
  return result;
}

async function runScheduleEntryLockWriteCheck(
  context: Parameters<ExecutableTestDefinition["run"]>[0],
  label: string,
  payload: Record<string, unknown>,
  action: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  try {
    return await action();
  } catch (error) {
    return await handleScheduleEntryLockWriteUnsupported(context, label, error, payload);
  }
}

export const scheduleEntryLockDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Schedule Entry Lock", "Time Parameters"],
  meta: {
    id: "schedule-entry-lock-compliance-v1",
    key: "schedule-entry-lock-compliance",
    name: "Schedule Entry Lock 计划表",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "读取门锁计划表 slot 能力、时区和首个 schedule slot；写入/删除 schedule 需单独开启 writeCheck。",
    inputSchema: { userId: { type: "number", default: 1 }, slotId: { type: "number", default: 1 }, writeCheck: { type: "boolean", default: false } },
  },
  supports: supportsCommandClass("Schedule Entry Lock"),
  async run(context) {
    const precheck = await readCcPrecheck(context, "Schedule Entry Lock");
    const userId = Number(context.inputs.userId ?? 1);
    const slotId = Number(context.inputs.slotId ?? 1);
    const slots = await invokeOptional(context, "Schedule Entry Lock", "getNumSlots") as AnyRecord | undefined;
    const timezone = await invokeOptional(context, "Schedule Entry Lock", "getTimezone") as AnyRecord | undefined;
    const weekDay = await invokeOptional(context, "Schedule Entry Lock", "getWeekDaySchedule", [{ userId, slotId }]);
    const yearDay = await invokeOptional(context, "Schedule Entry Lock", "getYearDaySchedule", [{ userId, slotId }]);
    const dailyRepeating = await invokeOptional(context, "Schedule Entry Lock", "getDailyRepeatingSchedule", [{ userId, slotId }]);
    if (!slots && !Object.keys(precheck.cachedValues).length) {
      throw new Error("Schedule Entry Lock 未返回 slot 能力或缓存值。 ");
    }
    if (context.inputs.writeCheck === true) {
      await context.log("warn", "schedule.write.not-implemented", "为避免破坏门锁通行计划，本版本仅做读取验证；实际写入/删除计划请在专用半自动用例中开启。", { userId, slotId });
    }
    return { ...precheck, userId, slotId, slots, timezone, weekDay, yearDay, dailyRepeating };
  },
};
export const scheduleEntryLockCapabilitiesDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Schedule Entry Lock", "User Code"],
  meta: {
    id: "schedule-entry-lock-capabilities-v1",
    key: "schedule-entry-lock-capabilities",
    name: "Schedule Entry Lock 能力与版本",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "读取 0x4E 版本和 Week Day / Year Day / Daily Repeating slot 数量，检查 v3 Daily Repeating 能力。",
    inputSchema: {},
  },
  supports: supportsCommandClass("Schedule Entry Lock"),
  async run(context) {
    const precheck = await readCcPrecheck(context, "Schedule Entry Lock");
    const slots = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getNumSlots" }) as AnyRecord | undefined;
    if (!slots) {
      throw new Error("Schedule Entry Lock Supported Report 未返回 slot 能力。");
    }
    assertScheduleSlotCount(slots.numWeekDaySlots, "numWeekDaySlots");
    assertScheduleSlotCount(slots.numYearDaySlots, "numYearDaySlots");
    if ((precheck.version ?? 1) >= 3) {
      assertScheduleSlotCount(slots.numDailyRepeatingSlots, "numDailyRepeatingSlots");
    }
    const userCount = context.node.commandClasses.includes("User Code")
      ? await invokeOptional(context, "User Code", "getUsersCount")
      : undefined;
    await context.log("info", "result", "最终测试结果：通过 Schedule Entry Lock 能力与版本检查", {
      version: precheck.version,
      slots,
      userCount,
    });
    return { ...precheck, slots, userCount };
  },
};
export const scheduleEntryLockTimeOffsetDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Schedule Entry Lock"],
  meta: {
    id: "schedule-entry-lock-time-offset-v1",
    key: "schedule-entry-lock-time-offset",
    name: "Schedule Entry Lock Time Offset",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "v2+ 读取 Schedule Entry Lock Time Offset，验证标准时区偏移和 DST 偏移编码合法。",
    inputSchema: {},
  },
  supports(node) {
    if (!node.commandClasses.includes("Schedule Entry Lock")) return { supported: false, reason: "节点未发现 Schedule Entry Lock CC。" };
    const version = nodeCcVersion(node, "Schedule Entry Lock");
    if (version != undefined && version < 2) return { supported: false, reason: `Schedule Entry Lock v${version} 不支持 Time Offset。` };
    return { supported: true };
  },
  async run(context) {
    const precheck = await readCcPrecheck(context, "Schedule Entry Lock");
    const timezone = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getTimezone" }) as AnyRecord | undefined;
    if (!timezone) {
      throw new Error("Schedule Entry Lock Time Offset Report 未返回。");
    }
    assertTimezoneOffset(timezone.standardOffset, "standardOffset");
    assertTimezoneOffset(timezone.dstOffset, "dstOffset");
    await context.log("info", "result", "最终测试结果：通过 Schedule Entry Lock Time Offset 检查", { timezone });
    return { ...precheck, timezone };
  },
};
export const scheduleEntryLockTimeDependencyDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Schedule Entry Lock", "Time"],
  meta: {
    id: "schedule-entry-lock-time-dependency-v1",
    key: "schedule-entry-lock-time-dependency",
    name: "Schedule Entry Lock 时间依赖",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "读取 Time CC 日期/时间/时区，验证设备本地时间可用于 Schedule Entry Lock 时间窗。",
    inputSchema: { maxDriftMinutes: { type: "number", default: 5 } },
  },
  supports(node) {
    if (!node.commandClasses.includes("Schedule Entry Lock")) return { supported: false, reason: "节点未发现 Schedule Entry Lock CC。" };
    if (!node.commandClasses.includes("Time")) return { supported: false, reason: "节点未发现 Time CC，无法执行时间依赖检查。" };
    return { supported: true };
  },
  async run(context) {
    const maxDriftMinutes = Number(context.inputs.maxDriftMinutes ?? 5);
    const schedulePrecheck = await readCcPrecheck(context, "Schedule Entry Lock");
    const timePrecheck = await readCcPrecheck(context, "Time");
    const [time, date, timeTimezone, scheduleTimezone] = await Promise.all([
      context.invokeCcApi({ commandClass: "Time", method: "getTime" }),
      context.invokeCcApi({ commandClass: "Time", method: "getDate" }),
      invokeOptional(context, "Time", "getTimezone"),
      schedulePrecheck.version != undefined && schedulePrecheck.version >= 2
        ? invokeOptional(context, "Schedule Entry Lock", "getTimezone")
        : undefined,
    ]);
    assertTimeRecord(time, "Time CC time");
    assertDateRecord(date, "Time CC date");
    if (isRecord(timeTimezone)) {
      assertTimezoneOffset(timeTimezone.standardOffset, "Time CC standardOffset");
      assertTimezoneOffset(timeTimezone.dstOffset, "Time CC dstOffset");
    }
    const drift = compareDeviceTime(date as AnyRecord, time as AnyRecord, isRecord(timeTimezone) ? timeTimezone : undefined);
    if (Number.isFinite(maxDriftMinutes) && drift.best.differenceMinutes > maxDriftMinutes) {
      throw new Error(`设备 Time CC 时间与控制器时间最小偏差约 ${drift.best.differenceMinutes} 分钟，超过 ${maxDriftMinutes} 分钟。`);
    }
    if (drift.best.interpretation === "reported-as-utc-with-time-offset") {
      await context.log("info", "time.utc-offset", "Time CC 时间按 UTC + Time Offset 解释后与控制器时间一致。", {
        time,
        date,
        timeTimezone,
        drift,
      });
    }
    if (isRecord(scheduleTimezone)) {
      assertTimezoneOffset(scheduleTimezone.standardOffset, "Schedule Entry Lock standardOffset");
      assertTimezoneOffset(scheduleTimezone.dstOffset, "Schedule Entry Lock dstOffset");
      if (isRecord(timeTimezone) && timeTimezone.standardOffset !== scheduleTimezone.standardOffset) {
        await context.log("warn", "time.offset.mismatch", "Time CC 与 Schedule Entry Lock Time Offset 的 standardOffset 不一致。", {
          timeTimezone,
          scheduleTimezone,
        });
      }
    }
    await context.log("info", "result", "最终测试结果：通过 Schedule Entry Lock 时间依赖检查", {
      time,
      date,
      drift,
      timeTimezone,
      scheduleTimezone,
      maxDriftMinutes,
    });
    return { schedulePrecheck, timePrecheck, time, date, drift, timeTimezone, scheduleTimezone, maxDriftMinutes };
  },
};
export const scheduleEntryLockTimezoneRoundTripDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Schedule Entry Lock", "Time"],
  meta: {
    id: "schedule-entry-lock-timezone-roundtrip-v1",
    key: "schedule-entry-lock-timezone-roundtrip",
    name: "Schedule Entry Lock / Time CC 时区切换回读",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "依次写入多个 Time CC Time Offset 并校验设备时间；Schedule Entry Lock Time Offset 若拒绝写入则记录告警；结束后恢复原始时区。",
    inputSchema: {
      offsetsMinutes: { type: "string", default: "0,480,-300" },
      maxDriftMinutes: { type: "number", default: 5 },
      settleMs: { type: "number", default: 1000 },
    },
  },
  supports(node) {
    if (!node.commandClasses.includes("Schedule Entry Lock")) return { supported: false, reason: "节点未发现 Schedule Entry Lock CC。" };
    if (!node.commandClasses.includes("Time")) return { supported: false, reason: "节点未发现 Time CC。" };
    const scheduleVersion = nodeCcVersion(node, "Schedule Entry Lock");
    if (scheduleVersion != undefined && scheduleVersion < 2) {
      return { supported: false, reason: `Schedule Entry Lock v${scheduleVersion} 不支持 Time Offset Set/Get。` };
    }
    const timeVersion = nodeCcVersion(node, "Time");
    if (timeVersion != undefined && timeVersion < 2) {
      return { supported: false, reason: `Time CC v${timeVersion} 不支持 Time Offset Set/Get。` };
    }
    return { supported: true };
  },
  async run(context) {
    const offsets = parseTimezoneOffsets(context.inputs.offsetsMinutes);
    const maxDriftMinutes = Number(context.inputs.maxDriftMinutes ?? 5);
    const settleMs = Math.max(0, Number(context.inputs.settleMs ?? 1000));
    const schedulePrecheck = await readCcPrecheck(context, "Schedule Entry Lock");
    const timePrecheck = await readCcPrecheck(context, "Time");
    const originalTimeTimezone = await context.invokeCcApi({ commandClass: "Time", method: "getTimezone" }) as AnyRecord | undefined;
    const originalScheduleTimezone = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getTimezone" }) as AnyRecord | undefined;
    if (!isRecord(originalTimeTimezone)) {
      throw new Error("Time CC 原始 Time Offset 未返回，无法安全执行写入/恢复测试。");
    }
    if (!isRecord(originalScheduleTimezone)) {
      throw new Error("Schedule Entry Lock 原始 Time Offset 未返回，无法安全执行写入/恢复测试。");
    }

    const results = [];
    try {
      for (const offset of offsets) {
        await context.log("info", "timezone.set.start", `写入 Time Offset ${offset} 分钟。`, { offset });
        const timeSetResult = await context.invokeCcApi({ commandClass: "Time", method: "setTimezone", args: [makeTimeCcTimezone(offset)] });
        let scheduleSetResult: unknown;
        try {
          scheduleSetResult = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "setTimezone", args: [makeScheduleEntryLockTimezone(offset)] });
        } catch (error) {
          scheduleSetResult = { error: getErrorMessage(error) };
          await context.log("warn", "timezone.schedule-set.failed", "Schedule Entry Lock Time Offset Set 调用失败，后续仅按 Time CC 时区校验设备时间。", {
            offset,
            scheduleSetResult,
          });
        }
        if (settleMs > 0) {
          await context.wait(settleMs);
        }

        const [timeTimezone, scheduleTimezone, time, date] = await Promise.all([
          context.invokeCcApi({ commandClass: "Time", method: "getTimezone" }),
          context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getTimezone" }),
          context.invokeCcApi({ commandClass: "Time", method: "getTime" }),
          context.invokeCcApi({ commandClass: "Time", method: "getDate" }),
        ]);
        assertTimezoneMatches(timeTimezone, offset, "Time CC");
        if (!timezoneMatches(scheduleTimezone, offset)) {
          await context.log("warn", "timezone.schedule-offset.mismatch", "Schedule Entry Lock Time Offset 未跟随本轮写入；该设备可能拒绝 0x4E Time Offset Set，按 Time CC 时间正确性继续判定。", {
            expectedOffset: offset,
            scheduleTimezone,
            scheduleSetResult,
          });
        }
        assertTimeRecord(time, "Time CC time");
        assertDateRecord(date, "Time CC date");
        const drift = compareDeviceTimeForOffset(date as AnyRecord, time as AnyRecord, offset);
        if (Number.isFinite(maxDriftMinutes) && drift.best.differenceMinutes > maxDriftMinutes) {
          throw new Error(`offset=${offset} 后设备 Time CC 时间与控制器时间最小偏差约 ${drift.best.differenceMinutes} 分钟，超过 ${maxDriftMinutes} 分钟。`);
        }
        const result = { offset, timeSetResult, scheduleSetResult, timeTimezone, scheduleTimezone, scheduleTimezoneMatched: timezoneMatches(scheduleTimezone, offset), time, date, drift };
        results.push(result);
        await context.log("info", "timezone.set.verify", `offset=${offset} 回读和时间校验通过。`, result);
      }
    } finally {
      await context.log("info", "timezone.restore.start", "恢复测试前的 Time CC / Schedule Entry Lock Time Offset。", {
        originalTimeTimezone,
        originalScheduleTimezone,
      });
      await context.invokeCcApi({ commandClass: "Time", method: "setTimezone", args: [originalTimeTimezone] });
      try {
        await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "setTimezone", args: [originalScheduleTimezone] });
      } catch (error) {
        await context.log("warn", "timezone.schedule-restore.failed", "Schedule Entry Lock Time Offset 恢复调用失败；Time CC 已按原值恢复。", {
          error: getErrorMessage(error),
          originalScheduleTimezone,
        });
      }
      if (settleMs > 0) {
        await context.wait(settleMs);
      }
    }

    await context.log("info", "result", "最终测试结果：通过 Schedule Entry Lock 时区切换回读检查", {
      offsets,
      results,
      restored: { timeTimezone: originalTimeTimezone, scheduleTimezone: originalScheduleTimezone },
      maxDriftMinutes,
    });
    return {
      schedulePrecheck,
      timePrecheck,
      offsets,
      results,
      restored: { timeTimezone: originalTimeTimezone, scheduleTimezone: originalScheduleTimezone },
      maxDriftMinutes,
    };
  },
};
export const scheduleEntryLockWeekDayReadDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Schedule Entry Lock"],
  meta: {
    id: "schedule-entry-lock-weekday-read-v1",
    key: "schedule-entry-lock-weekday-read",
    name: "Schedule Entry Lock Week Day 读取",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "读取指定用户 Week Day schedule slot，验证 weekday 和起止时间字段范围；空 slot 允许返回空值。",
    inputSchema: { userId: { type: "number", default: 1 }, slotId: { type: "number", default: 1 } },
  },
  supports: supportsCommandClass("Schedule Entry Lock"),
  async run(context) {
    const userId = Number(context.inputs.userId ?? 1);
    const slotId = Number(context.inputs.slotId ?? 1);
    const slots = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getNumSlots" }) as AnyRecord | undefined;
    const maxSlots = getScheduleSlotCount(slots, "numWeekDaySlots");
    if (maxSlots <= 0) throw new Error("设备声明不支持 Week Day schedule slot。");
    if (slotId < 1 || slotId > maxSlots) throw new Error(`Week Day slotId=${slotId} 超出支持范围 1..${maxSlots}。`);
    const schedule = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getWeekDaySchedule", args: [{ userId, slotId }] });
    assertWeekDaySchedule(schedule, "Week Day schedule");
    await context.log("info", "result", "最终测试结果：通过 Week Day schedule 读取检查", { userId, slotId, maxSlots, schedule });
    return { userId, slotId, slots, schedule };
  },
};
export const scheduleEntryLockYearDayReadDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Schedule Entry Lock"],
  meta: {
    id: "schedule-entry-lock-yearday-read-v1",
    key: "schedule-entry-lock-yearday-read",
    name: "Schedule Entry Lock Year Day 读取",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "读取指定用户 Year Day schedule slot，验证年月日时分字段范围；空 slot 允许返回空值。",
    inputSchema: { userId: { type: "number", default: 1 }, slotId: { type: "number", default: 1 } },
  },
  supports: supportsCommandClass("Schedule Entry Lock"),
  async run(context) {
    const userId = Number(context.inputs.userId ?? 1);
    const slotId = Number(context.inputs.slotId ?? 1);
    const slots = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getNumSlots" }) as AnyRecord | undefined;
    const maxSlots = getScheduleSlotCount(slots, "numYearDaySlots");
    if (maxSlots <= 0) throw new Error("设备声明不支持 Year Day schedule slot。");
    if (slotId < 1 || slotId > maxSlots) throw new Error(`Year Day slotId=${slotId} 超出支持范围 1..${maxSlots}。`);
    const schedule = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getYearDaySchedule", args: [{ userId, slotId }] });
    assertYearDaySchedule(schedule, "Year Day schedule");
    await context.log("info", "result", "最终测试结果：通过 Year Day schedule 读取检查", { userId, slotId, maxSlots, schedule });
    return { userId, slotId, slots, schedule };
  },
};
export const scheduleEntryLockDailyRepeatingReadDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Schedule Entry Lock"],
  meta: {
    id: "schedule-entry-lock-daily-repeating-read-v1",
    key: "schedule-entry-lock-daily-repeating-read",
    name: "Schedule Entry Lock Daily Repeating 读取",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "v3+ 读取指定用户 Daily Repeating schedule slot，验证 weekday bitmask、开始时间和持续时间。",
    inputSchema: { userId: { type: "number", default: 1 }, slotId: { type: "number", default: 1 } },
  },
  supports(node) {
    if (!node.commandClasses.includes("Schedule Entry Lock")) return { supported: false, reason: "节点未发现 Schedule Entry Lock CC。" };
    const version = nodeCcVersion(node, "Schedule Entry Lock");
    if (version != undefined && version < 3) return { supported: false, reason: `Schedule Entry Lock v${version} 不支持 Daily Repeating。` };
    return { supported: true };
  },
  async run(context) {
    const userId = Number(context.inputs.userId ?? 1);
    const slotId = Number(context.inputs.slotId ?? 1);
    const slots = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getNumSlots" }) as AnyRecord | undefined;
    const maxSlots = getScheduleSlotCount(slots, "numDailyRepeatingSlots");
    if (maxSlots <= 0) throw new Error("设备声明不支持 Daily Repeating schedule slot。");
    if (slotId < 1 || slotId > maxSlots) throw new Error(`Daily Repeating slotId=${slotId} 超出支持范围 1..${maxSlots}。`);
    const schedule = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getDailyRepeatingSchedule", args: [{ userId, slotId }] });
    assertDailyRepeatingSchedule(schedule, "Daily Repeating schedule");
    await context.log("info", "result", "最终测试结果：通过 Daily Repeating schedule 读取检查", { userId, slotId, maxSlots, schedule });
    return { userId, slotId, slots, schedule };
  },
};
export const scheduleEntryLockWeekDayLifecycleDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Schedule Entry Lock", "User Code"],
  meta: {
    id: "schedule-entry-lock-weekday-lifecycle-v1",
    key: "schedule-entry-lock-weekday-lifecycle",
    name: "Schedule Entry Lock Week Day 生命周期",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "先准备指定 userId 的有效 User Code，再覆盖写入 Week Day schedule、回读校验、删除 slot、删除后空 slot 校验。",
    inputSchema: { userId: { type: "number", default: 1 }, slotId: { type: "number", default: 1 } },
  },
  supports: supportsScheduleEntryLockUserCode,
  async run(context) {
    const slot = scheduleSlotInput(context);
    const preparedUser = await ensureScheduleUserCode(context, slot.userId, "Week Day schedule 生命周期");
    return await runScheduleEntryLockWriteCheck(context, "Week Day schedule 生命周期检查", { slot, preparedUser }, async () => {
      const slots = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getNumSlots" });
      const maxSlots = requireScheduleSlots(slots, "numWeekDaySlots", "Week Day", slot.slotId);
      const schedule = makeWeekDaySchedule();
      await setWeekDaySchedule(context, slot, schedule);
      const afterSet = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getWeekDaySchedule", args: [slot] });
      assertWeekDaySchedule(afterSet, "Week Day schedule");
      assertScheduleFieldsMatch(afterSet, schedule, ["weekday", "startHour", "startMinute", "stopHour", "stopMinute"], "Week Day schedule");
      await setWeekDaySchedule(context, slot);
      const afterErase = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getWeekDaySchedule", args: [slot] });
      assertScheduleErased(afterErase, "Week Day schedule");
      await context.log("info", "result", "最终测试结果：通过 Week Day schedule 生命周期检查", { slot, preparedUser, maxSlots, schedule, afterSet, afterErase });
      return { slot, preparedUser, slots, maxSlots, schedule, afterSet, afterErase };
    });
  },
};
export const scheduleEntryLockYearDayLifecycleDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Schedule Entry Lock", "User Code"],
  meta: {
    id: "schedule-entry-lock-yearday-lifecycle-v1",
    key: "schedule-entry-lock-yearday-lifecycle",
    name: "Schedule Entry Lock Year Day 生命周期",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "先准备指定 userId 的有效 User Code，再覆盖写入 Year Day schedule、起止时间合法性、回读校验、删除后空 slot 校验。",
    inputSchema: { userId: { type: "number", default: 1 }, slotId: { type: "number", default: 1 } },
  },
  supports: supportsScheduleEntryLockUserCode,
  async run(context) {
    const slot = scheduleSlotInput(context);
    const preparedUser = await ensureScheduleUserCode(context, slot.userId, "Year Day schedule 生命周期");
    return await runScheduleEntryLockWriteCheck(context, "Year Day schedule 生命周期检查", { slot, preparedUser }, async () => {
      const slots = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getNumSlots" });
      const maxSlots = requireScheduleSlots(slots, "numYearDaySlots", "Year Day", slot.slotId);
      const schedule = makeYearDaySchedule();
      assertYearDaySchedule(schedule, "Year Day schedule");
      await setYearDaySchedule(context, slot, schedule);
      const afterSet = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getYearDaySchedule", args: [slot] });
      assertYearDaySchedule(afterSet, "Year Day schedule");
      assertScheduleFieldsMatch(afterSet, schedule, ["startYear", "startMonth", "startDay", "startHour", "startMinute", "stopYear", "stopMonth", "stopDay", "stopHour", "stopMinute"], "Year Day schedule");
      await setYearDaySchedule(context, slot);
      const afterErase = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getYearDaySchedule", args: [slot] });
      assertScheduleErased(afterErase, "Year Day schedule");
      await context.log("info", "result", "最终测试结果：通过 Year Day schedule 生命周期检查", { slot, preparedUser, maxSlots, schedule, afterSet, afterErase });
      return { slot, preparedUser, slots, maxSlots, schedule, afterSet, afterErase };
    });
  },
};
export const scheduleEntryLockDailyRepeatingLifecycleDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Schedule Entry Lock", "User Code"],
  meta: {
    id: "schedule-entry-lock-daily-repeating-lifecycle-v1",
    key: "schedule-entry-lock-daily-repeating-lifecycle",
    name: "Schedule Entry Lock Daily Repeating 生命周期",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "v3+ 先准备指定 userId 的有效 User Code，再覆盖写入 Daily Repeating schedule、weekday bitmask/持续时间回读、删除后空 slot 校验。",
    inputSchema: { userId: { type: "number", default: 1 }, slotId: { type: "number", default: 1 } },
  },
  supports(node) {
    const userCodeSupport = supportsScheduleEntryLockUserCode(node);
    if (!userCodeSupport.supported) return userCodeSupport;
    const version = nodeCcVersion(node, "Schedule Entry Lock");
    if (version != undefined && version < 3) return { supported: false, reason: `Schedule Entry Lock v${version} 不支持 Daily Repeating。` };
    return { supported: true };
  },
  async run(context) {
    const slot = scheduleSlotInput(context);
    const preparedUser = await ensureScheduleUserCode(context, slot.userId, "Daily Repeating schedule 生命周期");
    return await runScheduleEntryLockWriteCheck(context, "Daily Repeating schedule 生命周期检查", { slot, preparedUser }, async () => {
      const slots = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getNumSlots" });
      const maxSlots = requireScheduleSlots(slots, "numDailyRepeatingSlots", "Daily Repeating", slot.slotId);
      const schedule = makeDailyRepeatingSchedule();
      await setDailyRepeatingSchedule(context, slot, schedule);
      const afterSet = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getDailyRepeatingSchedule", args: [slot] });
      assertDailyRepeatingSchedule(afterSet, "Daily Repeating schedule");
      assertScheduleFieldsMatch(afterSet, schedule, ["weekdays", "startHour", "startMinute", "durationHour", "durationMinute"], "Daily Repeating schedule");
      await setDailyRepeatingSchedule(context, slot);
      const afterErase = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getDailyRepeatingSchedule", args: [slot] });
      assertScheduleErased(afterErase, "Daily Repeating schedule");
      await context.log("info", "result", "最终测试结果：通过 Daily Repeating schedule 生命周期检查", { slot, preparedUser, maxSlots, schedule, afterSet, afterErase });
      return { slot, preparedUser, slots, maxSlots, schedule, afterSet, afterErase };
    });
  },
};
export const scheduleEntryLockSlotBoundaryDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Schedule Entry Lock"],
  meta: {
    id: "schedule-entry-lock-slot-boundary-v1",
    key: "schedule-entry-lock-slot-boundary",
    name: "Schedule Entry Lock slot 边界",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "按 Supported Report 验证首尾合法 slot 可读取，slot=0 和 max+1 不应被当作有效 slot 接受。",
    inputSchema: { userId: { type: "number", default: 1 } },
  },
  supports: supportsCommandClass("Schedule Entry Lock"),
  async run(context) {
    const userId = Number(context.inputs.userId ?? 1);
    assertIntegerRange(userId, "userId", 1, 255);
    const slots = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getNumSlots" });
    const results = [];
    const kinds: Array<{ kind: ScheduleKind; countKey: string; label: string }> = [
      { kind: "weekday", countKey: "numWeekDaySlots", label: "Week Day" },
      { kind: "yearday", countKey: "numYearDaySlots", label: "Year Day" },
      { kind: "dailyRepeating", countKey: "numDailyRepeatingSlots", label: "Daily Repeating" },
    ];
    for (const item of kinds) {
      const count = getScheduleSlotCount(slots, item.countKey);
      if (count <= 0) {
        results.push({ ...item, count, skipped: true });
        continue;
      }
      const validReads = [];
      for (const slotId of [...new Set([1, count])]) {
        const schedule = await getScheduleByKind(context, item.kind, { userId, slotId });
        validReads.push({ slotId, schedule });
      }
      const invalidReads = [];
      for (const slotId of [0, count + 1]) {
        try {
          const schedule = await getScheduleByKind(context, item.kind, { userId, slotId });
          invalidReads.push({ slotId, accepted: true, schedule });
          if (schedule != undefined) {
            throw new Error(`${item.label} 非法 slotId=${slotId} 被设备返回有效响应：${JSON.stringify(schedule)}。`);
          }
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          if (errorMessage.includes("非法 slotId=")) {
            throw error;
          }
          invalidReads.push({ slotId, accepted: false, error: errorMessage });
        }
      }
      results.push({ ...item, count, validReads, invalidReads });
    }
    await context.log("info", "result", "最终测试结果：通过 Schedule Entry Lock slot 边界检查", { userId, slots, results });
    return { userId, slots, results };
  },
};
export const scheduleEntryLockEmptySlotReportDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Schedule Entry Lock", "User Code"],
  meta: {
    id: "schedule-entry-lock-empty-slot-report-v1",
    key: "schedule-entry-lock-empty-slot-report",
    name: "Schedule Entry Lock 空 slot 上报",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "先准备指定 userId 的有效 User Code，再删除各类 schedule slot 后读取，验证 empty/erased slot 不应返回有效计划表字段。",
    inputSchema: { userId: { type: "number", default: 1 }, slotId: { type: "number", default: 1 } },
  },
  supports: supportsScheduleEntryLockUserCode,
  async run(context) {
    const slot = scheduleSlotInput(context);
    const preparedUser = await ensureScheduleUserCode(context, slot.userId, "空 slot 上报检查");
    return await runScheduleEntryLockWriteCheck(context, "空 slot 上报检查", { slot, preparedUser }, async () => {
      const slots = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getNumSlots" });
      const results = [];
      const kinds: Array<{ kind: ScheduleKind; countKey: string; label: string }> = [
        { kind: "weekday", countKey: "numWeekDaySlots", label: "Week Day" },
        { kind: "yearday", countKey: "numYearDaySlots", label: "Year Day" },
        { kind: "dailyRepeating", countKey: "numDailyRepeatingSlots", label: "Daily Repeating" },
      ];
      for (const item of kinds) {
        const count = getScheduleSlotCount(slots, item.countKey);
        if (count <= 0 || slot.slotId > count) {
          results.push({ ...item, count, skipped: true });
          continue;
        }
        await eraseScheduleByKind(context, item.kind, slot);
        const afterErase = await getScheduleByKind(context, item.kind, slot);
        assertScheduleErased(afterErase, `${item.label} schedule`);
        results.push({ ...item, count, afterErase });
      }
      await context.log("info", "result", "最终测试结果：通过 Schedule Entry Lock 空 slot 上报检查", { slot, preparedUser, slots, results });
      return { slot, preparedUser, slots, results };
    });
  },
};
export const scheduleEntryLockEnableDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Schedule Entry Lock", "User Code"],
  meta: {
    id: "schedule-entry-lock-enable-v1",
    key: "schedule-entry-lock-enable",
    name: "Schedule Entry Lock Enable Set",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "先准备指定 userId 的有效 User Code，再对该 userId 依次发送 disable/enable，验证设备接受 Enable Set 命令。",
    inputSchema: { userId: { type: "number", default: 1 } },
  },
  supports: supportsScheduleEntryLockUserCode,
  async run(context) {
    const userId = Number(context.inputs.userId ?? 1);
    assertIntegerRange(userId, "userId", 1, 255);
    const preparedUser = await ensureScheduleUserCode(context, userId, "Enable Set 检查");
    return await runScheduleEntryLockWriteCheck(context, "Enable Set 检查", { userId, preparedUser }, async () => {
      const disableResult = await setScheduleEntryLockEnabled(context, false, userId);
      const enableResult = await setScheduleEntryLockEnabled(context, true, userId);
      await context.log("info", "result", "最终测试结果：通过 Schedule Entry Lock Enable Set 检查", { userId, preparedUser, disableResult, enableResult });
      return { userId, preparedUser, disableResult, enableResult };
    });
  },
};
export const scheduleEntryLockEnableAllDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Schedule Entry Lock", "User Code"],
  meta: {
    id: "schedule-entry-lock-enable-all-v1",
    key: "schedule-entry-lock-enable-all",
    name: "Schedule Entry Lock Enable All Set",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "先准备一个有效 User Code，再依次发送全局 disable/enable，验证设备接受 Enable All Set 命令。",
    inputSchema: { userId: { type: "number", default: 1 } },
  },
  supports: supportsScheduleEntryLockUserCode,
  async run(context) {
    const userId = Number(context.inputs.userId ?? 1);
    assertIntegerRange(userId, "userId", 1, 255);
    const preparedUser = await ensureScheduleUserCode(context, userId, "Enable All Set 检查");
    return await runScheduleEntryLockWriteCheck(context, "Enable All Set 检查", { preparedUser }, async () => {
      const disableAllResult = await setScheduleEntryLockEnabled(context, false);
      const enableAllResult = await setScheduleEntryLockEnabled(context, true);
      await context.log("info", "result", "最终测试结果：通过 Schedule Entry Lock Enable All Set 检查", { preparedUser, disableAllResult, enableAllResult });
      return { preparedUser, disableAllResult, enableAllResult };
    });
  },
};
export const scheduleEntryLockTypeSwitchDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Schedule Entry Lock", "User Code"],
  meta: {
    id: "schedule-entry-lock-type-switch-v1",
    key: "schedule-entry-lock-type-switch",
    name: "Schedule Entry Lock 类型切换",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "先准备指定 userId 的有效 User Code，再同一 userId 依次写入 Week Day / Year Day / Daily Repeating，验证设备可切换并回读各类 schedule。",
    inputSchema: { userId: { type: "number", default: 1 }, slotId: { type: "number", default: 1 } },
  },
  supports: supportsScheduleEntryLockUserCode,
  async run(context) {
    const slot = scheduleSlotInput(context);
    const preparedUser = await ensureScheduleUserCode(context, slot.userId, "schedule 类型切换检查");
    return await runScheduleEntryLockWriteCheck(context, "Schedule 类型切换检查", { slot, preparedUser }, async () => {
      const slots = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getNumSlots" });
      const steps = [];
      const candidates: Array<{ kind: ScheduleKind; countKey: string; label: string; schedule: AnyRecord; fields: string[] }> = [
        { kind: "weekday", countKey: "numWeekDaySlots", label: "Week Day", schedule: makeWeekDaySchedule(), fields: ["weekday", "startHour", "startMinute", "stopHour", "stopMinute"] },
        { kind: "yearday", countKey: "numYearDaySlots", label: "Year Day", schedule: makeYearDaySchedule(), fields: ["startYear", "startMonth", "startDay", "startHour", "startMinute", "stopYear", "stopMonth", "stopDay", "stopHour", "stopMinute"] },
        { kind: "dailyRepeating", countKey: "numDailyRepeatingSlots", label: "Daily Repeating", schedule: makeDailyRepeatingSchedule(), fields: ["weekdays", "startHour", "startMinute", "durationHour", "durationMinute"] },
      ];
      for (const candidate of candidates) {
        const count = getScheduleSlotCount(slots, candidate.countKey);
        if (count <= 0 || slot.slotId > count) {
          steps.push({ ...candidate, count, skipped: true });
          continue;
        }
        const writeResult = await writeScheduleByKind(context, candidate.kind, slot, candidate.schedule);
        await setScheduleEntryLockEnabled(context, true, slot.userId);
        const afterSet = await getScheduleByKind(context, candidate.kind, slot);
        assertScheduleFieldsMatch(afterSet, candidate.schedule, candidate.fields, `${candidate.label} schedule`);
        steps.push({ kind: candidate.kind, label: candidate.label, count, writeResult, afterSet });
      }
      await context.log("info", "result", "最终测试结果：通过 Schedule Entry Lock 类型切换检查", { slot, preparedUser, slots, steps });
      return { slot, preparedUser, slots, steps };
    });
  },
};
export const scheduleEntryLockManualAuthDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Schedule Entry Lock", "Door Lock", "User Code"],
  meta: {
    id: "schedule-entry-lock-manual-auth-v1",
    key: "schedule-entry-lock-manual-auth",
    name: "Schedule Entry Lock 实际生效半自动",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "先准备指定 userId 的有效 User Code，写入当前有效计划后提示本地输入 PIN 应可解锁，再写入非当前时间计划后提示输入 PIN 应不可解锁。",
    inputSchema: { userId: { type: "number", default: 1 }, slotId: { type: "number", default: 1 }, waitMs: { type: "number", default: SCHEDULE_AUTH_WAIT_MS } },
  },
  supports: supportsScheduleEntryLockUserCodeDoorLock,
  async run(context) {
    const slot = scheduleSlotInput(context);
    const waitMs = Math.max(5000, Number(context.inputs.waitMs ?? SCHEDULE_AUTH_WAIT_MS));
    const preparedUser = await ensureScheduleUserCode(context, slot.userId, "实际生效半自动验证");
    const slots = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "getNumSlots" });
    const dailyCount = getScheduleSlotCount(slots, "numDailyRepeatingSlots");
    const weekDayCount = getScheduleSlotCount(slots, "numWeekDaySlots");
    const yearDayCount = getScheduleSlotCount(slots, "numYearDaySlots");
    const activeKind: ScheduleKind = dailyCount >= slot.slotId ? "dailyRepeating" : "weekday";
    if (activeKind === "weekday" && weekDayCount < slot.slotId) {
      throw new Error("设备没有可用于实际生效验证的 Daily Repeating 或 Week Day slot。");
    }
    const activeSchedule = activeKind === "dailyRepeating" ? makeDailyRepeatingSchedule() : makeWeekDaySchedule();
    const inactiveKind: ScheduleKind = yearDayCount >= slot.slotId ? "yearday" : "weekday";
    const inactiveSchedule = inactiveKind === "yearday" ? makeFutureYearDaySchedule() : makeInactiveWeekDaySchedule();
    const beforeDoorLock = await readDoorLockReport(context);
    const originalMode = optionalNumber(beforeDoorLock.currentMode);

    try {
      return await runScheduleEntryLockWriteCheck(context, "实际生效半自动检查", { slot, preparedUser, slots, activeKind, inactiveKind }, async () => {
        await writeScheduleByKind(context, activeKind, slot, activeSchedule);
        await setScheduleEntryLockEnabled(context, true, slot.userId);
        await restoreDoorLockMode(context, DOOR_LOCK_MODE_SECURED, DOOR_LOCK_MODE_SECURED);
        await context.log("info", "manual.wait", `请在门锁上输入 User ID=${slot.userId} 的 PIN=${preparedUser.code}，当前计划应允许通行。`, {
          promptKey: "schedule.active.auth",
          promptTitle: "Schedule 有效时间内认证",
          promptMessage: `请在 ${Math.round(waitMs / 1000)} 秒内输入 User ID=${slot.userId} 的 PIN=${preparedUser.code} 本地开锁，期望门锁解锁。`,
          promptMeta: `activeKind=${activeKind}，slotId=${slot.slotId}`,
          timeoutMs: waitMs,
        });
        const activeAuthStatus = await waitForDoorLockUnlocked(context, waitMs);
        await context.log("info", "manual.done", "Schedule 有效时间内认证完成，检测到门锁解锁。", { activeAuthStatus });

        await restoreDoorLockMode(context, DOOR_LOCK_MODE_SECURED, DOOR_LOCK_MODE_SECURED);
        await writeScheduleByKind(context, inactiveKind, slot, inactiveSchedule);
        await setScheduleEntryLockEnabled(context, true, slot.userId);
        await context.log("info", "manual.wait", `请再次在门锁上输入 User ID=${slot.userId} 的 PIN=${preparedUser.code}，当前计划应拒绝通行。`, {
          promptKey: "schedule.inactive.auth",
          promptTitle: "Schedule 非有效时间认证",
          promptMessage: `请在 ${Math.round(waitMs / 1000)} 秒内输入 User ID=${slot.userId} 的 PIN=${preparedUser.code} 本地开锁，期望门锁保持上锁。`,
          promptMeta: `inactiveKind=${inactiveKind}，slotId=${slot.slotId}`,
          timeoutMs: waitMs,
        });
        const inactiveAuthStatus = await waitForDoorLockStillLocked(context, waitMs);
        await context.log("info", "manual.done", "Schedule 非有效时间认证完成，门锁保持上锁。", { inactiveAuthStatus });
        await context.log("info", "result", "最终测试结果：通过 Schedule Entry Lock 实际生效半自动检查", {
          slot,
          preparedUser,
          activeKind,
          activeSchedule,
          activeAuthStatus,
          inactiveKind,
          inactiveSchedule,
          inactiveAuthStatus,
        });
        return { slot, preparedUser, slots, activeKind, activeSchedule, activeAuthStatus, inactiveKind, inactiveSchedule, inactiveAuthStatus };
      });
    } finally {
      await restoreDoorLockMode(context, originalMode, DOOR_LOCK_MODE_SECURED);
    }
  },
};
