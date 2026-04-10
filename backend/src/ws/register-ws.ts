import type { FastifyInstance } from "fastify";
import type { SocketStream } from "@fastify/websocket";

import { readRequestToken } from "../utils/auth.js";

export async function registerWsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/ws/events",
    { websocket: true },
    async (connection: SocketStream, request) => {
      const authorized = await app.services.authSession.isAuthorized(readRequestToken(request));
      if (!authorized) {
        connection.socket.close(1008, "Unauthorized");
        return;
      }

      app.services.system.attachWebSocket();
      const unsubscribe = app.services.eventBus.subscribe((event) => {
        connection.socket.send(JSON.stringify(event));
      });

      connection.socket.send(
        JSON.stringify({
          type: "system.health",
          timestamp: new Date().toISOString(),
          payload: await app.services.system.getHealth(),
        }),
      );

      connection.socket.on("close", () => {
        unsubscribe();
        app.services.system.detachWebSocket();
      });
    },
  );
}
