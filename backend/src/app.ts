import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";

import type { AppConfig } from "./domain/config.js";
import { DatabaseService } from "./storage/database.js";
import { EventBus } from "./services/event-bus.js";
import { ZwaveJsDirectAdapter } from "./adapters/zwave/zwave-js-adapter.js";
import { ZwaveRuntimeService } from "./services/zwave-runtime-service.js";
import { InclusionService } from "./services/inclusion-service.js";
import { NodeRegistryService } from "./services/node-registry-service.js";
import { AuthSessionService } from "./services/auth-session-service.js";
import { TestEngineService } from "./services/test-engine-service.js";
import { SystemService } from "./services/system-service.js";
import { registerApiRoutes } from "./api/routes.js";
import { registerWsRoutes } from "./ws/register-ws.js";
import { readRequestToken } from "./utils/auth.js";

declare module "fastify" {
  interface FastifyInstance {
    services: {
      config: AppConfig;
      storage: DatabaseService;
      eventBus: EventBus;
      authSession: AuthSessionService;
      zwaveRuntime: ZwaveRuntimeService;
      inclusion: InclusionService;
      nodeRegistry: NodeRegistryService;
      testEngine: TestEngineService;
      system: SystemService;
    };
  }
}

export async function createApp(config: AppConfig) {
  const app = Fastify({ logger: true });
  const frontendDistDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../frontend/dist");
  const frontendIndexPath = path.join(frontendDistDir, "index.html");
  const storage = new DatabaseService(config.dataDir);
  const eventBus = new EventBus();
  const adapter = new ZwaveJsDirectAdapter(config);
  const authSession = new AuthSessionService(config, storage);
  const zwaveRuntime = new ZwaveRuntimeService(config, storage, adapter);
  const nodeRegistry = new NodeRegistryService(storage, adapter);
  const inclusion = new InclusionService(zwaveRuntime);
  const testEngine = new TestEngineService(storage, eventBus, nodeRegistry, zwaveRuntime);
  const system = new SystemService(config, storage, zwaveRuntime, testEngine);

  app.services = {
    config,
    storage,
    eventBus,
    authSession,
    zwaveRuntime,
    inclusion,
    nodeRegistry,
    testEngine,
    system,
  };

  adapter.onEvent((event) => {
    void nodeRegistry.handleEvent(event);
    if (event.type === "zwave.inclusion.stopped" || event.type === "zwave.exclusion.stopped") {
      void nodeRegistry.syncAll();
    }
    eventBus.publish(event);
  });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  app.addHook("preHandler", async (request, reply) => {
    if (request.method === "OPTIONS") {
      return;
    }

    if (
      request.url === "/api/auth/login" ||
      request.url === "/api/auth/me" ||
      request.url === "/api/auth/logout"
    ) {
      return;
    }

    if (request.url.startsWith("/api/")) {
      const authorized = await authSession.isAuthorized(readRequestToken(request));
      if (!authorized) {
        return reply.code(401).send({ message: "Unauthorized" });
      }
    }

    if (request.url.startsWith("/ws/")) {
      return reply;
    }
  });

  if (existsSync(frontendIndexPath)) {
    await app.register(fastifyStatic, {
      root: frontendDistDir,
      prefix: "/",
      wildcard: false,
    });
  }

  await registerApiRoutes(app);
  await registerWsRoutes(app);

  app.get("/*", async (_request, reply) => {
    if (existsSync(frontendIndexPath)) {
      return reply.sendFile("index.html");
    }

    return reply.code(503).type("text/plain").send(
      "Frontend bundle is missing. Build frontend on Raspberry Pi Ubuntu with `npm run build` before serving the web UI.",
    );
  });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);

    if (error instanceof ZodError) {
      reply.code(400).send({
        message: "Invalid request payload.",
        issues: error.issues,
      });
      return;
    }

    reply.code(500).send({
      message: error instanceof Error ? error.message : "Internal server error.",
    });
  });

  app.addHook("onClose", async () => {
    await adapter.disconnect();
    storage.close();
  });

  return app;
}
