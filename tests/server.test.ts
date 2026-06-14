import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { buildApp } from "../src/server.js";
import type { ImageStorage } from "../src/types.js";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  apiKey: "test-api-key-that-is-long-enough",
  storage: {
    endpoint: "https://s3.ap-northeast-1.wasabisys.com",
    region: "ap-northeast-1",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    bucket: "shopify-images-ckc",
    publicBaseUrl:
      "https://s3.ap-northeast-1.wasabisys.com/shopify-images-ckc"
  },
  downloadTimeoutMs: 1000,
  maxDownloadBytes: 1024 * 1024,
  maxOutputBytes: 5 * 1024 * 1024,
  maxRedirects: 2,
  maxInputPixels: 40_000_000
};

const unusedStorage: ImageStorage = {
  async store() {
    throw new Error("Storage should not be called by these tests");
  }
};

test("health endpoint is public", async (t) => {
  const app = await buildApp(config, unusedStorage);
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/health"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().success, true);
});

test("relay endpoint requires a valid bearer API key", async (t) => {
  const app = await buildApp(config, unusedStorage);
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/images/relay",
    payload: {
      url: "https://example.com/image.jpg"
    }
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "UNAUTHORIZED");
});

test("relay endpoint blocks localhost with valid authentication", async (t) => {
  const app = await buildApp(config, unusedStorage);
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/images/relay",
    headers: {
      authorization: `Bearer ${config.apiKey}`
    },
    payload: {
      url: "http://127.0.0.1/image.jpg"
    }
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "BLOCKED_URL");
});

test("image check endpoint returns public response diagnostics", async (t) => {
  const checkedUrl =
    "https://s3.ap-northeast-1.wasabisys.com/shopify-images-ckc/images/test.jpg";
  const app = await buildApp(
    config,
    unusedStorage,
    async (url) => ({
      url,
      httpStatus: 200,
      contentType: "image/jpeg",
      contentLength: 1234,
      cacheControl: "public, max-age=31536000, immutable",
      contentDisposition: "inline",
      magicBytes: [255, 216, 255, 224],
      magicBytesHex: "ffd8ffe0",
      isJpeg: true
    })
  );
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/images/check?url=${encodeURIComponent(checkedUrl)}`,
    headers: {
      authorization: `Bearer ${config.apiKey}`
    }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    success: true,
    url: checkedUrl,
    httpStatus: 200,
    contentType: "image/jpeg",
    contentLength: 1234,
    cacheControl: "public, max-age=31536000, immutable",
    contentDisposition: "inline",
    magicBytes: [255, 216, 255, 224],
    magicBytesHex: "ffd8ffe0",
    isJpeg: true
  });
});
