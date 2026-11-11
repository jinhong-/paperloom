/**
 * Tests for request signing and verification.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bodyDigest,
  canonicalString,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64,
  signRequest,
  verifyRequest,
} from "./signing.js";

const request = {
  method: "POST",
  path: "/api/device/sync",
  timestamp: 1_762_000_000_000,
  nonce: "abcdef0123456789",
  deviceId: "device-0001",
  body: Buffer.from('{"hello":"world"}'),
};

test("canonical string has the documented field order", () => {
  const canonical = canonicalString(request);
  assert.equal(
    canonical,
    [
      "POST",
      "/api/device/sync",
      "1762000000000",
      "abcdef0123456789",
      "device-0001",
      bodyDigest(request.body),
    ].join("\n"),
  );
});

test("a signature verifies against the matching public key", () => {
  const keys = generateKeyPair();
  const signature = signRequest(request, keys.privateKeyPem);
  assert.equal(
    verifyRequest(request, signature, keys.publicKeyPem),
    true,
  );
});

test("a signature does not verify against a different key", () => {
  const keys = generateKeyPair();
  const other = generateKeyPair();
  const signature = signRequest(request, keys.privateKeyPem);
  assert.equal(verifyRequest(request, signature, other.publicKeyPem), false);
});

test("tampering with the body invalidates the signature", () => {
  const keys = generateKeyPair();
  const signature = signRequest(request, keys.privateKeyPem);
  const tampered = { ...request, body: Buffer.from('{"hello":"there"}') };
  assert.equal(verifyRequest(tampered, signature, keys.publicKeyPem), false);
});

test("tampering with the path invalidates the signature", () => {
  const keys = generateKeyPair();
  const signature = signRequest(request, keys.privateKeyPem);
  const tampered = { ...request, path: "/api/device/other" };
  assert.equal(verifyRequest(tampered, signature, keys.publicKeyPem), false);
});

test("a signature from another device cannot be replayed under this device id", () => {
  const keys = generateKeyPair();
  const signature = signRequest(request, keys.privateKeyPem);
  const tampered = { ...request, deviceId: "device-0002" };
  assert.equal(verifyRequest(tampered, signature, keys.publicKeyPem), false);
});

test("public keys round-trip through the base64 raw-point form", () => {
  const keys = generateKeyPair();
  const base64 = publicKeyToBase64(keys.publicKeyPem);
  assert.equal(base64.length, 88); // 65 bytes, base64 encoded
  const restored = publicKeyFromBase64(base64);
  assert.equal(restored, keys.publicKeyPem);
});

test("a malformed public key is rejected", () => {
  assert.throws(() => publicKeyFromBase64("not-a-key"), /uncompressed P-256/);
});
