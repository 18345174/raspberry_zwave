import type { ExecutableTestDefinition } from "../types.js";

interface ConfigurationProperties {
  minValue?: number;
  maxValue?: number;
  defaultValue?: unknown;
  isReadonly?: boolean;
  valueSize?: 1 | 2 | 4;
  valueFormat?: number;
}

interface WritableConfigCandidate {
  parameter: number;
  name?: string;
  info?: string;
  currentValue: number;
  targetValue: number;
  properties: ConfigurationProperties;
}

function listConfigurationParameters(context: Parameters<ExecutableTestDefinition["run"]>[0]): number[] {
  const parameters = new Set<number>();

  for (const value of context.node.values) {
    if (value.commandClass !== "Configuration") {
      continue;
    }
    const parameter = Number(value.property);
    if (Number.isInteger(parameter) && parameter >= 0) {
      parameters.add(parameter);
    }
  }

  return [...parameters].sort((left, right) => left - right);
}

function chooseTargetValue(currentValue: number, minValue: number, maxValue: number): number | undefined {
  if (currentValue !== minValue) {
    return minValue;
  }
  if (currentValue !== maxValue) {
    return maxValue;
  }
  if (currentValue + 1 <= maxValue) {
    return currentValue + 1;
  }
  if (currentValue - 1 >= minValue) {
    return currentValue - 1;
  }
  return undefined;
}

async function findWritableCandidate(
  context: Parameters<ExecutableTestDefinition["run"]>[0],
): Promise<WritableConfigCandidate> {
  const parameters = listConfigurationParameters(context);
  if (!parameters.length) {
    throw new Error("节点快照中未发现 Configuration 参数，无法执行参数读写测试。");
  }

  const probeResults: Array<Record<string, unknown>> = [];

  for (const parameter of parameters) {
    try {
      const [currentValueRaw, properties, name, info] = await Promise.all([
        context.invokeCcApi({
          commandClass: "Configuration",
          method: "get",
          args: [parameter],
        }),
        context.invokeCcApi({
          commandClass: "Configuration",
          method: "getProperties",
          args: [parameter],
        }) as Promise<ConfigurationProperties | undefined>,
        context.invokeCcApi({
          commandClass: "Configuration",
          method: "getName",
          args: [parameter],
        }).catch(() => undefined),
        context.invokeCcApi({
          commandClass: "Configuration",
          method: "getInfo",
          args: [parameter],
        }).catch(() => undefined),
      ]);

      const currentValue = Number(currentValueRaw);
      const minValue = Number(properties?.minValue);
      const maxValue = Number(properties?.maxValue);
      const targetValue =
        Number.isFinite(currentValue) && Number.isFinite(minValue) && Number.isFinite(maxValue)
          ? chooseTargetValue(currentValue, minValue, maxValue)
          : undefined;

      probeResults.push({
        parameter,
        currentValue: currentValueRaw,
        properties,
        name,
        info,
      });

      if (properties?.isReadonly) {
        continue;
      }
      if (!Number.isFinite(currentValue) || !Number.isInteger(currentValue)) {
        continue;
      }
      if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || minValue > maxValue) {
        continue;
      }
      if (targetValue == undefined) {
        continue;
      }

      return {
        parameter,
        name: typeof name === "string" ? name : undefined,
        info: typeof info === "string" ? info : undefined,
        currentValue,
        targetValue,
        properties: properties ?? {},
      };
    } catch (error) {
      probeResults.push({
        parameter,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw new Error(`未找到可安全执行写入的 Configuration 参数。探测结果：${JSON.stringify(probeResults)}`);
}

async function setAndVerifyParameter(
  context: Parameters<ExecutableTestDefinition["run"]>[0],
  candidate: WritableConfigCandidate,
  targetValue: number,
  stepKey: string,
): Promise<number> {
  await context.invokeCcApi({
    commandClass: "Configuration",
    method: "set",
    args: [{
      parameter: candidate.parameter,
      value: targetValue,
      valueSize: candidate.properties.valueSize,
      valueFormat: candidate.properties.valueFormat,
    }],
  });

  await context.wait(1000);
  const readBackRaw = await context.invokeCcApi({
    commandClass: "Configuration",
    method: "get",
    args: [candidate.parameter],
  });
  const readBack = Number(readBackRaw);

  await context.log("info", stepKey, "Configuration 参数读回完成", {
    parameter: candidate.parameter,
    expectedValue: targetValue,
    readBack,
  });

  if (readBack !== targetValue) {
    throw new Error(`参数 ${candidate.parameter} 写入 ${targetValue} 后读回为 ${String(readBackRaw)}。`);
  }

  return readBack;
}

export const configurationReadWriteDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Configuration"],
  meta: {
    id: "configuration-read-write-v1",
    key: "configuration-read-write",
    name: "Configuration 参数读写测试",
    deviceType: "generic-node",
    version: 1,
    enabled: true,
    description: "自动选择一个可写 Configuration 参数，执行读取、改写、读回校验，并最终恢复原值。",
    inputSchema: {},
  },
  supports(node) {
    return node.commandClasses.includes("Configuration")
      ? { supported: true }
      : { supported: false, reason: "节点未发现 Configuration CC。" };
  },
  async run(context) {
    await context.log("info", "precheck.start", "开始探测可读写的 Configuration 参数");
    const candidate = await findWritableCandidate(context);
    await context.log("info", "precheck.selected", "已选中 Configuration 测试参数", candidate as unknown as Record<string, unknown>);

    let restoredValue: number | undefined;
    try {
      await context.log("info", "write.set", "开始写入 Configuration 参数测试值", {
        parameter: candidate.parameter,
        from: candidate.currentValue,
        to: candidate.targetValue,
      });
      const writtenValue = await setAndVerifyParameter(context, candidate, candidate.targetValue, "write.verify");

      await context.log("info", "restore.set", "开始恢复 Configuration 参数原值", {
        parameter: candidate.parameter,
        from: writtenValue,
        to: candidate.currentValue,
      });
      restoredValue = await setAndVerifyParameter(context, candidate, candidate.currentValue, "restore.verify");
    } catch (error) {
      try {
        await context.invokeCcApi({
          commandClass: "Configuration",
          method: "set",
          args: [{
            parameter: candidate.parameter,
            value: candidate.currentValue,
            valueSize: candidate.properties.valueSize,
            valueFormat: candidate.properties.valueFormat,
          }],
        });
      } catch {
        // Ignore restore-on-error failures and surface the original error.
      }
      throw error;
    }

    await context.log("info", "result", "Configuration 参数读写测试通过", {
      parameter: candidate.parameter,
      restoredValue,
    });

    return {
      parameter: candidate.parameter,
      parameterName: candidate.name,
      parameterInfo: candidate.info,
      originalValue: candidate.currentValue,
      testValue: candidate.targetValue,
      restoredValue,
      properties: candidate.properties,
    };
  },
};
