import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { AppError } from "../errors.js";
import type { ProcessedImage } from "../types.js";

interface ProcessingOptions {
  maxOutputBytes: number;
  maxInputPixels: number;
}

interface EncodingProfile {
  maxDimension: number;
  quality: number;
}

const ENCODING_PROFILES: EncodingProfile[] = [
  { maxDimension: 2048, quality: 82 },
  { maxDimension: 2048, quality: 76 },
  { maxDimension: 2048, quality: 68 },
  { maxDimension: 1920, quality: 68 },
  { maxDimension: 1600, quality: 64 },
  { maxDimension: 1400, quality: 58 },
  { maxDimension: 1200, quality: 52 },
  { maxDimension: 1024, quality: 45 }
];

async function encodeJpeg(
  input: Buffer,
  profile: EncodingProfile,
  maxInputPixels: number
): Promise<{ data: Buffer; width: number; height: number; bytes: number }> {
  const result = await sharp(input, {
    failOn: "error",
    limitInputPixels: maxInputPixels,
    animated: false
  })
    .rotate()
    .resize({
      width: profile.maxDimension,
      height: profile.maxDimension,
      fit: "inside",
      withoutEnlargement: true
    })
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .jpeg({
      quality: profile.quality,
      mozjpeg: true,
      chromaSubsampling: "4:2:0"
    })
    .toBuffer({ resolveWithObject: true });

  if (!result.info.width || !result.info.height) {
    throw new AppError(422, "IMAGE_PROCESSING_FAILED", "Could not determine output dimensions");
  }

  return {
    data: result.data,
    width: result.info.width,
    height: result.info.height,
    bytes: result.info.size
  };
}

export async function processImage(
  input: Buffer,
  options: ProcessingOptions
): Promise<ProcessedImage> {
  const detected = await fileTypeFromBuffer(input);

  if (!detected || !detected.mime.startsWith("image/")) {
    throw new AppError(415, "UNSUPPORTED_IMAGE", "Downloaded content is not a recognized image");
  }

  let lastResult:
    | { data: Buffer; width: number; height: number; bytes: number }
    | undefined;

  try {
    for (const profile of ENCODING_PROFILES) {
      lastResult = await encodeJpeg(input, profile, options.maxInputPixels);

      if (lastResult.bytes <= options.maxOutputBytes) {
        return {
          buffer: lastResult.data,
          format: "jpeg",
          width: lastResult.width,
          height: lastResult.height,
          bytes: lastResult.bytes,
          sha256: createHash("sha256").update(lastResult.data).digest("hex")
        };
      }
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(
      422,
      "IMAGE_PROCESSING_FAILED",
      `The detected ${detected.ext} image could not be decoded`,
      { cause: error }
    );
  }

  throw new AppError(
    422,
    "OUTPUT_TOO_LARGE",
    `Image could not be compressed below ${options.maxOutputBytes} bytes`
  );
}
