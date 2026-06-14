import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { createS3Client } from "../src/services/s3-storage.js";

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
