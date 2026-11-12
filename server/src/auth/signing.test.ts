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

/**
 * The DER encoding the firmware produces.
 *
 * The firmware signs with mbedTLS and encodes the raw `r || s` pair into
 * DER itself, because the PSA signing path does not work on this chip.
 * This is a transcription of that encoder, kept here so that the exact
 * bytes it produces are pinned by a test.
 *
 * The bug this guards against: the length byte of each INTEGER must count
 * the value bytes only. Writing `value_length - 1` produces a DER
 * structure whose declared length is one byte short, which every
 * conforming parser rejects.
 */
function firmwareRawToDer(raw: Buffer): Buffer {
  const scalarLength = 32;
  const rValueLength = (raw[0]! & 0x80) !== 0 ? scalarLength + 1 : scalarLength;
  const sValueLength = (raw[scalarLength]! & 0x80) !== 0 ? scalarLength + 1 : scalarLength;
  const contentsLength = (2 + rValueLength) + (2 + sValueLength);

  const out = Buffer.alloc(2 + contentsLength);
  let offset = 0;
  out[offset++] = 0x30;
  out[offset++] = contentsLength;

  for (let which = 0; which < 2; which++) {
    const value = raw.subarray(which === 0 ? 0 : scalarLength);
    const valueLength = which === 0 ? rValueLength : sValueLength;
    out[offset++] = 0x02;
    out[offset++] = valueLength;
    if (valueLength > scalarLength) {
      out[offset++] = 0x00;
    }
    value.copy(out, offset);
    offset += scalarLength;
  }

  return out.subarray(0, offset);
}

/**
 * Split a DER signature into its two integers.
 *
 * Each integer is a tag, a length, and the value. The value may carry a
 * leading sign byte, which is stripped so that the result is a plain
 * big-endian number of at most 32 bytes.
 */
function derToRaw(der: Buffer): Buffer {
  const raw = Buffer.alloc(64);

  let offset = 2; // past the SEQUENCE header
  for (let which = 0; which < 2; which++) {
    assert.equal(der[offset], 0x02, "expected an INTEGER");
    const length = der[offset + 1]!;
    let value = der.subarray(offset + 2, offset + 2 + length);

    // Strip the sign byte if there is one.
    if (value.length === 33 && value[0] === 0x00) {
      value = value.subarray(1);
    }

    value.copy(raw, which === 0 ? 32 - value.length : 64 - value.length);
    offset += 2 + length;
  }

  return raw;
}

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

test("the firmware's DER encoding matches a conforming encoder", () => {
  const keys = generateKeyPair();
  const signature = signRequest(request, keys.privateKeyPem);

  // Recover the raw r and s from the conforming signature, then encode
  // them the way the firmware does.
  const der = Buffer.from(signature, "base64url");
  const raw = derToRaw(der);
  const firmwareDer = firmwareRawToDer(raw);

  assert.deepEqual(firmwareDer, der);
});

test("the firmware's DER encoding verifies against the public key", () => {
  const keys = generateKeyPair();
  const signature = signRequest(request, keys.privateKeyPem);
  const raw = derToRaw(Buffer.from(signature, "base64url"));
  const firmwareDer = firmwareRawToDer(raw);

  // The verifier the server uses has to accept the firmware's encoding.
  assert.equal(
    verifyRequest(request, firmwareDer.toString("base64url"), keys.publicKeyPem),
    true,
  );
});

test("a DER integer length counts the value bytes, not one fewer", () => {
  // A signature whose r has the high bit set needs a leading zero byte,
  // so the integer is 33 bytes long and the length byte must be 33.
  const raw = Buffer.alloc(64);
  raw[0] = 0x80; // high bit set: r needs a sign byte
  raw[32] = 0x00;
  raw[33] = 0x01; // high bit clear: s needs no sign byte

  const der = firmwareRawToDer(raw);

  assert.equal(der[0], 0x30); // SEQUENCE
  assert.equal(der[2], 0x02); // INTEGER
  assert.equal(der[3], 33); // the length is the value length
  assert.equal(der[4], 0x00); // the sign byte

  // The first integer occupies a tag, a length, and 33 value bytes, so
  // the second one starts at offset 2 + 2 + 33.
  const secondInteger = 2 + 2 + 33;
  assert.equal(der[secondInteger], 0x02);
  assert.equal(der[secondInteger + 1], 32); // s has no sign byte
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
