/**
 * The device-facing API: `/sync`, `/assets/:hash`, and enrollment.
 *
 * This is the contract the firmware implements against. It follows the
 * architecture document: the device reports actual state, the server
 * responds with desired future state, and there is no separate ACK call.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { AssetStore } from "../assets/store.js";
import {
  HEADER_DEVICE,
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  MAX_CLOCK_SKEW_MS,
  NONCE_TTL_MS,
  canonicalString,
  publicKeyFromBase64,
  verifyRequest,
} from "../auth/signing.js";
import type { Db } from "../db/index.js";
import type { ScheduleService } from "../schedule/service.js";

/**
 * How many assets a frame on battery is given in one check-in.
 *
 * A frame on mains power can fetch everything it is missing at once. A
 * frame on battery cannot: it spends most of its life asleep, and every
 * download is radio time and therefore power. So a battery frame is given
 * only as many assets as it needs to cover the coming period, and
 * collects the rest on later check-ins.
 */
const BATTERY_ASSET_LIMIT = 2;

/**
 * The body a device sends when it checks in.
 */
export interface SyncRequest {
  /** Stable device identifier. An identifier, not proof of identity. */
  readonly device_id: string;
  /** The revision of the schedule the device currently holds. */
  readonly schedule_revision?: string;
  /** The gallery/config revision the device last saw. */
  readonly gallery_updated_at?: string;
  /** The asset the device last successfully applied to the panel. */
  readonly displayed_asset?: string;
  /**
   * Content hashes of the assets the device already holds locally.
   *
   * The server uses this to build the download manifest: an asset listed
   * here is not sent again. This is what makes the sync incremental.
   */
  readonly cached_assets?: readonly string[];
  /** Battery voltage in millivolts. */
  readonly battery_mv?: number;
  readonly firmware_version?: string;
  /** Why the device woke: timer | button | boot. */
  readonly wake_reason?: string;
  /**
   * What the device's own clock reads, in milliseconds since the epoch.
   *
   * The server uses this to see how far the device's clock has drifted.
   */
  readonly clock_ms?: number;
  /**
   * Whether the device's clock is anchored to real time.
   *
   * Zero means the device has never synced, or has lost power and come
   * back without a clock.
   */
  readonly clock_anchored?: number;
  /**
   * Whether the frame is running on battery rather than mains power.
   *
   * A frame on battery spends more of its time asleep, so the server is
   * more careful about how much it asks it to download.
   */
  readonly on_battery?: number;
}

/** The body the server sends back. */
export interface SyncResponse {
  readonly server_time: string;
  readonly next_sync_at: string;
  readonly schedule: {
    readonly revision: string;
    readonly items: ReadonlyArray<{ readonly at: string; readonly asset: string }>;
  };
  readonly assets: Record<string, { readonly url: string; readonly sha256: string; readonly size: number }>;
}

export interface DeviceApiOptions {
  readonly db: Db;
  readonly assets: AssetStore;
  readonly schedules: ScheduleService;
  /** Base path for device endpoints, e.g. "/api/device". */
  readonly basePath: string;
}

export function registerDeviceApi(app: FastifyInstance, options: DeviceApiOptions): void {
  const { db, assets, schedules, basePath } = options;

  /**
   * The raw request body, as bytes.
   *
   * The signature covers the SHA-256 of the exact bytes sent, so we need the
   * unparsed body. Fastify's default JSON parser would hand us a decoded
   * object, and re-serialising it could produce different bytes (key order,
   * whitespace) which would break verification.
   *
   * We therefore add a content-type parser that captures the raw buffer,
   * parses JSON from it, and records the raw bytes on the request.
   */
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body: Buffer, done) => {
      const raw = body;
      try {
        const parsed = raw.length === 0 ? {} : JSON.parse(raw.toString("utf8"));
        request.rawBody = raw;
        done(null, parsed);
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  /**
   * Verify a signed device request.
   *
   * Returns the device row on success, or writes an error and returns null.
   */
  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ id: number; deviceId: string } | null> {
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
      .prepare("SELECT id, device_id, public_key, state FROM devices WHERE device_id = ?")
      .get(deviceId) as
      | { id: number; device_id: string; public_key: string | null; state: string }
      | undefined;

    if (!device || device.state !== "claimed" || !device.public_key) {
      request.log.warn(
        { deviceId, state: device?.state ?? "(unknown)", hasKey: !!device?.public_key },
        "the device is not allowed to sync",
      );
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
        {
          deviceId,
          path,
          timestamp,
          nonce,
          bodyLength: body.length,
          canonical: canonicalString(
            { method: request.method, path, timestamp, nonce, deviceId, body },
          ),
        },
        "the signature did not verify",
      );
      await reply.code(401).send({ error: "invalid signature" });
      return null;
    }

    // Replay defence: a nonce may be used only once.
    //
    // The lookup and the insert are done in one transaction so that two
    // concurrent requests carrying the same nonce cannot both pass the
    // check.
    const claimNonce = db.transaction((deviceId: number, value: string): boolean => {
      const seen = db
        .prepare("SELECT 1 FROM request_nonces WHERE device_id = ? AND nonce = ?")
        .get(deviceId, value);
      if (seen) return false;
      db.prepare("INSERT INTO request_nonces (device_id, nonce) VALUES (?, ?)").run(deviceId, value);
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

    return { id: device.id, deviceId: device.device_id };
  }

  /**
   * The server's current time.
   *
   * A device that has never synced has no absolute time, so the timestamp
   * it puts in a request would be meaningless and the server would reject
   * the request as being outside the accepted window. This endpoint lets
   * the device anchor its clock before it makes any signed request.
   *
   * It is deliberately unsigned and returns nothing but the time, so it
   * cannot be used to do anything on the device's behalf.
   */
  app.get(`${basePath}/time`, async (_request, reply) => {
    await reply.send({ server_time: new Date().toISOString() });
  });

  app.post(`${basePath}/sync`, async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (!auth) return;

    const body = request.body as SyncRequest;

    // The device reports what its own clock reads. This is how a frame
    // that has lost power, or whose real-time clock has drifted, becomes
    // visible in the logs instead of silently showing the wrong photo.
    //
    // The reported clock has already been used to check the request's
    // timestamp, so a large drift means the device is close to falling
    // out of the accepted window.
    if (typeof body.clock_ms === "number") {
      const drift = Math.abs(Date.now() - body.clock_ms);
      if (drift > MAX_CLOCK_SKEW_MS) {
        request.log.warn(
          { deviceId: auth.deviceId, clockMs: body.clock_ms, drift },
          "the device's clock is far from the server's",
        );
      } else {
        request.log.info(
          { deviceId: auth.deviceId, drift },
          "the device's clock is close to the server's",
        );
      }
    }
    if (body.clock_anchored === 0) {
      request.log.warn(
        { deviceId: auth.deviceId },
        "the device reports that its clock is not anchored",
      );
    }

    // The reported displayed_asset is the implicit acknowledgement: it tells
    // the server which asset is actually on the panel.
    db.prepare(
      `UPDATE devices
       SET displayed_asset = ?, battery_mv = COALESCE(?, battery_mv),
           firmware_version = COALESCE(?, firmware_version), last_seen_at = ?,
           clock_ms = COALESCE(?, clock_ms),
           clock_anchored = COALESCE(?, clock_anchored),
           on_battery = COALESCE(?, on_battery)
       WHERE id = ?`,
    ).run(
      body.displayed_asset ?? null,
      body.battery_mv ?? null,
      body.firmware_version ?? null,
      new Date().toISOString(),
      body.clock_ms ?? null,
      body.clock_anchored ?? null,
      body.on_battery ?? null,
      auth.id,
    );

    const now = Date.now();
    const window = schedules.getForDevice(auth.id, now);
    const policy = schedules.policyFor(auth.id);

    // Which assets the device needs but does not yet have.
    //
    // The device tells us what it already holds via `cached_assets`; the
    // manifest lists everything in the schedule it does not have. Without
    // that field we cannot tell a fresh device from a fully-cached one, so
    // the manifest stays empty only when the device explicitly reports its
    // cache contents.
    const required = new Set(window.items.map((item) => item.asset));
    const cached = new Set(body.cached_assets ?? []);
    const assetManifest: SyncResponse["assets"] = {};

    // How many assets the frame is told to download in one go.
    //
    // A frame on mains power can fetch everything it is missing at once.
    // A frame on battery cannot: it spends most of its life asleep, and
    // every download is radio time and therefore power. So a battery
    // frame is given the smallest number of assets it needs to cover the
    // coming period, and collects the rest on later check-ins.
    const limit = body.on_battery === 1 ? BATTERY_ASSET_LIMIT : required.size;

    let offered = 0;
    for (const hash of required) {
      if (cached.has(hash)) continue;
      if (offered >= limit) break;
      const bytes = await assets.get(hash);
      if (!bytes) continue;
      assetManifest[hash] = {
        url: `${basePath}/assets/${hash}`,
        sha256: hash,
        size: bytes.length,
      };
      offered++;
    }

    const response: SyncResponse = {
      server_time: new Date(now).toISOString(),
      next_sync_at: new Date(now + policy.syncInterval * 1000).toISOString(),
      schedule: {
        revision: window.revision,
        items: window.items.map((item) => ({
          at: new Date(item.at).toISOString(),
          asset: item.asset,
        })),
      },
      assets: assetManifest,
    };

    await reply.send(response);
  });

  /**
   * Download a display-ready asset.
   *
   * The asset is served as the raw gzip container; the device verifies the
   * hash before treating it as cached.
   */
  app.get(`${basePath}/assets/:hash`, async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (!auth) return;

    const { hash } = request.params as { hash: string };
    const data = await assets.get(hash);
    if (!data) {
      await reply.code(404).send({ error: "unknown asset" });
      return;
    }

    await reply
      .header("Content-Type", "application/gzip")
      .header("Content-Length", String(data.length))
      .header("X-Content-SHA256", hash)
      .send(data);
  });
}
