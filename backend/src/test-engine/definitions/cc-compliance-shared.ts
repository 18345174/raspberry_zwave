import type { ExecutableTestDefinition, TestExecutionContext } from "../types.js";
export type { ExecutableTestDefinition, TestExecutionContext };

export const WAIT_SHORT_MS = 700;
export const BASIC_SET_WAIT_MS = 5000;
export const BASIC_VALUE_OFF = 0x00;
export const BASIC_VALUE_UNKNOWN = 0xfe;
export const BASIC_VALUE_ON = 0xff;
export const DOOR_LOCK_MODE_UNSECURED = 0x00;
export const DOOR_LOCK_MODE_UNKNOWN = 0xfe;
export const DOOR_LOCK_MODE_SECURED = 0xff;
export const SCHEDULE_AUTH_WAIT_MS = 30000;

export type SupportCheck = { supported: boolean; reason?: string };
export type AnyRecord = Record<string, unknown>;
export type ScheduleKind = "weekday" | "yearday" | "dailyRepeating";
export type BasicReportSnapshot = {
  currentValue?: number;
  targetValue?: number;
  duration?: unknown;
  raw?: unknown;
};

export function supportsCommandClass(commandClass: string): (node: { commandClasses: string[] }) => SupportCheck {
  return (node) => node.commandClasses.includes(commandClass)
    ? { supported: true }
    : { supported: false, reason: `节点未发现 ${commandClass} CC。` };
}

export function nodeCcVersion(node: { commandClassDetails?: Array<{ name: string; version?: number }> }, commandClass: string): number | undefined {
  return node.commandClassDetails?.find((item) => item.name === commandClass)?.version;
}

export function supportsBasicDoorLock(node: { commandClasses: string[] }): SupportCheck {
  if (!node.commandClasses.includes("Basic")) return { supported: false, reason: "节点未发现 Basic CC。" };
  if (!node.commandClasses.includes("Door Lock")) return { supported: false, reason: "节点未发现 Door Lock CC。" };
  return { supported: true };
}

export function supportsScheduleEntryLockDoorLock(node: { commandClasses: string[] }): SupportCheck {
  if (!node.commandClasses.includes("Schedule Entry Lock")) return { supported: false, reason: "节点未发现 Schedule Entry Lock CC。" };
  if (!node.commandClasses.includes("Door Lock")) return { supported: false, reason: "节点未发现 Door Lock CC，无法验证计划表实际开锁效果。" };
  return { supported: true };
}

export function supportsBasicDoorLockV2(node: { commandClasses: string[]; commandClassDetails?: Array<{ name: string; version?: number }> }): SupportCheck {
  const support = supportsBasicDoorLock(node);
  if (!support.supported) return support;
  const version = nodeCcVersion(node, "Basic");
  if (version != undefined && version < 2) {
    return { supported: false, reason: `Basic CC 版本为 v${version}，该用例需要 v2。` };
  }
  return { supported: true };
}

export function supportedCcVersion(context: TestExecutionContext, commandClass: string): number | undefined {
  return nodeCcVersion(context.node, commandClass);
}

export function nodeValues(context: TestExecutionContext, commandClass: string): AnyRecord[] {
  return valuesForCommandClass(context.node.values as unknown[], commandClass);
}

export function valuesForCommandClass(values: unknown[] | undefined, commandClass: string): AnyRecord[] {
  return (values ?? []).filter((value) => isRecord(value) && value.commandClass === commandClass) as AnyRecord[];
}

export function valueSnapshot(context: TestExecutionContext, commandClass: string): Record<string, unknown> {
  return snapshotValues(nodeValues(context, commandClass));
}

export function snapshotValues(values: AnyRecord[]): Record<string, unknown> {
  return Object.fromEntries(values.map((value) => {
    const property = String(value.property);
    const key = value.propertyKey != undefined ? `${property}[${String(value.propertyKey)}]` : property;
    return [key, value.value];
  }));
}

export async function invokeOptional(
  context: TestExecutionContext,
  commandClass: string,
  method: string,
  args: unknown[] = [],
): Promise<unknown> {
  try {
    return await context.invokeCcApi({ commandClass, method, args });
  } catch (error) {
    await context.log("warn", `${commandClass}.${method}.unsupported`, `${commandClass}.${method} 调用失败，使用已采访缓存继续判定`, {
      error: error instanceof Error ? error.message : String(error),
      method,
      args,
    });
    return undefined;
  }
}

export async function readCcPrecheck(context: TestExecutionContext, commandClass: string): Promise<{ version?: number; cachedValues: Record<string, unknown> }> {
  const version = supportedCcVersion(context, commandClass);
  const cachedValues = valueSnapshot(context, commandClass);
  await context.log("info", "precheck.cc", `读取 ${commandClass} CC 基础信息`, {
    commandClass,
    version,
    cachedValueCount: Object.keys(cachedValues).length,
    cachedValues,
  });
  return { version, cachedValues };
}

export function requireNumber(value: unknown, label: string): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    throw new Error(`${label} 未返回有效数字。`);
  }
  return numberValue;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalNumber(value: unknown): number | undefined {
  if (value == undefined) {
    return undefined;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

export function pickNumber(record: AnyRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const numberValue = optionalNumber(record[key]);
    if (numberValue != undefined) {
      return numberValue;
    }
  }
  return undefined;
}


export function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  const numberValue = optionalNumber(value);
  return numberValue != undefined && Number.isInteger(numberValue) && numberValue >= min && numberValue <= max;
}

export function assertIntegerRange(value: unknown, label: string, min: number, max: number): void {
  if (!isIntegerInRange(value, min, max)) {
    throw new Error(`${label}=${String(value)} 超出合法范围 ${min}..${max}。`);
  }
}

export function assertOptionalIntegerRange(value: unknown, label: string, min: number, max: number): void {
  if (value != undefined) {
    assertIntegerRange(value, label, min, max);
  }
}

export function isErasedSchedule(schedule: unknown): boolean {
  return schedule == undefined || schedule === false || (isRecord(schedule) && Object.keys(schedule).length === 0);
}

export function assertScheduleSlotCount(value: unknown, label: string): void {
  assertIntegerRange(value, label, 0, 255);
}

export function numberOrZero(value: unknown): number {
  return optionalNumber(value) ?? 0;
}

export function getScheduleSlotCount(slots: unknown, key: string): number {
  return isRecord(slots) ? numberOrZero(slots[key]) : 0;
}

export function assertTimezoneOffset(value: unknown, label: string): void {
  const offset = optionalNumber(value);
  if (offset == undefined || !Number.isInteger(offset) || offset < -24 * 60 || offset > 24 * 60) {
    throw new Error(`${label}=${String(value)} 不是合法的分钟偏移值。`);
  }
}

export function assertTimeRecord(time: unknown, label: string): void {
  if (!isRecord(time)) {
    throw new Error(`${label} 未返回有效时间。`);
  }
  assertIntegerRange(time.hour, `${label}.hour`, 0, 23);
  assertIntegerRange(time.minute, `${label}.minute`, 0, 59);
  assertIntegerRange(time.second, `${label}.second`, 0, 59);
}

export function assertDateRecord(date: unknown, label: string): void {
  if (!isRecord(date)) {
    throw new Error(`${label} 未返回有效日期。`);
  }
  assertIntegerRange(date.year, `${label}.year`, 2000, 9999);
  assertIntegerRange(date.month, `${label}.month`, 1, 12);
  assertIntegerRange(date.day, `${label}.day`, 1, 31);
  const parsed = new Date(Number(date.year), Number(date.month) - 1, Number(date.day));
  if (parsed.getFullYear() !== Number(date.year) || parsed.getMonth() !== Number(date.month) - 1 || parsed.getDate() !== Number(date.day)) {
    throw new Error(`${label} 日期 ${String(date.year)}-${String(date.month)}-${String(date.day)} 不存在。`);
  }
}

export function assertScheduleTimeFields(schedule: AnyRecord, label: string): void {
  assertOptionalIntegerRange(schedule.startHour, `${label}.startHour`, 0, 23);
  assertOptionalIntegerRange(schedule.startMinute, `${label}.startMinute`, 0, 59);
  assertOptionalIntegerRange(schedule.stopHour, `${label}.stopHour`, 0, 23);
  assertOptionalIntegerRange(schedule.stopMinute, `${label}.stopMinute`, 0, 59);
  assertOptionalIntegerRange(schedule.durationHour, `${label}.durationHour`, 0, 23);
  assertOptionalIntegerRange(schedule.durationMinute, `${label}.durationMinute`, 0, 59);
}

export function assertWeekDaySchedule(schedule: unknown, label: string): void {
  if (isErasedSchedule(schedule)) return;
  if (!isRecord(schedule)) throw new Error(`${label} 未返回有效 Week Day schedule。`);
  assertIntegerRange(schedule.weekday, `${label}.weekday`, 0, 6);
  assertScheduleTimeFields(schedule, label);
  const startTotal = Number(schedule.startHour) * 60 + Number(schedule.startMinute);
  const stopTotal = Number(schedule.stopHour) * 60 + Number(schedule.stopMinute);
  if (stopTotal <= startTotal) {
    throw new Error(`${label} stop time 必须晚于 start time，且 Week Day schedule 不能跨天。`);
  }
}

export function assertYearDaySchedule(schedule: unknown, label: string): void {
  if (isErasedSchedule(schedule)) return;
  if (!isRecord(schedule)) throw new Error(`${label} 未返回有效 Year Day schedule。`);
  assertIntegerRange(schedule.startYear, `${label}.startYear`, 0, 99);
  assertIntegerRange(schedule.startMonth, `${label}.startMonth`, 1, 12);
  assertIntegerRange(schedule.startDay, `${label}.startDay`, 1, 31);
  assertIntegerRange(schedule.startHour, `${label}.startHour`, 0, 23);
  assertIntegerRange(schedule.startMinute, `${label}.startMinute`, 0, 59);
  assertIntegerRange(schedule.stopYear, `${label}.stopYear`, 0, 99);
  assertIntegerRange(schedule.stopMonth, `${label}.stopMonth`, 1, 12);
  assertIntegerRange(schedule.stopDay, `${label}.stopDay`, 1, 31);
  assertIntegerRange(schedule.stopHour, `${label}.stopHour`, 0, 23);
  assertIntegerRange(schedule.stopMinute, `${label}.stopMinute`, 0, 59);
  const start = new Date(2000 + Number(schedule.startYear), Number(schedule.startMonth) - 1, Number(schedule.startDay), Number(schedule.startHour), Number(schedule.startMinute));
  const stop = new Date(2000 + Number(schedule.stopYear), Number(schedule.stopMonth) - 1, Number(schedule.stopDay), Number(schedule.stopHour), Number(schedule.stopMinute));
  if (stop <= start) {
    throw new Error(`${label} stop date/time 必须晚于 start date/time。`);
  }
}

export function assertDailyRepeatingSchedule(schedule: unknown, label: string): void {
  if (isErasedSchedule(schedule)) return;
  if (!isRecord(schedule)) throw new Error(`${label} 未返回有效 Daily Repeating schedule。`);
  if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length < 1) {
    throw new Error(`${label}.weekdays 必须至少包含一天。`);
  }
  for (const weekday of schedule.weekdays) {
    assertIntegerRange(weekday, `${label}.weekdays[]`, 0, 6);
  }
  assertScheduleTimeFields(schedule, label);
  const durationTotal = Number(schedule.durationHour) * 60 + Number(schedule.durationMinute);
  if (durationTotal <= 0) {
    throw new Error(`${label} duration 必须大于 0。`);
  }
}

export function assertScheduleErased(schedule: unknown, label: string): void {
  if (isErasedSchedule(schedule)) return;
  throw new Error(`${label} 删除后仍返回有效 schedule：${JSON.stringify(schedule)}`);
}

export function assertSupervisionAccepted(result: unknown, label: string): void {
  if (!isRecord(result) || result.status == undefined) return;
  const status = Number(result.status);
  if (status === 0 || status === 2) {
    throw new Error(`${label} 被设备 Supervision 拒绝，status=${status}。`);
  }
}

export function assertScheduleFieldsMatch(actual: unknown, expected: AnyRecord, fields: string[], label: string): void {
  if (!isRecord(actual)) {
    throw new Error(`${label} 未返回有效 schedule。`);
  }
  for (const field of fields) {
    const actualValue = actual[field];
    const expectedValue = expected[field];
    if (Array.isArray(expectedValue)) {
      const actualArray = Array.isArray(actualValue) ? [...actualValue].map(Number).sort((left, right) => left - right) : [];
      const expectedArray = [...expectedValue].map(Number).sort((left, right) => left - right);
      if (actualArray.join(",") !== expectedArray.join(",")) {
        throw new Error(`${label}.${field}=${actualArray.join(",")}，期望 ${expectedArray.join(",")}。`);
      }
      continue;
    }
    if (Number(actualValue) !== Number(expectedValue)) {
      throw new Error(`${label}.${field}=${String(actualValue)}，期望 ${String(expectedValue)}。`);
    }
  }
}

export function scheduleSlotInput(context: TestExecutionContext): { userId: number; slotId: number } {
  const userId = Number(context.inputs.userId ?? 1);
  const slotId = Number(context.inputs.slotId ?? 1);
  assertIntegerRange(userId, "userId", 1, 255);
  assertIntegerRange(slotId, "slotId", 1, 255);
  return { userId, slotId };
}

export function requireScheduleSlots(slots: unknown, key: string, label: string, slotId: number): number {
  const count = getScheduleSlotCount(slots, key);
  if (count <= 0) throw new Error(`设备声明不支持 ${label} schedule slot。`);
  if (slotId > count) throw new Error(`${label} slotId=${slotId} 超出支持范围 1..${count}。`);
  return count;
}

export function makeWeekDaySchedule(date = new Date()): AnyRecord {
  return {
    weekday: date.getDay(),
    startHour: 0,
    startMinute: 0,
    stopHour: 23,
    stopMinute: 59,
  };
}

export function makeYearDaySchedule(date = new Date()): AnyRecord {
  const start = new Date(date.getTime() + 60_000);
  const stop = new Date(start.getTime() + 24 * 60 * 60_000);
  return {
    startYear: start.getFullYear() - 2000,
    startMonth: start.getMonth() + 1,
    startDay: start.getDate(),
    startHour: start.getHours(),
    startMinute: start.getMinutes(),
    stopYear: stop.getFullYear() - 2000,
    stopMonth: stop.getMonth() + 1,
    stopDay: stop.getDate(),
    stopHour: stop.getHours(),
    stopMinute: stop.getMinutes(),
  };
}

export function makeFutureYearDaySchedule(date = new Date()): AnyRecord {
  const start = new Date(date.getTime() + 24 * 60 * 60_000);
  const stop = new Date(start.getTime() + 24 * 60 * 60_000);
  return {
    startYear: start.getFullYear() - 2000,
    startMonth: start.getMonth() + 1,
    startDay: start.getDate(),
    startHour: 0,
    startMinute: 0,
    stopYear: stop.getFullYear() - 2000,
    stopMonth: stop.getMonth() + 1,
    stopDay: stop.getDate(),
    stopHour: 23,
    stopMinute: 59,
  };
}

export function makeDailyRepeatingSchedule(): AnyRecord {
  return {
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    startHour: 0,
    startMinute: 0,
    durationHour: 23,
    durationMinute: 59,
  };
}

export function makeInactiveWeekDaySchedule(date = new Date()): AnyRecord {
  return {
    weekday: (date.getDay() + 1) % 7,
    startHour: 0,
    startMinute: 0,
    stopHour: 0,
    stopMinute: 1,
  };
}

export async function setScheduleEntryLockEnabled(context: TestExecutionContext, enabled: boolean, userId?: number): Promise<unknown> {
  const args = userId == undefined ? [enabled] : [enabled, userId];
  const result = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "setEnabled", args });
  assertSupervisionAccepted(result, userId == undefined ? `Enable All ${enabled}` : `Enable userId=${userId} ${enabled}`);
  return result;
}

export async function setWeekDaySchedule(context: TestExecutionContext, slot: { userId: number; slotId: number }, schedule?: AnyRecord): Promise<unknown> {
  const args = schedule ? [slot, schedule] : [slot];
  const result = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "setWeekDaySchedule", args });
  assertSupervisionAccepted(result, schedule ? "Week Day Schedule Set" : "Week Day Schedule Erase");
  return result;
}

export async function setYearDaySchedule(context: TestExecutionContext, slot: { userId: number; slotId: number }, schedule?: AnyRecord): Promise<unknown> {
  const args = schedule ? [slot, schedule] : [slot];
  const result = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "setYearDaySchedule", args });
  assertSupervisionAccepted(result, schedule ? "Year Day Schedule Set" : "Year Day Schedule Erase");
  return result;
}

export async function setDailyRepeatingSchedule(context: TestExecutionContext, slot: { userId: number; slotId: number }, schedule?: AnyRecord): Promise<unknown> {
  const args = schedule ? [slot, schedule] : [slot];
  const result = await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method: "setDailyRepeatingSchedule", args });
  assertSupervisionAccepted(result, schedule ? "Daily Repeating Schedule Set" : "Daily Repeating Schedule Erase");
  return result;
}

export async function getScheduleByKind(context: TestExecutionContext, kind: ScheduleKind, slot: { userId: number; slotId: number }): Promise<unknown> {
  const method = kind === "weekday"
    ? "getWeekDaySchedule"
    : kind === "yearday"
      ? "getYearDaySchedule"
      : "getDailyRepeatingSchedule";
  return await context.invokeCcApi({ commandClass: "Schedule Entry Lock", method, args: [slot] });
}

export async function eraseScheduleByKind(context: TestExecutionContext, kind: ScheduleKind, slot: { userId: number; slotId: number }): Promise<unknown> {
  if (kind === "weekday") return await setWeekDaySchedule(context, slot);
  if (kind === "yearday") return await setYearDaySchedule(context, slot);
  return await setDailyRepeatingSchedule(context, slot);
}

export async function writeScheduleByKind(context: TestExecutionContext, kind: ScheduleKind, slot: { userId: number; slotId: number }, schedule: AnyRecord): Promise<unknown> {
  if (kind === "weekday") return await setWeekDaySchedule(context, slot, schedule);
  if (kind === "yearday") return await setYearDaySchedule(context, slot, schedule);
  return await setDailyRepeatingSchedule(context, slot, schedule);
}

export function isDoorLockUnlocked(report: AnyRecord): boolean {
  return optionalNumber(report.currentMode) === DOOR_LOCK_MODE_UNSECURED || report.boltStatus === "unlocked";
}

export async function waitForDoorLockUnlocked(context: TestExecutionContext, timeoutMs: number): Promise<AnyRecord> {
  const startedAt = Date.now();
  let lastReport = await readDoorLockReport(context);
  while (Date.now() - startedAt < timeoutMs) {
    if (isDoorLockUnlocked(lastReport)) return lastReport;
    await context.wait(1000);
    lastReport = await readDoorLockReport(context);
  }
  throw new Error(`未检测到门锁解锁，最后状态=${JSON.stringify(lastReport)}。`);
}

export async function waitForDoorLockStillLocked(context: TestExecutionContext, timeoutMs: number): Promise<AnyRecord> {
  await context.wait(timeoutMs);
  const report = await readDoorLockReport(context);
  if (isDoorLockUnlocked(report)) {
    throw new Error(`计划表外认证不应解锁，但检测到门锁已解锁：${JSON.stringify(report)}。`);
  }
  return report;
}

export function compareDeviceTime(date: AnyRecord, time: AnyRecord, timezone?: AnyRecord): {
  best: { interpretation: string; differenceMs: number; differenceMinutes: number };
  candidates: Array<{ interpretation: string; differenceMs: number; differenceMinutes: number }>;
} {
  const now = Date.now();
  const candidates = [];
  const asControllerLocal = new Date(Number(date.year), Number(date.month) - 1, Number(date.day), Number(time.hour), Number(time.minute), Number(time.second));
  const localDifferenceMs = Math.abs(now - asControllerLocal.getTime());
  candidates.push({
    interpretation: "reported-as-controller-local-time",
    differenceMs: localDifferenceMs,
    differenceMinutes: Math.round(localDifferenceMs / 60000),
  });

  // Some locks report Time CC date/time in UTC and publish the local offset separately.
  if (timezone && optionalNumber(timezone.standardOffset) != undefined) {
    const asUtc = Date.UTC(Number(date.year), Number(date.month) - 1, Number(date.day), Number(time.hour), Number(time.minute), Number(time.second));
    const utcDifferenceMs = Math.abs(now - asUtc);
    candidates.push({
      interpretation: "reported-as-utc-with-time-offset",
      differenceMs: utcDifferenceMs,
      differenceMinutes: Math.round(utcDifferenceMs / 60000),
    });
  }

  const best = [...candidates].sort((left, right) => left.differenceMs - right.differenceMs)[0];
  return { best, candidates };
}

export function compareDeviceTimeForOffset(date: AnyRecord, time: AnyRecord, offsetMinutes: number): {
  best: { interpretation: string; differenceMs: number; differenceMinutes: number };
  candidates: Array<{ interpretation: string; differenceMs: number; differenceMinutes: number }>;
} {
  const now = Date.now();
  const candidates = [];
  const reportedTimeAsUtc = Date.UTC(Number(date.year), Number(date.month) - 1, Number(date.day), Number(time.hour), Number(time.minute), Number(time.second));
  const configuredLocalTime = reportedTimeAsUtc - offsetMinutes * 60000;
  const configuredDifferenceMs = Math.abs(now - configuredLocalTime);
  candidates.push({
    interpretation: "reported-as-configured-timezone-local-time",
    differenceMs: configuredDifferenceMs,
    differenceMinutes: Math.round(configuredDifferenceMs / 60000),
  });

  const utcDifferenceMs = Math.abs(now - reportedTimeAsUtc);
  candidates.push({
    interpretation: "reported-as-utc-time-with-timezone-metadata",
    differenceMs: utcDifferenceMs,
    differenceMinutes: Math.round(utcDifferenceMs / 60000),
  });

  const controllerOffsetMinutes = -new Date().getTimezoneOffset();
  if (offsetMinutes === controllerOffsetMinutes) {
    const asControllerLocal = new Date(Number(date.year), Number(date.month) - 1, Number(date.day), Number(time.hour), Number(time.minute), Number(time.second));
    const localDifferenceMs = Math.abs(now - asControllerLocal.getTime());
    candidates.push({
      interpretation: "reported-as-controller-local-time",
      differenceMs: localDifferenceMs,
      differenceMinutes: Math.round(localDifferenceMs / 60000),
    });
  }

  const best = [...candidates].sort((left, right) => left.differenceMs - right.differenceMs)[0];
  return { best, candidates };
}

export function parseTimezoneOffsets(input: unknown): number[] {
  const rawOffsets = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",").map((item) => item.trim()).filter(Boolean)
      : [0, -new Date().getTimezoneOffset(), -300];
  const offsets = rawOffsets.map((item) => Number(item));
  if (!offsets.length) {
    throw new Error("时区切换测试至少需要一个 offset。");
  }
  for (const offset of offsets) {
    assertTimezoneOffset(offset, "timezoneOffsets[]");
  }
  return [...new Set(offsets)];
}

export function makeTimeCcTimezone(offsetMinutes: number): AnyRecord {
  const year = new Date().getUTCFullYear();
  return {
    standardOffset: offsetMinutes,
    dstOffset: offsetMinutes,
    startDate: new Date(Date.UTC(year, 2, 31, 1, 0, 0)),
    endDate: new Date(Date.UTC(year, 9, 31, 1, 0, 0)),
  };
}

export function makeScheduleEntryLockTimezone(offsetMinutes: number): AnyRecord {
  return {
    standardOffset: offsetMinutes,
    dstOffset: offsetMinutes,
  };
}

export function assertTimezoneMatches(timezone: unknown, expectedOffset: number, label: string): void {
  if (!isRecord(timezone)) {
    throw new Error(`${label} 未返回有效 Time Offset Report。`);
  }
  assertTimezoneOffset(timezone.standardOffset, `${label}.standardOffset`);
  assertTimezoneOffset(timezone.dstOffset, `${label}.dstOffset`);
  if (timezone.standardOffset !== expectedOffset || timezone.dstOffset !== expectedOffset) {
    throw new Error(`${label} 回读 offset 不匹配，期望 standard/dst=${expectedOffset}，实际 standard=${String(timezone.standardOffset)} dst=${String(timezone.dstOffset)}。`);
  }
}

export function timezoneMatches(timezone: unknown, expectedOffset: number): boolean {
  return isRecord(timezone) && timezone.standardOffset === expectedOffset && timezone.dstOffset === expectedOffset;
}

export function normalizeBasicReport(raw: unknown): BasicReportSnapshot {
  if (typeof raw === "number") {
    return { currentValue: raw, raw };
  }
  if (!isRecord(raw)) {
    return { raw };
  }
  return {
    currentValue: pickNumber(raw, ["currentValue", "current", "value"]),
    targetValue: pickNumber(raw, ["targetValue", "target"]),
    duration: raw.duration,
    raw,
  };
}

export function normalizeDoorLockReport(raw: unknown): AnyRecord {
  return isRecord(raw) ? raw : {};
}

export function isKnownBoltStatus(status: unknown): status is "locked" | "unlocked" {
  return status === "locked" || status === "unlocked";
}

export function isValidBasicValue(value: number): boolean {
  return value === BASIC_VALUE_OFF ||
    (value >= 0x01 && value <= 0x63) ||
    value === BASIC_VALUE_UNKNOWN ||
    value === BASIC_VALUE_ON;
}

export function assertValidBasicValue(value: number | undefined, label: string): void {
  if (value == undefined) {
    throw new Error(`${label} 未返回，无法验证 Basic Report 合法性。`);
  }
  if (!isValidBasicValue(value)) {
    throw new Error(`${label}=0x${value.toString(16).padStart(2, "0")} 为 Basic Report 保留值，发送节点不得使用。`);
  }
}

export function assertOptionalValidBasicValue(value: number | undefined, label: string): void {
  if (value != undefined) {
    assertValidBasicValue(value, label);
  }
}

export function isBasicOnValue(value: number | undefined): boolean {
  return value != undefined && ((value >= 0x01 && value <= 0x63) || value === BASIC_VALUE_ON);
}

export function isEquivalentBasicTargetValue(actual: number | undefined, expected: number): boolean {
  if (actual === expected) {
    return true;
  }
  // Door locks may normalize "On" from 0xFF to 0x63 (100% On) in Basic Report.
  if (expected === BASIC_VALUE_ON && isBasicOnValue(actual)) {
    return true;
  }
  return false;
}

export function assertValidReportDuration(duration: unknown, label: string): void {
  const durationValue = optionalNumber(duration);
  if (durationValue == undefined) {
    return;
  }
  if (durationValue < 0 || durationValue > 0xfe) {
    throw new Error(`${label}=0x${durationValue.toString(16).padStart(2, "0")} 不符合 Duration Report 编码，0xFF 为保留值。`);
  }
}

export function assertBasicDoorLockMapping(basicCurrentValue: number | undefined, doorLockRaw: unknown): void {
  assertValidBasicValue(basicCurrentValue, "Basic Current Value");
  const doorLock = normalizeDoorLockReport(doorLockRaw);
  const currentMode = optionalNumber(doorLock.currentMode);
  const boltStatus = doorLock.boltStatus;

  if (basicCurrentValue === BASIC_VALUE_OFF) {
    if (currentMode != undefined && currentMode !== DOOR_LOCK_MODE_UNSECURED) {
      throw new Error(`Basic Current Value=0x00 应映射到 Door Lock Mode=0x00，但当前 currentMode=${currentMode}。`);
    }
    if (isKnownBoltStatus(boltStatus) && boltStatus !== "unlocked") {
      throw new Error(`Basic Current Value=0x00 应表示解锁，但当前 boltStatus=${boltStatus}。`);
    }
    return;
  }

  if (isBasicOnValue(basicCurrentValue)) {
    if (currentMode != undefined && currentMode === DOOR_LOCK_MODE_UNSECURED) {
      throw new Error(`Basic Current Value=${basicCurrentValue} 表示 On/锁定，应映射到 Door Lock Mode!=0x00，但当前 currentMode=0x00。`);
    }
    if (isKnownBoltStatus(boltStatus) && boltStatus !== "locked") {
      throw new Error(`Basic Current Value=${basicCurrentValue} 表示 On/锁定，但当前 boltStatus=${boltStatus}。`);
    }
    return;
  }

  if (basicCurrentValue === BASIC_VALUE_UNKNOWN) {
    if (currentMode != undefined && currentMode !== DOOR_LOCK_MODE_UNKNOWN) {
      throw new Error(`Basic Current Value=0xFE 表示未知状态，但 Door Lock currentMode=${currentMode}。`);
    }
    return;
  }

  throw new Error(`当前 Basic Current Value=${basicCurrentValue} 无法映射到门锁状态。`);
}

export function assertDoorLockReached(raw: unknown, targetMode: number, label: string): void {
  const doorLock = normalizeDoorLockReport(raw);
  const currentMode = optionalNumber(doorLock.currentMode);
  const boltStatus = doorLock.boltStatus;
  if (targetMode === DOOR_LOCK_MODE_UNSECURED) {
    if (currentMode != undefined && currentMode !== DOOR_LOCK_MODE_UNSECURED) {
      throw new Error(`${label} 后 currentMode=${currentMode}，期望 0x00 Door Unsecured。`);
    }
    if (isKnownBoltStatus(boltStatus) && boltStatus !== "unlocked") {
      throw new Error(`${label} 后 boltStatus=${boltStatus}，期望 unlocked。`);
    }
    return;
  }
  if (currentMode != undefined && currentMode !== DOOR_LOCK_MODE_SECURED) {
    throw new Error(`${label} 后 currentMode=${currentMode}，期望 0xFF Door Secured。`);
  }
  if (isKnownBoltStatus(boltStatus) && boltStatus !== "locked") {
    throw new Error(`${label} 后 boltStatus=${boltStatus}，期望 locked。`);
  }
}

export async function readBasicReport(context: TestExecutionContext, attempts = 2): Promise<BasicReportSnapshot> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const raw = await context.invokeCcApi({ commandClass: "Basic", method: "get" });
      const report = normalizeBasicReport(raw);
      if (report.currentValue != undefined) {
        return report;
      }
      lastError = new Error("Basic Get 未返回可识别的 Current Value。");
      await context.log("warn", "basic.get.empty", "Basic Get 未返回可识别的 Current Value。", { attempt, raw });
    } catch (error) {
      lastError = error;
      await context.log("warn", "basic.get.failed", "Basic Get 调用失败，准备重试。", {
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (attempt < attempts) {
      await context.wait(1500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Basic Get 未返回可识别的 Current Value。"));
}

export async function tryReadBasicReport(context: TestExecutionContext, phaseKey: string): Promise<BasicReportSnapshot | undefined> {
  try {
    return await readBasicReport(context);
  } catch (error) {
    await context.log("warn", `${phaseKey}.basic.get-optional-failed`, "Basic Set 后 Door Lock 状态已可验证，但 Basic Get 读取失败，作为附加信息跳过。", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export async function readDoorLockReport(context: TestExecutionContext): Promise<AnyRecord> {
  return normalizeDoorLockReport(await context.invokeCcApi({ commandClass: "Door Lock", method: "get" }));
}

export function hasDoorLockState(report: AnyRecord): boolean {
  return report.currentMode != undefined || report.boltStatus != undefined || report.targetMode != undefined;
}

export function isExpectedDoorLockModeUpdate(mode: number | undefined, targetMode: number): boolean {
  if (mode == undefined) {
    return false;
  }
  return targetMode === DOOR_LOCK_MODE_UNSECURED ? mode === DOOR_LOCK_MODE_UNSECURED : mode === DOOR_LOCK_MODE_SECURED;
}

export async function waitForDoorLockModeUpdate(
  context: TestExecutionContext,
  targetMode: number,
  phaseKey: string,
): Promise<AnyRecord | undefined> {
  try {
    const payload = await context.waitForValueUpdate({
      commandClass: "Door Lock",
      property: "currentMode",
      timeoutMs: BASIC_SET_WAIT_MS + 7000,
      predicate: (valuePayload) => isExpectedDoorLockModeUpdate(optionalNumber(valuePayload.newValue), targetMode),
    });
    const report = {
      currentMode: optionalNumber(payload.newValue),
    };
    await context.log("info", `${phaseKey}.door-lock.event`, "已通过 Door Lock currentMode 事件确认状态变化。", {
      ...payload,
      report,
    });
    return report;
  } catch (error) {
    await context.log("warn", `${phaseKey}.door-lock.event-timeout`, "未在超时时间内等到 Door Lock currentMode 事件，改用主动查询。", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export async function readDoorLockReportWithCache(
  context: TestExecutionContext,
  phaseKey: string,
  fallbackReport?: AnyRecord | Promise<AnyRecord | undefined>,
): Promise<AnyRecord> {
  try {
    const directReport = await readDoorLockReport(context);
    if (hasDoorLockState(directReport)) {
      return directReport;
    }
    await context.log("warn", `${phaseKey}.door-lock.empty`, "Door Lock Get 未返回可识别状态，尝试使用最新缓存值。", { directReport });
  } catch (error) {
    await context.log("warn", `${phaseKey}.door-lock.get-failed`, "Door Lock Get 失败，尝试使用最新缓存值。", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const eventReport = await fallbackReport;
  if (eventReport && hasDoorLockState(eventReport)) {
    await context.log("info", `${phaseKey}.door-lock.event-fallback`, "已使用 Door Lock 事件结果继续验证，避免触发重新采访。", eventReport);
    return eventReport;
  }

  const cachedReport = valueSnapshot(context, "Door Lock");
  if (!hasDoorLockState(cachedReport)) {
    throw new Error("未读取到 Door Lock 当前状态，无法验证 Basic Set 映射。");
  }
  await context.log("warn", `${phaseKey}.door-lock.cache`, "已使用测试开始时的 Door Lock 缓存值继续验证；未调用 refreshInfo，避免触发重新采访。", cachedReport);
  return cachedReport;
}

export function isRestorableDoorLockMode(mode: number | undefined): boolean {
  return mode === 0x00 || mode === 0x01 || mode === 0x10 || mode === 0x11 || mode === 0x20 || mode === 0x21 || mode === 0xff;
}

export async function restoreDoorLockMode(context: TestExecutionContext, originalMode: number | undefined, fallbackMode = DOOR_LOCK_MODE_SECURED): Promise<void> {
  const restoreMode = isRestorableDoorLockMode(originalMode) ? originalMode : fallbackMode;
  await invokeOptional(context, "Door Lock", "set", [restoreMode]);
  await context.wait(BASIC_SET_WAIT_MS);
}

