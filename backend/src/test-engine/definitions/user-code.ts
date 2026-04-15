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

const USER_CODE_REPORT_TIMEOUT_MS = 1500;
const USER_CODE_FALLBACK_QUERY_DELAY_MS = 800;
const USER_CODE_BETWEEN_OPERATIONS_DELAY_MS = 1000;

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

function normalizeReportCode(value: string | Uint8Array | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("ascii");
  }
  return undefined;
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

async function runPlaceholderUserCodeTest(context: Parameters<ExecutableTestDefinition["run"]>[0], action: string) {
  await context.log("info", "placeholder.start", `${action} User Code 测试项当前为占位卡片，暂未实现实际设备操作。`);
  return {
    placeholder: true,
    action,
  };
}

async function waitForUserCodeConfirmation(
  context: Parameters<ExecutableTestDefinition["run"]>[0],
  userId: number,
  code: string,
): Promise<{ source: "event" | "poll"; report?: UserCodeReport }> {
  const propertyKey = String(userId);
  const statusPromise = context.waitForValueUpdate({
    commandClass: "User Code",
    property: "userIdStatus",
    propertyKey,
    timeoutMs: USER_CODE_REPORT_TIMEOUT_MS,
    predicate: (payload) => Number(payload.newValue) === UserIDStatus.Enabled,
  });
  const codePromise = context.waitForValueUpdate({
    commandClass: "User Code",
    property: "userCode",
    propertyKey,
    timeoutMs: USER_CODE_REPORT_TIMEOUT_MS,
    predicate: (payload) => String(payload.newValue ?? "") === code,
  });

  try {
    await Promise.all([statusPromise, codePromise]);
    return { source: "event" };
  } catch {
    await context.log("warn", "add.fallback", "未在预期时间内收到 User Code 主动上报，等待后改为主动查询确认", {
      userId,
      code,
      reportTimeoutMs: USER_CODE_REPORT_TIMEOUT_MS,
      fallbackDelayMs: USER_CODE_FALLBACK_QUERY_DELAY_MS,
    });

    await context.wait(USER_CODE_FALLBACK_QUERY_DELAY_MS);
    const report = await context.invokeCcApi({
      commandClass: "User Code",
      method: "get",
      args: [userId],
    }) as UserCodeReport | undefined;

    return {
      source: "poll",
      report,
    };
  }
}

export const userCodeAddDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["User Code"],
  meta: {
    id: "user-code-add-v1",
    key: "user-code-add",
    name: "添加 User Code",
    deviceType: "door-lock",
    version: 2,
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

    const supportedUsersRaw = await context.invokeCcApi({ commandClass: "User Code", method: "getUsersCount" });
    let capabilities: unknown;

    try {
      capabilities = await context.invokeCcApi({ commandClass: "User Code", method: "getCapabilities" });
    } catch (error) {
      if (!isUnsupportedCommandError(error)) {
        throw error;
      }

      await context.log("warn", "precheck.capabilities", "设备不支持 User Code CapabilitiesGet，跳过能力读取，继续执行批量添加", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const supportedUsers = normalizeSupportedUsers(supportedUsersRaw);
    const normalizedCapabilities = (capabilities ?? undefined) as UserCodeCapabilities | undefined;
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

      const confirmation = await waitForUserCodeConfirmation(context, userId, code);
      const report = confirmation.report;

      if (confirmation.source === "poll") {
        const actualCode = normalizeReportCode(report?.userCode);
        if (report?.userIdStatus !== UserIDStatus.Enabled) {
          throw new Error(`User ID ${userId} 添加后状态异常：${String(report?.userIdStatus)}。`);
        }
        if (actualCode !== code) {
          throw new Error(`User ID ${userId} 添加后密码异常：期望 ${code}，实际 ${actualCode ?? "-"}`);
        }
      }

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

    return {
      supportedUsers,
      generatedCodeRule: "User ID 零填充到至少 4 位，例如 0001、0002、0250。",
      firstUser: addedUsers[0],
      lastUser: addedUsers[addedUsers.length - 1],
      totalAdded: addedUsers.length,
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
    version: 1,
    enabled: true,
    description: "编辑指定 User Code 的占位测试项。",
    inputSchema: {},
  },
  supports(node) {
    return node.commandClasses.includes("User Code")
      ? { supported: true }
      : { supported: false, reason: "节点未发现 User Code CC。" };
  },
  async run(context) {
    return await runPlaceholderUserCodeTest(context, "编辑");
  },
};

export const userCodeDeleteDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["User Code"],
  meta: {
    id: "user-code-delete-v1",
    key: "user-code-delete",
    name: "删除 User Code",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "删除指定 User Code 的占位测试项。",
    inputSchema: {},
  },
  supports(node) {
    return node.commandClasses.includes("User Code")
      ? { supported: true }
      : { supported: false, reason: "节点未发现 User Code CC。" };
  },
  async run(context) {
    return await runPlaceholderUserCodeTest(context, "删除");
  },
};
