import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { createApiKeyGuard } from "../security/auth.js";
import { downloadRemoteImage } from "../services/downloader.js";
import { processImage } from "../services/image-processor.js";
import type { ImageStorage } from "../types.js";

interface RelayBody {
  url: string;
}

interface RelayResponse {
  success: true;
  url: string;
  format: "jpeg";
  width: number;
  height: number;
  bytes: number;
}

export async function registerImageRoutes(
  app: FastifyInstance,
  config: AppConfig,
  storage: ImageStorage
): Promise<void> {
  app.post<{ Body: RelayBody; Reply: RelayResponse }>(
    "/v1/images/relay",
    {
      preHandler: createApiKeyGuard(config.apiKey),
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["url"],
          properties: {
            url: {
              type: "string",
              minLength: 1,
              maxLength: 4096
            }
          }
        }
      }
    },
    async (request, reply) => {
      const source = await downloadRemoteImage(request.body.url, config);
      const image = await processImage(source, {
        maxOutputBytes: config.maxOutputBytes,
        maxInputPixels: config.maxInputPixels
      });
      const stored = await storage.store(image);

      request.log.info(
        {
          imageHash: image.sha256,
          bytes: image.bytes,
          width: image.width,
          height: image.height,
          uploaded: stored.uploaded
        },
        "image relay completed"
      );

      return reply.code(200).send({
        success: true,
        url: stored.url,
        format: image.format,
        width: image.width,
        height: image.height,
        bytes: image.bytes
      });
    }
  );
}
