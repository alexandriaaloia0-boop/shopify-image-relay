import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { resolvePublicTarget } from "../security/url-validator.js";

const MAGIC_BYTES_LENGTH = 20;
const RESPONSE_PREVIEW_BYTES = 500;

interface CheckerDependencies {
  fetchImpl?: typeof fetch;
  validateUrl?: (url: URL) => Promise<unknown>;
}

export interface PublicImageCheck {
  url: string;
  httpStatus: number;
  contentType: string | null;
  contentLength: number | null;
  cacheControl: string | null;
  contentDisposition: string | null;
  magicBytes: number[];
  magicBytesHex: string;
  responsePreview: string | null;
  isJpeg: boolean;
}

function parseContentLength(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isJpegMagicBytes(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

async function readResponsePrefix(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (totalBytes < limit) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      const remaining = limit - totalBytes;
      const chunk = Buffer.from(value.subarray(0, remaining));
      chunks.push(chunk);
      totalBytes += chunk.length;

      if (value.byteLength > remaining || totalBytes >= limit) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

export async function checkPublicImage(
  rawUrl: string,
  config: Pick<AppConfig, "downloadTimeoutMs">,
  dependencies: CheckerDependencies = {}
): Promise<PublicImageCheck> {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError(400, "INVALID_URL", "url must be a valid absolute URL");
  }

  const validateUrl = dependencies.validateUrl ?? resolvePublicTarget;
  await validateUrl(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.downloadTimeoutMs);

  try {
    const response = await (dependencies.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "image/jpeg,image/*;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      },
      redirect: "manual",
      signal: controller.signal
    });

    const responsePrefix = await readResponsePrefix(response, RESPONSE_PREVIEW_BYTES);
    const firstBytes = responsePrefix.subarray(0, MAGIC_BYTES_LENGTH);
    const contentType = response.headers.get("content-type");
    const isSuccessfulJpeg =
      response.status === 200 &&
      contentType?.split(";", 1)[0]?.trim().toLowerCase() === "image/jpeg" &&
      isJpegMagicBytes(firstBytes);

    return {
      url: url.toString(),
      httpStatus: response.status,
      contentType,
      contentLength: parseContentLength(response.headers.get("content-length")),
      cacheControl: response.headers.get("cache-control"),
      contentDisposition: response.headers.get("content-disposition"),
      magicBytes: [...firstBytes],
      magicBytesHex: firstBytes.toString("hex"),
      responsePreview: isSuccessfulJpeg
        ? null
        : new TextDecoder("utf-8").decode(responsePrefix).slice(0, 500),
      isJpeg: isSuccessfulJpeg
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (controller.signal.aborted) {
      throw new AppError(
        504,
        "PUBLIC_IMAGE_CHECK_TIMEOUT",
        `Public image check exceeded ${config.downloadTimeoutMs}ms`,
        { cause: error }
      );
    }

    throw new AppError(
      502,
      "PUBLIC_IMAGE_CHECK_FAILED",
      `Could not fetch the public image URL: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  } finally {
    clearTimeout(timeout);
  }
}
