import type { ExecutableTestDefinition } from "../types.js";

interface ConfigurationProperties {
  minValue?: number;
  maxValue?: number;
  defaultValue?: unknown;
  isReadonly?: boolean;
  altersCapabilities?: boolean;
  valueSize?: 1 | 2 | 4;
  valueFormat?: number;
}

interface WritableConfigCandidate {
  parameter: number;
  name?: string;
  info?: string;
  currentValue: number;
  targetValue: number;
  fallbackTargetValue?: number;
  properties: ConfigurationProperties;
}

interface SkippedConfigCandidate {
  parameter: number;
  reason: string;
  currentValue?: unknown;
  properties?: ConfigurationProperties;
  error?: string;
}

interface ParameterTestResult {
  parameter: number;
  parameterName?: string;
  parameterInfo?: string;
  originalValue: number;
  testValue: number;
  restoredValue: number;
  properties: ConfigurationProperties;
}

function describeParameter(parameter: number, name?: string, info?: string): string {
  const label = name?.trim() || info?.trim();
  return label ? `Configuration 参数 ${parameter}（${label}）` : `Configuration 参数 ${parameter}`;
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

function chooseTargetValue(
  currentValue: number,
  minValue: number,
  maxValue: number,
): number | undefined {
  if (currentValue !== maxValue) {
    return maxValue;
  }
  if (currentValue !== 1 && 1 >= minValue && 1 <= maxValue) {
    return 1;
  }
  if (currentValue !== minValue) {
    return minValue;
  }
  if (currentValue + 1 <= maxValue) {
    return currentValue + 1;
  }
  if (currentValue - 1 >= minValue) {
    return currentValue - 1;
  }
  return undefined;
}

function chooseFallbackTargetValue(
  currentValue: number,
  minValue: number,
  maxValue: number,
  primaryTargetValue: number,
): number | undefined {
  if (primaryTargetValue !== 1 && currentValue !== 1 && 1 >= minValue && 1 <= maxValue) {
    return 1;
  }
  return undefined;
}

class ConfigurationReadBackMismatchError extends Error {
  public constructor(
    public readonly parameter: number,
    public readonly expectedValue: number,
    public readonly readBackRaw: unknown,
  ) {
    super(`参数 ${parameter} 写入 ${expectedValue} 后读回为 ${String(readBackRaw)}。`);
    this.name = "ConfigurationReadBackMismatchError";
  }
}

async function findWritableCandidates(
  context: Parameters<ExecutableTestDefinition["run"]>[0],
): Promise<{
  parameters: number[];
  writable: WritableConfigCandidate[];
  skipped: SkippedConfigCandidate[];
}> {
  const parameters = listConfigurationParameters(context);
  if (!parameters.length) {
    throw new Error("节点快照中未发现 Configuration 参数，无法执行参数读写测试。");
  }

  const writable: WritableConfigCandidate[] = [];
  const skipped: SkippedConfigCandidate[] = [];

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

      if (properties?.isReadonly) {
        skipped.push({
          parameter,
          reason: "readonly",
          currentValue: currentValueRaw,
          properties,
        });
        continue;
      }

      if (properties?.altersCapabilities) {
        skipped.push({
          parameter,
          reason: "alters-capabilities",
          currentValue: currentValueRaw,
          properties,
        });
        continue;
      }

      if (!Number.isFinite(currentValue) || !Number.isInteger(currentValue)) {
        skipped.push({
          parameter,
          reason: "invalid-current-value",
          currentValue: currentValueRaw,
          properties,
        });
        continue;
      }

      if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || minValue > maxValue) {
        skipped.push({
          parameter,
          reason: "invalid-range",
          currentValue: currentValueRaw,
          properties,
        });
        continue;
      }

      const targetValue = chooseTargetValue(currentValue, minValue, maxValue);
      if (targetValue == undefined) {
        skipped.push({
          parameter,
          reason: "no-safe-target-value",
          currentValue: currentValueRaw,
          properties,
        });
        continue;
      }

      writable.push({
        parameter,
        name: typeof name === "string" ? name : undefined,
        info: typeof info === "string" ? info : undefined,
        currentValue,
        targetValue,
        fallbackTargetValue: chooseFallbackTargetValue(currentValue, minValue, maxValue, targetValue),
        properties: properties ?? {},
      });
    } catch (error) {
      skipped.push({
        parameter,
        reason: "probe-error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    parameters,
    writable,
    skipped,
  };
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

  await context.log(
    "info",
    stepKey,
    `${describeParameter(candidate.parameter, candidate.name, candidate.info)} 读回完成（期望 ${targetValue}，实际 ${String(readBackRaw)}）`,
    {
    parameter: candidate.parameter,
    parameterName: candidate.name,
    parameterInfo: candidate.info,
    expectedValue: targetValue,
    readBack,
    },
  );

  if (readBack !== targetValue) {
    throw new ConfigurationReadBackMismatchError(candidate.parameter, targetValue, readBackRaw);
  }

  return readBack;
}

async function restoreParameterBestEffort(
  context: Parameters<ExecutableTestDefinition["run"]>[0],
  candidate: WritableConfigCandidate,
): Promise<void> {
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
    await context.wait(1000);
  } catch {
    // Ignore restore-on-error failures and surface the original error.
  }
}

async function testWritableCandidate(
  context: Parameters<ExecutableTestDefinition["run"]>[0],
  candidate: WritableConfigCandidate,
  index: number,
  total: number,
): Promise<ParameterTestResult> {
  const parameterLabel = describeParameter(candidate.parameter, candidate.name, candidate.info);
  let effectiveTargetValue = candidate.targetValue;

  await context.log("info", `parameter.${candidate.parameter}.start`, `开始测试 ${parameterLabel}`, {
    index,
    total,
    parameter: candidate.parameter,
    name: candidate.name,
    info: candidate.info,
    from: candidate.currentValue,
    to: candidate.targetValue,
    fallbackTo: candidate.fallbackTargetValue,
  });

  let restoredValue: number | undefined;
  try {
    await context.log(
      "info",
      `parameter.${candidate.parameter}.write.set`,
      `${parameterLabel} 开始写入测试值（${candidate.currentValue} -> ${effectiveTargetValue}）`,
      {
      parameter: candidate.parameter,
      parameterName: candidate.name,
      parameterInfo: candidate.info,
      from: candidate.currentValue,
      to: effectiveTargetValue,
      },
    );
    let writtenValue: number;
    try {
      writtenValue = await setAndVerifyParameter(
        context,
        candidate,
        effectiveTargetValue,
        `parameter.${candidate.parameter}.write.verify`,
      );
    } catch (error) {
      if (
        error instanceof ConfigurationReadBackMismatchError
        && candidate.fallbackTargetValue != undefined
        && candidate.fallbackTargetValue !== effectiveTargetValue
      ) {
        effectiveTargetValue = candidate.fallbackTargetValue;
        await context.log(
          "warn",
          `parameter.${candidate.parameter}.write.fallback`,
          `${parameterLabel} 写入最大值失败，改为尝试写入 ${effectiveTargetValue}`,
          {
            parameter: candidate.parameter,
            parameterName: candidate.name,
            parameterInfo: candidate.info,
            failedExpectedValue: error.expectedValue,
            failedReadBackValue: error.readBackRaw,
            retryTargetValue: effectiveTargetValue,
          },
        );
        await context.log(
          "info",
          `parameter.${candidate.parameter}.write.set`,
          `${parameterLabel} 开始写入测试值（${candidate.currentValue} -> ${effectiveTargetValue}）`,
          {
            parameter: candidate.parameter,
            parameterName: candidate.name,
            parameterInfo: candidate.info,
            from: candidate.currentValue,
            to: effectiveTargetValue,
          },
        );
        writtenValue = await setAndVerifyParameter(
          context,
          candidate,
          effectiveTargetValue,
          `parameter.${candidate.parameter}.write.verify`,
        );
      } else {
        throw error;
      }
    }

    await context.log(
      "info",
      `parameter.${candidate.parameter}.restore.set`,
      `${parameterLabel} 开始恢复原值（${writtenValue} -> ${candidate.currentValue}）`,
      {
      parameter: candidate.parameter,
      parameterName: candidate.name,
      parameterInfo: candidate.info,
      from: writtenValue,
      to: candidate.currentValue,
      },
    );
    restoredValue = await setAndVerifyParameter(
      context,
      candidate,
      candidate.currentValue,
      `parameter.${candidate.parameter}.restore.verify`,
    );
  } catch (error) {
    await restoreParameterBestEffort(context, candidate);
    throw error;
  }

  await context.log("info", `parameter.${candidate.parameter}.result`, `${parameterLabel} 测试通过`, {
    index,
    total,
    parameter: candidate.parameter,
    parameterName: candidate.name,
    parameterInfo: candidate.info,
    restoredValue,
  });

  return {
    parameter: candidate.parameter,
    parameterName: candidate.name,
    parameterInfo: candidate.info,
    originalValue: candidate.currentValue,
    testValue: effectiveTargetValue,
    restoredValue,
    properties: candidate.properties,
  };
}

export const configurationReadWriteDefinition: ExecutableTestDefinition = {
  traceCommandClasses: ["Configuration"],
  meta: {
    id: "configuration-read-write-v2",
    key: "configuration-read-write",
    name: "Configuration 参数读写测试",
    deviceType: "generic-node",
    version: 2,
    enabled: true,
    description: "批量测试所有安全可写的 Configuration 参数，逐个执行读取、改写、读回校验，并最终恢复原值。",
    inputSchema: {},
  },
  supports(node) {
    return node.commandClasses.includes("Configuration")
      ? { supported: true }
      : { supported: false, reason: "节点未发现 Configuration CC。" };
  },
  async run(context) {
    await context.log("info", "precheck.start", "开始探测可批量读写的 Configuration 参数");
    const discovery = await findWritableCandidates(context);

    await context.log("info", "precheck.summary", "Configuration 参数探测完成", {
      totalParameters: discovery.parameters.length,
      writableParameters: discovery.writable.map((candidate) => ({
        parameter: candidate.parameter,
        label: describeParameter(candidate.parameter, candidate.name, candidate.info),
      })),
      skippedParameters: discovery.skipped,
    });

    if (!discovery.writable.length) {
      throw new Error(`未找到可安全执行写入的 Configuration 参数。探测结果：${JSON.stringify(discovery.skipped)}`);
    }

    const results: ParameterTestResult[] = [];
    for (const [index, candidate] of discovery.writable.entries()) {
      try {
        const result = await testWritableCandidate(context, candidate, index + 1, discovery.writable.length);
        results.push(result);
      } catch (error) {
        throw new Error(
          `Configuration 参数 ${candidate.parameter} 批量测试失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await context.log("info", "result", "Configuration 参数批量读写测试通过", {
      testedCount: results.length,
      skippedCount: discovery.skipped.length,
      testedParameters: results.map((result) => ({
        parameter: result.parameter,
        label: describeParameter(result.parameter, result.parameterName, result.parameterInfo),
      })),
    });

    return {
      totalCount: discovery.parameters.length,
      testedCount: results.length,
      skippedCount: discovery.skipped.length,
      testedParameters: results.map((result) => result.parameter),
      skippedParameters: discovery.skipped,
      results,
    };
  },
};
