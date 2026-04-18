import { UserIDStatus } from "zwave-js";

import type { ExecutableTestDefinition } from "../types.js";

interface UserCodeCapabilities {
  supportedASCIIChars?: string;
  supportedUserIDStatuses?: number[];
}

interface UserCodeReport {
  userId?: number;
  userIdStatus?: number;
  userCode?: string | Uint8Array;
}

interface ManualVerificationTarget {
  userId: number;
  code: string;
}

const USER_CODE_REPORT_TIMEOUT_MS = 600;
const USER_CODE_FALLBACK_QUERY_DELAY_MS = 400;
const USER_CODE_BETWEEN_OPERATIONS_DELAY_MS = 1000;
const USER_CODE_MANUAL_UNLOCK_TIMEOUT_MS = 2 * 60 * 1000;
const USER_CODE_MANUAL_UNLOCK_MIN_COUNT = 3;
const USER_CODE_MANUAL_UNLOCK_MAX_COUNT = 5;

function normalizeSupportedUsers(value: unknown): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`设备返回的 User Code 用户数量无效：${String(value)}。`);
  }
  return count;
}

function formatUserCode(userId: number): string {
  return String(userId).padStart(Math.max(4, String(userId).length), "0");
}

function formatEditedUserCode(code: string, supportedChars?: string): string {
  const normalized = code.length >= 4 ? code : code.padStart(4, "0");
  const candidateChars = (supportedChars && supportedChars.length > 0 ? supportedChars : "0123456789").split("");
  const replacementHead = candidateChars.find((char) => char !== normalized[0]);

  if (!replacementHead) {
    throw new Error("设备支持的 User Code 字符集不足以生成不同的编辑密码。");
  }

  return `${replacementHead}${normalized.slice(1)}`;
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

function extractNotificationUserId(parameters: Record<string, unknown>): number | undefined {
  const rawUserId = parameters.userId ?? parameters["0"];
  const userId = Number(rawUserId);
  return Number.isInteger(userId) && userId > 0 ? userId : undefined;
}

function ensureAddIsSupported(capabilities: UserCodeCapabilities | undefined): void {
  const supportedStatuses = capabilities?.supportedUserIDStatuses;
  if (Array.isArray(supportedStatuses) && !supportedStatuses.includes(UserIDStatus.Enabled)) {
    throw new Error("设备的 User Code 能力未声明支持 Enabled 状态，无法执行批量添加。");
  }

  const supportedChars = capabilities?.supportedASCIIChars;
  if (typeof supportedChars === "string" && supportedChars.length > 0) {
    const invalidCode = formatUserCode(1).split("").find((char) => !supportedChars.includes(char));
    if (invalidCode) {
      throw new Error(`设备的 User Code 能力不支持字符 "${invalidCode}"，无法按 0001 规则生成密码。`);
    }
  }
}

function isUnsupportedCommandError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("does not support the command");
}

function randomIntInclusive(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandomUserIds(maxUserId: number, explicitCount?: number): number[] {
  if (maxUserId <= 0) {
    return [];
  }

  const upperBound = Math.min(USER_CODE_MANUAL_UNLOCK_MAX_COUNT, maxUserId);
  const lowerBound = Math.min(USER_CODE_MANUAL_UNLOCK_MIN_COUNT, upperBound);
  const targetCount = explicitCount == undefined
    ? randomIntInclusive(lowerBound, upperBound)
    : Math.max(1, Math.min(explicitCount, maxUserId));
  const pool = Array.from({ length: maxUserId }, (_, index) => index + 1);

  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
  }

  return pool.slice(0, targetCount);
}

async function readSupportedUsersAndCapabilities(
  context: Parameters<ExecutableTestDefinition["run"]>[0],
  capabilityFallbackStepKey: string,
): Promise<{ supportedUsers: number; capabilities?: UserCodeCapabilities }> {
  const supportedUsersRaw = await context.invokeCcApi({ commandClass: "User Code", method: "getUsersCount" });
  let capabilities: unknown;

  try {
    capabilities = await context.invokeCcApi({ commandClass: "User Code", method: "getCapabilities" });
  } catch (error) {
    if (!isUnsupportedCommandError(error)) {
      throw error;
    }

    await context.log("warn", capabilityFallbackStepKey, "设备不支持 User Code CapabilitiesGet，跳过能力读取，继续执行批量操作", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    supportedUsers: normalizeSupportedUsers(supportedUsersRaw),
    capabilities: (capabilities ?? undefined) as UserCodeCapabilities | undefined,
  };
}

async function getUserCodeReport(
  context: Parameters<ExecutableTestDefinition["run"]>[0],
  userId: number,
): Promise<UserCodeReport | undefined> {
  return await context.invokeCcApi({
    commandClass: "User Code",
    method: "get",
    args: [userId],
  }) as UserCodeReport | undefined;
}

function ensureExpectedUserCodeReport(
  report: UserCodeReport | undefined,
  userId: number,
  expectedStatus: UserIDStatus,
  expectedCode: string,
  actionLabel: string,
): void {
  const actualCode = normalizeReportCode(report?.userCode) ?? "";
  if (report?.userIdStatus !== expectedStatus) {
    throw new Error(`User ID ${userId} ${actionLabel}后状态异常：${String(report?.userIdStatus)}。`);
  }
  if (actualCode !== expectedCode) {
    throw new Error(`User ID ${userId} ${actionLabel}后密码异常：期望 ${expectedCode || "(empty)"}，实际 ${actualCode || "(empty)"}。`);
  }
}

async function waitForUserCodeState(
  context: Parameters<ExecutableTestDefinition["run"]>[0],
  input: {
    userId: number;
    expectedStatus: UserIDStatus;
    expectedCode: string;
    fallbackStepKey: string;
    fallbackMessage: string;
    actionLabel: string;
  },
): Promise<{ source: "event" | "poll"; report?: UserCodeReport }> {
  const propertyKey = String(input.userId);
  const statusPromise = context.waitForValueUpdate({
    commandClass: "User Code",
    property: "userIdStatus",
    propertyKey,
    timeoutMs: USER_CODE_REPORT_TIMEOUT_MS,
    predicate: (payload) => Number(payload.newValue) === input.expectedStatus,
  });
  const codePromise = context.waitForValueUpdate({
    commandClass: "User Code",
    property: "userCode",
    propertyKey,
    timeoutMs: USER_CODE_REPORT_TIMEOUT_MS,
    predicate: (payload) => String(payload.newValue ?? "") === input.expectedCode,
  });

  try {
    await Promise.all([statusPromise, codePromise]);
    return { source: "event" };
  } catch {
    await context.log("warn", input.fallbackStepKey, input.fallbackMessage, {
      userId: input.userId,
      code: input.expectedCode,
      reportTimeoutMs: USER_CODE_REPORT_TIMEOUT_MS,
      fallbackDelayMs: USER_CODE_FALLBACK_QUERY_DELAY_MS,
    });

    await context.wait(USER_CODE_FALLBACK_QUERY_DELAY_MS);
    const report = await getUserCodeReport(context, input.userId);
    ensureExpectedUserCodeReport(report, input.userId, input.expectedStatus, input.expectedCode, input.actionLabel);

    return {
      source: "poll",
      report,
    };
  }
}

async function waitForManualKeypadUnlock(
  context: Parameters<ExecutableTestDefinition["run"]>[0],
  userId: number,
): Promise<Record<string, unknown>> {
  return await context.waitForEvent({
    type: "zwave.node.notification",
    timeoutMs: USER_CODE_MANUAL_UNLOCK_TIMEOUT_MS,
    predicate: (payload) => {
      if (Number(payload.nodeId) !== context.node.nodeId) {
        return false;
      }
      if (String(payload.commandClass ?? "") !== "Notification") {
        return false;
      }

      const args = (payload.args ?? {}) as Record<string, unknown>;
      const parameters = (args.parameters ?? {}) as Record<string, unknown>;
      return Number(args.type) === 6
        && Number(args.event) === 6
        && extractNotificationUserId(parameters) === userId;
    },
  });
}

async function waitForManualInvalidCode(
  context: Parameters<ExecutableTestDefinition["run"]>[0],
): Promise<Record<string, unknown>> {
  return await context.waitForEvent({
    type: "zwave.node.notification",
    timeoutMs: USER_CODE_MANUAL_UNLOCK_TIMEOUT_MS,
    predicate: (payload) => {
      if (Number(payload.nodeId) !== context.node.nodeId) {
        return false;
      }
      if (String(payload.commandClass ?? "") !== "Notification") {
        return false;
      }

      const args = (payload.args ?? {}) as Record<string, unknown>;
      return Number(args.type) === 7 && Number(args.event) === 4;
    },
  });
}

async function runManualVerificationSequence(
  context: Parameters<ExecutableTestDefinition["run"]>[0],
  input: {
    targets: ManualVerificationTarget[];
    startMessage: string;
    doneMessage: string;
    promptMessage(target: ManualVerificationTarget): string;
    promptMeta?(target: ManualVerificationTarget, sequence: number, totalCount: number): string | undefined;
    successMessage(target: ManualVerificationTarget): string;
    waitForExpectedEvent(target: ManualVerificationTarget): Promise<Record<string, unknown>>;
  },
): Promise<void> {
  await context.log("info", "manual.start", input.startMessage, {
    userIds: input.targets.map((target) => target.userId),
    codes: input.targets.map((target) => target.code),
    timeoutMsPerUser: USER_CODE_MANUAL_UNLOCK_TIMEOUT_MS,
  });

  for (let index = 0; index < input.targets.length; index += 1) {
    const target = input.targets[index];
    const sequence = index + 1;
    const totalCount = input.targets.length;

    await context.log("info", "manual.wait", input.promptMessage(target), {
      userId: target.userId,
      code: target.code,
      sequence,
      totalCount,
      promptMessage: input.promptMessage(target),
      promptMeta: input.promptMeta?.(target, sequence, totalCount),
    });

    const notification = await input.waitForExpectedEvent(target);

    await context.log("info", "manual.confirmed", input.successMessage(target), {
      userId: target.userId,
      code: target.code,
      sequence,
      totalCount,
      notification,
    });

    if (index < input.targets.length - 1) {
      await context.wait(300);
    }
  }

  await context.log("info", "manual.done", input.doneMessage, {
    userIds: input.targets.map((target) => target.userId),
    codes: input.targets.map((target) => target.code),
  });
}

export const userCodeAddDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["User Code"],
  meta: {
    id: "user-code-add-v1",
    key: "user-code-add",
    name: "添加 User Code",
    deviceType: "door-lock",
    version: 3,
    enabled: true,
    description: "读取设备支持的最大用户数后，从 User ID 1 开始依次批量添加 User Code。",
    inputSchema: {},
  },
  supports(node) {
    return node.commandClasses.includes("User Code")
      ? { supported: true }
      : { supported: false, reason: "节点未发现 User Code CC。" };
  },
  async run(context) {
    await context.log("info", "precheck.start", "开始读取 User Code 用户数量");

    const { supportedUsers, capabilities: normalizedCapabilities } = await readSupportedUsersAndCapabilities(context, "precheck.capabilities");
    ensureAddIsSupported(normalizedCapabilities);

    await context.log("info", "precheck.ready", `设备支持 ${supportedUsers} 个 User Code 用户位，开始批量添加`, {
      supportedUsers,
      capabilities: normalizedCapabilities as Record<string, unknown> | undefined,
    });

    const addedUsers: Array<{ userId: number; code: string }> = [];

    for (let userId = 1; userId <= supportedUsers; userId += 1) {
      if (context.isCancelled()) {
        throw new Error("测试已取消。");
      }

      const code = formatUserCode(userId);

      await context.invokeCcApi({
        commandClass: "User Code",
        method: "set",
        args: [userId, UserIDStatus.Enabled, code],
      });

      const confirmation = await waitForUserCodeState(context, {
        userId,
        expectedStatus: UserIDStatus.Enabled,
        expectedCode: code,
        fallbackStepKey: "add.fallback",
        fallbackMessage: "未在预期时间内收到 User Code 主动上报，等待后改为主动查询确认",
        actionLabel: "添加",
      });

      addedUsers.push({ userId, code });

      await context.log("info", "add.progress", `已完成 ${userId}/${supportedUsers} 个 User Code 添加`, {
        currentUserId: userId,
        code,
        supportedUsers,
        confirmationSource: confirmation.source,
      });

      if (userId < supportedUsers) {
        // Leave enough time for S2 nonce/span state and door-lock notifications to settle.
        await context.wait(USER_CODE_BETWEEN_OPERATIONS_DELAY_MS);
      }
    }

    await context.log("info", "result", "批量添加 User Code 完成", {
      supportedUsers,
      firstCode: addedUsers[0]?.code,
      lastCode: addedUsers[addedUsers.length - 1]?.code,
    });

    const manualUnlockTargets = pickRandomUserIds(supportedUsers).map((userId) => ({
      userId,
      code: formatUserCode(userId),
    }));

    await runManualVerificationSequence(context, {
      targets: manualUnlockTargets,
      startMessage: `开始执行 ${manualUnlockTargets.length} 组随机 User Code 手动解锁验证`,
      doneMessage: "随机 User Code 手动解锁验证完成",
      promptMessage: (target) => `请使用 User ID：${target.userId} 的 User Code 在设备上手动解锁`,
      promptMeta: (_target, sequence, totalCount) => `第 ${sequence} / ${totalCount} 组，检测到解锁上报后会自动进入下一组。`,
      successMessage: (target) => `已收到 User ID：${target.userId} 的手动解锁上报`,
      waitForExpectedEvent: (target) => waitForManualKeypadUnlock(context, target.userId),
    });

    return {
      supportedUsers,
      generatedCodeRule: "User ID 零填充到至少 4 位，例如 0001、0002、0250。",
      firstUser: addedUsers[0],
      lastUser: addedUsers[addedUsers.length - 1],
      totalAdded: addedUsers.length,
      manualUnlockUserIds: manualUnlockTargets.map((target) => target.userId),
    };
  },
};

export const userCodeEditDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["User Code"],
  meta: {
    id: "user-code-edit-v1",
    key: "user-code-edit",
    name: "编辑 User Code",
    deviceType: "door-lock",
    version: 2,
    enabled: true,
    description: "从已添加的 User Code 中随机挑选若干项进行修改，并通过人工解锁验证修改结果。",
    inputSchema: {},
  },
  supports(node) {
    return node.commandClasses.includes("User Code")
      ? { supported: true }
      : { supported: false, reason: "节点未发现 User Code CC。" };
  },
  async run(context) {
    await context.log("info", "precheck.start", "开始读取 User Code 用户数量，准备随机编辑");

    const { supportedUsers, capabilities } = await readSupportedUsersAndCapabilities(context, "precheck.capabilities");
    ensureAddIsSupported(capabilities);

    const targetUserIds = pickRandomUserIds(supportedUsers);
    const editedUsers: ManualVerificationTarget[] = [];

    await context.log("info", "precheck.ready", `设备支持 ${supportedUsers} 个 User Code 用户位，开始随机编辑 ${targetUserIds.length} 项`, {
      supportedUsers,
      targetUserIds,
    });

    for (let index = 0; index < targetUserIds.length; index += 1) {
      const userId = targetUserIds[index];
      const report = await getUserCodeReport(context, userId);
      const existingCode = normalizeReportCode(report?.userCode) ?? "";

      if (report?.userIdStatus !== UserIDStatus.Enabled || existingCode.length < 4) {
        throw new Error(`User ID ${userId} 当前未处于可编辑状态，请先完成添加 User Code 测试。`);
      }

      const updatedCode = formatEditedUserCode(existingCode, capabilities?.supportedASCIIChars);

      await context.invokeCcApi({
        commandClass: "User Code",
        method: "set",
        args: [userId, UserIDStatus.Enabled, updatedCode],
      });

      const confirmation = await waitForUserCodeState(context, {
        userId,
        expectedStatus: UserIDStatus.Enabled,
        expectedCode: updatedCode,
        fallbackStepKey: "edit.fallback",
        fallbackMessage: "未在预期时间内收到编辑后的 User Code 主动上报，等待后改为主动查询确认",
        actionLabel: "编辑",
      });

      editedUsers.push({ userId, code: updatedCode });

      await context.log("info", "edit.progress", `已完成 ${index + 1}/${targetUserIds.length} 个 User Code 编辑`, {
        currentUserId: userId,
        updatedCode,
        totalTargets: targetUserIds.length,
        confirmationSource: confirmation.source,
      });

      if (index < targetUserIds.length - 1) {
        await context.wait(USER_CODE_BETWEEN_OPERATIONS_DELAY_MS);
      }
    }

    await context.log("info", "result", "随机编辑 User Code 完成", {
      totalEdited: editedUsers.length,
      editedUserIds: editedUsers.map((item) => item.userId),
    });

    await runManualVerificationSequence(context, {
      targets: editedUsers,
      startMessage: `开始执行 ${editedUsers.length} 组随机 User Code 编辑后手动解锁验证`,
      doneMessage: "随机 User Code 编辑后手动解锁验证完成",
      promptMessage: (target) => `请使用 User Code：${target.code} 在设备上手动解锁`,
      promptMeta: (target, sequence, totalCount) => `当前验证 User ID：${target.userId}，第 ${sequence} / ${totalCount} 组，检测到对应 User ID 的解锁上报后会自动进入下一组。`,
      successMessage: (target) => `已收到 User ID：${target.userId} 的编辑后手动解锁上报`,
      waitForExpectedEvent: (target) => waitForManualKeypadUnlock(context, target.userId),
    });

    return {
      supportedUsers,
      totalEdited: editedUsers.length,
      editedUsers,
    };
  },
};

export const userCodeDeleteDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["User Code"],
  meta: {
    id: "user-code-delete-v1",
    key: "user-code-delete",
    name: "删除 User Code",
    deviceType: "door-lock",
    version: 2,
    enabled: true,
    description: "从已添加的 User Code 中随机挑选若干项删除，并通过无效密码上报验证删除结果。",
    inputSchema: {},
  },
  supports(node) {
    return node.commandClasses.includes("User Code")
      ? { supported: true }
      : { supported: false, reason: "节点未发现 User Code CC。" };
  },
  async run(context) {
    await context.log("info", "precheck.start", "开始读取 User Code 用户数量，准备随机删除");

    const { supportedUsers, capabilities } = await readSupportedUsersAndCapabilities(context, "precheck.capabilities");
    ensureAddIsSupported(capabilities);

    const targetUserIds = pickRandomUserIds(supportedUsers);
    const deletedUsers: ManualVerificationTarget[] = [];

    await context.log("info", "precheck.ready", `设备支持 ${supportedUsers} 个 User Code 用户位，开始随机删除 ${targetUserIds.length} 项`, {
      supportedUsers,
      targetUserIds,
    });

    for (let index = 0; index < targetUserIds.length; index += 1) {
      const userId = targetUserIds[index];
      const report = await getUserCodeReport(context, userId);
      const existingCode = normalizeReportCode(report?.userCode) ?? "";

      if (report?.userIdStatus !== UserIDStatus.Enabled || existingCode.length < 4) {
        throw new Error(`User ID ${userId} 当前未处于可删除状态，请先完成添加 User Code 测试。`);
      }

      await context.invokeCcApi({
        commandClass: "User Code",
        method: "clear",
        args: [userId],
      });

      const confirmation = await waitForUserCodeState(context, {
        userId,
        expectedStatus: UserIDStatus.Available,
        expectedCode: "",
        fallbackStepKey: "delete.fallback",
        fallbackMessage: "未在预期时间内收到删除后的 User Code 主动上报，等待后改为主动查询确认",
        actionLabel: "删除",
      });

      deletedUsers.push({ userId, code: existingCode });

      await context.log("info", "delete.progress", `已完成 ${index + 1}/${targetUserIds.length} 个 User Code 删除`, {
        currentUserId: userId,
        deletedCode: existingCode,
        totalTargets: targetUserIds.length,
        confirmationSource: confirmation.source,
      });

      if (index < targetUserIds.length - 1) {
        await context.wait(USER_CODE_BETWEEN_OPERATIONS_DELAY_MS);
      }
    }

    await context.log("info", "result", "随机删除 User Code 完成", {
      totalDeleted: deletedUsers.length,
      deletedUserIds: deletedUsers.map((item) => item.userId),
    });

    await runManualVerificationSequence(context, {
      targets: deletedUsers,
      startMessage: `开始执行 ${deletedUsers.length} 组随机 User Code 删除后无效密码验证`,
      doneMessage: "随机 User Code 删除后无效密码验证完成",
      promptMessage: (target) => `请使用已删除的 User Code：${target.code} 尝试解锁设备`,
      promptMeta: (_target, sequence, totalCount) => `第 ${sequence} / ${totalCount} 组，检测到无效密码上报后会自动进入下一组。`,
      successMessage: (target) => `已收到 User ID：${target.userId} 删除后的无效密码上报`,
      waitForExpectedEvent: () => waitForManualInvalidCode(context),
    });

    return {
      supportedUsers,
      totalDeleted: deletedUsers.length,
      deletedUsers,
    };
  },
};
