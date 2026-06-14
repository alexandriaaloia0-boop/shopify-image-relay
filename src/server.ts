import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { loadConfig, type AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import { registerImageRoutes } from "./routes/images.js";
import { checkPublicImage } from "./services/public-image-checker.js";
import { S3Storage } from "./services/s3-storage.js";
import type { ImageStorage } from "./types.js";

export async function buildApp(
  config: AppConfig = loadConfig(),
  storage: ImageStorage = new S3Storage(config.storage),
  checkImage: typeof checkPublicImage = checkPublicImage
): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.nodeEnv === "test"
        ? false
        : {
            level: config.nodeEnv === "production" ? "info" : "debug"
          },
    bodyLimit: 16 * 1024,
    requestTimeout: config.downloadTimeoutMs + 10_000
  });

  app.get("/health", async () => ({
    success: true,
    service: "shopify-image-relay"
  }));

  await registerImageRoutes(app, config, storage, checkImage);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error, code: error.code }, error.message);
      } else {
        request.log.warn({ err: error, code: error.code }, error.message);
      }

      return reply.code(error.statusCode).send({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          ...error.details
        }
      });
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "validation" in error &&
      error.validation
    ) {
      return reply.code(400).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: error instanceof Error ? error.message : "Request validation failed"
        }
      });
    }

    request.log.error({ err: error }, "unhandled request error");
    return reply.code(500).send({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error"
      }
    });
  });

  return app;
}

async function start(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";

if (import.meta.url === entryPoint) {
  void start();
}
