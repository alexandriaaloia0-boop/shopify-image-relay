import {
  GetObjectAclCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectAclCommandOutput,
  type S3ServiceException
} from "@aws-sdk/client-s3";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import type { ImageStorage, ProcessedImage, StoredImage } from "../types.js";

const IMAGE_CONTENT_TYPE = "image/jpeg";
const IMAGE_CONTENT_DISPOSITION = "inline";
const IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const PUBLIC_READ_ACL = "public-read";
const ALL_USERS_GROUP = "http://acs.amazonaws.com/groups/global/AllUsers";

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

function hasCorrectResponseMetadata(metadata: {
  ContentType?: string | undefined;
  ContentDisposition?: string | undefined;
  CacheControl?: string | undefined;
}): boolean {
  return (
    metadata.ContentType?.toLowerCase() === IMAGE_CONTENT_TYPE &&
    metadata.ContentDisposition?.toLowerCase() === IMAGE_CONTENT_DISPOSITION &&
    metadata.CacheControl === IMAGE_CACHE_CONTROL
  );
}

function hasPublicReadAcl(
  grants: GetObjectAclCommandOutput["Grants"]
): boolean {
  return (
    grants?.some(
      (grant) =>
        grant.Grantee?.Type === "Group" &&
        grant.Grantee.URI === ALL_USERS_GROUP &&
        grant.Permission === "READ"
    ) ?? false
  );
}

export function buildPublicObjectUrl(publicBaseUrl: string, key: string): string {
  const url = new URL(publicBaseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  url.pathname = `${basePath}/${encodedKey}`.replace(/\/{2,}/g, "/");
  url.search = "";
  url.hash = "";

  return url.toString();
}

export class S3Storage implements ImageStorage {
  constructor(
    private readonly config: AppConfig["storage"],
    private readonly client: Pick<S3Client, "send"> = createS3Client(config)
  ) {}

  async store(image: ProcessedImage): Promise<StoredImage> {
    const key = `images/${image.sha256}.jpg`;
    let needsUpload = true;

    try {
      const existing = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: key
        })
      );
      needsUpload = !hasCorrectResponseMetadata(existing);

      if (!needsUpload) {
        try {
          const acl = await this.client.send(
            new GetObjectAclCommand({
              Bucket: this.config.bucket,
              Key: key
            })
          );
          needsUpload = !hasPublicReadAcl(acl.Grants);
        } catch {
          // Re-uploading with public-read is safer than trusting an unknown ACL.
          needsUpload = true;
        }
      }
    } catch (error) {
      if (!isNotFound(error)) {
        throw new AppError(502, "S3_HEAD_FAILED", "Could not check the image in object storage", {
          cause: error
        });
      }
    }

    if (needsUpload) {
      try {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.config.bucket,
            Key: key,
            Body: image.buffer,
            ContentLength: image.bytes,
            ACL: PUBLIC_READ_ACL,
            ContentType: IMAGE_CONTENT_TYPE,
            ContentDisposition: IMAGE_CONTENT_DISPOSITION,
            CacheControl: IMAGE_CACHE_CONTROL
          })
        );
      } catch (error) {
        throw new AppError(502, "S3_UPLOAD_FAILED", "Could not upload the image to object storage", {
          cause: error
        });
      }
    }

    return {
      url: buildPublicObjectUrl(this.config.publicBaseUrl, key),
      uploaded: needsUpload
    };
  }
}
