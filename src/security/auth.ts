import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../errors.js";

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createApiKeyGuard(apiKey: string) {
  return async function apiKeyGuard(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";

    if (!token || !secureEqual(token, apiKey)) {
      reply.header("WWW-Authenticate", "Bearer");
      throw new AppError(401, "UNAUTHORIZED", "Missing or invalid API key");
    }
  };
}
