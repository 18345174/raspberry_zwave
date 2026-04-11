import type { FastifyInstance } from "fastify";

import { readRequestToken } from "../utils/auth.js";

export async function registerWsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/ws/events",
    { websocket: true },
    async (socket, request) => {
      const authorized = await app.services.authSession.isAuthorized(readRequestToken(request));
      if (!authorized) {
        socket.close(1008, "Unauthorized");
        return;
      }

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
        unsubscribe();
        app.services.system.detachWebSocket();
      });
    },
  );
}
