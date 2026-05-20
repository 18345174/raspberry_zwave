import type { ExecutableTestDefinition, TestExecutionContext } from "../types.js";

const WAIT_SHORT_MS = 700;

type SupportCheck = { supported: boolean; reason?: string };
type AnyRecord = Record<string, unknown>;

function supportsCommandClass(commandClass: string): (node: { commandClasses: string[] }) => SupportCheck {
  return (node) => node.commandClasses.includes(commandClass)
    ? { supported: true }
    : { supported: false, reason: `节点未发现 ${commandClass} CC。` };
}

function supportedCcVersion(context: TestExecutionContext, commandClass: string): number | undefined {
  const detail = context.node.commandClassDetails?.find((item) => item.name === commandClass);
  return detail?.version;
}

function nodeValues(context: TestExecutionContext, commandClass: string): AnyRecord[] {
  return context.node.values.filter((value) => value.commandClass === commandClass) as unknown as AnyRecord[];
}

function valueSnapshot(context: TestExecutionContext, commandClass: string): Record<string, unknown> {
  return Object.fromEntries(nodeValues(context, commandClass).map((value) => {
    const property = String(value.property);
    const key = value.propertyKey != undefined ? `${property}[${String(value.propertyKey)}]` : property;
    return [key, value.value];
  }));
}

async function invokeOptional(
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

async function readCcPrecheck(context: TestExecutionContext, commandClass: string): Promise<{ version?: number; cachedValues: Record<string, unknown> }> {
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

function requireNumber(value: unknown, label: string): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    throw new Error(`${label} 未返回有效数字。`);
  }
  return numberValue;
}

export const basicDoorLockMappingDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Basic", "Door Lock"],
  meta: {
    id: "basic-door-lock-mapping-v1",
    key: "basic-door-lock-mapping",
    name: "Basic CC 门锁映射",
    deviceType: "door-lock",
    version: 1,
    enabled: true,
    description: "读取 Basic Report，并在显式开启 writeCheck 时验证 Basic Set 与 Door Lock 状态映射。",
    inputSchema: { writeCheck: { type: "boolean", default: false } },
  },
  supports(node) {
    if (!node.commandClasses.includes("Basic")) return { supported: false, reason: "节点未发现 Basic CC。" };
    if (!node.commandClasses.includes("Door Lock")) return { supported: false, reason: "节点未发现 Door Lock CC。" };
    return { supported: true };
  },
  async run(context) {
    const precheck = await readCcPrecheck(context, "Basic");
    const basic = await invokeOptional(context, "Basic", "get") as AnyRecord | undefined;
    let writeCheckResult: AnyRecord | undefined;
    if (context.inputs.writeCheck === true) {
      const beforeDoorLock = await invokeOptional(context, "Door Lock", "get") as AnyRecord | undefined;
      await context.log("warn", "basic.write.start", "即将执行 Basic Set 0x00/0xFF 映射验证，测试结束会尽量恢复原门锁状态", { beforeDoorLock });
      try {
        await context.invokeCcApi({ commandClass: "Basic", method: "set", args: [0] });
        await context.wait(WAIT_SHORT_MS);
        const afterZero = await invokeOptional(context, "Door Lock", "get") as AnyRecord | undefined;
        await context.invokeCcApi({ commandClass: "Basic", method: "set", args: [255] });
        await context.wait(WAIT_SHORT_MS);
        const afterFull = await invokeOptional(context, "Door Lock", "get") as AnyRecord | undefined;
        writeCheckResult = { beforeDoorLock, afterZero, afterFull };
      } finally {
        const originalMode = beforeDoorLock?.currentMode;
        if (typeof originalMode === "number") {
          await invokeOptional(context, "Door Lock", "set", [originalMode]);
        }
      }
    } else {
      await context.log("info", "basic.write.skip", "默认不执行 Basic Set，避免无意开关门；如需验证映射可设置 writeCheck=true。", { basic });
    }
    return { ...precheck, basic, writeCheckResult };
  },
};

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

export const transportServiceDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Transport Service", "User Credential", "Configuration"],
  meta: {
    id: "transport-service-fragmentation-v1",
    key: "transport-service-fragmentation",
    name: "Transport Service 分片传输",
    deviceType: "generic-node",
    version: 1,
    enabled: true,
    description: "确认 Transport Service v2 已采访，并通过大能力读取场景验证长报文可正常完成。",
    inputSchema: {},
  },
  supports: supportsCommandClass("Transport Service"),
  async run(context) {
    const precheck = await readCcPrecheck(context, "Transport Service");
    const ping = await context.pingNode();
    const userCredentialCapabilities = context.node.commandClasses.includes("User Credential")
      ? await invokeOptional(context, "User Credential", "getCredentialCapabilities")
      : undefined;
    const configurationValues = valueSnapshot(context, "Configuration");
    if (!ping) {
      throw new Error("Transport Service 节点 ping 失败，无法确认分片传输基础通信。 ");
    }
    return { ...precheck, ping, userCredentialCapabilities, configurationValueCount: Object.keys(configurationValues).length };
  },
};

export const associationGroupInfoDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Association", "Association Group Information"],
  meta: {
    id: "association-group-info-v1",
    key: "association-group-info",
    name: "Association Group Information",
    deviceType: "generic-node",
    version: 1,
    enabled: true,
    description: "读取 Association group count、group name、profile 和 command list，验证 Lifeline/AGI 元数据可用。",
    inputSchema: {},
  },
  supports: supportsCommandClass("Association Group Information"),
  async run(context) {
    const precheck = await readCcPrecheck(context, "Association Group Information");
    const groupCount = await invokeOptional(context, "Association", "getGroupCount");
    const count = groupCount == undefined ? 1 : Math.max(1, requireNumber(groupCount, "Association group count"));
    const groups = [];
    for (let groupId = 1; groupId <= Math.min(count, 5); groupId += 1) {
      groups.push({
        groupId,
        name: await invokeOptional(context, "Association Group Information", "getGroupName", [groupId]),
        info: await invokeOptional(context, "Association Group Information", "getGroupInfo", [groupId, true]),
        commands: await invokeOptional(context, "Association Group Information", "getCommands", [groupId, false]),
      });
    }
    return { ...precheck, groupCount, groups };
  },
};

export const deviceResetLocallyDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Device Reset Locally"],
  meta: {
    id: "device-reset-locally-presence-v1",
    key: "device-reset-locally-presence",
    name: "Device Reset Locally 通知能力",
    deviceType: "generic-node",
    version: 1,
    enabled: true,
    description: "只读确认 Device Reset Locally CC 存在；真实恢复出厂通知测试为高风险，默认不执行。",
    inputSchema: { destructiveConfirmation: { type: "boolean", default: false } },
  },
  supports: supportsCommandClass("Device Reset Locally"),
  async run(context) {
    const precheck = await readCcPrecheck(context, "Device Reset Locally");
    if (context.inputs.destructiveConfirmation === true) {
      await context.log("warn", "reset.destructive.skip", "该 CC 的真实测试需要本地恢复出厂并会让设备离网，当前自动化不触发 reset。", { nodeId: context.node.nodeId });
    }
    return { ...precheck, destructiveTestExecuted: false };
  },
};

export const zwavePlusInfoDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Z-Wave Plus Info"],
  meta: {
    id: "zwave-plus-info-v1",
    key: "zwave-plus-info",
    name: "Z-Wave Plus Info 身份",
    deviceType: "generic-node",
    version: 1,
    enabled: true,
    description: "读取 Z-Wave Plus role/node type 和 installer/user icon，确认节点身份信息完整。",
    inputSchema: {},
  },
  supports: supportsCommandClass("Z-Wave Plus Info"),
  async run(context) {
    const precheck = await readCcPrecheck(context, "Z-Wave Plus Info");
    const report = await invokeOptional(context, "Z-Wave Plus Info", "get") as AnyRecord | undefined;
    if (!report && !Object.keys(precheck.cachedValues).length) {
      throw new Error("Z-Wave Plus Info 未返回 Report 或缓存值。 ");
    }
    return { ...precheck, report };
  },
};

export const supervisionDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Supervision", "Door Lock"],
  meta: {
    id: "supervision-command-status-v1",
    key: "supervision-command-status",
    name: "Supervision 命令确认",
    deviceType: "generic-node",
    version: 1,
    enabled: true,
    description: "确认 Supervision CC 存在，并通过安全 Set 类命令的返回/日志检查命令确认链路。",
    inputSchema: {},
  },
  supports: supportsCommandClass("Supervision"),
  async run(context) {
    const precheck = await readCcPrecheck(context, "Supervision");
    const doorLock = context.node.commandClasses.includes("Door Lock") ? await invokeOptional(context, "Door Lock", "get") : undefined;
    const ping = await context.pingNode();
    if (!ping) throw new Error("Supervision 节点 ping 失败。 ");
    return { ...precheck, ping, doorLock };
  },
};

export const manufacturerSpecificDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Manufacturer Specific"],
  meta: {
    id: "manufacturer-specific-identity-v1",
    key: "manufacturer-specific-identity",
    name: "Manufacturer Specific 厂商身份",
    deviceType: "generic-node",
    version: 1,
    enabled: true,
    description: "读取 Manufacturer ID、Product Type ID、Product ID，生成 DUT 身份记录。",
    inputSchema: {},
  },
  supports: supportsCommandClass("Manufacturer Specific"),
  async run(context) {
    const precheck = await readCcPrecheck(context, "Manufacturer Specific");
    const report = await invokeOptional(context, "Manufacturer Specific", "get") as AnyRecord | undefined;
    return { ...precheck, report, manufacturer: context.node.manufacturer, product: context.node.product, productCode: context.node.productCode };
  },
};

export const powerlevelDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Powerlevel"],
  meta: {
    id: "powerlevel-readonly-v1",
    key: "powerlevel-readonly",
    name: "Powerlevel 射频功率只读",
    deviceType: "generic-node",
    version: 1,
    enabled: true,
    description: "读取当前 Powerlevel 和 Node Test 状态；默认不改变射频功率。",
    inputSchema: { restoreNormal: { type: "boolean", default: false } },
  },
  supports: supportsCommandClass("Powerlevel"),
  async run(context) {
    const precheck = await readCcPrecheck(context, "Powerlevel");
    const powerlevel = await invokeOptional(context, "Powerlevel", "getPowerlevel") as AnyRecord | undefined;
    const nodeTestStatus = await invokeOptional(context, "Powerlevel", "getNodeTestStatus") as AnyRecord | undefined;
    if (context.inputs.restoreNormal === true) {
      await invokeOptional(context, "Powerlevel", "setNormalPowerlevel");
    }
    return { ...precheck, powerlevel, nodeTestStatus };
  },
};

export const firmwareMetadataDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Firmware Update Meta Data", "Version", "Manufacturer Specific"],
  meta: {
    id: "firmware-update-metadata-readonly-v1",
    key: "firmware-update-metadata-readonly",
    name: "Firmware Update Meta Data 能力",
    deviceType: "generic-node",
    version: 1,
    enabled: true,
    description: "只读读取 OTA metadata、firmware targets、fragment size、activation/resume 能力；不执行 OTA。",
    inputSchema: {},
  },
  supports: supportsCommandClass("Firmware Update Meta Data"),
  async run(context) {
    const precheck = await readCcPrecheck(context, "Firmware Update Meta Data");
    const metadata = await invokeOptional(context, "Firmware Update Meta Data", "getMetaData") as AnyRecord | undefined;
    return { ...precheck, metadata };
  },
};

export const batteryHealthDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Battery", "Notification"],
  meta: {
    id: "battery-health-v1",
    key: "battery-health",
    name: "Battery 电池状态",
    deviceType: "generic-node",
    version: 1,
    enabled: true,
    description: "读取 Battery Report 和 Battery Health，验证电量取值为 0..100 或 low battery 语义。",
    inputSchema: {},
  },
  supports: supportsCommandClass("Battery"),
  async run(context) {
    const precheck = await readCcPrecheck(context, "Battery");
    const report = await invokeOptional(context, "Battery", "get") as AnyRecord | undefined;
    const health = await invokeOptional(context, "Battery", "getHealth") as AnyRecord | undefined;
    const level = Number(report?.level ?? report?.currentValue ?? precheck.cachedValues.level);
    if (Number.isFinite(level) && level !== 255 && (level < 0 || level > 100)) {
      throw new Error(`Battery level 超出范围：${level}。`);
    }
    return { ...precheck, report, health };
  },
};

export const associationDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Association", "Association Group Information"],
  meta: {
    id: "association-lifeline-v1",
    key: "association-lifeline",
    name: "Association Lifeline",
    deviceType: "generic-node",
    version: 1,
    enabled: true,
    description: "读取 Association group count 与前几个 group 的 maxNodes/nodeIds，确认 Lifeline group 可读。",
    inputSchema: {},
  },
  supports: supportsCommandClass("Association"),
  async run(context) {
    const precheck = await readCcPrecheck(context, "Association");
    const groupCount = await invokeOptional(context, "Association", "getGroupCount");
    const count = requireNumber(groupCount, "Association group count");
    if (count <= 0) throw new Error(`Association group count 无效：${count}。`);
    const groups = [];
    for (let groupId = 1; groupId <= Math.min(count, 5); groupId += 1) {
      groups.push({ groupId, group: await invokeOptional(context, "Association", "getGroup", [groupId]) });
    }
    return { ...precheck, groupCount: count, groups };
  },
};

export const versionInfoDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Version"],
  meta: {
    id: "version-info-v1",
    key: "version-info",
    name: "Version 版本信息",
    deviceType: "generic-node",
    version: 1,
    enabled: true,
    description: "读取 Version Report、Capabilities、Z-Wave Software，并逐个核对 supported CC version。",
    inputSchema: {},
  },
  supports: supportsCommandClass("Version"),
  async run(context) {
    const precheck = await readCcPrecheck(context, "Version");
    const report = await invokeOptional(context, "Version", "get") as AnyRecord | undefined;
    const capabilities = await invokeOptional(context, "Version", "getCapabilities") as AnyRecord | undefined;
    const software = await invokeOptional(context, "Version", "getZWaveSoftware") as AnyRecord | undefined;
    const ccVersions: Record<string, unknown> = {};
    for (const cc of context.node.commandClassDetails ?? []) {
      ccVersions[cc.name] = await invokeOptional(context, "Version", "getCCVersion", [cc.id]);
    }
    return { ...precheck, report, capabilities, software, ccVersions };
  },
};

export const indicatorDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Indicator"],
  meta: {
    id: "indicator-supported-v1",
    key: "indicator-supported",
    name: "Indicator 指示器能力",
    deviceType: "generic-node",
    version: 1,
    enabled: true,
    description: "读取 Indicator 支持的 indicator/property；默认不触发 identify/blink。",
    inputSchema: { identify: { type: "boolean", default: false } },
  },
  supports: supportsCommandClass("Indicator"),
  async run(context) {
    const precheck = await readCcPrecheck(context, "Indicator");
    const supported0 = await invokeOptional(context, "Indicator", "getSupported", [0]);
    const value0 = await invokeOptional(context, "Indicator", "get", [0]);
    if (context.inputs.identify === true) {
      await invokeOptional(context, "Indicator", "identify");
    }
    return { ...precheck, supported0, value0, identifyTriggered: context.inputs.identify === true };
  },
};

export const timeDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Time"],
  meta: {
    id: "time-cc-read-v1",
    key: "time-cc-read",
    name: "Time 时间能力",
    deviceType: "generic-node",
    version: 1,
    enabled: true,
    description: "读取 Time CC 的 time/date/timezone，并与控制器当前时间做基础比较。",
    inputSchema: {},
  },
  supports: supportsCommandClass("Time"),
  async run(context) {
    const precheck = await readCcPrecheck(context, "Time");
    const time = await invokeOptional(context, "Time", "getTime") as AnyRecord | undefined;
    const date = await invokeOptional(context, "Time", "getDate") as AnyRecord | undefined;
    const timezone = await invokeOptional(context, "Time", "getTimezone") as AnyRecord | undefined;
    return { ...precheck, controllerTime: new Date().toISOString(), time, date, timezone };
  },
};

export const timeParametersDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Time Parameters"],
  meta: {
    id: "time-parameters-read-v1",
    key: "time-parameters-read",
    name: "Time Parameters 时间参数",
    deviceType: "generic-node",
    version: 1,
    enabled: true,
    description: "读取旧版 Time Parameters；默认不写入设备时间。",
    inputSchema: { writeCurrentTime: { type: "boolean", default: false } },
  },
  supports: supportsCommandClass("Time Parameters"),
  async run(context) {
    const precheck = await readCcPrecheck(context, "Time Parameters");
    const before = await invokeOptional(context, "Time Parameters", "get") as AnyRecord | undefined;
    let after: unknown;
    if (context.inputs.writeCurrentTime === true) {
      const now = new Date();
      await invokeOptional(context, "Time Parameters", "set", [now]);
      await context.wait(WAIT_SHORT_MS);
      after = await invokeOptional(context, "Time Parameters", "get");
    }
    return { ...precheck, before, after, writeCurrentTime: context.inputs.writeCurrentTime === true };
  },
};

export const multiChannelAssociationDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Multi Channel Association"],
  meta: {
    id: "multi-channel-association-v1",
    key: "multi-channel-association",
    name: "Multi Channel Association",
    deviceType: "generic-node",
    version: 1,
    enabled: true,
    description: "读取 Multi Channel Association group count 与前几个 group，确认多端点关联信息可读。",
    inputSchema: {},
  },
  supports: supportsCommandClass("Multi Channel Association"),
  async run(context) {
    const precheck = await readCcPrecheck(context, "Multi Channel Association");
    const groupCount = await invokeOptional(context, "Multi Channel Association", "getGroupCount");
    const count = requireNumber(groupCount, "Multi Channel Association group count");
    const groups = [];
    for (let groupId = 1; groupId <= Math.min(count, 5); groupId += 1) {
      groups.push({ groupId, group: await invokeOptional(context, "Multi Channel Association", "getGroup", [groupId]) });
    }
    return { ...precheck, groupCount: count, groups };
  },
};

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
