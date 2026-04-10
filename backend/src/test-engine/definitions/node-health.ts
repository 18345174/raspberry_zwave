import type { ExecutableTestDefinition } from "../types.js";

export const nodeHealthDefinition: ExecutableTestDefinition = {
  meta: {
    id: "node-health-v1",
    key: "node-health",
    name: "节点健康检查",
    deviceType: "generic-node",
    version: 1,
    enabled: true,
    description: "对节点做 ping 与 lifeline health check，输出诊断结果。",
    inputSchema: {
      includeHealthCheck: { type: "boolean", default: true },
    },
  },
  supports() {
    return { supported: true };
  },
  async run(context) {
    await context.log("info", "ping", "开始执行节点 ping");
    const ping = await context.pingNode();

    let health: unknown;
    if (context.inputs.includeHealthCheck !== false) {
      await context.log("info", "health", "开始执行 lifeline health check");
      health = await context.checkNodeHealth();
    }

    return {
      ping,
      health,
    };
  },
};
