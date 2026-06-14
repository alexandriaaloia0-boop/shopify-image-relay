import assert from "node:assert/strict";
import test from "node:test";
import { isPublicIp, resolvePublicTarget } from "../src/security/url-validator.js";

test("accepts ordinary public IP addresses", () => {
  assert.equal(isPublicIp("1.1.1.1"), true);
  assert.equal(isPublicIp("8.8.8.8"), true);
  assert.equal(isPublicIp("2606:4700:4700::1111"), true);
});

test("rejects loopback, private, link-local, and carrier-grade NAT addresses", () => {
  const blocked = [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.1.1",
    "100.64.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1"
  ];

  for (const address of blocked) {
    assert.equal(isPublicIp(address), false, `${address} should be blocked`);
  }
});

test("blocks localhost before making a network request", async () => {
  await assert.rejects(
    resolvePublicTarget(new URL("http://localhost/image.jpg")),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "BLOCKED_URL"
  );
});
