import {
  DoorLockMode,
  UserCredentialAdminCodeOperationResult,
  UserCredentialCredentialReportType,
  UserCredentialLearnStatus,
  UserCredentialNameEncoding,
  UserCredentialOperationType,
  UserCredentialRule,
  UserCredentialType,
  UserCredentialUserType,
} from "zwave-js";
import { Bytes } from "@zwave-js/shared";

import type { ExecutableTestDefinition, TestExecutionContext } from "../types.js";
import {
  describeBoltStatus,
  isBoltUnlocked,
  performDoorLockCommand,
  readDoorLockStatus,
} from "./door-lock-shared.js";

const USER_CREDENTIAL_CC = "User Credential";
const PIN_TYPE = UserCredentialType.PINCode;
const PASSWORD_TYPE = UserCredentialType.Password;
const FINGER_TYPE = UserCredentialType.FingerBiometric;
const ACCESS_CONTROL_NOTIFICATION = 0x06;
const ACCESS_CONTROL_CREDENTIAL_UNLOCK = 0x24;
const ACCESS_CONTROL_NOT_ENOUGH_CREDENTIALS = 0x31;
const ACCESS_CONTROL_INVALID_CREDENTIAL = 0x32;

const DEFAULT_PRIMARY_USER_ID = 1;
const DEFAULT_SECONDARY_USER_ID = 2;
const DEFAULT_NON_ACCESS_USER_ID = 3;
const DEFAULT_PIN_SLOT = 1;
const DEFAULT_PIN_SLOT_2 = 2;
const DEFAULT_FINGER_SLOT = 1;
const DEFAULT_FINGER_SLOT_2 = 2;
const DEFAULT_PIN = "1234";
const DEFAULT_PIN_EDITED = "5678";
const DEFAULT_SECONDARY_PIN = "2468";
const DEFAULT_ADMIN_PIN = "8642";
const DEFAULT_ADMIN_PIN_EDITED = "9753";
const DEFAULT_PASSWORD = "open-sesame";
const DEFAULT_PASSWORD_EDITED = "backup-code";
const DEFAULT_WEAK_PIN = "111111";
const WAIT_SHORT_MS = 700;
const NEGATIVE_AUTH_WAIT_MS = 12_000;
const POSITIVE_AUTH_WAIT_MS = 20_000;
const MANUAL_LEARN_EXTRA_WAIT_MS = 10_000;
const POLL_INTERVAL_MS = 1_000;

type CredentialCapability = {
  numberOfCredentialSlots: number;
  minCredentialLength: number;
  maxCredentialLength: number;
  maxCredentialHashLength: number;
  supportsCredentialLearn: boolean;
  credentialLearnRecommendedTimeout?: number;
  credentialLearnNumberOfSteps?: number;
};

type UserCapabilities = {
  numberOfSupportedUsers?: number;
  supportedCredentialRules?: number[];
  supportedUserTypes?: number[];
  supportedUserNameEncodings?: number[];
  supportsAllUsersChecksum?: boolean;
  supportsUserChecksum?: boolean;
  supportsUserSchedule?: boolean;
  maxUserNameLength?: number;
};

type CredentialCapabilities = {
  supportsCredentialChecksum?: boolean;
  supportsAdminCode?: boolean;
  supportsAdminCodeDeactivation?: boolean;
  credentialTypes: Map<number, CredentialCapability>;
};

type CredentialReport = {
  reportType?: number;
  userId?: number;
  credentialType?: number;
  credentialSlot?: number;
  credentialReadBack?: boolean;
  credentialLength?: number;
  credentialData?: unknown;
  nextCredentialType?: number;
  nextCredentialSlot?: number;
  modifierType?: number;
  modifierNodeId?: number;
};

type UserReport = {
  reportType?: number;
  nextUserId?: number;
  userId?: number;
  userType?: number;
  active?: boolean;
  credentialRule?: number;
  userName?: string;
  modifierType?: number;
};

function supportsUserCredential(node: { commandClasses: string[] }): { supported: boolean; reason?: string } {
  return node.commandClasses.includes(USER_CREDENTIAL_CC)
    ? { supported: true }
    : { supported: false, reason: "节点未发现 User Credential CC。" };
}

function supportsUserCredentialDoorLock(node: { commandClasses: string[] }): { supported: boolean; reason?: string } {
  if (!node.commandClasses.includes(USER_CREDENTIAL_CC)) {
    return { supported: false, reason: "节点未发现 User Credential CC。" };
  }
  if (!node.commandClasses.includes("Door Lock")) {
    return { supported: false, reason: "节点未发现 Door Lock CC，无法执行门锁联动测试。" };
  }
  return { supported: true };
}

function asNumber(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function normalizeNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  }
  if (value instanceof Set) {
    return [...value].map((item) => Number(item)).filter((item) => Number.isFinite(item));
  }
  return [];
}

function normalizeCredentialTypes(value: unknown): Map<number, CredentialCapability> {
  if (value instanceof Map) {
    return new Map([...value.entries()].map(([key, raw]) => [Number(key), normalizeCredentialCapability(raw)]));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return new Map(entries.map(([key, raw]) => [Number(key), normalizeCredentialCapability(raw)]));
  }

  return new Map();
}

function normalizeCredentialCapability(value: unknown): CredentialCapability {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    numberOfCredentialSlots: Number(raw.numberOfCredentialSlots ?? 0),
    minCredentialLength: Number(raw.minCredentialLength ?? 0),
    maxCredentialLength: Number(raw.maxCredentialLength ?? 0),
    maxCredentialHashLength: Number(raw.maxCredentialHashLength ?? 0),
    supportsCredentialLearn: raw.supportsCredentialLearn === true,
    credentialLearnRecommendedTimeout: asNumber(raw.credentialLearnRecommendedTimeout),
    credentialLearnNumberOfSteps: asNumber(raw.credentialLearnNumberOfSteps),
  };
}

function credentialCapabilitiesToJson(capabilities: CredentialCapabilities): Record<string, unknown> {
  return {
    supportsCredentialChecksum: capabilities.supportsCredentialChecksum,
    supportsAdminCode: capabilities.supportsAdminCode,
    supportsAdminCodeDeactivation: capabilities.supportsAdminCodeDeactivation,
    credentialTypes: Object.fromEntries([...capabilities.credentialTypes.entries()].map(([type, capability]) => [String(type), capability])),
  };
}

function bytesToAscii(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("ascii");
  }
  if (Array.isArray(value)) {
    return Buffer.from(value.map((item) => Number(item))).toString("ascii");
  }
  return "";
}

function bytesToHex(value: unknown): string {
  if (typeof value === "string") {
    return Buffer.from(value, "ascii").toString("hex");
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("hex");
  }
  if (Array.isArray(value)) {
    return Buffer.from(value.map((item) => Number(item))).toString("hex");
  }
  return "";
}

function credentialLength(report: CredentialReport | undefined): number {
  const explicit = Number(report?.credentialLength);
  if (Number.isInteger(explicit) && explicit >= 0) {
    return explicit;
  }
  const data = report?.credentialData;
  if (typeof data === "string") {
    return data.length;
  }
  if (data instanceof Uint8Array || Array.isArray(data)) {
    return data.length;
  }
  return 0;
}

function isCredentialOccupied(report: CredentialReport | undefined): boolean {
  return credentialLength(report) > 0;
}

function normalizeNotificationArgs(payload: Record<string, unknown>): Record<string, unknown> {
  const args = payload.args;
  return args && typeof args === "object" ? args as Record<string, unknown> : {};
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function credentialReportTypeName(reportType: UserCredentialCredentialReportType): string {
  return UserCredentialCredentialReportType[reportType] ?? `0x${reportType.toString(16)}`;
}

function adminCodeResultName(result: UserCredentialAdminCodeOperationResult): string {
  return UserCredentialAdminCodeOperationResult[result] ?? `0x${result.toString(16)}`;
}

function getInputNumber(context: TestExecutionContext, key: string, fallback: number): number {
  const value = Number(context.inputs[key]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function getInputString(context: TestExecutionContext, key: string, fallback: string): string {
  const value = context.inputs[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function requireCapability(capabilities: CredentialCapabilities, credentialType: number, label: string): CredentialCapability {
  const capability = capabilities.credentialTypes.get(credentialType);
  if (!capability) {
    throw new Error(`设备未声明支持 ${label}，Credential Type=${credentialType}。`);
  }
  if (capability.numberOfCredentialSlots <= 0) {
    throw new Error(`${label} 的 Number of Supported Credential Slots 无效：${capability.numberOfCredentialSlots}。`);
  }
  if (capability.maxCredentialLength < capability.minCredentialLength) {
    throw new Error(`${label} 的 Max Length 小于 Min Length。`);
  }
  return capability;
}

function chooseValidPin(pin: string, capability: CredentialCapability): string {
  const minLength = Math.max(4, capability.minCredentialLength || 4);
  const maxLength = capability.maxCredentialLength || Math.max(10, minLength);
  let candidate = pin.replace(/\D/g, "");
  if (candidate.length < minLength) {
    candidate = candidate.padEnd(minLength, "7");
  }
  if (candidate.length > maxLength) {
    candidate = candidate.slice(0, maxLength);
  }
  if (candidate.length < minLength || candidate.length > maxLength) {
    throw new Error(`无法生成符合 PIN 长度范围 ${minLength}..${maxLength} 的测试 PIN。`);
  }
  return candidate;
}

function chooseValidAsciiCredential(value: string, capability: CredentialCapability, filler = "x"): string {
  const minLength = capability.minCredentialLength || 1;
  const maxLength = capability.maxCredentialLength || Math.max(minLength, value.length);
  let candidate = value.replace(/[^\x20-\x7e]/g, "");
  if (candidate.length < minLength) {
    candidate = candidate.padEnd(minLength, filler);
  }
  if (candidate.length > maxLength) {
    candidate = candidate.slice(0, maxLength);
  }
  if (candidate.length < minLength || candidate.length > maxLength) {
    throw new Error(`无法生成符合 Credential 长度范围 ${minLength}..${maxLength} 的 ASCII 测试值。`);
  }
  return candidate;
}

function invalidShortPin(capability: CredentialCapability): string | undefined {
  const minLength = capability.minCredentialLength || 4;
  if (minLength <= 1) {
    return undefined;
  }
  return "1".repeat(minLength - 1);
}

function invalidLongPin(capability: CredentialCapability): string | undefined {
  const maxLength = capability.maxCredentialLength || 10;
  if (maxLength >= 250) {
    return undefined;
  }
  return "9".repeat(maxLength + 1);
}

async function readUserCapabilities(context: TestExecutionContext): Promise<UserCapabilities> {
  const raw = await context.invokeCcApi({ commandClass: USER_CREDENTIAL_CC, method: "getUserCapabilities" }) as Record<string, unknown> | undefined;
  return {
    numberOfSupportedUsers: asNumber(raw?.numberOfSupportedUsers),
    supportedCredentialRules: normalizeNumberArray(raw?.supportedCredentialRules),
    supportedUserTypes: normalizeNumberArray(raw?.supportedUserTypes),
    supportedUserNameEncodings: normalizeNumberArray(raw?.supportedUserNameEncodings),
    supportsAllUsersChecksum: raw?.supportsAllUsersChecksum === true,
    supportsUserChecksum: raw?.supportsUserChecksum === true,
    supportsUserSchedule: raw?.supportsUserSchedule === true,
    maxUserNameLength: asNumber(raw?.maxUserNameLength),
  };
}

async function readCredentialCapabilities(context: TestExecutionContext): Promise<CredentialCapabilities> {
  const raw = await context.invokeCcApi({ commandClass: USER_CREDENTIAL_CC, method: "getCredentialCapabilities" }) as Record<string, unknown> | undefined;
  return {
    supportsCredentialChecksum: raw?.supportsCredentialChecksum === true,
    supportsAdminCode: raw?.supportsAdminCode === true,
    supportsAdminCodeDeactivation: raw?.supportsAdminCodeDeactivation === true,
    credentialTypes: normalizeCredentialTypes(raw?.credentialTypes),
  };
}

async function setGeneralUser(context: TestExecutionContext, userId: number, rule: UserCredentialRule, active = true): Promise<void> {
  await context.invokeCcApi({
    commandClass: USER_CREDENTIAL_CC,
    method: "setUser",
    args: [{
      userId,
      operationType: UserCredentialOperationType.Add,
      userType: UserCredentialUserType.General,
      active,
      credentialRule: rule,
      nameEncoding: UserCredentialNameEncoding.ASCII,
      userName: `UC-${userId}`,
    }],
  });
}

async function setUserWithType(
  context: TestExecutionContext,
  input: { userId: number; userType: UserCredentialUserType; rule?: UserCredentialRule; active?: boolean; userName?: string },
): Promise<void> {
  await context.invokeCcApi({
    commandClass: USER_CREDENTIAL_CC,
    method: "setUser",
    args: [{
      userId: input.userId,
      operationType: UserCredentialOperationType.Add,
      userType: input.userType,
      active: input.active ?? true,
      credentialRule: input.rule ?? UserCredentialRule.Single,
      nameEncoding: UserCredentialNameEncoding.ASCII,
      userName: input.userName ?? `UC-${input.userType}-${input.userId}`,
    }],
  });
}

async function modifyGeneralUser(context: TestExecutionContext, userId: number, rule: UserCredentialRule, active = true): Promise<void> {
  await context.invokeCcApi({
    commandClass: USER_CREDENTIAL_CC,
    method: "setUser",
    args: [{
      userId,
      operationType: UserCredentialOperationType.Modify,
      userType: UserCredentialUserType.General,
      active,
      credentialRule: rule,
      nameEncoding: UserCredentialNameEncoding.ASCII,
      userName: `UC-${userId}`,
    }],
  });
}

async function setNonAccessUser(context: TestExecutionContext, userId: number): Promise<void> {
  await context.invokeCcApi({
    commandClass: USER_CREDENTIAL_CC,
    method: "setUser",
    args: [{
      userId,
      operationType: UserCredentialOperationType.Add,
      userType: UserCredentialUserType.NonAccess,
      active: true,
      credentialRule: UserCredentialRule.Single,
      nameEncoding: UserCredentialNameEncoding.ASCII,
      userName: `UC-NA-${userId}`,
    }],
  });
}

async function deleteUserBestEffort(context: TestExecutionContext, userId: number): Promise<void> {
  try {
    await context.invokeCcApi({
      commandClass: USER_CREDENTIAL_CC,
      method: "setUser",
      args: [{ userId, operationType: UserCredentialOperationType.Delete }],
    });
    await context.wait(WAIT_SHORT_MS);
  } catch (error) {
    await context.log("warn", "cleanup.user", `清理测试用户 UID=${userId} 失败，继续执行`, {
      error: formatErrorMessage(error),
      userId,
    });
  }
}

async function getUser(context: TestExecutionContext, userId: number): Promise<UserReport | undefined> {
  return await context.invokeCcApi({
    commandClass: USER_CREDENTIAL_CC,
    method: "getUser",
    args: [userId],
  }) as UserReport | undefined;
}

async function readAllUsersChecksum(context: TestExecutionContext): Promise<number> {
  const checksum = asNumber(await context.invokeCcApi({ commandClass: USER_CREDENTIAL_CC, method: "getAllUsersChecksum" }));
  if (checksum == undefined) {
    throw new Error("All Users Checksum Report 未返回 checksum。");
  }
  return checksum;
}

async function readUserChecksum(context: TestExecutionContext, userId: number): Promise<number> {
  const checksum = asNumber(await context.invokeCcApi({ commandClass: USER_CREDENTIAL_CC, method: "getUserChecksum", args: [userId] }));
  if (checksum == undefined) {
    throw new Error(`User Checksum Report 未返回 UID=${userId} 的 checksum。`);
  }
  return checksum;
}

async function readCredentialChecksum(context: TestExecutionContext, credentialType: UserCredentialType): Promise<number> {
  const checksum = asNumber(await context.invokeCcApi({ commandClass: USER_CREDENTIAL_CC, method: "getCredentialChecksum", args: [credentialType] }));
  if (checksum == undefined) {
    throw new Error(`Credential Checksum Report 未返回 Credential Type=${credentialType} 的 checksum。`);
  }
  return checksum;
}

async function setAdminPinCode(context: TestExecutionContext, pinCode: string): Promise<void> {
  await context.invokeCcApi({
    commandClass: USER_CREDENTIAL_CC,
    method: "setAdminPinCode",
    args: [{ pinCode }],
  });
}

async function getAdminPinCode(context: TestExecutionContext): Promise<string | undefined> {
  const result = await context.invokeCcApi({
    commandClass: USER_CREDENTIAL_CC,
    method: "getAdminPinCode",
  });
  return typeof result === "string" ? result : undefined;
}

async function addPin(context: TestExecutionContext, userId: number, slot: number, pin: string): Promise<void> {
  await context.invokeCcApi({
    commandClass: USER_CREDENTIAL_CC,
    method: "setCredential",
    args: [{
      userId,
      credentialType: PIN_TYPE,
      credentialSlot: slot,
      operationType: UserCredentialOperationType.Add,
      credentialData: Bytes.from(pin, "ascii"),
    }],
  });
}

async function modifyPin(context: TestExecutionContext, userId: number, slot: number, pin: string): Promise<void> {
  await context.invokeCcApi({
    commandClass: USER_CREDENTIAL_CC,
    method: "setCredential",
    args: [{
      userId,
      credentialType: PIN_TYPE,
      credentialSlot: slot,
      operationType: UserCredentialOperationType.Modify,
      credentialData: Bytes.from(pin, "ascii"),
    }],
  });
}

async function setAsciiCredential(
  context: TestExecutionContext,
  input: { userId: number; credentialType: UserCredentialType; slot: number; operationType: UserCredentialOperationType.Add | UserCredentialOperationType.Modify; value: string },
): Promise<void> {
  await context.invokeCcApi({
    commandClass: USER_CREDENTIAL_CC,
    method: "setCredential",
    args: [{
      userId: input.userId,
      credentialType: input.credentialType,
      credentialSlot: input.slot,
      operationType: input.operationType,
      credentialData: Bytes.from(input.value, "ascii"),
    }],
  });
}

async function deleteCredentialBestEffort(context: TestExecutionContext, userId: number, credentialType: UserCredentialType, slot: number): Promise<void> {
  try {
    await context.invokeCcApi({
      commandClass: USER_CREDENTIAL_CC,
      method: "setCredential",
      args: [{
        userId,
        credentialType,
        credentialSlot: slot,
        operationType: UserCredentialOperationType.Delete,
      }],
    });
    await context.wait(WAIT_SHORT_MS);
  } catch (error) {
    await context.log("warn", "cleanup.credential", "清理测试 credential 失败，继续执行", {
      error: formatErrorMessage(error),
      userId,
      credentialType,
      slot,
    });
  }
}

async function getCredential(
  context: TestExecutionContext,
  userId: number,
  credentialType: UserCredentialType,
  slot: number,
): Promise<CredentialReport | undefined> {
  return await context.invokeCcApi({
    commandClass: USER_CREDENTIAL_CC,
    method: "getCredential",
    args: [userId, credentialType, slot],
  }) as CredentialReport | undefined;
}

async function assertPin(context: TestExecutionContext, userId: number, slot: number, expectedPin: string, stepKey: string): Promise<CredentialReport> {
  const report = await getCredential(context, userId, PIN_TYPE, slot);
  const actual = bytesToAscii(report?.credentialData);
  if (report?.credentialReadBack !== true) {
    throw new Error(`PIN Code Credential Report CRB 应为 true，实际为 ${String(report?.credentialReadBack)}。`);
  }
  if (credentialLength(report) !== expectedPin.length || actual !== expectedPin) {
    throw new Error(`PIN Code 读取不一致：期望 ${expectedPin}，实际 ${actual || "(empty)"}。`);
  }
  await context.log("info", stepKey, `PIN Slot=${slot} 读取确认成功`, {
    userId,
    slot,
    expectedPin,
    credentialReadBack: report.credentialReadBack,
    credentialLength: credentialLength(report),
  });
  return report;
}

async function assertAsciiCredential(
  context: TestExecutionContext,
  input: { userId: number; credentialType: UserCredentialType; slot: number; expectedValue: string; capability: CredentialCapability; label: string; stepKey: string },
): Promise<CredentialReport> {
  const report = await getCredential(context, input.userId, input.credentialType, input.slot);
  if (report?.credentialReadBack === true) {
    const actual = bytesToAscii(report.credentialData);
    if (credentialLength(report) !== input.expectedValue.length || actual !== input.expectedValue) {
      throw new Error(`${input.label} 读取不一致：期望 ${input.expectedValue}，实际 ${actual || "(empty)"}。`);
    }
  } else {
    await assertCredentialReportFitsCapability(context, report, input.capability, input.label, `${input.stepKey}.hash-length`);
  }
  await context.log("info", input.stepKey, `${input.label} Slot=${input.slot} 读取确认成功`, {
    userId: input.userId,
    credentialType: input.credentialType,
    slot: input.slot,
    credentialReadBack: report?.credentialReadBack,
    credentialLength: credentialLength(report),
  });
  return report as CredentialReport;
}

async function assertCredentialEmpty(
  context: TestExecutionContext,
  userId: number,
  credentialType: UserCredentialType,
  slot: number,
  stepKey: string,
): Promise<void> {
  const report = await getCredential(context, userId, credentialType, slot);
  if (isCredentialOccupied(report)) {
    throw new Error(`Credential Type=${credentialType} Slot=${slot} 应为空，但读取到 length=${credentialLength(report)}。`);
  }
  await context.log("info", stepKey, "Credential 空状态确认成功", {
    userId,
    credentialType,
    slot,
    report,
  });
}

function assertChecksumChanged(before: number, after: number, label: string): void {
  if (before === after) {
    throw new Error(`${label} 应在对象变化后改变，但前后 checksum 都是 ${before}。`);
  }
}

function assertChecksumUnchanged(before: number, after: number, label: string): void {
  if (before !== after) {
    throw new Error(`${label} 不应被无关对象影响，但 checksum 从 ${before} 变为 ${after}。`);
  }
}

async function assertUserReport(
  context: TestExecutionContext,
  userId: number,
  expected: { userType: UserCredentialUserType; active: boolean; credentialRule: UserCredentialRule },
  stepKey: string,
): Promise<UserReport> {
  const user = await getUser(context, userId);
  if (user?.userId !== userId || user.userType !== expected.userType || user.active !== expected.active || user.credentialRule !== expected.credentialRule) {
    throw new Error(`User Report 不符合预期：UID=${userId}，实际 ${JSON.stringify(user)}。`);
  }
  await context.log("info", stepKey, "User Report 符合预期", { userId, user });
  return user;
}

async function logExpectedCredentialReportType(
  context: TestExecutionContext,
  stepKey: string,
  reportType: UserCredentialCredentialReportType,
): Promise<void> {
  await context.log("info", stepKey, "规范期望设备以对应 Credential Report Type 拒绝或保持不变；zwave-js API 不直接返回 Set 后的 Report Type，本步骤用状态不变进行判定", {
    expectedReportType: reportType,
    expectedReportTypeName: credentialReportTypeName(reportType),
  });
}

async function assertCredentialReportFitsCapability(
  context: TestExecutionContext,
  report: CredentialReport | undefined,
  capability: CredentialCapability,
  label: string,
  stepKey: string,
): Promise<void> {
  const length = credentialLength(report);
  if (!report) {
    throw new Error(`${label} Credential Report 为空。`);
  }

  if (report.credentialReadBack === false) {
    if (length <= 0) {
      throw new Error(`${label} 不可 read back 时 Credential Report 必须包含非空 hash。`);
    }
    if (capability.maxCredentialHashLength > 0 && length > capability.maxCredentialHashLength) {
      throw new Error(`${label} Credential Report hash length ${length} exceeds maxCredentialHashLength ${capability.maxCredentialHashLength}。`);
    }
  }

  await context.log("info", stepKey, "Credential Report 长度符合能力声明", {
    credentialReadBack: report.credentialReadBack,
    credentialLength: length,
    maxCredentialHashLength: capability.maxCredentialHashLength,
  });
}

async function expectCommandRejectedOrUnchanged(
  context: TestExecutionContext,
  stepKey: string,
  action: () => Promise<void>,
): Promise<{ commandError?: string }> {
  try {
    await action();
    await context.wait(WAIT_SHORT_MS);
    await context.log("info", stepKey, "命令已发送，继续验证设备状态是否保持不变");
    return {};
  } catch (error) {
    const message = formatErrorMessage(error);
    await context.log("info", stepKey, "命令被拒绝，继续验证设备状态是否保持不变", { error: message });
    return { commandError: message };
  }
}

async function waitForCredentialOccupied(
  context: TestExecutionContext,
  input: {
    userId: number;
    credentialType: UserCredentialType;
    slot: number;
    timeoutMs: number;
    expectDataChangeFromHex?: string;
  },
): Promise<CredentialReport> {
  const startedAt = Date.now();
  let lastReport: CredentialReport | undefined;
  while (Date.now() - startedAt < input.timeoutMs) {
    if (context.isCancelled()) {
      throw new Error("测试已取消。");
    }
    lastReport = await getCredential(context, input.userId, input.credentialType, input.slot);
    const occupied = isCredentialOccupied(lastReport);
    const dataHex = bytesToHex(lastReport?.credentialData);
    if (lastReport && occupied && (!input.expectDataChangeFromHex || dataHex !== input.expectDataChangeFromHex)) {
      return lastReport;
    }
    await context.wait(POLL_INTERVAL_MS);
  }
  throw new Error(`等待 Credential Type=${input.credentialType} Slot=${input.slot} 写入超时，最后读取 length=${credentialLength(lastReport)}。`);
}

async function waitForCredentialEmpty(
  context: TestExecutionContext,
  input: { userId: number; credentialType: UserCredentialType; slot: number; timeoutMs: number },
): Promise<CredentialReport | undefined> {
  const startedAt = Date.now();
  let lastReport: CredentialReport | undefined;
  while (Date.now() - startedAt < input.timeoutMs) {
    if (context.isCancelled()) {
      throw new Error("测试已取消。");
    }
    lastReport = await getCredential(context, input.userId, input.credentialType, input.slot);
    if (!isCredentialOccupied(lastReport)) {
      return lastReport;
    }
    await context.wait(POLL_INTERVAL_MS);
  }
  throw new Error(`等待 Credential Type=${input.credentialType} Slot=${input.slot} 清空超时，最后读取 length=${credentialLength(lastReport)}。`);
}

async function logManualPrompt<T>(
  context: TestExecutionContext,
  input: {
    promptKey: string;
    promptTitle: string;
    promptMessage: string;
    promptMeta?: string;
    timeoutMs: number;
    wait: () => Promise<T>;
  },
): Promise<T> {
  await context.log("info", "manual.wait", input.promptMessage, {
    promptKey: input.promptKey,
    promptTitle: input.promptTitle,
    promptMessage: input.promptMessage,
    promptMeta: input.promptMeta,
    timeoutMs: input.timeoutMs,
  });
  try {
    const result = await input.wait();
    await context.log("info", "manual.done", `${input.promptTitle} 完成`, {
      promptKey: input.promptKey,
      result: result as Record<string, unknown>,
    });
    return result;
  } catch (error) {
    await context.log("error", "manual.done", `${input.promptTitle} 失败：${formatErrorMessage(error)}`, {
      promptKey: input.promptKey,
    });
    throw error;
  }
}

async function startCredentialLearn(
  context: TestExecutionContext,
  input: {
    userId: number;
    credentialType: UserCredentialType;
    slot: number;
    operationType: UserCredentialOperationType;
    timeoutSec: number;
  },
): Promise<void> {
  await context.invokeCcApi({
    commandClass: USER_CREDENTIAL_CC,
    method: "startCredentialLearn",
    args: [{
      userId: input.userId,
      credentialType: input.credentialType,
      credentialSlot: input.slot,
      operationType: input.operationType,
      learnTimeout: input.timeoutSec,
    }],
  });
}

async function cancelCredentialLearn(context: TestExecutionContext): Promise<void> {
  await context.invokeCcApi({
    commandClass: USER_CREDENTIAL_CC,
    method: "cancelCredentialLearn",
  });
}

async function learnFingerprint(
  context: TestExecutionContext,
  input: {
    userId: number;
    slot: number;
    operationType: UserCredentialOperationType;
    timeoutSec: number;
    promptTitle: string;
    promptMessage: string;
    promptKey: string;
    previousDataHex?: string;
  },
): Promise<CredentialReport> {
  await startCredentialLearn(context, {
    userId: input.userId,
    credentialType: FINGER_TYPE,
    slot: input.slot,
    operationType: input.operationType,
    timeoutSec: input.timeoutSec,
  });

  return await logManualPrompt(context, {
    promptKey: input.promptKey,
    promptTitle: input.promptTitle,
    promptMessage: input.promptMessage,
    promptMeta: `User ID=${input.userId}，Finger Slot=${input.slot}，超时 ${input.timeoutSec} 秒。检测到指纹写入后会自动继续。`,
    timeoutMs: input.timeoutSec * 1000 + MANUAL_LEARN_EXTRA_WAIT_MS,
    wait: async () => waitForCredentialOccupied(context, {
      userId: input.userId,
      credentialType: FINGER_TYPE,
      slot: input.slot,
      timeoutMs: input.timeoutSec * 1000 + MANUAL_LEARN_EXTRA_WAIT_MS,
      expectDataChangeFromHex: input.previousDataHex,
    }),
  });
}

function learnTimeoutSeconds(capability: CredentialCapability): number {
  const recommended = capability.credentialLearnRecommendedTimeout;
  if (recommended && recommended > 0) {
    return Math.max(10, Math.min(recommended, 120));
  }
  return 60;
}

async function ensureLocked(context: TestExecutionContext, phaseKey: string): Promise<void> {
  const status = await readDoorLockStatus(context);
  if (isBoltUnlocked(status?.boltStatus) === false) {
    return;
  }
  await performDoorLockCommand(context, {
    phaseKey,
    actionLabel: "上锁",
    targetMode: DoorLockMode.Secured,
    expectedStatus: "locked",
    successMessage: "门锁已恢复上锁状态",
    failureMessage: "门锁未能恢复上锁状态",
  });
}

async function assertDoorLockedAfterManualPhase(
  context: TestExecutionContext,
  input: { promptKey: string; promptTitle: string; promptMessage: string; promptMeta?: string; waitMs?: number },
): Promise<Record<string, unknown>> {
  return await logManualPrompt(context, {
    promptKey: input.promptKey,
    promptTitle: input.promptTitle,
    promptMessage: input.promptMessage,
    promptMeta: input.promptMeta,
    timeoutMs: input.waitMs ?? NEGATIVE_AUTH_WAIT_MS,
    wait: async () => {
      await context.wait(input.waitMs ?? NEGATIVE_AUTH_WAIT_MS);
      const status = await readDoorLockStatus(context);
      const unlocked = isBoltUnlocked(status?.boltStatus);
      if (unlocked === true) {
        throw new Error(`门锁不应解锁，但 boltStatus=${describeBoltStatus(status?.boltStatus)}。`);
      }
      return { status: status as Record<string, unknown> | undefined };
    },
  });
}

async function assertDoorUnlockedAfterManualPhase(
  context: TestExecutionContext,
  input: { promptKey: string; promptTitle: string; promptMessage: string; promptMeta?: string; waitMs?: number },
): Promise<Record<string, unknown>> {
  return await logManualPrompt(context, {
    promptKey: input.promptKey,
    promptTitle: input.promptTitle,
    promptMessage: input.promptMessage,
    promptMeta: input.promptMeta,
    timeoutMs: input.waitMs ?? POSITIVE_AUTH_WAIT_MS,
    wait: async () => {
      const startedAt = Date.now();
      let lastStatus = await readDoorLockStatus(context);
      while (Date.now() - startedAt < (input.waitMs ?? POSITIVE_AUTH_WAIT_MS)) {
        if (isBoltUnlocked(lastStatus?.boltStatus) === true) {
          return { status: lastStatus as Record<string, unknown> | undefined };
        }
        await context.wait(POLL_INTERVAL_MS);
        lastStatus = await readDoorLockStatus(context);
      }
      throw new Error(`未检测到门锁解锁，最后 boltStatus=${describeBoltStatus(lastStatus?.boltStatus)}。`);
    },
  });
}

async function waitForAccessControlEvent(
  context: TestExecutionContext,
  expectedEvent: number,
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> {
  try {
    return await context.waitForEvent({
      type: "zwave.node.notification",
      timeoutMs,
      predicate: (payload) => {
        if (Number(payload.nodeId) !== context.node.nodeId) {
          return false;
        }
        const args = normalizeNotificationArgs(payload);
        return Number(args.type) === ACCESS_CONTROL_NOTIFICATION && Number(args.event) === expectedEvent;
      },
    });
  } catch {
    return undefined;
  }
}

export const userCredentialCapabilitiesDefinition: ExecutableTestDefinition = {
  traceCommandClasses: [USER_CREDENTIAL_CC, "Door Lock", "Notification"],
  meta: {
    id: "user-credential-capabilities-v1",
    key: "user-credential-capabilities",
    name: "User Credential 能力检查",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "验证 User Credential CC、PIN Code、Finger Biometric、Door Lock 和 Notification 依赖能力。",
    inputSchema: {},
  },
  supports: supportsUserCredential,
  async run(context) {
    await context.log("info", "precheck.start", "开始读取 User Credential 能力");
    const [userCapabilities, credentialCapabilities] = await Promise.all([
      readUserCapabilities(context),
      readCredentialCapabilities(context),
    ]);

    if (!userCapabilities.numberOfSupportedUsers || userCapabilities.numberOfSupportedUsers <= 0) {
      throw new Error(`Number of supported User Unique Identifiers 无效：${String(userCapabilities.numberOfSupportedUsers)}。`);
    }
    if (!userCapabilities.supportedCredentialRules?.length) {
      throw new Error("设备未声明任何 Credential Rule。");
    }
    if (!userCapabilities.supportedCredentialRules.includes(UserCredentialRule.Single)) {
      throw new Error("设备未声明支持 Single Credential Rule (0x01)。");
    }
    if (!userCapabilities.supportedUserTypes?.includes(UserCredentialUserType.General)) {
      throw new Error("设备未声明支持 General User (0x00)。");
    }

    const pinCapability = requireCapability(credentialCapabilities, PIN_TYPE, "PIN Code");
    const fingerCapability = requireCapability(credentialCapabilities, FINGER_TYPE, "Finger Biometric");

    if (pinCapability.minCredentialLength < 4) {
      throw new Error(`PIN Code Min Length 应至少为 4，实际为 ${pinCapability.minCredentialLength}。`);
    }
    if (pinCapability.maxCredentialLength < pinCapability.minCredentialLength) {
      throw new Error("PIN Code Max Length 小于 Min Length。");
    }
    if (fingerCapability.maxCredentialLength === 0 && !fingerCapability.supportsCredentialLearn) {
      throw new Error("Finger Biometric 不能直接写入时必须支持 Credential Learn。 ");
    }
    if (!fingerCapability.supportsCredentialLearn) {
      await context.log("warn", "capability.fingerprint", "Finger Biometric 未声明 Credential Learn；后续指纹学习测试不会被支持", fingerCapability);
    }
    if (fingerCapability.maxCredentialHashLength <= 0 && fingerCapability.maxCredentialLength === 0) {
      throw new Error("Finger Biometric 既不能 read back，也未声明有效 hash 长度。 ");
    }
    if (!context.node.commandClasses.includes("Door Lock")) {
      throw new Error("支持 User Credential CC 的门锁应支持 Door Lock CC，当前节点未发现 Door Lock CC。 ");
    }
    if (!context.node.commandClasses.includes("Notification")) {
      throw new Error("支持 User Credential CC 的节点必须支持 Notification CC v3-v8，当前节点未发现 Notification CC。 ");
    }

    await context.log("info", "result", "User Credential 能力检查通过", {
      userCapabilities,
      credentialCapabilities: credentialCapabilitiesToJson(credentialCapabilities),
      commandClasses: context.node.commandClasses,
    });

    return {
      userCapabilities,
      credentialCapabilities: credentialCapabilitiesToJson(credentialCapabilities),
      pinCapability,
      fingerCapability,
    };
  },
};

export const userCredentialPinLifecycleDefinition: ExecutableTestDefinition = {
  traceCommandClasses: [USER_CREDENTIAL_CC, "Notification"],
  meta: {
    id: "user-credential-pin-lifecycle-v1",
    key: "user-credential-pin-lifecycle",
    name: "User Credential PIN 生命周期",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "自动验证 User 创建/修改/禁用/删除、PIN Add/Get/Modify/Delete、重复、非法长度、占用 slot 和空 slot 场景。",
    inputSchema: {},
  },
  supports: supportsUserCredential,
  async run(context) {
    const primaryUserId = getInputNumber(context, "primaryUserId", DEFAULT_PRIMARY_USER_ID);
    const secondaryUserId = getInputNumber(context, "secondaryUserId", DEFAULT_SECONDARY_USER_ID);
    const pinSlot = getInputNumber(context, "pinSlot", DEFAULT_PIN_SLOT);
    const pinSlot2 = getInputNumber(context, "pinSlot2", DEFAULT_PIN_SLOT_2);

    const [userCapabilities, credentialCapabilities] = await Promise.all([
      readUserCapabilities(context),
      readCredentialCapabilities(context),
    ]);
    const pinCapability = requireCapability(credentialCapabilities, PIN_TYPE, "PIN Code");
    const pin = chooseValidPin(getInputString(context, "pin", DEFAULT_PIN), pinCapability);
    const editedPin = chooseValidPin(getInputString(context, "editedPin", DEFAULT_PIN_EDITED), pinCapability);
    const secondaryPin = chooseValidPin(getInputString(context, "secondaryPin", DEFAULT_SECONDARY_PIN), pinCapability);

    if (pinSlot > pinCapability.numberOfCredentialSlots || pinSlot2 > pinCapability.numberOfCredentialSlots) {
      throw new Error(`PIN 测试 slot 超出能力范围：slot=${pinSlot}/${pinSlot2}，支持 ${pinCapability.numberOfCredentialSlots}。`);
    }
    if ((userCapabilities.numberOfSupportedUsers ?? 0) < Math.max(primaryUserId, secondaryUserId)) {
      throw new Error(`测试 User ID 超出设备声明范围：需要 ${Math.max(primaryUserId, secondaryUserId)}，设备支持 ${String(userCapabilities.numberOfSupportedUsers)}。`);
    }

    await context.log("warn", "precheck.cleanup", "将清理测试使用的 User ID 和 Credential Slot，请确认这些 ID 未保存生产数据", {
      primaryUserId,
      secondaryUserId,
      pinSlot,
      pinSlot2,
    });

    try {
      await deleteUserBestEffort(context, primaryUserId);
      await deleteUserBestEffort(context, secondaryUserId);

      await context.log("info", "user.add", "添加 General User / Single Rule", { primaryUserId });
      await setGeneralUser(context, primaryUserId, UserCredentialRule.Single, true);
      await context.wait(WAIT_SHORT_MS);
      let user = await getUser(context, primaryUserId);
      if (user?.userId !== primaryUserId || user.userType !== UserCredentialUserType.General || user.active !== true || user.credentialRule !== UserCredentialRule.Single) {
        throw new Error(`User 添加后读取不一致：${JSON.stringify(user)}。`);
      }

      await context.log("info", "user.modify.disabled", "修改 User 为 Occupied Disabled", { primaryUserId });
      await modifyGeneralUser(context, primaryUserId, UserCredentialRule.Single, false);
      await context.wait(WAIT_SHORT_MS);
      user = await getUser(context, primaryUserId);
      if (user?.active !== false) {
        throw new Error(`User Disabled 后读取异常：${JSON.stringify(user)}。`);
      }
      await modifyGeneralUser(context, primaryUserId, UserCredentialRule.Single, true);

      await context.log("info", "pin.add", "添加 PIN Code credential", { primaryUserId, pinSlot, pin });
      await addPin(context, primaryUserId, pinSlot, pin);
      await context.wait(WAIT_SHORT_MS);
      await assertPin(context, primaryUserId, pinSlot, pin, "pin.get");

      await expectCommandRejectedOrUnchanged(context, "pin.add.occupied", async () => {
        await addPin(context, primaryUserId, pinSlot, editedPin);
      });
      await assertPin(context, primaryUserId, pinSlot, pin, "pin.add.occupied.assert");

      await setGeneralUser(context, secondaryUserId, UserCredentialRule.Single, true);
      await expectCommandRejectedOrUnchanged(context, "pin.duplicate.same-type", async () => {
        await addPin(context, secondaryUserId, pinSlot, pin);
      });
      await assertCredentialEmpty(context, secondaryUserId, PIN_TYPE, pinSlot, "pin.duplicate.assert");

      await expectCommandRejectedOrUnchanged(context, "pin.modify.empty", async () => {
        await modifyPin(context, primaryUserId, pinSlot2, secondaryPin);
      });
      await assertCredentialEmpty(context, primaryUserId, PIN_TYPE, pinSlot2, "pin.modify.empty.assert");

      const shortPin = invalidShortPin(pinCapability);
      if (shortPin) {
        await expectCommandRejectedOrUnchanged(context, "pin.invalid.short", async () => {
          await addPin(context, primaryUserId, pinSlot2, shortPin);
        });
        await assertCredentialEmpty(context, primaryUserId, PIN_TYPE, pinSlot2, "pin.invalid.short.assert");
      }

      const longPin = invalidLongPin(pinCapability);
      if (longPin) {
        await expectCommandRejectedOrUnchanged(context, "pin.invalid.long", async () => {
          await addPin(context, primaryUserId, pinSlot2, longPin);
        });
        await assertCredentialEmpty(context, primaryUserId, PIN_TYPE, pinSlot2, "pin.invalid.long.assert");
      }

      if (DEFAULT_WEAK_PIN.length >= pinCapability.minCredentialLength && DEFAULT_WEAK_PIN.length <= pinCapability.maxCredentialLength) {
        await expectCommandRejectedOrUnchanged(context, "pin.weak.security-rule", async () => {
          await addPin(context, primaryUserId, pinSlot2, DEFAULT_WEAK_PIN);
        });
        const weakReport = await getCredential(context, primaryUserId, PIN_TYPE, pinSlot2);
        if (isCredentialOccupied(weakReport)) {
          await context.log("warn", "pin.weak.security-rule", "设备接受了弱 PIN；规范为 SHOULD NOT，记录为警告并清理", {
            weakPin: DEFAULT_WEAK_PIN,
            report: weakReport,
          });
          await deleteCredentialBestEffort(context, primaryUserId, PIN_TYPE, pinSlot2);
        }
      } else {
        await context.log("warn", "pin.weak.security-rule.skip", "弱 PIN 测试值不在设备 PIN 长度范围内，跳过厂商安全规则测试", {
          weakPin: DEFAULT_WEAK_PIN,
          pinCapability,
        });
      }

      await context.log("info", "pin.modify", "修改 PIN Code credential", { primaryUserId, pinSlot, editedPin });
      await modifyPin(context, primaryUserId, pinSlot, editedPin);
      await context.wait(WAIT_SHORT_MS);
      await assertPin(context, primaryUserId, pinSlot, editedPin, "pin.modify.assert");

      await context.log("info", "pin.delete", "删除 PIN Code credential", { primaryUserId, pinSlot });
      await deleteCredentialBestEffort(context, primaryUserId, PIN_TYPE, pinSlot);
      await assertCredentialEmpty(context, primaryUserId, PIN_TYPE, pinSlot, "pin.delete.assert");

      let checksumResult: Record<string, unknown> | undefined;
      if (userCapabilities.supportsAllUsersChecksum || userCapabilities.supportsUserChecksum || credentialCapabilities.supportsCredentialChecksum) {
        checksumResult = {};
        if (userCapabilities.supportsAllUsersChecksum) {
          checksumResult.allUsersChecksum = await context.invokeCcApi({ commandClass: USER_CREDENTIAL_CC, method: "getAllUsersChecksum" });
        }
        if (userCapabilities.supportsUserChecksum) {
          checksumResult.userChecksum = await context.invokeCcApi({ commandClass: USER_CREDENTIAL_CC, method: "getUserChecksum", args: [primaryUserId] });
        }
        if (credentialCapabilities.supportsCredentialChecksum) {
          checksumResult.pinCredentialChecksum = await context.invokeCcApi({ commandClass: USER_CREDENTIAL_CC, method: "getCredentialChecksum", args: [PIN_TYPE] });
        }
        await context.log("info", "checksum.optional", "可选 checksum 能力读取完成", checksumResult);
      }

      await context.log("info", "result", "User Credential PIN 生命周期测试完成", {
        primaryUserId,
        secondaryUserId,
        pinCapability,
        checksumResult,
      });

      return {
        primaryUserId,
        secondaryUserId,
        pinSlot,
        pinSlot2,
        pinCapability,
        checksumResult,
      };
    } finally {
      await deleteUserBestEffort(context, primaryUserId);
      await deleteUserBestEffort(context, secondaryUserId);
    }
  },
};

export const userCredentialFingerprintLifecycleDefinition: ExecutableTestDefinition = {
  traceCommandClasses: [USER_CREDENTIAL_CC, "Door Lock", "Notification"],
  meta: {
    id: "user-credential-fingerprint-lifecycle-v1",
    key: "user-credential-fingerprint-lifecycle",
    name: "User Credential 指纹生命周期",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "半自动验证 Finger Biometric Learn Add/Get/Modify/Delete、Timeout、Cancel、Invalid Add/Modify、直接写入限制和 Association。",
    inputSchema: {},
  },
  supports: supportsUserCredential,
  async run(context) {
    const primaryUserId = getInputNumber(context, "primaryUserId", DEFAULT_PRIMARY_USER_ID);
    const secondaryUserId = getInputNumber(context, "secondaryUserId", DEFAULT_SECONDARY_USER_ID);
    const fingerSlot = getInputNumber(context, "fingerSlot", DEFAULT_FINGER_SLOT);
    const fingerSlot2 = getInputNumber(context, "fingerSlot2", DEFAULT_FINGER_SLOT_2);

    const [userCapabilities, credentialCapabilities] = await Promise.all([
      readUserCapabilities(context),
      readCredentialCapabilities(context),
    ]);
    const fingerCapability = requireCapability(credentialCapabilities, FINGER_TYPE, "Finger Biometric");
    if (!fingerCapability.supportsCredentialLearn) {
      throw new Error("Finger Biometric 未声明 Credential Learn Support，无法执行指纹生命周期测试。 ");
    }
    if (fingerSlot > fingerCapability.numberOfCredentialSlots || fingerSlot2 > fingerCapability.numberOfCredentialSlots) {
      throw new Error(`指纹测试 slot 超出能力范围：slot=${fingerSlot}/${fingerSlot2}，支持 ${fingerCapability.numberOfCredentialSlots}。`);
    }
    if ((userCapabilities.numberOfSupportedUsers ?? 0) < Math.max(primaryUserId, secondaryUserId)) {
      throw new Error(`测试 User ID 超出设备声明范围：需要 ${Math.max(primaryUserId, secondaryUserId)}，设备支持 ${String(userCapabilities.numberOfSupportedUsers)}。`);
    }

    const timeoutSec = learnTimeoutSeconds(fingerCapability);

    await context.log("warn", "precheck.cleanup", "将清理测试使用的 User ID 和 Finger Credential Slot，请确认这些 ID 未保存生产数据", {
      primaryUserId,
      secondaryUserId,
      fingerSlot,
      fingerSlot2,
      timeoutSec,
    });

    try {
      await deleteUserBestEffort(context, primaryUserId);
      await deleteUserBestEffort(context, secondaryUserId);
      await setGeneralUser(context, primaryUserId, UserCredentialRule.Single, true);
      await setGeneralUser(context, secondaryUserId, UserCredentialRule.Single, true);

      if (fingerCapability.minCredentialLength === 0 && fingerCapability.maxCredentialLength === 0) {
        await expectCommandRejectedOrUnchanged(context, "finger.direct-set.ignored", async () => {
          await context.invokeCcApi({
            commandClass: USER_CREDENTIAL_CC,
            method: "setCredential",
            args: [{
              userId: primaryUserId,
              credentialType: FINGER_TYPE,
              credentialSlot: fingerSlot2,
              operationType: UserCredentialOperationType.Add,
              credentialData: Bytes.from([0x01, 0x02, 0x03, 0x04]),
            }],
          });
        });
        await assertCredentialEmpty(context, primaryUserId, FINGER_TYPE, fingerSlot2, "finger.direct-set.assert");
      }

      const addReport = await learnFingerprint(context, {
        userId: primaryUserId,
        slot: fingerSlot,
        operationType: UserCredentialOperationType.Add,
        timeoutSec,
        promptKey: "finger-add-primary",
        promptTitle: "录入主用户指纹",
        promptMessage: "请在门锁上为主测试用户录入 Finger-A，录入成功后测试会自动继续。",
      });
      const firstFingerHex = bytesToHex(addReport.credentialData);
      await assertCredentialReportFitsCapability(context, addReport, fingerCapability, "Finger Biometric", "finger.add.hash-length.assert");
      await context.log("info", "finger.add.assert", "指纹 Add 学习成功并已读取到 credential", {
        report: addReport,
        dataHex: firstFingerHex,
        credentialLength: credentialLength(addReport),
      });

      await expectCommandRejectedOrUnchanged(context, "finger.learn-add.occupied", async () => {
        await startCredentialLearn(context, {
          userId: primaryUserId,
          credentialType: FINGER_TYPE,
          slot: fingerSlot,
          operationType: UserCredentialOperationType.Add,
          timeoutSec: Math.min(timeoutSec, 10),
        });
      });
      const afterInvalidAdd = await getCredential(context, primaryUserId, FINGER_TYPE, fingerSlot);
      await assertCredentialReportFitsCapability(context, afterInvalidAdd, fingerCapability, "Finger Biometric", "finger.learn-add.occupied.hash-length.assert");
      if (bytesToHex(afterInvalidAdd?.credentialData) !== firstFingerHex) {
        throw new Error("Learn Add 到已占用指纹 slot 后，原 credential 被改变。 ");
      }

      await expectCommandRejectedOrUnchanged(context, "finger.learn-modify.empty", async () => {
        await startCredentialLearn(context, {
          userId: primaryUserId,
          credentialType: FINGER_TYPE,
          slot: fingerSlot2,
          operationType: UserCredentialOperationType.Modify,
          timeoutSec: Math.min(timeoutSec, 10),
        });
      });
      await assertCredentialEmpty(context, primaryUserId, FINGER_TYPE, fingerSlot2, "finger.learn-modify.empty.assert");

      await startCredentialLearn(context, {
        userId: primaryUserId,
        credentialType: FINGER_TYPE,
        slot: fingerSlot2,
        operationType: UserCredentialOperationType.Add,
        timeoutSec: Math.min(timeoutSec, 15),
      });
      await context.wait(500);
      await expectCommandRejectedOrUnchanged(context, "finger.learn-already-in-progress", async () => {
        await startCredentialLearn(context, {
          userId: primaryUserId,
          credentialType: FINGER_TYPE,
          slot: fingerSlot2,
          operationType: UserCredentialOperationType.Add,
          timeoutSec: Math.min(timeoutSec, 15),
        });
      });
      await cancelCredentialLearn(context);
      await waitForCredentialEmpty(context, { userId: primaryUserId, credentialType: FINGER_TYPE, slot: fingerSlot2, timeoutMs: 5_000 });
      await context.log("info", "finger.learn-already-in-progress.assert", "重复 Start Learn 后未写入 credential，已 Cancel 并确认 slot 为空", {
        expectedLearnStatus: UserCredentialLearnStatus.AlreadyInProgress,
        expectedLearnStatusName: UserCredentialLearnStatus[UserCredentialLearnStatus.AlreadyInProgress],
      });

      await startCredentialLearn(context, {
        userId: primaryUserId,
        credentialType: FINGER_TYPE,
        slot: fingerSlot2,
        operationType: UserCredentialOperationType.Add,
        timeoutSec: 5,
      });
      await context.log("info", "finger.learn-timeout.wait", "已启动指纹学习超时测试，请不要录入任何指纹", { timeoutSec: 5 });
      await context.wait(7_000);
      await waitForCredentialEmpty(context, { userId: primaryUserId, credentialType: FINGER_TYPE, slot: fingerSlot2, timeoutMs: 1_000 });

      await startCredentialLearn(context, {
        userId: primaryUserId,
        credentialType: FINGER_TYPE,
        slot: fingerSlot2,
        operationType: UserCredentialOperationType.Add,
        timeoutSec: Math.min(timeoutSec, 30),
      });
      await context.wait(500);
      await cancelCredentialLearn(context);
      await waitForCredentialEmpty(context, { userId: primaryUserId, credentialType: FINGER_TYPE, slot: fingerSlot2, timeoutMs: 5_000 });
      await context.log("info", "finger.learn-cancel.assert", "Credential Learn Cancel 后 slot 保持为空", { fingerSlot2 });

      const modifyReport = await learnFingerprint(context, {
        userId: primaryUserId,
        slot: fingerSlot,
        operationType: UserCredentialOperationType.Modify,
        timeoutSec,
        promptKey: "finger-modify-primary",
        promptTitle: "修改主用户指纹",
        promptMessage: "请在门锁上为主测试用户录入另一枚 Finger-B，录入成功后测试会自动继续。",
        previousDataHex: firstFingerHex,
      });
      const modifiedFingerHex = bytesToHex(modifyReport.credentialData);
      await assertCredentialReportFitsCapability(context, modifyReport, fingerCapability, "Finger Biometric", "finger.modify.hash-length.assert");
      await context.log("info", "finger.modify.assert", "指纹 Modify 学习成功", {
        beforeHex: firstFingerHex,
        afterHex: modifiedFingerHex,
        report: modifyReport,
      });

      let associationResult: Record<string, unknown> | undefined;
      try {
        await context.invokeCcApi({
          commandClass: USER_CREDENTIAL_CC,
          method: "setUserCredentialAssociation",
          args: [{ credentialType: FINGER_TYPE, credentialSlot: fingerSlot, destinationUserId: secondaryUserId }],
        });
        const movedReport = await waitForCredentialOccupied(context, {
          userId: secondaryUserId,
          credentialType: FINGER_TYPE,
          slot: fingerSlot,
          timeoutMs: 5_000,
        });
        associationResult = { movedToSecondary: movedReport };
        await context.invokeCcApi({
          commandClass: USER_CREDENTIAL_CC,
          method: "setUserCredentialAssociation",
          args: [{ credentialType: FINGER_TYPE, credentialSlot: fingerSlot, destinationUserId: primaryUserId }],
        });
        await waitForCredentialOccupied(context, {
          userId: primaryUserId,
          credentialType: FINGER_TYPE,
          slot: fingerSlot,
          timeoutMs: 5_000,
        });
        associationResult.movedBackToPrimary = true;
        await context.log("info", "finger.association.success", "User Credential Association 成功迁移并恢复指纹 credential", associationResult);
      } catch (error) {
        await context.log("warn", "finger.association.skip", "Association 成功迁移测试未完成，记录为警告并继续后续删除验证", {
          error: formatErrorMessage(error),
        });
      }

      await expectCommandRejectedOrUnchanged(context, "finger.association.empty-slot", async () => {
        await context.invokeCcApi({
          commandClass: USER_CREDENTIAL_CC,
          method: "setUserCredentialAssociation",
          args: [{ credentialType: FINGER_TYPE, credentialSlot: fingerSlot2, destinationUserId: primaryUserId }],
        });
      });
      await assertCredentialEmpty(context, primaryUserId, FINGER_TYPE, fingerSlot2, "finger.association.empty-slot.assert");

      await deleteCredentialBestEffort(context, primaryUserId, FINGER_TYPE, fingerSlot);
      await assertCredentialEmpty(context, primaryUserId, FINGER_TYPE, fingerSlot, "finger.delete.assert");

      await context.log("info", "result", "User Credential 指纹生命周期测试完成", {
        primaryUserId,
        secondaryUserId,
        fingerCapability,
        associationResult,
      });

      return {
        primaryUserId,
        secondaryUserId,
        fingerSlot,
        fingerSlot2,
        fingerCapability,
        associationResult,
      };
    } finally {
      await deleteUserBestEffort(context, primaryUserId);
      await deleteUserBestEffort(context, secondaryUserId);
    }
  },
};



export const userCredentialPasswordLifecycleDefinition: ExecutableTestDefinition = {
  traceCommandClasses: [USER_CREDENTIAL_CC],
  meta: {
    id: "user-credential-password-lifecycle-v1",
    key: "user-credential-password-lifecycle",
    name: "User Credential Password 生命周期",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "当设备声明支持 Password Credential Type 时，自动验证 Password Add/Get/Modify/Delete、占用 slot、空 slot 修改和长度边界。",
    inputSchema: {},
  },
  supports: supportsUserCredential,
  async run(context) {
    const primaryUserId = getInputNumber(context, "primaryUserId", DEFAULT_PRIMARY_USER_ID);
    const passwordSlot = getInputNumber(context, "passwordSlot", DEFAULT_PIN_SLOT);
    const passwordSlot2 = getInputNumber(context, "passwordSlot2", DEFAULT_PIN_SLOT_2);

    const [userCapabilities, credentialCapabilities] = await Promise.all([
      readUserCapabilities(context),
      readCredentialCapabilities(context),
    ]);
    const passwordCapability = requireCapability(credentialCapabilities, PASSWORD_TYPE, "Password");
    if ((userCapabilities.numberOfSupportedUsers ?? 0) < primaryUserId) {
      throw new Error(`测试 User ID 超出设备声明范围：需要 ${primaryUserId}，设备支持 ${String(userCapabilities.numberOfSupportedUsers)}。`);
    }
    if (Math.max(passwordSlot, passwordSlot2) > passwordCapability.numberOfCredentialSlots) {
      throw new Error(`Password 测试 slot 超出能力范围：slot=${passwordSlot}/${passwordSlot2}，支持 ${passwordCapability.numberOfCredentialSlots}。`);
    }
    if (passwordSlot === passwordSlot2) {
      throw new Error("Password 生命周期测试需要两个不同 slot，请调整 passwordSlot/passwordSlot2。");
    }

    const password = chooseValidAsciiCredential(getInputString(context, "password", DEFAULT_PASSWORD), passwordCapability);
    const editedPassword = chooseValidAsciiCredential(getInputString(context, "editedPassword", DEFAULT_PASSWORD_EDITED), passwordCapability);
    await context.log("warn", "precheck.cleanup", "将清理测试使用的 User ID 和 Password Slot，请确认这些 ID 未保存生产数据", {
      primaryUserId,
      passwordSlot,
      passwordSlot2,
    });

    try {
      await deleteUserBestEffort(context, primaryUserId);
      await setGeneralUser(context, primaryUserId, UserCredentialRule.Single, true);

      await setAsciiCredential(context, {
        userId: primaryUserId,
        credentialType: PASSWORD_TYPE,
        slot: passwordSlot,
        operationType: UserCredentialOperationType.Add,
        value: password,
      });
      await context.wait(WAIT_SHORT_MS);
      await assertAsciiCredential(context, {
        userId: primaryUserId,
        credentialType: PASSWORD_TYPE,
        slot: passwordSlot,
        expectedValue: password,
        capability: passwordCapability,
        label: "Password",
        stepKey: "password.add.assert",
      });

      await expectCommandRejectedOrUnchanged(context, "password.add.occupied", async () => {
        await setAsciiCredential(context, {
          userId: primaryUserId,
          credentialType: PASSWORD_TYPE,
          slot: passwordSlot,
          operationType: UserCredentialOperationType.Add,
          value: editedPassword,
        });
      });
      await assertAsciiCredential(context, {
        userId: primaryUserId,
        credentialType: PASSWORD_TYPE,
        slot: passwordSlot,
        expectedValue: password,
        capability: passwordCapability,
        label: "Password",
        stepKey: "password.add.occupied.assert",
      });

      await expectCommandRejectedOrUnchanged(context, "password.modify.empty", async () => {
        await setAsciiCredential(context, {
          userId: primaryUserId,
          credentialType: PASSWORD_TYPE,
          slot: passwordSlot2,
          operationType: UserCredentialOperationType.Modify,
          value: editedPassword,
        });
      });
      await assertCredentialEmpty(context, primaryUserId, PASSWORD_TYPE, passwordSlot2, "password.modify.empty.assert");

      const shortPassword = passwordCapability.minCredentialLength > 1 ? "x".repeat(passwordCapability.minCredentialLength - 1) : undefined;
      if (shortPassword) {
        await expectCommandRejectedOrUnchanged(context, "password.invalid.short", async () => {
          await setAsciiCredential(context, {
            userId: primaryUserId,
            credentialType: PASSWORD_TYPE,
            slot: passwordSlot2,
            operationType: UserCredentialOperationType.Add,
            value: shortPassword,
          });
        });
        await assertCredentialEmpty(context, primaryUserId, PASSWORD_TYPE, passwordSlot2, "password.invalid.short.assert");
      }

      const longPassword = passwordCapability.maxCredentialLength < 250 ? "y".repeat(passwordCapability.maxCredentialLength + 1) : undefined;
      if (longPassword) {
        await expectCommandRejectedOrUnchanged(context, "password.invalid.long", async () => {
          await setAsciiCredential(context, {
            userId: primaryUserId,
            credentialType: PASSWORD_TYPE,
            slot: passwordSlot2,
            operationType: UserCredentialOperationType.Add,
            value: longPassword,
          });
        });
        await assertCredentialEmpty(context, primaryUserId, PASSWORD_TYPE, passwordSlot2, "password.invalid.long.assert");
      }

      await setAsciiCredential(context, {
        userId: primaryUserId,
        credentialType: PASSWORD_TYPE,
        slot: passwordSlot,
        operationType: UserCredentialOperationType.Modify,
        value: editedPassword,
      });
      await context.wait(WAIT_SHORT_MS);
      await assertAsciiCredential(context, {
        userId: primaryUserId,
        credentialType: PASSWORD_TYPE,
        slot: passwordSlot,
        expectedValue: editedPassword,
        capability: passwordCapability,
        label: "Password",
        stepKey: "password.modify.assert",
      });

      await deleteCredentialBestEffort(context, primaryUserId, PASSWORD_TYPE, passwordSlot);
      await assertCredentialEmpty(context, primaryUserId, PASSWORD_TYPE, passwordSlot, "password.delete.assert");

      await context.log("info", "result", "Password Credential 生命周期测试完成", {
        primaryUserId,
        passwordSlot,
        passwordSlot2,
        passwordCapability,
      });

      return {
        primaryUserId,
        passwordSlot,
        passwordSlot2,
        passwordCapability,
      };
    } finally {
      await deleteUserBestEffort(context, primaryUserId);
    }
  },
};

export const userCredentialChecksumDefinition: ExecutableTestDefinition = {
  traceCommandClasses: [USER_CREDENTIAL_CC],
  meta: {
    id: "user-credential-checksum-v1",
    key: "user-credential-checksum",
    name: "User Credential Checksum 一致性",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "验证 All Users / User / Credential checksum 在 User 和 PIN credential 变化时按规范变化，且未受影响的用户 checksum 保持不变。",
    inputSchema: {},
  },
  supports: supportsUserCredential,
  async run(context) {
    const primaryUserId = getInputNumber(context, "primaryUserId", DEFAULT_PRIMARY_USER_ID);
    const secondaryUserId = getInputNumber(context, "secondaryUserId", DEFAULT_SECONDARY_USER_ID);
    const pinSlot = getInputNumber(context, "pinSlot", DEFAULT_PIN_SLOT);

    const [userCapabilities, credentialCapabilities] = await Promise.all([
      readUserCapabilities(context),
      readCredentialCapabilities(context),
    ]);
    const pinCapability = requireCapability(credentialCapabilities, PIN_TYPE, "PIN Code");
    if (!userCapabilities.supportsAllUsersChecksum) {
      throw new Error("设备未声明支持 All Users Checksum，无法执行 checksum 一致性测试。");
    }
    if (!userCapabilities.supportsUserChecksum) {
      throw new Error("设备未声明支持 User Checksum，无法执行 checksum 一致性测试。");
    }
    if (!credentialCapabilities.supportsCredentialChecksum) {
      throw new Error("设备未声明支持 Credential Checksum，无法执行 checksum 一致性测试。");
    }
    if ((userCapabilities.numberOfSupportedUsers ?? 0) < Math.max(primaryUserId, secondaryUserId)) {
      throw new Error(`测试 User ID 超出设备声明范围：需要 ${Math.max(primaryUserId, secondaryUserId)}，设备支持 ${String(userCapabilities.numberOfSupportedUsers)}。`);
    }
    if (pinSlot > pinCapability.numberOfCredentialSlots) {
      throw new Error(`PIN 测试 slot 超出能力范围：slot=${pinSlot}，支持 ${pinCapability.numberOfCredentialSlots}。`);
    }

    const pin = chooseValidPin(getInputString(context, "pin", DEFAULT_PIN), pinCapability);
    await context.log("warn", "precheck.cleanup", "将清理测试使用的 User ID 和 PIN Slot，请确认这些 ID 未保存生产数据", {
      primaryUserId,
      secondaryUserId,
      pinSlot,
    });

    try {
      await deleteUserBestEffort(context, primaryUserId);
      await deleteUserBestEffort(context, secondaryUserId);

      const baselineAll = await readAllUsersChecksum(context);
      const baselinePrimary = await readUserChecksum(context, primaryUserId);
      const baselineSecondary = await readUserChecksum(context, secondaryUserId);
      const baselinePin = await readCredentialChecksum(context, PIN_TYPE);
      await context.log("info", "checksum.baseline", "读取 checksum 基线", {
        baselineAll,
        baselinePrimary,
        baselineSecondary,
        baselinePin,
      });

      await setGeneralUser(context, primaryUserId, UserCredentialRule.Single, true);
      await context.wait(WAIT_SHORT_MS);
      const afterUserAddAll = await readAllUsersChecksum(context);
      const afterUserAddPrimary = await readUserChecksum(context, primaryUserId);
      const afterUserAddSecondary = await readUserChecksum(context, secondaryUserId);
      assertChecksumChanged(baselineAll, afterUserAddAll, "All Users Checksum");
      assertChecksumChanged(baselinePrimary, afterUserAddPrimary, "Primary User Checksum");
      assertChecksumUnchanged(baselineSecondary, afterUserAddSecondary, "Secondary User Checksum");

      await addPin(context, primaryUserId, pinSlot, pin);
      await context.wait(WAIT_SHORT_MS);
      await assertPin(context, primaryUserId, pinSlot, pin, "checksum.pin.assert");
      const afterPinAddAll = await readAllUsersChecksum(context);
      const afterPinAddPrimary = await readUserChecksum(context, primaryUserId);
      const afterPinAddSecondary = await readUserChecksum(context, secondaryUserId);
      const afterPinAddPin = await readCredentialChecksum(context, PIN_TYPE);
      assertChecksumChanged(afterUserAddAll, afterPinAddAll, "All Users Checksum");
      assertChecksumChanged(afterUserAddPrimary, afterPinAddPrimary, "Primary User Checksum");
      assertChecksumUnchanged(afterUserAddSecondary, afterPinAddSecondary, "Secondary User Checksum");
      assertChecksumChanged(baselinePin, afterPinAddPin, "PIN Credential Checksum");

      await deleteCredentialBestEffort(context, primaryUserId, PIN_TYPE, pinSlot);
      await assertCredentialEmpty(context, primaryUserId, PIN_TYPE, pinSlot, "checksum.pin.delete.assert");
      const afterPinDeleteAll = await readAllUsersChecksum(context);
      const afterPinDeletePrimary = await readUserChecksum(context, primaryUserId);
      const afterPinDeletePin = await readCredentialChecksum(context, PIN_TYPE);
      assertChecksumChanged(afterPinAddAll, afterPinDeleteAll, "All Users Checksum");
      assertChecksumChanged(afterPinAddPrimary, afterPinDeletePrimary, "Primary User Checksum");
      assertChecksumChanged(afterPinAddPin, afterPinDeletePin, "PIN Credential Checksum");

      await context.log("info", "result", "User Credential checksum 一致性测试完成", {
        baselineAll,
        afterUserAddAll,
        afterPinAddAll,
        afterPinDeleteAll,
        baselinePrimary,
        afterUserAddPrimary,
        afterPinAddPrimary,
        afterPinDeletePrimary,
        baselinePin,
        afterPinAddPin,
        afterPinDeletePin,
      });

      return {
        primaryUserId,
        secondaryUserId,
        pinSlot,
        checksums: {
          baselineAll,
          afterUserAddAll,
          afterPinAddAll,
          afterPinDeleteAll,
          baselinePrimary,
          afterUserAddPrimary,
          afterPinAddPrimary,
          afterPinDeletePrimary,
          baselinePin,
          afterPinAddPin,
          afterPinDeletePin,
        },
      };
    } finally {
      await deleteUserBestEffort(context, primaryUserId);
      await deleteUserBestEffort(context, secondaryUserId);
    }
  },
};

export const userCredentialAdminPinDefinition: ExecutableTestDefinition = {
  traceCommandClasses: [USER_CREDENTIAL_CC],
  meta: {
    id: "user-credential-admin-pin-v1",
    key: "user-credential-admin-pin",
    name: "User Credential Admin PIN Code",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "验证 Admin PIN Code Set/Get/Modify/Deactivate，以及 Admin PIN 与普通 PIN 互斥的重复码规则。",
    inputSchema: {},
  },
  supports: supportsUserCredential,
  async run(context) {
    const primaryUserId = getInputNumber(context, "primaryUserId", DEFAULT_PRIMARY_USER_ID);
    const pinSlot = getInputNumber(context, "pinSlot", DEFAULT_PIN_SLOT);
    const pinSlot2 = getInputNumber(context, "pinSlot2", DEFAULT_PIN_SLOT_2);

    const [userCapabilities, credentialCapabilities] = await Promise.all([
      readUserCapabilities(context),
      readCredentialCapabilities(context),
    ]);
    const pinCapability = requireCapability(credentialCapabilities, PIN_TYPE, "PIN Code");
    if (!credentialCapabilities.supportsAdminCode) {
      throw new Error("设备未声明支持 Admin Code，无法执行 Admin PIN 测试。");
    }
    if ((userCapabilities.numberOfSupportedUsers ?? 0) < primaryUserId) {
      throw new Error(`测试 User ID 超出设备声明范围：需要 ${primaryUserId}，设备支持 ${String(userCapabilities.numberOfSupportedUsers)}。`);
    }
    if (Math.max(pinSlot, pinSlot2) > pinCapability.numberOfCredentialSlots) {
      throw new Error(`PIN 测试 slot 超出能力范围：slot=${pinSlot}/${pinSlot2}，支持 ${pinCapability.numberOfCredentialSlots}。`);
    }

    const pin = chooseValidPin(getInputString(context, "pin", DEFAULT_PIN), pinCapability);
    const adminPin = chooseValidPin(getInputString(context, "adminPin", DEFAULT_ADMIN_PIN), pinCapability);
    const editedAdminPin = chooseValidPin(getInputString(context, "editedAdminPin", DEFAULT_ADMIN_PIN_EDITED), pinCapability);
    if (pin === adminPin || adminPin === editedAdminPin || pin === editedAdminPin) {
      throw new Error("测试 PIN / Admin PIN / Edited Admin PIN 必须互不相同。 ");
    }

    await context.log("warn", "precheck.cleanup", "将清理测试使用的 User ID、PIN Slot 和 Admin PIN，请确认这些 ID 未保存生产数据", {
      primaryUserId,
      pinSlot,
      pinSlot2,
      supportsAdminCodeDeactivation: credentialCapabilities.supportsAdminCodeDeactivation,
    });

    try {
      if (credentialCapabilities.supportsAdminCodeDeactivation) {
        await setAdminPinCode(context, "");
        await context.wait(WAIT_SHORT_MS);
      }
      await deleteUserBestEffort(context, primaryUserId);
      await setGeneralUser(context, primaryUserId, UserCredentialRule.Single, true);
      await addPin(context, primaryUserId, pinSlot, pin);
      await assertPin(context, primaryUserId, pinSlot, pin, "admin.setup.normal-pin");

      await expectCommandRejectedOrUnchanged(context, "admin.duplicate-normal-pin", async () => {
        await setAdminPinCode(context, pin);
      });
      const duplicateRead = await getAdminPinCode(context);
      if (duplicateRead === pin) {
        throw new Error(`Admin PIN 不应接受与普通 PIN 相同的值；规范期望 ${adminCodeResultName(UserCredentialAdminCodeOperationResult.FailDuplicateCredential)}。`);
      }

      await setAdminPinCode(context, adminPin);
      await context.wait(WAIT_SHORT_MS);
      let readBack = await getAdminPinCode(context);
      if (readBack !== adminPin) {
        throw new Error(`Admin PIN Set/Get 不一致：期望 ${adminPin}，实际 ${readBack ?? "(empty)"}。`);
      }
      await context.log("info", "admin.set.assert", "Admin PIN 写入并读取成功", { adminPinLength: adminPin.length });

      await logExpectedCredentialReportType(context, "admin.normal-pin-duplicate-admin", UserCredentialCredentialReportType.DuplicateAdminPINCode);
      await expectCommandRejectedOrUnchanged(context, "admin.normal-pin-duplicate-admin", async () => {
        await addPin(context, primaryUserId, pinSlot2, adminPin);
      });
      await assertCredentialEmpty(context, primaryUserId, PIN_TYPE, pinSlot2, "admin.normal-pin-duplicate-admin.assert");

      await setAdminPinCode(context, editedAdminPin);
      await context.wait(WAIT_SHORT_MS);
      readBack = await getAdminPinCode(context);
      if (readBack !== editedAdminPin) {
        throw new Error(`Admin PIN Modify 后读取不一致：期望 ${editedAdminPin}，实际 ${readBack ?? "(empty)"}。`);
      }

      let deactivated = false;
      if (credentialCapabilities.supportsAdminCodeDeactivation) {
        await setAdminPinCode(context, "");
        await context.wait(WAIT_SHORT_MS);
        readBack = await getAdminPinCode(context);
        if (readBack && readBack.length > 0) {
          throw new Error(`Admin PIN Deactivate 后仍读取到 PIN，length=${readBack.length}。`);
        }
        deactivated = true;
      } else {
        await context.log("warn", "admin.deactivate.skip", "设备未声明支持 Admin Code Deactivation，跳过禁用步骤", {
          expectedResultIfAttempted: adminCodeResultName(UserCredentialAdminCodeOperationResult.ErrorDisablingNotSupported),
        });
      }

      await context.log("info", "result", "Admin PIN Code 测试完成", {
        primaryUserId,
        pinSlot,
        pinSlot2,
        deactivated,
      });

      return {
        primaryUserId,
        pinSlot,
        pinSlot2,
        deactivated,
      };
    } finally {
      if (credentialCapabilities.supportsAdminCodeDeactivation) {
        try {
          await setAdminPinCode(context, "");
        } catch (error) {
          await context.log("warn", "cleanup.admin", "清理 Admin PIN 失败，继续清理测试用户", { error: formatErrorMessage(error) });
        }
      }
      await deleteUserBestEffort(context, primaryUserId);
    }
  },
};

export const userCredentialNegativeDefinition: ExecutableTestDefinition = {
  traceCommandClasses: [USER_CREDENTIAL_CC],
  meta: {
    id: "user-credential-negative-v1",
    key: "user-credential-negative",
    name: "User Credential 负向规则",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "验证 Add 到已占用位置、Modify 空位置、重复 credential、错误 User ID、越界 User/Slot、弱 PIN 安全规则等负向行为。",
    inputSchema: {},
  },
  supports: supportsUserCredential,
  async run(context) {
    const primaryUserId = getInputNumber(context, "primaryUserId", DEFAULT_PRIMARY_USER_ID);
    const secondaryUserId = getInputNumber(context, "secondaryUserId", DEFAULT_SECONDARY_USER_ID);
    const pinSlot = getInputNumber(context, "pinSlot", DEFAULT_PIN_SLOT);
    const pinSlot2 = getInputNumber(context, "pinSlot2", DEFAULT_PIN_SLOT_2);

    const [userCapabilities, credentialCapabilities] = await Promise.all([
      readUserCapabilities(context),
      readCredentialCapabilities(context),
    ]);
    const pinCapability = requireCapability(credentialCapabilities, PIN_TYPE, "PIN Code");
    const maxUserId = userCapabilities.numberOfSupportedUsers ?? 0;
    if (maxUserId < Math.max(primaryUserId, secondaryUserId)) {
      throw new Error(`测试 User ID 超出设备声明范围：需要 ${Math.max(primaryUserId, secondaryUserId)}，设备支持 ${String(userCapabilities.numberOfSupportedUsers)}。`);
    }
    if (Math.max(pinSlot, pinSlot2) > pinCapability.numberOfCredentialSlots) {
      throw new Error(`PIN 测试 slot 超出能力范围：slot=${pinSlot}/${pinSlot2}，支持 ${pinCapability.numberOfCredentialSlots}。`);
    }

    const pin = chooseValidPin(getInputString(context, "pin", DEFAULT_PIN), pinCapability);
    const editedPin = chooseValidPin(getInputString(context, "editedPin", DEFAULT_PIN_EDITED), pinCapability);
    const secondaryPin = chooseValidPin(getInputString(context, "secondaryPin", DEFAULT_SECONDARY_PIN), pinCapability);
    const outOfRangeUserId = maxUserId + 1;
    const outOfRangeSlot = pinCapability.numberOfCredentialSlots + 1;

    await context.log("warn", "precheck.cleanup", "将清理测试使用的 User ID 和 PIN Slot，请确认这些 ID 未保存生产数据", {
      primaryUserId,
      secondaryUserId,
      pinSlot,
      pinSlot2,
      outOfRangeUserId,
      outOfRangeSlot,
    });

    try {
      await deleteUserBestEffort(context, primaryUserId);
      await deleteUserBestEffort(context, secondaryUserId);
      await setGeneralUser(context, primaryUserId, UserCredentialRule.Single, true);
      await setGeneralUser(context, secondaryUserId, UserCredentialRule.Single, true);
      await addPin(context, primaryUserId, pinSlot, pin);
      await assertPin(context, primaryUserId, pinSlot, pin, "negative.setup.pin");

      await logExpectedCredentialReportType(context, "negative.add.occupied", UserCredentialCredentialReportType.CredentialAddRejectedLocationOccupied);
      await expectCommandRejectedOrUnchanged(context, "negative.add.occupied", async () => {
        await addPin(context, primaryUserId, pinSlot, editedPin);
      });
      await assertPin(context, primaryUserId, pinSlot, pin, "negative.add.occupied.assert");

      await logExpectedCredentialReportType(context, "negative.modify.empty", UserCredentialCredentialReportType.CredentialModifyRejectedLocationEmpty);
      await expectCommandRejectedOrUnchanged(context, "negative.modify.empty", async () => {
        await modifyPin(context, primaryUserId, pinSlot2, secondaryPin);
      });
      await assertCredentialEmpty(context, primaryUserId, PIN_TYPE, pinSlot2, "negative.modify.empty.assert");

      await logExpectedCredentialReportType(context, "negative.duplicate", UserCredentialCredentialReportType.DuplicateCredential);
      await expectCommandRejectedOrUnchanged(context, "negative.duplicate", async () => {
        await addPin(context, secondaryUserId, pinSlot2, pin);
      });
      await assertCredentialEmpty(context, secondaryUserId, PIN_TYPE, pinSlot2, "negative.duplicate.assert");

      await deleteUserBestEffort(context, secondaryUserId);
      await logExpectedCredentialReportType(context, "negative.wrong-user", UserCredentialCredentialReportType.WrongUserUniqueIdentifier);
      await expectCommandRejectedOrUnchanged(context, "negative.wrong-user", async () => {
        await addPin(context, secondaryUserId, pinSlot2, secondaryPin);
      });
      await assertCredentialEmpty(context, secondaryUserId, PIN_TYPE, pinSlot2, "negative.wrong-user.assert");

      await expectCommandRejectedOrUnchanged(context, "negative.slot-out-of-range", async () => {
        await addPin(context, primaryUserId, outOfRangeSlot, secondaryPin);
      });
      await assertPin(context, primaryUserId, pinSlot, pin, "negative.slot-out-of-range.assert");

      await expectCommandRejectedOrUnchanged(context, "negative.user-out-of-range", async () => {
        await addPin(context, outOfRangeUserId, pinSlot2, secondaryPin);
      });
      await assertPin(context, primaryUserId, pinSlot, pin, "negative.user-out-of-range.assert");

      let weakPinAccepted = false;
      const weakPin = DEFAULT_WEAK_PIN;
      if (weakPin.length >= pinCapability.minCredentialLength && weakPin.length <= pinCapability.maxCredentialLength && weakPin !== pin) {
        await logExpectedCredentialReportType(context, "negative.weak-pin", UserCredentialCredentialReportType.ManufacturerSecurityRules);
        await expectCommandRejectedOrUnchanged(context, "negative.weak-pin", async () => {
          await addPin(context, primaryUserId, pinSlot2, weakPin);
        });
        const weakReport = await getCredential(context, primaryUserId, PIN_TYPE, pinSlot2);
        weakPinAccepted = isCredentialOccupied(weakReport);
        if (weakPinAccepted) {
          await context.log("warn", "negative.weak-pin.accepted", "设备接受了弱 PIN；规范为 SHOULD NOT，记录为警告并清理", {
            weakPin,
            report: weakReport,
          });
          await deleteCredentialBestEffort(context, primaryUserId, PIN_TYPE, pinSlot2);
        } else {
          await assertCredentialEmpty(context, primaryUserId, PIN_TYPE, pinSlot2, "negative.weak-pin.assert");
        }
      } else {
        await context.log("warn", "negative.weak-pin.skip", "弱 PIN 测试值不在设备 PIN 长度范围内或与主 PIN 重复，跳过厂商安全规则测试", {
          weakPin,
          pinCapability,
        });
      }

      await context.log("info", "result", "User Credential 负向规则测试完成", {
        primaryUserId,
        secondaryUserId,
        pinSlot,
        pinSlot2,
        outOfRangeUserId,
        outOfRangeSlot,
        weakPinAccepted,
      });

      return {
        primaryUserId,
        secondaryUserId,
        pinSlot,
        pinSlot2,
        outOfRangeUserId,
        outOfRangeSlot,
        weakPinAccepted,
      };
    } finally {
      await deleteUserBestEffort(context, primaryUserId);
      await deleteUserBestEffort(context, secondaryUserId);
    }
  },
};

export const userCredentialIterationDefinition: ExecutableTestDefinition = {
  traceCommandClasses: [USER_CREDENTIAL_CC],
  meta: {
    id: "user-credential-iteration-v1",
    key: "user-credential-iteration",
    name: "User Credential 迭代字段",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "验证 User Report 的 nextUserId 以及 Credential Report 的 nextCredentialType/nextCredentialSlot 能枚举下一个已占用对象。",
    inputSchema: {},
  },
  supports: supportsUserCredential,
  async run(context) {
    const primaryUserId = getInputNumber(context, "primaryUserId", DEFAULT_PRIMARY_USER_ID);
    const secondaryUserId = getInputNumber(context, "secondaryUserId", DEFAULT_SECONDARY_USER_ID);
    const pinSlot = getInputNumber(context, "pinSlot", DEFAULT_PIN_SLOT);
    const pinSlot2 = getInputNumber(context, "pinSlot2", DEFAULT_PIN_SLOT_2);

    const [userCapabilities, credentialCapabilities] = await Promise.all([
      readUserCapabilities(context),
      readCredentialCapabilities(context),
    ]);
    const pinCapability = requireCapability(credentialCapabilities, PIN_TYPE, "PIN Code");
    if ((userCapabilities.numberOfSupportedUsers ?? 0) < Math.max(primaryUserId, secondaryUserId)) {
      throw new Error(`测试 User ID 超出设备声明范围：需要 ${Math.max(primaryUserId, secondaryUserId)}，设备支持 ${String(userCapabilities.numberOfSupportedUsers)}。`);
    }
    if (Math.max(pinSlot, pinSlot2) > pinCapability.numberOfCredentialSlots) {
      throw new Error(`PIN 测试 slot 超出能力范围：slot=${pinSlot}/${pinSlot2}，支持 ${pinCapability.numberOfCredentialSlots}。`);
    }

    const pin = chooseValidPin(getInputString(context, "pin", DEFAULT_PIN), pinCapability);
    const secondaryPin = chooseValidPin(getInputString(context, "secondaryPin", DEFAULT_SECONDARY_PIN), pinCapability);

    await context.log("warn", "precheck.cleanup", "将清理测试使用的 User ID 和 PIN Slot，请确认这些 ID 未保存生产数据", {
      primaryUserId,
      secondaryUserId,
      pinSlot,
      pinSlot2,
    });

    try {
      await deleteUserBestEffort(context, primaryUserId);
      await deleteUserBestEffort(context, secondaryUserId);
      await setGeneralUser(context, primaryUserId, UserCredentialRule.Single, true);
      await setGeneralUser(context, secondaryUserId, UserCredentialRule.Single, true);
      await addPin(context, primaryUserId, pinSlot, pin);
      await addPin(context, primaryUserId, pinSlot2, secondaryPin);

      const user1 = await assertUserReport(context, primaryUserId, {
        userType: UserCredentialUserType.General,
        active: true,
        credentialRule: UserCredentialRule.Single,
      }, "iteration.user.primary");
      const user2 = await assertUserReport(context, secondaryUserId, {
        userType: UserCredentialUserType.General,
        active: true,
        credentialRule: UserCredentialRule.Single,
      }, "iteration.user.secondary");
      if (user1.nextUserId !== secondaryUserId) {
        throw new Error(`User Report nextUserId 应指向下一个已占用 UID=${secondaryUserId}，实际 ${String(user1.nextUserId)}。`);
      }
      if ((user2.nextUserId ?? 0) !== 0) {
        throw new Error(`最后一个 User Report nextUserId 应为 0，实际 ${String(user2.nextUserId)}。`);
      }

      const credential1 = await assertPin(context, primaryUserId, pinSlot, pin, "iteration.credential.first");
      const credential2 = await assertPin(context, primaryUserId, pinSlot2, secondaryPin, "iteration.credential.second");
      if (credential1.nextCredentialType !== PIN_TYPE || credential1.nextCredentialSlot !== pinSlot2) {
        throw new Error(`Credential Report nextCredential 应指向 PIN Slot=${pinSlot2}，实际 type=${String(credential1.nextCredentialType)} slot=${String(credential1.nextCredentialSlot)}。`);
      }
      if ((credential2.nextCredentialType ?? UserCredentialType.None) !== UserCredentialType.None || (credential2.nextCredentialSlot ?? 0) !== 0) {
        throw new Error(`最后一个 Credential Report nextCredential 应为空，实际 type=${String(credential2.nextCredentialType)} slot=${String(credential2.nextCredentialSlot)}。`);
      }

      await context.log("info", "result", "User / Credential 迭代字段测试完成", {
        user1,
        user2,
        credential1,
        credential2,
      });

      return {
        primaryUserId,
        secondaryUserId,
        pinSlot,
        pinSlot2,
        user1,
        user2,
        credential1,
        credential2,
      };
    } finally {
      await deleteUserBestEffort(context, primaryUserId);
      await deleteUserBestEffort(context, secondaryUserId);
    }
  },
};

export const userCredentialUserTypeDefinition: ExecutableTestDefinition = {
  traceCommandClasses: [USER_CREDENTIAL_CC, "Door Lock", "Notification"],
  meta: {
    id: "user-credential-user-types-v1",
    key: "user-credential-user-types",
    name: "User Credential 用户类型",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "验证 General/Programming/NonAccess 用户类型 Set/Get；对 NonAccess credential 半自动验证本地认证不会开锁。",
    inputSchema: {},
  },
  supports: supportsUserCredentialDoorLock,
  async run(context) {
    const generalUserId = getInputNumber(context, "generalUserId", DEFAULT_PRIMARY_USER_ID);
    const programmingUserId = getInputNumber(context, "programmingUserId", DEFAULT_SECONDARY_USER_ID);
    const nonAccessUserId = getInputNumber(context, "nonAccessUserId", DEFAULT_NON_ACCESS_USER_ID);
    const pinSlot = getInputNumber(context, "pinSlot", DEFAULT_PIN_SLOT);
    const nonAccessPinSlot = getInputNumber(context, "nonAccessPinSlot", DEFAULT_PIN_SLOT_2);

    const [userCapabilities, credentialCapabilities] = await Promise.all([
      readUserCapabilities(context),
      readCredentialCapabilities(context),
    ]);
    const pinCapability = requireCapability(credentialCapabilities, PIN_TYPE, "PIN Code");
    if ((userCapabilities.numberOfSupportedUsers ?? 0) < Math.max(generalUserId, programmingUserId, nonAccessUserId)) {
      throw new Error(`测试 User ID 超出设备声明范围：需要 ${Math.max(generalUserId, programmingUserId, nonAccessUserId)}，设备支持 ${String(userCapabilities.numberOfSupportedUsers)}。`);
    }
    if (Math.max(pinSlot, nonAccessPinSlot) > pinCapability.numberOfCredentialSlots) {
      throw new Error(`PIN 测试 slot 超出能力范围：slot=${pinSlot}/${nonAccessPinSlot}，支持 ${pinCapability.numberOfCredentialSlots}。`);
    }
    if (pinSlot === nonAccessPinSlot && (userCapabilities.supportedUserTypes ?? []).includes(UserCredentialUserType.NonAccess)) {
      throw new Error("General User 与 NonAccess User 需要使用不同 PIN Slot，请调整 nonAccessPinSlot。");
    }

    const supportedUserTypes = userCapabilities.supportedUserTypes ?? [];
    if (!supportedUserTypes.includes(UserCredentialUserType.General)) {
      throw new Error("设备未声明支持 General User，无法执行用户类型测试。");
    }
    const pin = chooseValidPin(getInputString(context, "pin", DEFAULT_PIN), pinCapability);
    const nonAccessPin = chooseValidPin(getInputString(context, "nonAccessPin", "7890"), pinCapability);
    let programmingUser: UserReport | undefined;
    let nonAccessResult: Record<string, unknown> | undefined;

    await context.log("warn", "precheck.cleanup", "将清理测试使用的 User ID 和 PIN Slot，请确认这些 ID 未保存生产数据", {
      generalUserId,
      programmingUserId,
      nonAccessUserId,
      pinSlot,
      nonAccessPinSlot,
      supportedUserTypes,
    });

    try {
      await deleteUserBestEffort(context, generalUserId);
      await deleteUserBestEffort(context, programmingUserId);
      await deleteUserBestEffort(context, nonAccessUserId);

      await setUserWithType(context, { userId: generalUserId, userType: UserCredentialUserType.General, userName: `UC-G-${generalUserId}` });
      const generalUser = await assertUserReport(context, generalUserId, {
        userType: UserCredentialUserType.General,
        active: true,
        credentialRule: UserCredentialRule.Single,
      }, "user-type.general.assert");
      await addPin(context, generalUserId, pinSlot, pin);
      await assertPin(context, generalUserId, pinSlot, pin, "user-type.general.pin");

      if (supportedUserTypes.includes(UserCredentialUserType.Programming)) {
        await setUserWithType(context, { userId: programmingUserId, userType: UserCredentialUserType.Programming, userName: `UC-P-${programmingUserId}` });
        programmingUser = await assertUserReport(context, programmingUserId, {
          userType: UserCredentialUserType.Programming,
          active: true,
          credentialRule: UserCredentialRule.Single,
        }, "user-type.programming.assert");
        await context.log("info", "user-type.programming.note", "Programming User 的本地编程模式进入/退出依赖厂商 UI，本测试只做 User Type Set/Get 规范字段验证。", {
          programmingUserId,
          programmingUser,
        });
      } else {
        await context.log("warn", "user-type.programming.skip", "设备未声明支持 Programming User，跳过 Programming User 字段验证");
      }

      if (supportedUserTypes.includes(UserCredentialUserType.NonAccess)) {
        await setNonAccessUser(context, nonAccessUserId);
        const nonAccessUser = await assertUserReport(context, nonAccessUserId, {
          userType: UserCredentialUserType.NonAccess,
          active: true,
          credentialRule: UserCredentialRule.Single,
        }, "user-type.non-access.assert");
        await addPin(context, nonAccessUserId, nonAccessPinSlot, nonAccessPin);
        await assertPin(context, nonAccessUserId, nonAccessPinSlot, nonAccessPin, "user-type.non-access.pin");
        await ensureLocked(context, "user-type.non-access.prepare");
        nonAccessResult = await assertDoorLockedAfterManualPhase(context, {
          promptKey: "non-access-user-pin",
          promptTitle: "Non-Access User 本地认证",
          promptMessage: `请输入 Non-Access 测试用户 PIN：${nonAccessPin}；测试将确认 credential 不会开锁。`,
          promptMeta: `Non-Access UID=${nonAccessUserId}，PIN Slot=${nonAccessPinSlot}。`,
        });
        nonAccessResult.user = nonAccessUser;
      } else {
        await context.log("warn", "user-type.non-access.skip", "设备未声明支持 NonAccess User，跳过 NonAccess 本地不开锁验证");
      }

      await context.log("info", "result", "User Credential 用户类型测试完成", {
        generalUser,
        programmingUser,
        nonAccessResult,
      });

      return {
        generalUserId,
        programmingUserId,
        nonAccessUserId,
        nonAccessPinSlot,
        generalUser,
        programmingUser,
        nonAccessResult,
      };
    } finally {
      await deleteUserBestEffort(context, generalUserId);
      await deleteUserBestEffort(context, programmingUserId);
      await deleteUserBestEffort(context, nonAccessUserId);
    }
  },
};

export const userCredentialAssociationDefinition: ExecutableTestDefinition = {
  traceCommandClasses: [USER_CREDENTIAL_CC],
  meta: {
    id: "user-credential-association-v1",
    key: "user-credential-association",
    name: "User Credential Association",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "半自动录入指纹后验证 User Credential Association 可迁移 credential，并验证空 slot / 不存在用户迁移不会破坏原 credential。",
    inputSchema: {},
  },
  supports: supportsUserCredential,
  async run(context) {
    const primaryUserId = getInputNumber(context, "primaryUserId", DEFAULT_PRIMARY_USER_ID);
    const secondaryUserId = getInputNumber(context, "secondaryUserId", DEFAULT_SECONDARY_USER_ID);
    const fingerSlot = getInputNumber(context, "fingerSlot", DEFAULT_FINGER_SLOT);
    const emptyFingerSlot = getInputNumber(context, "emptyFingerSlot", DEFAULT_FINGER_SLOT_2);

    const [userCapabilities, credentialCapabilities] = await Promise.all([
      readUserCapabilities(context),
      readCredentialCapabilities(context),
    ]);
    const fingerCapability = requireCapability(credentialCapabilities, FINGER_TYPE, "Finger Biometric");
    if (!fingerCapability.supportsCredentialLearn) {
      throw new Error("Finger Biometric 未声明 Credential Learn Support，无法执行 Association 测试。 ");
    }
    if ((userCapabilities.numberOfSupportedUsers ?? 0) < Math.max(primaryUserId, secondaryUserId)) {
      throw new Error(`测试 User ID 超出设备声明范围：需要 ${Math.max(primaryUserId, secondaryUserId)}，设备支持 ${String(userCapabilities.numberOfSupportedUsers)}。`);
    }
    if (Math.max(fingerSlot, emptyFingerSlot) > fingerCapability.numberOfCredentialSlots) {
      throw new Error(`指纹测试 slot 超出能力范围：slot=${fingerSlot}/${emptyFingerSlot}，支持 ${fingerCapability.numberOfCredentialSlots}。`);
    }

    const invalidDestinationUserId = (userCapabilities.numberOfSupportedUsers ?? secondaryUserId) + 1;
    const timeoutSec = learnTimeoutSeconds(fingerCapability);
    await context.log("warn", "precheck.cleanup", "将清理测试使用的 User ID 和 Finger Slot，请确认这些 ID 未保存生产数据", {
      primaryUserId,
      secondaryUserId,
      invalidDestinationUserId,
      fingerSlot,
      emptyFingerSlot,
      timeoutSec,
    });

    try {
      await deleteUserBestEffort(context, primaryUserId);
      await deleteUserBestEffort(context, secondaryUserId);
      await setGeneralUser(context, primaryUserId, UserCredentialRule.Single, true);
      await setGeneralUser(context, secondaryUserId, UserCredentialRule.Single, true);

      const learned = await learnFingerprint(context, {
        userId: primaryUserId,
        slot: fingerSlot,
        operationType: UserCredentialOperationType.Add,
        timeoutSec,
        promptKey: "association-learn-primary-finger",
        promptTitle: "录入待迁移指纹",
        promptMessage: "请在门锁上为主测试用户录入一枚指纹，用于 User Credential Association 迁移测试。",
      });
      const originalHex = bytesToHex(learned.credentialData);
      await assertCredentialReportFitsCapability(context, learned, fingerCapability, "Finger Biometric", "association.learn.hash-length.assert");

      await context.invokeCcApi({
        commandClass: USER_CREDENTIAL_CC,
        method: "setUserCredentialAssociation",
        args: [{ credentialType: FINGER_TYPE, credentialSlot: fingerSlot, destinationUserId: secondaryUserId }],
      });
      const movedToSecondary = await waitForCredentialOccupied(context, {
        userId: secondaryUserId,
        credentialType: FINGER_TYPE,
        slot: fingerSlot,
        timeoutMs: 5_000,
      });
      await assertCredentialEmpty(context, primaryUserId, FINGER_TYPE, fingerSlot, "association.move.primary-empty");
      if (bytesToHex(movedToSecondary.credentialData) !== originalHex) {
        throw new Error("Association 迁移后 credential hash/data 与原始值不一致。 ");
      }

      await expectCommandRejectedOrUnchanged(context, "association.invalid-destination", async () => {
        await context.invokeCcApi({
          commandClass: USER_CREDENTIAL_CC,
          method: "setUserCredentialAssociation",
          args: [{ credentialType: FINGER_TYPE, credentialSlot: fingerSlot, destinationUserId: invalidDestinationUserId }],
        });
      });
      const afterInvalidDestination = await getCredential(context, secondaryUserId, FINGER_TYPE, fingerSlot);
      if (bytesToHex(afterInvalidDestination?.credentialData) !== originalHex) {
        throw new Error("Association 到不存在 User 后，原 credential 不应被移动或改变。 ");
      }

      await expectCommandRejectedOrUnchanged(context, "association.empty-slot", async () => {
        await context.invokeCcApi({
          commandClass: USER_CREDENTIAL_CC,
          method: "setUserCredentialAssociation",
          args: [{ credentialType: FINGER_TYPE, credentialSlot: emptyFingerSlot, destinationUserId: primaryUserId }],
        });
      });
      await assertCredentialEmpty(context, primaryUserId, FINGER_TYPE, emptyFingerSlot, "association.empty-slot.assert");

      await context.invokeCcApi({
        commandClass: USER_CREDENTIAL_CC,
        method: "setUserCredentialAssociation",
        args: [{ credentialType: FINGER_TYPE, credentialSlot: fingerSlot, destinationUserId: primaryUserId }],
      });
      const movedBack = await waitForCredentialOccupied(context, {
        userId: primaryUserId,
        credentialType: FINGER_TYPE,
        slot: fingerSlot,
        timeoutMs: 5_000,
      });
      await assertCredentialEmpty(context, secondaryUserId, FINGER_TYPE, fingerSlot, "association.move-back.secondary-empty");
      if (bytesToHex(movedBack.credentialData) !== originalHex) {
        throw new Error("Association 迁回后 credential hash/data 与原始值不一致。 ");
      }

      await context.log("info", "result", "User Credential Association 测试完成", {
        primaryUserId,
        secondaryUserId,
        fingerSlot,
        emptyFingerSlot,
        originalHex,
        movedToSecondary,
        movedBack,
      });

      return {
        primaryUserId,
        secondaryUserId,
        fingerSlot,
        emptyFingerSlot,
        movedToSecondary,
        movedBack,
      };
    } finally {
      await deleteUserBestEffort(context, primaryUserId);
      await deleteUserBestEffort(context, secondaryUserId);
    }
  },
};

export const userCredentialDualAuthDefinition: ExecutableTestDefinition = {
  traceCommandClasses: [USER_CREDENTIAL_CC, "Door Lock", "Notification"],
  meta: {
    id: "user-credential-dual-auth-v1",
    key: "user-credential-dual-auth",
    name: "User Credential PIN + 指纹组合认证",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "半自动验证 Dual Rule 下 PIN-only、finger-only 不开锁，PIN+finger 开锁，不同用户 credential 不得组合，并验证相关 Notification/Door Lock 状态。",
    inputSchema: {},
  },
  supports: supportsUserCredentialDoorLock,
  async run(context) {
    const primaryUserId = getInputNumber(context, "primaryUserId", DEFAULT_PRIMARY_USER_ID);
    const secondaryUserId = getInputNumber(context, "secondaryUserId", DEFAULT_SECONDARY_USER_ID);
    const nonAccessUserId = getInputNumber(context, "nonAccessUserId", DEFAULT_NON_ACCESS_USER_ID);
    const pinSlot = getInputNumber(context, "pinSlot", DEFAULT_PIN_SLOT);
    const secondaryPinSlot = getInputNumber(context, "secondaryPinSlot", DEFAULT_PIN_SLOT_2);
    const fingerSlot = getInputNumber(context, "fingerSlot", DEFAULT_FINGER_SLOT);
    const fingerSlot2 = getInputNumber(context, "fingerSlot2", DEFAULT_FINGER_SLOT_2);

    const [userCapabilities, credentialCapabilities] = await Promise.all([
      readUserCapabilities(context),
      readCredentialCapabilities(context),
    ]);
    if (!userCapabilities.supportedCredentialRules?.includes(UserCredentialRule.Dual)) {
      throw new Error("设备未声明支持 Dual Credential Rule (0x02)。");
    }
    const pinCapability = requireCapability(credentialCapabilities, PIN_TYPE, "PIN Code");
    const fingerCapability = requireCapability(credentialCapabilities, FINGER_TYPE, "Finger Biometric");
    if (!fingerCapability.supportsCredentialLearn) {
      throw new Error("Finger Biometric 未声明 Credential Learn Support，无法执行 PIN + 指纹组合认证测试。 ");
    }

    const pin = chooseValidPin(getInputString(context, "pin", DEFAULT_PIN), pinCapability);
    const secondaryPin = chooseValidPin(getInputString(context, "secondaryPin", DEFAULT_SECONDARY_PIN), pinCapability);
    const timeoutSec = learnTimeoutSeconds(fingerCapability);

    await context.log("warn", "precheck.cleanup", "将清理并重建测试用户和 credential，请确认这些 ID 未保存生产数据", {
      primaryUserId,
      secondaryUserId,
      nonAccessUserId,
      pinSlot,
      secondaryPinSlot,
      fingerSlot,
      fingerSlot2,
    });

    try {
      await deleteUserBestEffort(context, primaryUserId);
      await deleteUserBestEffort(context, secondaryUserId);
      await deleteUserBestEffort(context, nonAccessUserId);

      await setGeneralUser(context, primaryUserId, UserCredentialRule.Dual, true);
      await setGeneralUser(context, secondaryUserId, UserCredentialRule.Single, true);
      if (userCapabilities.supportedUserTypes?.includes(UserCredentialUserType.NonAccess)) {
        await setNonAccessUser(context, nonAccessUserId);
      }

      await addPin(context, primaryUserId, pinSlot, pin);
      await assertPin(context, primaryUserId, pinSlot, pin, "setup.pin.primary");
      await addPin(context, secondaryUserId, secondaryPinSlot, secondaryPin);
      await assertPin(context, secondaryUserId, secondaryPinSlot, secondaryPin, "setup.pin.secondary");

      await learnFingerprint(context, {
        userId: primaryUserId,
        slot: fingerSlot,
        operationType: UserCredentialOperationType.Add,
        timeoutSec,
        promptKey: "dual-learn-primary-finger",
        promptTitle: "录入 Dual 主用户指纹",
        promptMessage: "请在门锁上为主测试用户录入 Finger-A，用于 PIN + 指纹组合认证测试。",
      });
      await learnFingerprint(context, {
        userId: secondaryUserId,
        slot: fingerSlot2,
        operationType: UserCredentialOperationType.Add,
        timeoutSec,
        promptKey: "dual-learn-secondary-finger",
        promptTitle: "录入第二用户指纹",
        promptMessage: "请在门锁上为第二测试用户录入另一枚 Finger-B，用于不同用户 credential 混用测试。",
      });

      await ensureLocked(context, "dual.pin-only.prepare");
      const pinOnly = await assertDoorLockedAfterManualPhase(context, {
        promptKey: "dual-pin-only",
        promptTitle: "Dual Rule - 仅输入 PIN",
        promptMessage: `请只输入主用户 PIN：${pin}，不要输入指纹；测试将确认门锁不会解锁。`,
        promptMeta: `User ID=${primaryUserId}，PIN Slot=${pinSlot}，等待 ${NEGATIVE_AUTH_WAIT_MS / 1000} 秒。`,
      });
      const pinOnlyDenied = await waitForAccessControlEvent(context, ACCESS_CONTROL_NOT_ENOUGH_CREDENTIALS, 1_000);

      await ensureLocked(context, "dual.finger-only.prepare");
      const fingerOnly = await assertDoorLockedAfterManualPhase(context, {
        promptKey: "dual-finger-only",
        promptTitle: "Dual Rule - 仅输入指纹",
        promptMessage: "请只输入主用户 Finger-A，不要输入 PIN；测试将确认门锁不会解锁。",
        promptMeta: `User ID=${primaryUserId}，Finger Slot=${fingerSlot}，等待 ${NEGATIVE_AUTH_WAIT_MS / 1000} 秒。`,
      });
      const fingerOnlyDenied = await waitForAccessControlEvent(context, ACCESS_CONTROL_NOT_ENOUGH_CREDENTIALS, 1_000);

      await ensureLocked(context, "dual.success.prepare");
      const success = await assertDoorUnlockedAfterManualPhase(context, {
        promptKey: "dual-success-pin-finger",
        promptTitle: "Dual Rule - PIN + 指纹开锁",
        promptMessage: `请在组合认证窗口内输入主用户 PIN：${pin}，然后输入主用户 Finger-A。`,
        promptMeta: `User ID=${primaryUserId}，期望门锁解锁。`,
      });
      const successNotification = await waitForAccessControlEvent(context, ACCESS_CONTROL_CREDENTIAL_UNLOCK, 1_000);

      await ensureLocked(context, "dual.cross-user.prepare");
      const crossUser = await assertDoorLockedAfterManualPhase(context, {
        promptKey: "dual-cross-user",
        promptTitle: "Dual Rule - 不同用户 credential 混用",
        promptMessage: `请先输入主用户 PIN：${pin}，再输入第二用户 Finger-B；测试将确认不会解锁。`,
        promptMeta: `主用户 UID=${primaryUserId}，第二用户 UID=${secondaryUserId}。`,
      });

      await ensureLocked(context, "dual.invalid.prepare");
      const invalidSecond = await assertDoorLockedAfterManualPhase(context, {
        promptKey: "dual-invalid-second",
        promptTitle: "Dual Rule - 一个有效一个无效",
        promptMessage: `请先输入主用户 PIN：${pin}，再输入未注册的指纹；测试将确认不会解锁。`,
        promptMeta: "如果门锁无法区分未注册指纹，请使用未录入过的手指。",
      });
      const invalidNotification = await waitForAccessControlEvent(context, ACCESS_CONTROL_INVALID_CREDENTIAL, 1_000);

      let nonAccessResult: Record<string, unknown> | undefined;
      if (userCapabilities.supportedUserTypes?.includes(UserCredentialUserType.NonAccess)) {
        await addPin(context, nonAccessUserId, pinSlot, chooseValidPin("7890", pinCapability));
        await ensureLocked(context, "non-access.prepare");
        nonAccessResult = await assertDoorLockedAfterManualPhase(context, {
          promptKey: "non-access-pin",
          promptTitle: "Non-Access User credential",
          promptMessage: "请输入 Non-Access 测试用户 PIN：7890；测试将确认 credential 被识别但不会开锁。",
          promptMeta: `Non-Access UID=${nonAccessUserId}。`,
        });
      }

      await context.log("info", "result", "User Credential PIN + 指纹组合认证测试完成", {
        pinOnly,
        pinOnlyDenied,
        fingerOnly,
        fingerOnlyDenied,
        success,
        successNotification,
        crossUser,
        invalidSecond,
        invalidNotification,
        nonAccessResult,
      });

      return {
        primaryUserId,
        secondaryUserId,
        nonAccessUserId,
        pinOnly,
        pinOnlyDenied,
        fingerOnly,
        fingerOnlyDenied,
        success,
        successNotification,
        crossUser,
        invalidSecond,
        invalidNotification,
        nonAccessResult,
      };
    } finally {
      await deleteUserBestEffort(context, primaryUserId);
      await deleteUserBestEffort(context, secondaryUserId);
      await deleteUserBestEffort(context, nonAccessUserId);
    }
  },
};
