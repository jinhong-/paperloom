/**
 * End-to-end test of the device protocol.
 *
 * Walks the full lifecycle: enroll a device, claim it, sign a sync request,
 * download the assets it was told about, and verify the schedule is stable
 * across retries.
 */

import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

import { generateKeyPair, publicKeyToBase64, signRequest } from "../auth/signing.js";
import { openDatabase, type Db } from "../db/index.js";
import { AssetStore } from "../assets/store.js";
import { ScheduleService } from "../schedule/service.js";
import { buildServer, type BuiltServer } from "../index.js";
import type { SyncResponse } from "./device.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Build a server on a throwaway database.
 */
function makeServer(): BuiltServer {
  const dir = mkdtempSync(join(tmpdir(), "paperloom-test-"));
  return buildServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    logLevel: "silent",
  });
}

/**
 * Create a user and a gallery with one photo, and return the ids.
 */
async function seedGallery(server: BuiltServer): Promise<{ galleryId: number; contentHash: string }> {
  const db = server.db;

  const userId = Number(
    db
      .prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
      .run(`u-${randomUUID()}`, "x").lastInsertRowid,
  );

  const galleryId = Number(
    db
      .prepare(
        `INSERT INTO galleries (user_id, name, rotation_mode, min_interval, max_interval)
         VALUES (?, 'Test', 'sequential', 3600, 3600)`,
      )
      .run(userId).lastInsertRowid,
  );

  // A minimal but valid asset: gzip of an all-white 4bpp frame would be
  // enormous, so use a short one. The device API only cares that the hash
  // resolves to stored bytes.
  const payload = gzipSync(Buffer.alloc(16, 0x11));
  const contentHash = AssetStore.hash(payload);
  await server.assets.put(contentHash, payload, 1200, 1600);

  db.prepare(
    `INSERT INTO photos (gallery_id, filename, source_hash, content_hash, width, height, byte_size, weight)
     VALUES (?, 'a.jpg', 'src', ?, 1200, 1600, ?, 1.0)`,
  ).run(galleryId, contentHash, payload.length);

  return { galleryId, contentHash };
}

/**
 * Sign and send a request the way the firmware does.
 */
async function signed(
  server: BuiltServer,
  keys: { privateKeyPem: string },
  deviceId: string,
  method: string,
  path: string,
  body: Buffer,
): Promise<{
  status: number;
  body: unknown;
  raw: Buffer;
  headers: Record<string, string>;
}> {
  const timestamp = Date.now();
  const nonce = randomUUID();
  const signature = signRequest(
    { method, path, timestamp, nonce, deviceId, body },
    keys.privateKeyPem,
  );

  const response = await server.app.inject({
    method: method as "GET",
    url: path,
    headers: {
      "content-type": "application/json",
      "x-paperloom-device": deviceId,
      "x-paperloom-timestamp": String(timestamp),
      "x-paperloom-nonce": nonce,
      "x-paperloom-signature": signature,
    },
    payload: body,
  });

  const raw = Buffer.from(response.rawPayload);
  let parsed: unknown;
  const contentType = response.headers["content-type"] ?? "";
  if (contentType.includes("application/json") && raw.length > 0) {
    parsed = JSON.parse(raw.toString("utf8"));
  }

  return {
    status: response.statusCode,
    body: parsed,
    raw,
    headers: response.headers as Record<string, string>,
  };
}

test("the device protocol works end to end", async (t) => {
  const server = makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const { galleryId, contentHash } = await seedGallery(server);
  const db = server.db;

  const deviceId = `dev-${randomUUID()}`;
  const keys = generateKeyPair();

  // --- Enrollment -----------------------------------------------------
  const enroll = await server.app.inject({
    method: "POST",
    url: "/api/device/enroll",
    payload: {
      device_id: deviceId,
      name: "Living room",
      public_key: publicKeyToBase64(keys.publicKeyPem),
    },
  });
  assert.equal(enroll.statusCode, 200);
  const enrollBody = enroll.json() as { claim_code: string };
  assert.ok(enrollBody.claim_code.length > 0);

  // --- Claiming -------------------------------------------------------
  const claim = await server.app.inject({
    method: "POST",
    url: `/api/device/claim/${enrollBody.claim_code}`,
  });
  // No session: claiming requires a signed-in owner.
  assert.equal(claim.statusCode, 401);

  const user = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: number };
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('tok', ?, datetime('now', '+1 day'))").run(
    user.id,
  );

  const claimWithSession = await server.app.inject({
    method: "POST",
    url: `/api/device/claim/${enrollBody.claim_code}`,
    headers: { cookie: "paperloom_session=tok" },
  });
  assert.equal(claimWithSession.statusCode, 200);

  // The device is now claimed and bound to the user.
  const device = db
    .prepare("SELECT state, user_id FROM devices WHERE device_id = ?")
    .get(deviceId) as { state: string; user_id: number };
  assert.equal(device.state, "claimed");
  assert.equal(device.user_id, user.id);

  // Give the device a gallery and a policy.
  const deviceRowId = (
    db.prepare("SELECT id FROM devices WHERE device_id = ?").get(deviceId) as { id: number }
  ).id;
  db.prepare("INSERT INTO device_galleries (device_id, gallery_id) VALUES (?, ?)").run(
    deviceRowId,
    galleryId,
  );
  db.prepare(
    `INSERT INTO device_policies (device_id, sync_interval, lookahead) VALUES (?, 3600, 10800)`,
  ).run(deviceRowId);

  // --- Sync -----------------------------------------------------------
  const sync = await signed(
    server,
    keys,
    deviceId,
    "POST",
    "/api/device/sync",
    Buffer.from(
      JSON.stringify({
        device_id: deviceId,
        displayed_asset: null,
        battery_mv: 3850,
        firmware_version: "0.1.0",
        wake_reason: "timer",
      }),
    ),
  );
  assert.equal(sync.status, 200);

  const syncBody = sync.body as {
    server_time: string;
    next_sync_at: string;
    schedule: { revision: string; items: Array<{ at: string; asset: string }> };
    assets: Record<string, { url: string; sha256: string; size: number }>;
  };

  assert.ok(syncBody.schedule.items.length > 0, "the schedule must contain events");
  assert.equal(syncBody.schedule.items[0]!.asset, contentHash);
  assert.ok(syncBody.next_sync_at > syncBody.server_time, "next sync must be in the future");

  // The asset manifest must point at the stored asset.
  const manifest = syncBody.assets[contentHash];
  assert.ok(manifest, "the schedule's asset must be listed in the manifest");
  assert.equal(manifest.sha256, contentHash);
  assert.equal(manifest.size, gzipSync(Buffer.alloc(16, 0x11)).length);

  // --- Asset download -------------------------------------------------
  const download = await signed(server, keys, deviceId, "GET", manifest.url, Buffer.alloc(0));
  assert.equal(download.status, 200);
  assert.equal(download.raw.length, manifest.size);
  assert.equal(download.headers["content-type"], "application/gzip");
  // The bytes must hash to the advertised digest, or the device will
  // refuse to cache them.
  assert.equal(AssetStore.hash(download.raw), contentHash);

  // A device that already holds the asset is not sent it again.
  const cachedSync = await signed(
    server,
    keys,
    deviceId,
    "POST",
    "/api/device/sync",
    Buffer.from(JSON.stringify({ device_id: deviceId, cached_assets: [contentHash] })),
  );
  const cachedBody = cachedSync.body as SyncResponse;
  assert.equal(
    Object.keys(cachedBody.assets).length,
    0,
    "an already-cached asset must not be re-sent",
  );

  // --- Replay protection ----------------------------------------------
  const replayBody = Buffer.from(JSON.stringify({ device_id: deviceId }));
  const timestamp = Date.now();
  const nonce = randomUUID();
  const signature = signRequest(
    { method: "POST", path: "/api/device/sync", timestamp, nonce, deviceId, body: replayBody },
    keys.privateKeyPem,
  );
  const headers = {
    "content-type": "application/json",
    "x-paperloom-device": deviceId,
    "x-paperloom-timestamp": String(timestamp),
    "x-paperloom-nonce": nonce,
    "x-paperloom-signature": signature,
  };
  const first = await server.app.inject({
    method: "POST",
    url: "/api/device/sync",
    headers,
    payload: replayBody,
  });
  assert.equal(first.statusCode, 200);

  // The identical request must be rejected the second time.
  const second = await server.app.inject({
    method: "POST",
    url: "/api/device/sync",
    headers,
    payload: replayBody,
  });
  assert.equal(second.statusCode, 401);
  assert.match(second.body, /nonce already used/);

  // A body that differs from the signed bytes must be rejected too.
  const tampered = await server.app.inject({
    method: "POST",
    url: "/api/device/sync",
    headers: { ...headers, "x-paperloom-nonce": randomUUID() },
    payload: Buffer.from(JSON.stringify({ device_id: deviceId, battery_mv: 1 })),
  });
  assert.equal(tampered.statusCode, 401);
  assert.match(tampered.body, /invalid signature/);

  // --- Unsigned requests are rejected ---------------------------------
  const unsigned = await server.app.inject({
    method: "POST",
    url: "/api/device/sync",
    headers: { "content-type": "application/json" },
    payload: "{}",
  });
  assert.equal(unsigned.statusCode, 401);
  assert.match(unsigned.body, /missing signature headers/);
});

test("the schedule is identical across retries", async (t) => {
  const server = makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const { galleryId } = await seedGallery(server);
  const db = server.db;

  const deviceId = `dev-${randomUUID()}`;
  const keys = generateKeyPair();

  db.prepare(
    `INSERT INTO devices (name, device_id, public_key, state, user_id)
     VALUES ('d', ?, ?, 'claimed', NULL)`,
  ).run(deviceId, publicKeyToBase64(keys.publicKeyPem));

  const deviceRowId = (
    db.prepare("SELECT id FROM devices WHERE device_id = ?").get(deviceId) as { id: number }
  ).id;
  db.prepare("INSERT INTO device_galleries (device_id, gallery_id) VALUES (?, ?)").run(
    deviceRowId,
    galleryId,
  );
  db.prepare(
    `INSERT INTO device_policies (device_id, sync_interval, lookahead) VALUES (?, 3600, 10800)`,
  ).run(deviceRowId);

  const first = await signed(
    server,
    keys,
    deviceId,
    "POST",
    "/api/device/sync",
    Buffer.from(JSON.stringify({ device_id: deviceId })),
  );
  const second = await signed(
    server,
    keys,
    deviceId,
    "POST",
    "/api/device/sync",
    Buffer.from(JSON.stringify({ device_id: deviceId })),
  );

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const a = (first.body as { schedule: { revision: string } }).schedule.revision;
  const b = (second.body as { schedule: { revision: string } }).schedule.revision;
  assert.equal(a, b, "a retry must yield the same schedule revision");
});

test("a device cannot sync before it has been claimed", async (t) => {
  const server = makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const deviceId = `dev-${randomUUID()}`;
  const keys = generateKeyPair();

  server.db
    .prepare(
      `INSERT INTO devices (name, device_id, public_key, state) VALUES ('d', ?, ?, 'pending')`,
    )
    .run(deviceId, publicKeyToBase64(keys.publicKeyPem));

  const response = await signed(
    server,
    keys,
    deviceId,
    "POST",
    "/api/device/sync",
    Buffer.from(JSON.stringify({ device_id: deviceId })),
  );
  assert.equal(response.status, 401);
});
