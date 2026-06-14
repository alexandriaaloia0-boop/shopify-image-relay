import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { createApiKeyGuard } from "../security/auth.js";
import { downloadRemoteImage } from "../services/downloader.js";
import { processImage } from "../services/image-processor.js";
import {
  checkPublicImage,
  type PublicImageCheck
} from "../services/public-image-checker.js";
import { AppError } from "../errors.js";
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

interface CheckQuery {
  url: string;
}

interface CheckResponse extends PublicImageCheck {
  success: true;
}

type PublicImageChecker = typeof checkPublicImage;

export async function registerImageRoutes(
  app: FastifyInstance,
  config: AppConfig,
  storage: ImageStorage,
  checkImage: PublicImageChecker = checkPublicImage
): Promise<void> {
  const apiKeyGuard = createApiKeyGuard(config.apiKey);

  app.get<{ Querystring: CheckQuery; Reply: CheckResponse }>(
    "/v1/images/check",
    {
      preHandler: apiKeyGuard,
      schema: {
        querystring: {
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
      const check = await checkImage(request.query.url, config);

      request.log.info(check, "public image check completed");

      return reply.code(200).send({
        success: true,
        ...check
      });
    }
  );

  app.post<{ Body: RelayBody; Reply: RelayResponse }>(
    "/v1/images/relay",
    {
      preHandler: apiKeyGuard,
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
      const source = await downloadRemoteImage(request.body.url, config, {
        logger: request.log
      });
      const image = await processImage(source, {
        maxOutputBytes: config.maxOutputBytes,
        maxInputPixels: config.maxInputPixels
      });
      const stored = await storage.store(image);

      request.log.info(
        {
          url: stored.url,
          imageHash: image.sha256,
          bytes: image.bytes,
          width: image.width,
          height: image.height,
          uploaded: stored.uploaded
        },
        "image uploaded to object storage"
      );

      let publicCheck: PublicImageCheck;

      try {
        publicCheck = await checkImage(stored.url, config);
      } catch (error) {
        request.log.error(
          {
            url: stored.url,
            err: error
          },
          "public image verification request failed"
        );
        throw error;
      }

      request.log.info(
        {
          ...publicCheck
        },
        "public image verification completed"
      );

      if (!publicCheck.isJpeg) {
        request.log.error(
          {
            ...publicCheck
          },
          "public image verification failed"
        );
        throw new AppError(
          502,
          "PUBLIC_IMAGE_VERIFICATION_FAILED",
          `Public image verification failed: HTTP ${publicCheck.httpStatus}, content-type ${
            publicCheck.contentType ?? "missing"
          }, JPEG magic ${publicCheck.magicBytesHex || "missing"}`
        );
      }

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
