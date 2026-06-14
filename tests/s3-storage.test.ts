import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import {
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import {
  createS3Client,
  S3Storage
} from "../src/services/s3-storage.js";
import type { ProcessedImage } from "../src/types.js";

const storageConfig: AppConfig["storage"] = {
  endpoint: "https://s3.ap-northeast-1.wasabisys.com",
  region: "ap-northeast-1",
  bucket: "shopify-images-ckc",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  publicBaseUrl:
    "https://s3.ap-northeast-1.wasabisys.com/shopify-images-ckc"
};

test("configures the S3 client for the Wasabi Tokyo endpoint", async () => {
  const client = createS3Client(storageConfig);

  try {
    const endpoint = await client.config.endpoint();
    const region = await client.config.region();

    assert.equal(endpoint.protocol, "https:");
    assert.equal(endpoint.hostname, "s3.ap-northeast-1.wasabisys.com");
    assert.equal(region, "ap-northeast-1");
    assert.equal(client.config.forcePathStyle, true);
  } finally {
    client.destroy();
  }
});

test("uploads .jpg objects with standard HTTP response metadata", async () => {
  const commands: unknown[] = [];
  const client = {
    async send(command: unknown) {
      commands.push(command);

      if (command instanceof HeadObjectCommand) {
        throw Object.assign(new Error("Not found"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 }
        });
      }

      return {};
    }
  } as unknown as Pick<S3Client, "send">;

  const storage = new S3Storage(storageConfig, client);
  const image: ProcessedImage = {
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    format: "jpeg",
    width: 1,
    height: 1,
    bytes: 4,
    sha256: "a".repeat(64)
  };

  const result = await storage.store(image);
  const put = commands.find(
    (command): command is PutObjectCommand => command instanceof PutObjectCommand
  );

  assert.ok(put);
  assert.equal(put.input.Bucket, "shopify-images-ckc");
  assert.equal(put.input.Key, `images/${"a".repeat(64)}.jpg`);
  assert.equal(put.input.ContentType, "image/jpeg");
  assert.equal(put.input.ContentDisposition, "inline");
  assert.equal(
    put.input.CacheControl,
    "public, max-age=31536000, immutable"
  );
  assert.equal(put.input.Metadata, undefined);
  assert.equal(
    result.url,
    `https://s3.ap-northeast-1.wasabisys.com/shopify-images-ckc/images/${"a".repeat(64)}.jpg`
  );
  assert.equal(result.uploaded, true);
});

test("rewrites an existing object when its response metadata is stale", async () => {
  const commands: unknown[] = [];
  const client = {
    async send(command: unknown) {
      commands.push(command);

      if (command instanceof HeadObjectCommand) {
        return {
          ContentType: "application/octet-stream",
          CacheControl: undefined,
          ContentDisposition: undefined
        };
      }

      return {};
    }
  } as unknown as Pick<S3Client, "send">;

  const storage = new S3Storage(storageConfig, client);

  await storage.store({
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    format: "jpeg",
    width: 1,
    height: 1,
    bytes: 4,
    sha256: "b".repeat(64)
  });

  assert.equal(
    commands.some((command) => command instanceof PutObjectCommand),
    true
  );
});
