import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createTestReportBodySchema,
  firmwareFileBodySchema,
  firmwareStartBodySchema,
  grantSecurityBodySchema,
  invokeCcBodySchema,
  listTestReportsQuerySchema,
  loginBodySchema,
  nodeIdParamSchema,
  runTestBodySchema,
  selectPortBodySchema,
  setValueBodySchema,
  updateConfigBodySchema,
  validateDskBodySchema,
} from "./helpers.js";
import { readRequestToken } from "../utils/auth.js";

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  const services = app.services;

  const requireDebugAccess = (reply: FastifyReply): boolean => {
    if (services.config.debugApiEnabled) {
      return true;
    }
    reply.code(403).send({ message: "Debug endpoints are disabled." });
    return false;
  };

  app.get("/api/system/health", async () => {
    return services.system.getHealth();
  });

  app.get("/api/auth/me", async (request) => {
    return services.authSession.getSessionView(readRequestToken(request));
  });

  app.post("/api/auth/login", async (request) => {
    const payload = loginBodySchema.parse(request.body ?? {});
    return services.authSession.login(payload.username, payload.password);
  });

  app.post("/api/auth/logout", async (request) => {
    await services.authSession.logout(readRequestToken(request));
    return {
      ok: true,
      session: await services.authSession.getSessionView(undefined),
    };
  });

  app.get("/api/system/config", async () => {
    return { items: services.system.getConfig() };
  });

  app.put("/api/system/config", async (request) => {
    const payload = updateConfigBodySchema.parse(request.body ?? {});
    services.system.updateConfig(payload);
    return { ok: true };
  });

  app.get("/api/serial/ports", async () => {
    return { items: await services.zwaveRuntime.listPorts() };
  });

  app.post("/api/serial/select", async (request) => {
    const payload = selectPortBodySchema.parse(request.body ?? {});
    await services.zwaveRuntime.saveSelectedPort(payload.path, payload.stablePath);
    return { ok: true };
  });

  app.get("/api/zwave/status", async () => {
    return await services.zwaveRuntime.getStatus();
  });

  app.post("/api/zwave/connect", async () => {
    const status = await services.zwaveRuntime.connect();
    if (status.hasReadyDriver) {
      await services.nodeRegistry.syncAll();
    }
    return status;
  });

  app.post("/api/zwave/disconnect", async () => {
    return await services.zwaveRuntime.disconnect();
  });

  app.post("/api/zwave/reconnect", async () => {
    const status = await services.zwaveRuntime.reconnect();
    if (status.hasReadyDriver) {
      await services.nodeRegistry.syncAll();
    }
    return status;
  });

  app.post("/api/zwave/inclusion/start", async () => {
    await services.inclusion.startInclusion();
    return { ok: true };
  });

  app.get("/api/zwave/inclusion/challenge", async () => {
    return { challenge: await services.inclusion.getInclusionChallenge() };
  });

  app.post("/api/zwave/inclusion/stop", async () => {
    await services.inclusion.stopInclusion();
    return { ok: true };
  });

  app.post("/api/zwave/exclusion/start", async () => {
    await services.inclusion.startExclusion();
    return { ok: true };
  });

  app.post("/api/zwave/exclusion/stop", async () => {
    await services.inclusion.stopExclusion();
    return { ok: true };
  });

  app.post("/api/zwave/controller/reset", async () => {
    const status = await services.zwaveRuntime.hardResetController();
    services.nodeRegistry.clearAll();
    return status;
  });

  app.post("/api/zwave/inclusion/grant-security", async (request) => {
    const payload = grantSecurityBodySchema.parse(request.body ?? {});
    await services.inclusion.grantSecurity(payload.requestId, {
      grant: payload.grant,
      clientSideAuth: payload.clientSideAuth,
    });
    return { ok: true };
  });

  app.post("/api/zwave/inclusion/validate-dsk", async (request) => {
    const payload = validateDskBodySchema.parse(request.body ?? {});
    await services.inclusion.validateDsk(payload.requestId, payload.pin);
    return { ok: true };
  });

  app.get("/api/nodes", async () => {
    return { items: await services.nodeRegistry.listNodes() };
  });

  app.get("/api/nodes/:nodeId", async (request, reply) => {
    const { nodeId } = nodeIdParamSchema.parse(request.params);
    const node = await services.nodeRegistry.getNode(nodeId);
    if (!node) {
      return reply.code(404).send({ message: `Node ${nodeId} not found.` });
    }
    return node;
  });

  app.get("/api/nodes/:nodeId/values", async (request) => {
    const { nodeId } = nodeIdParamSchema.parse(request.params);
    const node = await services.nodeRegistry.getNode(nodeId);
    if (!node) {
      return { items: [] };
    }
    return { items: node.values };
  });

  app.get("/api/nodes/:nodeId/contact-config", async (request) => {
    const { nodeId } = nodeIdParamSchema.parse(request.params);
    return { items: await services.zwaveRuntime.getContactConfig(nodeId) };
  });

  app.get("/api/nodes/:nodeId/firmware-update/capabilities", async (request) => {
    const { nodeId } = nodeIdParamSchema.parse(request.params);
    return await services.zwaveRuntime.getFirmwareUpdateCapabilities(nodeId);
  });

  app.get("/api/nodes/:nodeId/firmware-update/status", async (request) => {
    const { nodeId } = nodeIdParamSchema.parse(request.params);
    return { status: await services.zwaveRuntime.getFirmwareUpdateStatus(nodeId) };
  });

  app.post("/api/nodes/:nodeId/firmware-update/inspect", async (request) => {
    const { nodeId } = nodeIdParamSchema.parse(request.params);
    const payload = firmwareFileBodySchema.parse(request.body ?? {});
    return await services.zwaveRuntime.inspectFirmwareFile(nodeId, payload.filename, payload.contentBase64);
  });

  app.post("/api/nodes/:nodeId/firmware-update/start", async (request) => {
    const { nodeId } = nodeIdParamSchema.parse(request.params);
    const payload = firmwareStartBodySchema.parse(request.body ?? {});
    return await services.zwaveRuntime.startFirmwareUpdate({
      nodeId,
      filename: payload.filename,
      contentBase64: payload.contentBase64,
      target: payload.target,
      resume: payload.resume,
      nonSecureTransfer: payload.nonSecureTransfer,
    });
  });

  app.post("/api/nodes/:nodeId/firmware-update/abort", async (request) => {
    const { nodeId } = nodeIdParamSchema.parse(request.params);
    await services.zwaveRuntime.abortFirmwareUpdate(nodeId);
    return { ok: true };
  });

  app.post("/api/nodes/:nodeId/refresh", async (request) => {
    const { nodeId } = nodeIdParamSchema.parse(request.params);
    return await services.nodeRegistry.refreshNode(nodeId);
  });

  app.post("/api/nodes/:nodeId/read-supported-cc", async (request) => {
    const { nodeId } = nodeIdParamSchema.parse(request.params);
    return await services.nodeRegistry.readSupportedCommandClasses(nodeId);
  });

  app.post("/api/nodes/:nodeId/ping", async (request) => {
    const { nodeId } = nodeIdParamSchema.parse(request.params);
    return { ok: await services.zwaveRuntime.pingNode(nodeId) };
  });

  app.post("/api/nodes/:nodeId/heal", async (request) => {
    const { nodeId } = nodeIdParamSchema.parse(request.params);
    return { result: await services.zwaveRuntime.healNode(nodeId) };
  });

  app.post("/api/nodes/:nodeId/set-value", async (request, reply) => {
    if (!requireDebugAccess(reply)) {
      return;
    }
    const { nodeId } = nodeIdParamSchema.parse(request.params);
    const payload = setValueBodySchema.parse(request.body ?? {});
    await services.zwaveRuntime.setValue({
      nodeId,
      valueId: payload.valueId,
      value: payload.value,
    });
    return { ok: true };
  });

  app.post("/api/nodes/:nodeId/invoke-cc", async (request, reply) => {
    if (!requireDebugAccess(reply)) {
      return;
    }
    const { nodeId } = nodeIdParamSchema.parse(request.params);
    const payload = invokeCcBodySchema.parse(request.body ?? {});
    return {
      result: await services.zwaveRuntime.invokeCcApi({
        nodeId,
        endpoint: payload.endpoint,
        commandClass: payload.commandClass,
        method: payload.method,
        args: payload.args,
      }),
    };
  });

  app.get("/api/tests/definitions", async () => {
    return { items: services.testEngine.listDefinitions() };
  });

  app.get("/api/tests/definitions/supported/:nodeId", async (request) => {
    const { nodeId } = nodeIdParamSchema.parse(request.params);
    return { items: await services.testEngine.listSupportedDefinitions(nodeId) };
  });

  app.get("/api/tests/definitions/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const definition = services.testEngine.getDefinition(request.params.id);
    if (!definition) {
      return reply.code(404).send({ message: "Definition not found." });
    }
    return definition;
  });

  app.post("/api/tests/run", async (request) => {
    const payload = runTestBodySchema.parse(request.body ?? {});
    return await services.testEngine.createRun(payload);
  });

  app.post("/api/tests/reports", async (request) => {
    const payload = createTestReportBodySchema.parse(request.body ?? {});
    return services.testEngine.createReport(payload);
  });

  app.get("/api/tests/reports", async (request) => {
    const query = listTestReportsQuerySchema.parse(request.query ?? {});
    return { items: services.testEngine.listReports(query.nodeId) };
  });

  app.get("/api/tests/reports/:reportId", async (request: FastifyRequest<{ Params: { reportId: string } }>, reply) => {
    const report = services.testEngine.getReport(request.params.reportId);
    if (!report) {
      return reply.code(404).send({ message: "Test report not found." });
    }
    return report;
  });

  app.get("/api/tests/runs", async () => {
    return { items: services.testEngine.listRuns() };
  });

  app.get("/api/tests/runs/:runId", async (request: FastifyRequest<{ Params: { runId: string } }>, reply) => {
    const run = services.testEngine.getRun(request.params.runId);
    if (!run) {
      return reply.code(404).send({ message: "Test run not found." });
    }
    return run;
  });

  app.get("/api/tests/runs/:runId/logs", async (request: FastifyRequest<{ Params: { runId: string } }>) => {
    return { items: services.testEngine.getRunLogs(request.params.runId) };
  });

  app.post("/api/tests/runs/:runId/cancel", async (request: FastifyRequest<{ Params: { runId: string } }>) => {
    await services.testEngine.cancelRun(request.params.runId);
    return { ok: true };
  });
}
