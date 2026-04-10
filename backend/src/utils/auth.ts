import type { FastifyReply, FastifyRequest } from "fastify";

function getBearerToken(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}

export function readRequestToken(request: FastifyRequest): string | undefined {
  const headerToken =
    request.headers["x-api-token"] ??
    getBearerToken(typeof request.headers.authorization === "string" ? request.headers.authorization : undefined);

  if (typeof headerToken === "string" && headerToken.trim()) {
    return headerToken.trim();
  }

  const queryToken = (request.query as { token?: unknown } | undefined)?.token;
  return typeof queryToken === "string" && queryToken.trim() ? queryToken.trim() : undefined;
}

export function ensureAuthorized(
  request: FastifyRequest,
  reply: FastifyReply,
  expectedToken?: string,
): boolean {
  if (!expectedToken) {
    return true;
  }

  if (readRequestToken(request) === expectedToken) {
    return true;
  }

  reply.code(401).send({ message: "Unauthorized" });
  return false;
}
