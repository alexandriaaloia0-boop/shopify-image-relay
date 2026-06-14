import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/errors.js";
import { downloadRemoteImage } from "../src/services/downloader.js";

const config = {
  downloadTimeoutMs: 1000,
  maxDownloadBytes: 1024,
  maxRedirects: 3
};

function asFetch(
  implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
): typeof fetch {
  return implementation as typeof fetch;
}

test("uses browser headers and returns the downloaded bytes", async () => {
  let requestHeaders: Headers | undefined;

  const result = await downloadRemoteImage(
    "https://images.example.com/product.jpg",
    config,
    {
      validateUrl: async () => undefined,
      fetchImpl: asFetch(async (_input, init) => {
        requestHeaders = new Headers(init?.headers);
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      })
    }
  );

  assert.deepEqual([...result], [1, 2, 3]);
  assert.equal(requestHeaders?.get("user-agent"), "Mozilla/5.0");
  assert.equal(
    requestHeaders?.get("accept"),
    "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
  );
  assert.equal(requestHeaders?.get("accept-language"), "en-US,en;q=0.9");
});

test("handles redirects manually and validates every redirect target", async () => {
  const validatedUrls: string[] = [];
  const fetchedUrls: string[] = [];

  const result = await downloadRemoteImage(
    "https://images.example.com/start",
    config,
    {
      validateUrl: async (url) => {
        validatedUrls.push(url.toString());
      },
      fetchImpl: asFetch(async (input) => {
        const url = input.toString();
        fetchedUrls.push(url);

        if (url === "https://images.example.com/start") {
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://cdn.example.com/final.jpg"
            }
          });
        }

        return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
      })
    }
  );

  assert.deepEqual(validatedUrls, [
    "https://images.example.com/start",
    "https://cdn.example.com/final.jpg"
  ]);
  assert.deepEqual(fetchedUrls, validatedUrls);
  assert.deepEqual([...result], [4, 5, 6]);
});

test("blocks a redirect target before making the next fetch request", async () => {
  let fetchCount = 0;

  await assert.rejects(
    downloadRemoteImage("https://images.example.com/start", config, {
      validateUrl: async (url) => {
        if (url.hostname === "127.0.0.1") {
          throw new AppError(400, "BLOCKED_URL", "Private address blocked");
        }
      },
      fetchImpl: asFetch(async () => {
        fetchCount += 1;
        return new Response(null, {
          status: 302,
          headers: {
            location: "http://127.0.0.1/private.jpg"
          }
        });
      })
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === "BLOCKED_URL"
  );

  assert.equal(fetchCount, 1);
});

test("returns a detailed error and log entry for non-2xx responses", async () => {
  const logEntries: Array<Record<string, unknown>> = [];

  await assert.rejects(
    downloadRemoteImage("https://images.example.com/missing.jpg", config, {
      validateUrl: async () => undefined,
      fetchImpl: asFetch(async () => new Response(null, { status: 404 })),
      logger: {
        error(bindings) {
          logEntries.push(bindings);
        }
      }
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "REMOTE_HTTP_ERROR" &&
      error.message === "REMOTE_HTTP_ERROR HTTP 404"
  );

  assert.equal(logEntries.length, 1);
  assert.equal(logEntries[0]?.url, "https://images.example.com/missing.jpg");
  assert.equal(logEntries[0]?.statusCode, 404);
  assert.equal(logEntries[0]?.originalError, "REMOTE_HTTP_ERROR HTTP 404");
});

test("logs the original network error message", async () => {
  const logEntries: Array<Record<string, unknown>> = [];
  const socketError = new Error("socket disconnected");
  const fetchError = new TypeError("fetch failed", { cause: socketError });

  await assert.rejects(
    downloadRemoteImage("https://images.example.com/network-error.jpg", config, {
      validateUrl: async () => undefined,
      fetchImpl: asFetch(async () => {
        throw fetchError;
      }),
      logger: {
        error(bindings) {
          logEntries.push(bindings);
        }
      }
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "DOWNLOAD_FAILED" &&
      error.message.includes("socket disconnected")
  );

  assert.equal(logEntries.length, 1);
  assert.equal(logEntries[0]?.originalError, "socket disconnected");
  assert.equal(
    logEntries[0]?.url,
    "https://images.example.com/network-error.jpg"
  );
});

test("keeps the maximum download size limit", async () => {
  await assert.rejects(
    downloadRemoteImage(
      "https://images.example.com/large.jpg",
      { ...config, maxDownloadBytes: 4 },
      {
        validateUrl: async () => undefined,
        fetchImpl: asFetch(
          async () =>
            new Response(new Uint8Array([1, 2, 3, 4, 5]), {
              status: 200
            })
        )
      }
    ),
    (error: unknown) =>
      error instanceof AppError && error.code === "DOWNLOAD_TOO_LARGE"
  );
});

test("keeps the download timeout", async () => {
  await assert.rejects(
    downloadRemoteImage(
      "https://images.example.com/slow.jpg",
      { ...config, downloadTimeoutMs: 10 },
      {
        validateUrl: async () => undefined,
        fetchImpl: asFetch(
          async (_input, init) =>
            await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("The operation was aborted", "AbortError")),
                { once: true }
              );
            })
        )
      }
    ),
    (error: unknown) =>
      error instanceof AppError && error.code === "DOWNLOAD_TIMEOUT"
  );
});
