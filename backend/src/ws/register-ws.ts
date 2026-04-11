import type { FastifyInstance } from "fastify";

import { readRequestToken } from "../utils/auth.js";

export async function registerWsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/ws/events",
    { websocket: true },
    async (socket, request) => {
      const authorized = await app.services.authSession.isAuthorized(readRequestToken(request));
      if (!authorized) {
        app.log.warn({
          remoteAddress: request.ip,
          userAgent: request.headers["user-agent"],
        }, "Rejected websocket client");
        socket.close(1008, "Unauthorized");
        return;
      }

      app.log.info({
        remoteAddress: request.ip,
        userAgent: request.headers["user-agent"],
      }, "Websocket client connected");
      app.services.system.attachWebSocket();
      const unsubscribe = app.services.eventBus.subscribe((event) => {
        socket.send(JSON.stringify(event));
      });

      socket.send(
        JSON.stringify({
          type: "system.health",
          timestamp: new Date().toISOString(),
          payload: await app.services.system.getHealth(),
        }),
      );

      socket.on("close", () => {
        app.log.info({
          remoteAddress: request.ip,
        }, "Websocket client disconnected");
        unsubscribe();
        app.services.system.detachWebSocket();
      });
    },
  );
}
