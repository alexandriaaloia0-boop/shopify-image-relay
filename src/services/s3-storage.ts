import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ServiceException
} from "@aws-sdk/client-s3";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import type { ImageStorage, ProcessedImage, StoredImage } from "../types.js";

function isNotFound(error: unknown): boolean {
  const serviceError = error as Partial<S3ServiceException>;
  return (
    serviceError.$metadata?.httpStatusCode === 404 ||
    serviceError.name === "NotFound" ||
    serviceError.name === "NoSuchKey"
  );
}

export function createS3Client(config: AppConfig["storage"]): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
}

export class S3Storage implements ImageStorage {
  private readonly client: S3Client;

  constructor(private readonly config: AppConfig["storage"]) {
    this.client = createS3Client(config);
  }

  async store(image: ProcessedImage): Promise<StoredImage> {
    const key = `images/${image.sha256}.jpg`;
    let exists = false;

    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: key
        })
      );
      exists = true;
    } catch (error) {
      if (!isNotFound(error)) {
        throw new AppError(502, "S3_HEAD_FAILED", "Could not check the image in object storage", {
          cause: error
        });
      }
    }

    if (!exists) {
      try {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
            Body: image.buffer,
            ContentLength: image.bytes,
            ContentType: "image/jpeg",
            CacheControl: "public, max-age=31536000, immutable"
          })
        );
      } catch (error) {
        throw new AppError(502, "S3_UPLOAD_FAILED", "Could not upload the image to object storage", {
          cause: error
        });
      }
    }

    return {
      url: `${this.config.publicBaseUrl}/${key}`,
      uploaded: !exists
    };
  }
}
