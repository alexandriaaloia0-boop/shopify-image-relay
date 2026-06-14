import assert from "node:assert/strict";
import test from "node:test";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { processImage } from "../src/services/image-processor.js";

test("converts a real image to a bounded JPEG", async () => {
  const source = await sharp({
    create: {
      width: 3000,
      height: 1500,
      channels: 4,
      background: { r: 30, g: 120, b: 220, alpha: 0.7 }
    }
  })
    .png()
    .toBuffer();

  const result = await processImage(source, {
    maxOutputBytes: 5 * 1024 * 1024,
    maxInputPixels: 40_000_000
  });
  const detected = await fileTypeFromBuffer(result.buffer);

  assert.equal(result.format, "jpeg");
  assert.equal(detected?.mime, "image/jpeg");
  assert.equal(result.width, 2048);
  assert.equal(result.height, 1024);
  assert.ok(result.bytes <= 5 * 1024 * 1024);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

test("rejects non-image content even when a URL might claim it is an image", async () => {
  await assert.rejects(
    processImage(Buffer.from("<html>not an image</html>"), {
      maxOutputBytes: 5 * 1024 * 1024,
      maxInputPixels: 40_000_000
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "UNSUPPORTED_IMAGE"
  );
});
