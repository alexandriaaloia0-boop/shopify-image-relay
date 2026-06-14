import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { resolvePublicTarget } from "../security/url-validator.js";

interface DownloadLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

interface DownloaderDependencies {
  fetchImpl?: typeof fetch;
  validateUrl?: (url: URL) => Promise<unknown>;
  logger?: DownloadLogger;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0",
  Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

function parseContentLength(response: Response): number | undefined {
  const rawValue = response.headers.get("content-length");

  if (!rawValue) {
    return undefined;
  }

  const value = Number(rawValue);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function getOriginalErrorMessage(error: unknown): string {
  let current = error;
  let message = error instanceof Error ? error.message : String(error);

  while (
    current instanceof Error &&
    "cause" in current &&
    current.cause !== undefined
  ) {
    current = current.cause;
    message = current instanceof Error ? current.message : String(current);
  }

  return message;
}

function logDownloadFailure(
  logger: DownloadLogger | undefined,
  url: URL,
  error: unknown,
  statusCode?: number
): void {
  logger?.error(
    {
      url: url.toString(),
      ...(statusCode !== undefined ? { statusCode } : {}),
      errorCode: error instanceof AppError ? error.code : "DOWNLOAD_FAILED",
      originalError: getOriginalErrorMessage(error)
    },
    "remote image download failed"
  );
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The original download error is more useful than a cleanup failure.
  }
}

async function readResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = parseContentLength(response);

  if (contentLength !== undefined && contentLength > maxBytes) {
    await cancelResponseBody(response);
    throw new AppError(
      413,
      "DOWNLOAD_TOO_LARGE",
      `Remote image exceeds the ${maxBytes} byte download limit`
    );
  }

  if (!response.body) {
    throw new AppError(422, "EMPTY_FILE", "Remote image response was empty");
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      receivedBytes += value.byteLength;

      if (receivedBytes > maxBytes) {
        await reader.cancel();
        throw new AppError(
          413,
          "DOWNLOAD_TOO_LARGE",
          `Remote image exceeds the ${maxBytes} byte download limit`
        );
      }

      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  if (receivedBytes === 0) {
    throw new AppError(422, "EMPTY_FILE", "Remote image response was empty");
  }

  return Buffer.concat(chunks, receivedBytes);
}

export async function downloadRemoteImage(
  rawUrl: string,
  config: Pick<
    AppConfig,
    "downloadTimeoutMs" | "maxDownloadBytes" | "maxRedirects"
  >,
  dependencies: DownloaderDependencies = {}
): Promise<Buffer> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const validateUrl = dependencies.validateUrl ?? resolvePublicTarget;
  let currentUrl: URL;

  try {
    currentUrl = new URL(rawUrl);
  } catch {
    throw new AppError(400, "INVALID_URL", "url must be a valid absolute URL");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.downloadTimeoutMs);

  try {
    for (let redirectCount = 0; redirectCount <= config.maxRedirects; redirectCount += 1) {
      try {
        await validateUrl(currentUrl);
      } catch (error) {
        logDownloadFailure(dependencies.logger, currentUrl, error);
        throw error;
      }

      let response: Response;

      try {
        response = await fetchImpl(currentUrl, {
          method: "GET",
          headers: REQUEST_HEADERS,
          redirect: "manual",
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted) {
          const timeoutError = new AppError(
            504,
            "DOWNLOAD_TIMEOUT",
            `Image download exceeded ${config.downloadTimeoutMs}ms`,
            { cause: error }
          );
          logDownloadFailure(dependencies.logger, currentUrl, timeoutError);
          throw timeoutError;
        }

        const downloadError = new AppError(
          502,
          "DOWNLOAD_FAILED",
          `Failed to download the remote image: ${getOriginalErrorMessage(error)}`,
          { cause: error }
        );
        logDownloadFailure(dependencies.logger, currentUrl, downloadError);
        throw downloadError;
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        await cancelResponseBody(response);

        if (!location) {
          const error = new AppError(
            502,
            "INVALID_REDIRECT",
            "Remote server returned an empty redirect"
          );
          logDownloadFailure(dependencies.logger, currentUrl, error, response.status);
          throw error;
        }

        if (redirectCount === config.maxRedirects) {
          const error = new AppError(
            502,
            "TOO_MANY_REDIRECTS",
            "Remote image returned too many redirects"
          );
          logDownloadFailure(dependencies.logger, currentUrl, error, response.status);
          throw error;
        }

        try {
          currentUrl = new URL(location, currentUrl);
        } catch (cause) {
          const error = new AppError(
            502,
            "INVALID_REDIRECT",
            "Remote server returned an invalid redirect URL",
            { cause }
          );
          logDownloadFailure(dependencies.logger, currentUrl, error, response.status);
          throw error;
        }

        continue;
      }

      if (!response.ok) {
        await cancelResponseBody(response);
        const error = new AppError(
          502,
          "REMOTE_HTTP_ERROR",
          `REMOTE_HTTP_ERROR HTTP ${response.status}`
        );
        logDownloadFailure(dependencies.logger, currentUrl, error, response.status);
        throw error;
      }

      try {
        return await readResponseBody(response, config.maxDownloadBytes);
      } catch (error) {
        if (controller.signal.aborted && !(error instanceof AppError)) {
          const timeoutError = new AppError(
            504,
            "DOWNLOAD_TIMEOUT",
            `Image download exceeded ${config.downloadTimeoutMs}ms`,
            { cause: error }
          );
          logDownloadFailure(dependencies.logger, currentUrl, timeoutError, response.status);
          throw timeoutError;
        }

        logDownloadFailure(dependencies.logger, currentUrl, error, response.status);
        throw error;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  throw new AppError(502, "DOWNLOAD_FAILED", "Failed to download the remote image");
}
