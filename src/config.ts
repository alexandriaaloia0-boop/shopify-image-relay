import { AppError } from "./errors.js";

export interface AppConfig {
  nodeEnv: string;
  host: string;
  port: number;
  apiKey: string;
  storage: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    publicBaseUrl: string;
  };
  downloadTimeoutMs: number;
  maxDownloadBytes: number;
  maxOutputBytes: number;
  maxRedirects: number;
  maxInputPixels: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new AppError(500, "CONFIG_ERROR", `Missing required environment variable: ${name}`);
  }

  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const rawValue = process.env[name]?.trim();

  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AppError(500, "CONFIG_ERROR", `${name} must be a positive integer`);
  }

  return value;
}

function normalizeHttpUrl(name: string, value: string): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new AppError(500, "CONFIG_ERROR", `${name} must be a valid URL`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new AppError(500, "CONFIG_ERROR", `${name} must use http or https`);
  }

  return value.replace(/\/+$/, "");
}

function normalizePublicBaseUrl(value: string, bucket: string): string {
  const normalized = normalizeHttpUrl("WASABI_PUBLIC_BASE_URL", value);
  const parsed = new URL(normalized);

  if (parsed.hostname.endsWith(".wasabisys.com")) {
    const segments = parsed.pathname.split("/").filter(Boolean);

    if (segments.length === 0) {
      segments.push(bucket);
    } else if (segments.at(-1) !== bucket) {
      throw new AppError(
        500,
        "CONFIG_ERROR",
        `WASABI_PUBLIC_BASE_URL must end with /${bucket} for a Wasabi service URL`
      );
    }

    parsed.pathname = `/${segments.join("/")}`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  }

  return normalized;
}

export function loadConfig(): AppConfig {
  const apiKey = required("API_KEY");
  const bucket = required("WASABI_BUCKET");

  if (apiKey.length < 16) {
    throw new AppError(500, "CONFIG_ERROR", "API_KEY must contain at least 16 characters");
  }

  return {
    nodeEnv: process.env.NODE_ENV?.trim() || "development",
    host: process.env.HOST?.trim() || "0.0.0.0",
    port: positiveInteger("PORT", 3000),
    apiKey,
    storage: {
      endpoint: normalizeHttpUrl("WASABI_ENDPOINT", required("WASABI_ENDPOINT")),
      region: required("WASABI_REGION"),
      accessKeyId: required("WASABI_ACCESS_KEY_ID"),
      secretAccessKey: required("WASABI_SECRET_ACCESS_KEY"),
      bucket,
      publicBaseUrl: normalizePublicBaseUrl(required("WASABI_PUBLIC_BASE_URL"), bucket)
    },
    downloadTimeoutMs: positiveInteger("DOWNLOAD_TIMEOUT_MS", 15_000),
    maxDownloadBytes: positiveInteger("MAX_DOWNLOAD_BYTES", 15 * 1024 * 1024),
    maxOutputBytes: positiveInteger("MAX_OUTPUT_BYTES", 5 * 1024 * 1024),
    maxRedirects: positiveInteger("MAX_REDIRECTS", 5),
    maxInputPixels: positiveInteger("MAX_INPUT_PIXELS", 40_000_000)
  };
}
