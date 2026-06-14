import assert from "node:assert/strict";
import test from "node:test";
import { checkPublicImage } from "../src/services/public-image-checker.js";

const config = {
  downloadTimeoutMs: 1000
};

function asFetch(
  implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
): typeof fetch {
  return implementation as typeof fetch;
}

test("reports JPEG headers and the first 20 magic bytes", async () => {
  const bytes = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
    0x00, 0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xaa, 0xbb
  ]);

  const result = await checkPublicImage(
    "https://images.example.com/images/test.jpg",
    config,
    {
      validateUrl: async () => undefined,
      fetchImpl: asFetch(
        async () =>
          new Response(bytes, {
            status: 200,
            headers: {
              "content-type": "image/jpeg",
              "content-length": String(bytes.length),
              "cache-control": "public, max-age=31536000, immutable",
              "content-disposition": "inline"
            }
          })
      )
    }
  );

  assert.equal(result.httpStatus, 200);
  assert.equal(result.contentType, "image/jpeg");
  assert.equal(result.contentLength, 22);
  assert.equal(result.cacheControl, "public, max-age=31536000, immutable");
  assert.equal(result.contentDisposition, "inline");
  assert.deepEqual(result.magicBytes, [...bytes.slice(0, 20)]);
  assert.equal(result.magicBytesHex, Buffer.from(bytes.slice(0, 20)).toString("hex"));
  assert.equal(result.isJpeg, true);
});

test("does not follow redirects and does not classify them as JPEG", async () => {
  let redirectMode: RequestRedirect | undefined;

  const result = await checkPublicImage(
    "https://images.example.com/images/test.jpg",
    config,
    {
      validateUrl: async () => undefined,
      fetchImpl: asFetch(async (_input, init) => {
        redirectMode = init?.redirect;
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://cdn.example.com/test.jpg"
          }
        });
      })
    }
  );

  assert.equal(redirectMode, "manual");
  assert.equal(result.httpStatus, 302);
  assert.equal(result.isJpeg, false);
  assert.deepEqual(result.magicBytes, []);
});

test("detects an HTML error page even when the URL ends in .jpg", async () => {
  const result = await checkPublicImage(
    "https://images.example.com/images/test.jpg",
    config,
    {
      validateUrl: async () => undefined,
      fetchImpl: asFetch(
        async () =>
          new Response("<html>Access denied</html>", {
            status: 200,
            headers: {
              "content-type": "text/html"
            }
          })
      )
    }
  );

  assert.equal(result.httpStatus, 200);
  assert.equal(result.contentType, "text/html");
  assert.equal(result.isJpeg, false);
});
