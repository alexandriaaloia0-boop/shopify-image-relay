import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import ipaddr from "ipaddr.js";
import { AppError } from "../errors.js";

export interface ResolvedTarget {
  address: string;
  family: 4 | 6;
}

function normalizeIp(address: string): ipaddr.IPv4 | ipaddr.IPv6 {
  const parsed = ipaddr.parse(address);

  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    return parsed.toIPv4Address();
  }

  return parsed;
}

export function isPublicIp(address: string): boolean {
  try {
    return normalizeIp(address).range() === "unicast";
  } catch {
    return false;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export async function resolvePublicTarget(url: URL): Promise<ResolvedTarget> {
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new AppError(400, "INVALID_URL", "Only http and https image URLs are allowed");
  }

  if (url.username || url.password) {
    throw new AppError(400, "INVALID_URL", "Image URLs must not contain credentials");
  }

  const hostname = normalizeHostname(url.hostname).toLowerCase();

  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new AppError(400, "BLOCKED_URL", "Local and private network addresses are not allowed");
  }

  if (ipaddr.isValid(hostname)) {
    if (!isPublicIp(hostname)) {
      throw new AppError(400, "BLOCKED_URL", "Local and private network addresses are not allowed");
    }

    const parsed = normalizeIp(hostname);
    return {
      address: parsed.toString(),
      family: parsed.kind() === "ipv4" ? 4 : 6
    };
  }

  let records: LookupAddress[];

  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new AppError(502, "DNS_LOOKUP_FAILED", "Could not resolve the image host", {
      cause: error
    });
  }

  if (records.length === 0 || records.some((record) => !isPublicIp(record.address))) {
    throw new AppError(400, "BLOCKED_URL", "Local and private network addresses are not allowed");
  }

  const preferred = records.find((record) => record.family === 4) ?? records[0];

  if (!preferred || (preferred.family !== 4 && preferred.family !== 6)) {
    throw new AppError(502, "DNS_LOOKUP_FAILED", "Could not resolve a usable image host address");
  }

  return {
    address: preferred.address,
    family: preferred.family
  };
}
