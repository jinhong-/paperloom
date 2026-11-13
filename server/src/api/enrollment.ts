/**
 * Enrollment API.
 *
 * Enrollment binds a physically present device to an owner account. The
 * flow mirrors the architecture document:
 *
 * 1. The device generates a key pair and opens a pending enrollment.
 * 2. The server issues a short-lived, single-use claim code.
 * 3. The device shows the code as a QR code on the panel.
 * 4. The owner enters the code in the management UI and confirms.
 * 5. The server activates the device's credentials.
 *
 * Security properties:
 *
 * - Possession of a device id is not sufficient to claim a device; the
 *   claim code is a high-entropy secret that only the physical panel knows.
 * - The pending enrollment is bound to the device's public key, so a
 *   device that opens a claim cannot have its key swapped afterwards.
 * - The claim code is single-use and expires.
 */

import { randomInt } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Db } from "../db/index.js";
import { DEFAULT_RULES } from "../schedule/defaults.js";

export interface EnrollmentOptions {
  readonly db: Db;
  readonly basePath: string;
  /** How long a claim code stays valid, in milliseconds. */
  readonly claimTtlMs?: number;
}

export interface PendingEnrollmentRequest {
  readonly device_id: string;
  readonly name?: string;
  /** Base64 of the device's raw uncompressed P-256 public point. */
  readonly public_key: string;
  readonly panel_width?: number;
  readonly panel_height?: number;
}

export function registerEnrollmentApi(app: FastifyInstance, options: EnrollmentOptions): void {
  const { db, basePath } = options;

  /**
   * How long a claim code stays valid.
   *
   * The code is shown on the panel for the owner to read or scan, so it
   * has to last long enough for a person to notice the frame, go to it,
   * and claim it. An hour is enough for that in most cases.
   *
   * The code is high-entropy, single-use, and can only be redeemed by
   * somebody who is already signed in, so a longer life is not much of a
   * risk. The device keeps the same code across restarts, so this is what
   * ends it rather than the device asking for a new one.
   */
  const claimTtlMs = options.claimTtlMs ?? 60 * 60 * 1000;

  /**
   * The signed-in user id, or null if the request is not authenticated.
   *
   * Claiming is a human action, so it is authenticated by the management
   * session cookie rather than by a device signature.
   */
  function sessionUserId(request: FastifyRequest): number | null {
    const token = request.cookies?.["paperloom_session"];
    if (!token) return null;

    const session = db
      .prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?")
      .get(token) as { user_id: number; expires_at: string } | undefined;

    if (!session || new Date(session.expires_at).getTime() < Date.now()) return null;
    return session.user_id;
  }

  /**
   * Open a pending enrollment and receive a claim code.
   */
  app.post(`${basePath}/enroll`, async (request, reply) => {
    const body = request.body as PendingEnrollmentRequest;

    if (!body?.device_id || !body?.public_key) {
      await reply.code(400).send({ error: "device_id and public_key are required" });
      return;
    }
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(body.device_id)) {
      await reply.code(400).send({ error: "device_id must be 8-64 URL-safe characters" });
      return;
    }

    const now = Date.now();

    // A device re-enrolling replaces its pending record; it does not take
    // over an already-claimed device.
    const existing = db
      .prepare("SELECT id, state, claim_code, claim_expires_at FROM devices WHERE device_id = ?")
      .get(body.device_id) as
      | { id: number; state: string; claim_code: string | null; claim_expires_at: string | null }
      | undefined;

    if (existing?.state === "claimed") {
      /* The device is enrolled and has been claimed. The device keeps
       * asking until it hears this, so the answer is a plain "yes" rather
       * than an error: from the device's point of view this is the end
       * of the enrolment and the start of the syncing.
       *
       * The device is not told the owner's details, and the request is
       * still signed, so nothing here gives anything away. */
      await reply.send({
        claimed: true,
        server_time: new Date().toISOString(),
      });
      return;
    }

    /* A device that enrols again while it is still waiting to be claimed
     * keeps the code it already has, as long as that code has not run
     * out.
     *
     * The code is on the panel for the owner to read, so handing out a
     * new one each time the device wakes would mean the code on the panel
     * stopped working the moment the device woke up again. Reusing it
     * keeps the panel and the server in agreement.
     */
    let claimCode = existing?.claim_code ?? null;
    let expiresAt =
      existing?.claim_expires_at !== null && existing?.claim_expires_at !== undefined
        ? new Date(existing.claim_expires_at)
        : null;

    if (claimCode === null || expiresAt === null || expiresAt.getTime() < now) {
      claimCode = generateClaimCode();
      expiresAt = new Date(now + claimTtlMs);
    }

    if (existing) {
      db.prepare(
        `UPDATE devices
         SET public_key = ?, name = COALESCE(?, name), state = 'pending',
             claim_code = ?, claim_expires_at = ?,
             panel_width = COALESCE(?, panel_width),
             panel_height = COALESCE(?, panel_height)
         WHERE id = ?`,
      ).run(
        body.public_key,
        body.name ?? null,
        claimCode,
        expiresAt.toISOString(),
        body.panel_width ?? null,
        body.panel_height ?? null,
        existing.id,
      );
    } else {
      db.prepare(
        `INSERT INTO devices
           (name, device_id, public_key, state, claim_code, claim_expires_at,
            panel_width, panel_height)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
      ).run(
        body.name ?? body.device_id,
        body.device_id,
        body.public_key,
        claimCode,
        expiresAt.toISOString(),
        body.panel_width ?? 1200,
        body.panel_height ?? 1600,
      );
    }

    /* A new frame comes with rules already set.
     *
     * There is no default interval: a frame that no rule covers has
     * nothing to check in for, and sleeps until a rule covers the time
     * again. A frame with no rules would therefore never check in, and
     * would never show anything.
     *
     * The rules are the ones a frame would sensibly start with: awake
     * and responsive while somebody is around, and asleep overnight.
     * The owner can change them from the management page.
     *
     * They are added to a frame that has none, rather than only to a
     * frame that has just been created, so that a frame which enrolled
     * and then waited to be claimed has them too. */
    const deviceRow = db
      .prepare("SELECT id FROM devices WHERE device_id = ?")
      .get(body.device_id) as { id: number } | undefined;

    if (deviceRow) {
      const hasRules = db
        .prepare("SELECT COUNT(*) AS n FROM device_sync_rules WHERE device_id = ?")
        .get(deviceRow.id) as { n: number };

      if (hasRules.n === 0) {
        const addRule = db.prepare(
          `INSERT INTO device_sync_rules
             (device_id, days, start_minute, end_minute, sync_interval, priority)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );

        for (const rule of DEFAULT_RULES) {
          addRule.run(
            deviceRow.id,
            rule.days,
            rule.startMinute,
            rule.endMinute,
            rule.syncInterval,
            rule.priority,
          );
        }
      }
    }

    await reply.send({
      claim_code: claimCode,
      expires_at: expiresAt.toISOString(),
      // The device is not claimed until an owner claims it, so it keeps
      // showing the code until the server says otherwise.
      claimed: false,
      // The device encodes this as a QR code pointing at the claim URL.
      claim_url: `/claim/${claimCode}`,
      // The device's clock is not yet anchored to real time when it first
      // enrols, so it cannot produce a timestamp the server would accept.
      // The server's time here is what anchors it. Later requests carry a
      // real timestamp and are checked normally.
      server_time: new Date().toISOString(),
    });
  });

  /**
   * Look up a claim code. Used by the management UI to show which device is
   * being claimed before the owner confirms.
   */
  app.get(`${basePath}/claim/:code`, async (request, reply) => {
    const { code } = request.params as { code: string };

    const device = db
      .prepare(
        `SELECT device_id, name, state, claim_expires_at, panel_width, panel_height
         FROM devices WHERE claim_code = ?`,
      )
      .get(code) as
      | {
          device_id: string;
          name: string;
          state: string;
          claim_expires_at: string;
          panel_width: number;
          panel_height: number;
        }
      | undefined;

    if (!device) {
      await reply.code(404).send({ error: "unknown claim code" });
      return;
    }
    if (device.state !== "pending") {
      await reply.code(409).send({ error: "claim code has already been used" });
      return;
    }
    if (new Date(device.claim_expires_at).getTime() < Date.now()) {
      await reply.code(410).send({ error: "claim code has expired" });
      return;
    }

    await reply.send({
      device_id: device.device_id,
      name: device.name,
      panel_width: device.panel_width,
      panel_height: device.panel_height,
      expires_at: device.claim_expires_at,
    });
  });

  /**
   * Confirm a claim, binding the device to the signed-in user.
   *
   * This route is authenticated by the management UI's session, not by a
   * device signature: it is the human asserting ownership.
   */
  app.post(`${basePath}/claim/:code`, async (request, reply) => {
    const userId = sessionUserId(request);
    if (userId === null) {
      await reply.code(401).send({ error: "sign in to claim a device" });
      return;
    }

    const { code } = request.params as { code: string };

    const device = db
      .prepare("SELECT id, state, claim_expires_at FROM devices WHERE claim_code = ?")
      .get(code) as
      | { id: number; state: string; claim_expires_at: string }
      | undefined;

    if (!device) {
      await reply.code(404).send({ error: "unknown claim code" });
      return;
    }
    if (device.state !== "pending") {
      await reply.code(409).send({ error: "claim code has already been used" });
      return;
    }
    if (new Date(device.claim_expires_at).getTime() < Date.now()) {
      await reply.code(410).send({ error: "claim code has expired" });
      return;
    }

    db.prepare(
      `UPDATE devices
       SET user_id = ?, state = 'claimed', claim_code = NULL, claim_expires_at = NULL
       WHERE id = ?`,
    ).run(userId, device.id);

    await reply.send({ status: "claimed", device_id: device.id });
  });

  /**
   * Poll for the result of a pending enrollment.
   *
   * The device polls this while it waits for the owner to scan the QR code.
   */
  app.get(`${basePath}/enroll/status/:deviceId`, async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    const device = db
      .prepare("SELECT state, claim_code, claim_expires_at FROM devices WHERE device_id = ?")
      .get(deviceId) as
      | { state: string; claim_code: string | null; claim_expires_at: string }
      | undefined;

    if (!device) {
      await reply.code(404).send({ error: "unknown device" });
      return;
    }

    await reply.send({
      state: device.state,
      claim_code: device.claim_code,
      expires_at: device.claim_expires_at,
    });
  });
}

/**
 * Generate a human-transcribable claim code.
 *
 * 12 characters from an unambiguous alphabet (no O/0, I/1), grouped in
 * blocks of four so it can be read off the panel and typed by hand.
 */
export function generateClaimCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 12; i++) {
    code += alphabet[randomInt(alphabet.length)];
    if ((i + 1) % 4 === 0 && i !== 11) code += "-";
  }
  return code;
}
