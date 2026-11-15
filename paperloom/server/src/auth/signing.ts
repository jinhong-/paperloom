/**
 * Device request signing.
 *
 * Devices authenticate with an asymmetric signature over a canonical
 * representation of the request, using an ECDSA P-256 key pair. The device
 * keeps the private key; the server stores only the public key.
 *
 * Why signing rather than mTLS: signing works through ordinary HTTPS
 * ingress (no proxy support for client certificates required), and it lets
 * the server attribute a request to a device without the device ever
 * transmitting a shared secret.
 *
 * ## Canonical string
 *
 * The signed payload is the concatenation of several newline-terminated
 * fields, in this exact order:
 *
 *     <method>\n
 *     <path>\n
 *     <timestamp>\n
 *     <nonce>\n
 *     <device_id>\n
 *     <sha256-hex of body>
 *
 * - `method` is upper-case (`GET`, `POST`).
 * - `path` is the request path **including** the query string, with the
 *   origin omitted. It is the exact path the client requested, so the
 *   server must reconstruct it identically. `req.url` in Fastify gives
 *   path plus query, which is what we want.
 * - `timestamp` is a Unix timestamp in milliseconds.
 * - `nonce` is a unique-per-request random string. It is the replay guard.
 * - `device_id` binds the signature to one device, so a signature captured
 *   from device A cannot be replayed as device B.
 * - the body digest is the hex SHA-256 of the raw request body, or the
 *   digest of the empty string for a body-less request.
 *
 * ## Headers
 *
 *     X-Paperloom-Device: <device_id>
 *     X-Paperloom-Timestamp: <unix ms>
 *     X-Paperloom-Nonce: <random>
 *     X-Paperloom-Signature: <base64url of DER-encoded ECDSA signature>
 *
 * The signature is over the canonical string above, so the headers are
 * redundant with the signed content but convenient for the server to locate
 * and bound the request.
 *
 * ## Replay defence
 *
 * The server rejects a request whose timestamp is outside a ±5 minute
 * window, and records each nonce for longer than that window. A nonce that
 * has been seen is rejected even if the signature is valid.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

/** Header carrying the device identifier. */
export const HEADER_DEVICE = "x-paperloom-device";
/** Header carrying the request timestamp in Unix milliseconds. */
export const HEADER_TIMESTAMP = "x-paperloom-timestamp";
/** Header carrying the anti-replay nonce. */
export const HEADER_NONCE = "x-paperloom-nonce";
/** Header carrying the base64url DER-encoded ECDSA signature. */
export const HEADER_SIGNATURE = "x-paperloom-signature";

/** Maximum clock skew tolerated on a signed request, in milliseconds. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * How long a seen nonce is remembered, in milliseconds.
 *
 * Must exceed the accepted clock-skew window, otherwise a nonce could expire
 * while a captured request would still be inside the window and be replayed.
 */
export const NONCE_TTL_MS = MAX_CLOCK_SKEW_MS * 2;

export interface SignedRequestInput {
  readonly method: string;
  /** Path including query string, origin omitted. */
  readonly path: string;
  readonly timestamp: number;
  readonly nonce: string;
  readonly deviceId: string;
  readonly body: Buffer;
}

/**
 * Build the canonical string that gets signed.
 *
 * Exported so that the firmware port and the tests can assert the exact
 * same bytes.
 */
export function canonicalString(input: SignedRequestInput): string {
  const digest = createHash("sha256").update(input.body).digest("hex");
  return [
    input.method.toUpperCase(),
    input.path,
    String(input.timestamp),
    input.nonce,
    input.deviceId,
    digest,
  ].join("\n");
}

/**
 * Compute the SHA-256 hex digest of a body.
 */
export function bodyDigest(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Sign a request with an ECDSA P-256 private key.
 *
 * @returns The base64url-encoded DER signature.
 */
export function signRequest(input: SignedRequestInput, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  const canonical = canonicalString(input);
  const signature = sign("sha256", Buffer.from(canonical, "utf8"), {
    key,
    dsaEncoding: "der",
  });
  return Buffer.from(signature).toString("base64url");
}

/**
 * Verify a request signature against a known public key.
 *
 * @returns `true` if the signature is valid for the given canonical string.
 */
export function verifyRequest(
  input: SignedRequestInput,
  signatureBase64url: string,
  publicKeyPem: string,
): boolean {
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureBase64url, "base64url");
  } catch {
    return false;
  }
  if (signature.length === 0) return false;

  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return false;
  }

  const canonical = canonicalString(input);
  return verify("sha256", Buffer.from(canonical, "utf8"), {
    key,
    dsaEncoding: "der",
  }, signature);
}

/**
 * A P-256 key pair in PEM form.
 */
export interface KeyPair {
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  /** Base64 of the raw uncompressed public point (65 bytes). */
  readonly publicKeyBase64: string;
}

/**
 * Generate a new P-256 key pair for a device.
 */
export function generateKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  return {
    privateKeyPem,
    publicKeyPem,
    publicKeyBase64: publicKeyToBase64(publicKeyPem),
  };
}

/**
 * Convert a public key to the base64 raw-point form stored in the database.
 */
export function publicKeyToBase64(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  const der = key.export({ type: "spki", format: "der" }) as Buffer;
  // The SPKI DER for P-256 ends with the 65-byte uncompressed point; strip
  // the fixed 26-byte header to get the raw point.
  const raw = der.subarray(der.length - 65);
  return raw.toString("base64");
}

/**
 * Rebuild a PEM public key from the base64 raw-point form.
 */
export function publicKeyFromBase64(base64: string): string {
  const raw = Buffer.from(base64, "base64");
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error("expected a 65-byte uncompressed P-256 public point");
  }
  // SPKI prefix for id-ecPublicKey + prime256v1.
  const prefix = Buffer.from(
    "3059301306072a8648ce3d020106082a8648ce3d030107034200",
    "hex",
  );
  return createPublicKey({
    key: Buffer.concat([prefix, raw]),
    format: "der",
    type: "spki",
  }).export({ type: "spki", format: "pem" }) as string;
}
