import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import {
  resolvePublicTarget,
  type ResolvedTarget
} from "../security/url-validator.js";

interface DownloadResponse {
  kind: "image";
  buffer: Buffer;
}

interface RedirectResponse {
  kind: "redirect";
  location: string;
}

type RequestResult = DownloadResponse | RedirectResponse;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function parseContentLength(headers: IncomingHttpHeaders): number | undefined {
  const rawValue = headers["content-length"];

  if (!rawValue) {
    return undefined;
  }

  const value = Number(Array.isArray(rawValue) ? rawValue[0] : rawValue);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function requestOnce(
  url: URL,
  target: ResolvedTarget,
  timeoutMs: number,
  maxBytes: number
): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const lookup: LookupFunction = (_hostname, _options, callback) => {
      callback(null, target.address, target.family);
    };

    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: RequestResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      reject(
        error instanceof AppError
          ? error
          : new AppError(502, "DOWNLOAD_FAILED", "Failed to download the remote image", {
              cause: error
            })
      );
    };

    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        lookup,
        headers: {
          Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
          "Accept-Encoding": "identity",
          "User-Agent": "ShopifyImageRelay/1.0"
        },
        ...(url.port ? { port: url.port } : {})
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;

        if (REDIRECT_STATUSES.has(statusCode)) {
          const location = response.headers.location;
          response.resume();

          if (!location) {
            fail(new AppError(502, "INVALID_REDIRECT", "Remote server returned an empty redirect"));
            return;
          }

          finish({ kind: "redirect", location });
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          fail(
            new AppError(
              502,
              "REMOTE_HTTP_ERROR",
              `Remote image server returned HTTP ${statusCode}`
            )
          );
          return;
        }

        const contentLength = parseContentLength(response.headers);

        if (contentLength !== undefined && contentLength > maxBytes) {
          response.resume();
          fail(
            new AppError(
              413,
              "DOWNLOAD_TOO_LARGE",
              `Remote image exceeds the ${maxBytes} byte download limit`
            )
          );
          return;
        }

        const chunks: Buffer[] = [];
        let receivedBytes = 0;

        response.on("data", (chunk: Buffer) => {
          receivedBytes += chunk.length;

          if (receivedBytes > maxBytes) {
            response.destroy();
            fail(
              new AppError(
                413,
                "DOWNLOAD_TOO_LARGE",
                `Remote image exceeds the ${maxBytes} byte download limit`
              )
            );
            return;
          }

          chunks.push(chunk);
        });

        response.on("end", () => {
          if (receivedBytes === 0) {
            fail(new AppError(422, "EMPTY_FILE", "Remote image response was empty"));
            return;
          }

          finish({ kind: "image", buffer: Buffer.concat(chunks, receivedBytes) });
        });

        response.on("error", fail);
      }
    );

    timer = setTimeout(() => {
      request.destroy(
        new AppError(504, "DOWNLOAD_TIMEOUT", `Image download exceeded ${timeoutMs}ms`)
      );
    }, timeoutMs);

    request.on("error", fail);
    request.end();
  });
}

export async function downloadRemoteImage(
  rawUrl: string,
  config: Pick<
    AppConfig,
    "downloadTimeoutMs" | "maxDownloadBytes" | "maxRedirects"
  >
): Promise<Buffer> {
  let currentUrl: URL;

  try {
    currentUrl = new URL(rawUrl);
  } catch {
    throw new AppError(400, "INVALID_URL", "url must be a valid absolute URL");
  }

  for (let redirectCount = 0; redirectCount <= config.maxRedirects; redirectCount += 1) {
    const target = await resolvePublicTarget(currentUrl);
    const result = await requestOnce(
      currentUrl,
      target,
      config.downloadTimeoutMs,
      config.maxDownloadBytes
    );

    if (result.kind === "image") {
      return result.buffer;
    }

    if (redirectCount === config.maxRedirects) {
      throw new AppError(502, "TOO_MANY_REDIRECTS", "Remote image returned too many redirects");
    }

    try {
      currentUrl = new URL(result.location, currentUrl);
    } catch {
      throw new AppError(502, "INVALID_REDIRECT", "Remote server returned an invalid redirect URL");
    }
  }

  throw new AppError(502, "DOWNLOAD_FAILED", "Failed to download the remote image");
}
