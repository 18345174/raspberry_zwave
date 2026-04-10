import { waitForCondition } from "../definition-helpers.js";
import type { ExecutableTestDefinition } from "../types.js";

export const binarySwitchDefinition: ExecutableTestDefinition = {
  meta: {
    id: "binary-switch-basic-v1",
    key: "binary-switch-basic",
    name: "二进制开关通断测试",
    deviceType: "binary-switch",
    version: 2,
    enabled: true,
    description: "基于 Binary Switch CC 执行开/关命令、状态轮询和断言。",
    inputSchema: {
      repeat: { type: "number", default: 2, min: 1, max: 20 },
      onTimeoutMs: { type: "number", default: 10000, min: 1000, max: 60000 },
      offTimeoutMs: { type: "number", default: 10000, min: 1000, max: 60000 },
    },
  },
  supports(node) {
    return node.commandClasses.includes("Binary Switch")
      ? { supported: true }
      : { supported: false, reason: "节点未发现 Binary Switch CC。" };
  },
  async run(context) {
    const repeat = Number(context.inputs.repeat ?? 2);
    const onTimeoutMs = Number(context.inputs.onTimeoutMs ?? 10000);
    const offTimeoutMs = Number(context.inputs.offTimeoutMs ?? 10000);

    const initialState = await context.invokeCcApi({ commandClass: "Binary Switch", method: "get" }) as { currentValue?: boolean } | undefined;
    await context.log("info", "precheck", "Binary Switch CC precheck complete", {
      initialState,
      repeat,
      onTimeoutMs,
      offTimeoutMs,
    });

    for (let round = 1; round <= repeat; round += 1) {
      await context.log("info", "switch.on.command", `第 ${round} 轮下发开指令`, { targetValue: true });
      await context.invokeCcApi({
        commandClass: "Binary Switch",
        method: "set",
        args: [true],
      });

      const onState = await waitForCondition(
        context,
        "switch.on.wait",
        onTimeoutMs,
        async () => {
          return context.invokeCcApi({ commandClass: "Binary Switch", method: "get" }) as Promise<{ currentValue?: boolean; targetValue?: boolean }>;
        },
        (state) => state.currentValue === true,
        (state) => ({ currentValue: state.currentValue, targetValue: state.targetValue }),
      );

      await context.log("info", "switch.on.assert", `第 ${round} 轮开状态确认`, onState);

      await context.log("info", "switch.off.command", `第 ${round} 轮下发关指令`, { targetValue: false });
      await context.invokeCcApi({
        commandClass: "Binary Switch",
        method: "set",
        args: [false],
      });

      const offState = await waitForCondition(
        context,
        "switch.off.wait",
        offTimeoutMs,
        async () => {
          return context.invokeCcApi({ commandClass: "Binary Switch", method: "get" }) as Promise<{ currentValue?: boolean; targetValue?: boolean }>;
        },
        (state) => state.currentValue === false,
        (state) => ({ currentValue: state.currentValue, targetValue: state.targetValue }),
      );

      await context.log("info", "switch.off.assert", `第 ${round} 轮关状态确认`, offState);
    }

    const finalState = await context.invokeCcApi({ commandClass: "Binary Switch", method: "get" }) as Record<string, unknown> | undefined;
    const ping = await context.pingNode();

    return {
      repeat,
      onTimeoutMs,
      offTimeoutMs,
      initialState,
      finalState,
      ping,
    };
  },
};
