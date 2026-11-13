/**
 * Verifying a signed device request.
 *
 * Every request a device makes apart from asking for the time carries a
 * signature over the method, path, timestamp, nonce, device id and the
 * SHA-256 of the body bytes. The verification lives here because both the
 * device API and the enrolment API need it.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

import {
  HEADER_DEVICE,
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  MAX_CLOCK_SKEW_MS,
  NONCE_TTL_MS,
  publicKeyFromBase64,
  verifyRequest,
} from "../auth/signing.js";
import type { Db } from "../db/index.js";

/**
 * The device a request came from.
 */
export interface VerifiedDevice {
  readonly id: number;
  readonly deviceId: string;
  readonly state: string;
  readonly claimCode: string | null;
}

/**
 * Check the signature headers and the device's public key.
 *
 * The device must be known and must have a usable public key. Whether it
 * is allowed to make the request it is making is up to the caller: a
 * device that is waiting to be claimed may poll for its status, but it
 * may not sync.
 *
 * @param requireClaimed Whether only a claimed device is allowed.
 */
export async function verifyDeviceRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  db: Db,
  options: { readonly requireClaimed: boolean },
): Promise<VerifiedDevice | null> {
  const deviceId = request.headers[HEADER_DEVICE];
  const timestampHeader = request.headers[HEADER_TIMESTAMP];
  const nonce = request.headers[HEADER_NONCE];
  const signature = request.headers[HEADER_SIGNATURE];

  if (
    typeof deviceId !== "string" ||
    typeof timestampHeader !== "string" ||
    typeof nonce !== "string" ||
    typeof signature !== "string"
  ) {
    await reply.code(401).send({ error: "missing signature headers" });
    return null;
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    await reply.code(401).send({ error: "invalid timestamp" });
    return null;
  }

  const skew = Math.abs(Date.now() - timestamp);
  if (skew > MAX_CLOCK_SKEW_MS) {
    request.log.warn(
      { deviceId, timestamp, now: Date.now(), skew },
      "the request timestamp is outside the accepted window",
    );
    await reply.code(401).send({ error: "timestamp outside accepted window" });
    return null;
  }

  const device = db
    .prepare(
      "SELECT id, device_id, public_key, state, claim_code FROM devices WHERE device_id = ?",
    )
    .get(deviceId) as
    | {
        id: number;
        device_id: string;
        public_key: string | null;
        state: string;
        claim_code: string | null;
      }
    | undefined;

  if (!device || !device.public_key) {
    request.log.warn(
      { deviceId, state: device?.state ?? "(unknown)", hasKey: !!device?.public_key },
      "the device is not allowed to sync",
    );
    await reply.code(401).send({ error: "unknown device" });
    return null;
  }

  if (options.requireClaimed && device.state !== "claimed") {
    request.log.warn({ deviceId, state: device.state }, "the device is not allowed to sync");
    await reply.code(401).send({ error: "unknown or unclaimed device" });
    return null;
  }

  let publicKeyPem: string;
  try {
    publicKeyPem = publicKeyFromBase64(device.public_key);
  } catch {
    await reply.code(401).send({ error: "device has an unusable public key" });
    return null;
  }

  const body = request.rawBody ?? Buffer.alloc(0);
  const path = request.url;

  const valid = verifyRequest(
    { method: request.method, path, timestamp, nonce, deviceId, body },
    signature,
    publicKeyPem,
  );
  if (!valid) {
    request.log.warn(
      { deviceId, timestamp, nonce, path },
      "the request signature is not valid",
    );
    await reply.code(401).send({ error: "invalid signature" });
    return null;
  }

  // Replay defence: a nonce may be used only once.
  //
  // The lookup and the insert are done in one transaction so that two
  // concurrent requests carrying the same nonce cannot both pass the
  // check.
  const claimNonce = db.transaction((id: number, value: string): boolean => {
    const seen = db
      .prepare("SELECT 1 FROM request_nonces WHERE device_id = ? AND nonce = ?")
      .get(id, value);
    if (seen) return false;
    db.prepare("INSERT INTO request_nonces (device_id, nonce) VALUES (?, ?)").run(id, value);
    return true;
  });

  if (!claimNonce(device.id, nonce)) {
    await reply.code(401).send({ error: "nonce already used" });
    return null;
  }

  // Housekeeping: drop nonces that can no longer be replayed.
  //
  // The cutoff is written in the same ISO-8601 format the column uses.
  // SQLite's `datetime('now')` produces "YYYY-MM-DD HH:MM:SS" (a space,
  // no timezone), which does not sort correctly against an ISO string.
  db.prepare("DELETE FROM request_nonces WHERE seen_at < ?").run(
    new Date(Date.now() - NONCE_TTL_MS).toISOString(),
  );

  return {
    id: device.id,
    deviceId: device.device_id,
    state: device.state,
    claimCode: device.claim_code,
  };
}
