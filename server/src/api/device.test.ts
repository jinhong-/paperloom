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
async function makeServer(): Promise<BuiltServer> {
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
  const server = await makeServer();
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
  const server = await makeServer();
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
  assert.equal(first.status, 200);
  const firstRevision = (first.body as { schedule: { revision: string } }).schedule.revision;

  /* The frame asks again, saying which plan it is holding. The server
   * extends that plan rather than making a new one, so the frame is not
   * told one thing and then another. */
  const second = await signed(
    server,
    keys,
    deviceId,
    "POST",
    "/api/device/sync",
    Buffer.from(
      JSON.stringify({ device_id: deviceId, schedule_revision: firstRevision }),
    ),
  );

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const a = (first.body as { schedule: { revision: string } }).schedule.revision;
  const b = (second.body as { schedule: { revision: string } }).schedule.revision;
  assert.equal(a, b, "a retry must yield the same schedule revision");
});

test("the frame is given the whole plan the revision names", async (t) => {
  const server = await makeServer();
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
  db.prepare(
    `INSERT INTO device_sync_rules
       (device_id, days, start_minute, end_minute, sync_interval, priority)
     VALUES (?, 127, 480, 1320, 300, 0)`,
  ).run(deviceRowId);

  const response = await signed(
    server,
    keys,
    deviceId,
    "POST",
    "/api/device/sync",
    Buffer.from(JSON.stringify({ device_id: deviceId })),
  );
  assert.equal(response.status, 200);

  const body = response.body as {
    schedule: { revision: string; items: Array<{ at: string; asset: string }> };
  };
  const sent = body.schedule.items;

  /* The revision names the plan. The frame is given the whole of it, so
   * that the plan the frame works to is the plan the revision describes.
   *
   * If the frame were given only part of it, it would be working to a
   * plan the server does not hold, and would show a photo at a time the
   * server does not have. */
  const stored = db
    .prepare("SELECT revision, events_json FROM schedules WHERE device_id = ?")
    .get(deviceRowId) as { revision: string; events_json: string };
  const plan = JSON.parse(stored.events_json) as Array<{ at: number; asset: string }>;

  assert.equal(stored.revision, body.schedule.revision, "the revision must be the plan's");
  assert.equal(
    sent.length,
    plan.length,
    "the frame must be given every event of the plan the revision names",
  );

  for (let i = 0; i < plan.length; i++) {
    assert.equal(
      Date.parse(sent[i]!.at),
      plan[i]!.at,
      `the event at ${i} must be the one the plan says`,
    );
    assert.equal(sent[i]!.asset, plan[i]!.asset, `the photo at ${i} must be the plan's`);
  }
});

test("enrolling twice gives the same claim code", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const deviceId = `dev-${randomUUID()}`;
  const keys = generateKeyPair();
  const body = Buffer.from(
    JSON.stringify({
      device_id: deviceId,
      public_key: publicKeyToBase64(keys.publicKeyPem),
    }),
  );

  const first = await signed(server, keys, deviceId, "POST", "/api/device/enroll", body);
  assert.equal(first.status, 200);
  const firstBody = first.body as { claim_code: string; claimed: boolean };
  assert.equal(firstBody.claimed, false);

  // Enrolling again must not change the code. The code is on the panel
  // for the owner to read, so a new one each time would leave the panel
  // showing something that no longer works.
  const second = await signed(server, keys, deviceId, "POST", "/api/device/enroll", body);
  assert.equal(second.status, 200);
  const secondBody = second.body as { claim_code: string; claimed: boolean };
  assert.equal(secondBody.claim_code, firstBody.claim_code, "the claim code must not change");
});

test("a claimed device is told it is claimed rather than refused", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const deviceId = `dev-${randomUUID()}`;
  const keys = generateKeyPair();
  const body = Buffer.from(
    JSON.stringify({
      device_id: deviceId,
      public_key: publicKeyToBase64(keys.publicKeyPem),
    }),
  );

  const enroll = await signed(server, keys, deviceId, "POST", "/api/device/enroll", body);
  assert.equal(enroll.status, 200);
  const claimCode = (enroll.body as { claim_code: string }).claim_code;

  server.db
    .prepare("UPDATE devices SET state = 'claimed', claim_code = NULL WHERE device_id = ?")
    .run(deviceId);

  // The device keeps asking until it hears that it has been claimed, so
  // the answer has to be a plain yes rather than an error.
  const again = await signed(server, keys, deviceId, "POST", "/api/device/enroll", body);
  assert.equal(again.status, 200);
  const againBody = again.body as { claimed: boolean };
  assert.equal(againBody.claimed, true);
});

test("the claim code is replaced once it has expired", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const deviceId = `dev-${randomUUID()}`;
  const keys = generateKeyPair();
  const body = Buffer.from(
    JSON.stringify({
      device_id: deviceId,
      public_key: publicKeyToBase64(keys.publicKeyPem),
    }),
  );

  const first = await signed(server, keys, deviceId, "POST", "/api/device/enroll", body);
  const firstCode = (first.body as { claim_code: string }).claim_code;

  // Let the code run out.
  server.db
    .prepare("UPDATE devices SET claim_expires_at = ? WHERE device_id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), deviceId);

  const second = await signed(server, keys, deviceId, "POST", "/api/device/enroll", body);
  const secondCode = (second.body as { claim_code: string }).claim_code;

  assert.notEqual(secondCode, firstCode, "an expired code must be replaced");
});

test("a device cannot sync before it has been claimed", async (t) => {
  const server = await makeServer();
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


test("a schedule built before the galleries change is not reused", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const db = server.db;
  const deviceId = `dev-${randomUUID()}`;
  const keys = generateKeyPair();

  // A gallery with a photo, and the owner who will be given the device.
  const { galleryId, contentHash } = await seedGallery(server);
  const user = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: number };

  // A claimed device with no galleries yet.
  db.prepare(
    `INSERT INTO devices (name, device_id, public_key, state, user_id)
     VALUES ('d', ?, ?, 'claimed', ?)`,
  ).run(deviceId, publicKeyToBase64(keys.publicKeyPem), user.id);

  const deviceRowId = (
    db.prepare("SELECT id FROM devices WHERE device_id = ?").get(deviceId) as { id: number }
  ).id;

  db.prepare(
    `INSERT INTO device_policies (device_id, sync_interval, lookahead) VALUES (?, 3600, 10800)`,
  ).run(deviceRowId);

  // The device syncs with nothing to show, so the window is empty.
  const empty = await signed(
    server,
    keys,
    deviceId,
    "POST",
    "/api/device/sync",
    Buffer.from(JSON.stringify({ device_id: deviceId })),
  );
  assert.equal(empty.status, 200);
  const emptyBody = empty.body as { schedule: { items: unknown[] } };
  assert.equal(emptyBody.schedule.items.length, 0);

  // Now give it a gallery with a photo, the way the owner would.
  db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES ('tok', ?, datetime('now', '+1 day'))",
  ).run(user.id);

  const assign = await server.app.inject({
    method: "POST",
    url: `/api/devices/${deviceRowId}/galleries`,
    headers: { cookie: "paperloom_session=tok" },
    payload: { gallery_id: galleryId },
  });
  assert.equal(assign.statusCode, 200);

  // The empty window must not be reused: the device has something to show
  // now, and it must be told about it.
  const filled = await signed(
    server,
    keys,
    deviceId,
    "POST",
    "/api/device/sync",
    Buffer.from(JSON.stringify({ device_id: deviceId })),
  );
  assert.equal(filled.status, 200);
  const filledBody = filled.body as {
    schedule: { items: Array<{ asset: string }> };
    assets: Record<string, unknown>;
  };

  assert.ok(
    filledBody.schedule.items.length > 0,
    "the schedule must contain events once a gallery is assigned",
  );
  assert.equal(filledBody.schedule.items[0]!.asset, contentHash);
  assert.ok(filledBody.assets[contentHash], "the asset must be in the manifest");
});

test("a schedule built before the policy changes is not reused", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const db = server.db;
  const deviceId = `dev-${randomUUID()}`;
  const keys = generateKeyPair();

  // A gallery with a photo, and the owner who will be given the device.
  await seedGallery(server);
  const user = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: number };

  db.prepare(
    `INSERT INTO devices (name, device_id, public_key, state, user_id)
     VALUES ('d', ?, ?, 'claimed', ?)`,
  ).run(deviceId, publicKeyToBase64(keys.publicKeyPem), user.id);

  const deviceRowId = (
    db.prepare("SELECT id FROM devices WHERE device_id = ?").get(deviceId) as { id: number }
  ).id;

  // No galleries yet: the first window is empty.
  db.prepare(
    `INSERT INTO device_policies (device_id, sync_interval, lookahead) VALUES (?, 3600, 10800)`,
  ).run(deviceRowId);

  await signed(
    server,
    keys,
    deviceId,
    "POST",
    "/api/device/sync",
    Buffer.from(JSON.stringify({ device_id: deviceId })),
  );

  // Change the policy. The window boundaries move, and the device must
  // be given a schedule that matches its new policy rather than the
  // window that was built under the old one.
  db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES ('tok', ?, datetime('now', '+1 day'))",
  ).run(user.id);

  /* The interval comes from the rules, so that is what is changed.
   *
   * The rule covers every day and the whole of it, so it applies at the
   * moment of the check-in. */
  const changed = await server.app.inject({
    method: "POST",
    url: `/api/devices/${deviceRowId}/sync-rules`,
    headers: { cookie: "paperloom_session=tok" },
    payload: {
      days: 127,
      start_minute: 0,
      end_minute: 0,
      sync_interval: 120,
      priority: 0,
    },
  });
  assert.equal(changed.statusCode, 200);

  const after = await signed(
    server,
    keys,
    deviceId,
    "POST",
    "/api/device/sync",
    Buffer.from(JSON.stringify({ device_id: deviceId })),
  );
  assert.equal(after.status, 200);
  const afterBody = after.body as { next_sync_at: string; server_time: string };
  const gap = new Date(afterBody.next_sync_at).getTime() - new Date(afterBody.server_time).getTime();
  assert.ok(
    gap <= 120_000 && gap > 0,
    `the next sync must follow the new interval, got ${gap} ms`,
  );
});

test("a frame that retries gets the same schedule", async (t) => {
  const server = await makeServer();
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
  db.prepare(
    `INSERT INTO device_sync_rules
       (device_id, days, start_minute, end_minute, sync_interval, priority)
     VALUES (?, 127, 480, 1320, 300, 0)`,
  ).run(deviceRowId);

  const schedules = new ScheduleService(db, server.assets);

  const first = schedules.getForDevice(deviceRowId, Date.now());
  /* A moment later, as if the frame had not got the first answer and
   * asked again. The plan is stored, so the frame is given the same one. */
  const second = schedules.getForDevice(deviceRowId, Date.now() + 45_000);

  assert.equal(second.revision, first.revision, "the schedule must not change");
  assert.deepEqual(second.items, first.items, "the events must not change");
});

test("the plan grows rather than being replaced", async (t) => {
  const server = await makeServer();
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
  /* A short interval, so that the plan holds events close together and
   * the extension is visible. */
  db.prepare("UPDATE galleries SET min_interval = 60, max_interval = 60 WHERE id = ?").run(
    galleryId,
  );
  db.prepare(
    `INSERT INTO device_policies (device_id, sync_interval, lookahead) VALUES (?, 3600, 10800)`,
  ).run(deviceRowId);
  db.prepare(
    `INSERT INTO device_sync_rules
       (device_id, days, start_minute, end_minute, sync_interval, priority)
     VALUES (?, 127, 480, 1320, 300, 0)`,
  ).run(deviceRowId);

  const schedules = new ScheduleService(db, server.assets);
  const now = Date.now();

  const first = schedules.getForDevice(deviceRowId, now);
  assert.ok(first.items.length > 0, "the plan must hold some events");

  /* The plan has to be extended when it no longer reaches far enough.
   * Time is moved on past the end of the plan to bring that about. */
  const stored = db
    .prepare("SELECT window_end FROM schedules WHERE device_id = ?")
    .get(deviceRowId) as { window_end: string };
  const later = Date.parse(stored.window_end) + 60_000;
  const second = schedules.getForDevice(deviceRowId, later);

  /* The events that are still in the plan keep their times and their
   * photos. A frame that is working to a time is never told that the time
   * has moved.
   *
   * The events that have long since passed are dropped, because the frame
   * knows from its own memory which ones it has already shown. */
  const keepFrom = later - 30 * 60 * 1000;
  const firstTimes = first.items.map((e) => e.at).filter((at) => at > keepFrom);
  const secondTimes = second.items.map((e) => e.at);

  assert.ok(firstTimes.length > 0, "the plan must hold some recent events");
  for (const at of firstTimes) {
    assert.ok(secondTimes.includes(at), `the event at ${at} must still be there`);
  }

  /* And the plan has grown, so that it reaches further than it did.
   *
   * The plan grows by reaching further, not by holding more events. The
   * events that have long since passed are dropped, because the frame
   * knows from its own memory which ones it has already shown, so a plan
   * that has been extended can hold fewer events than the one before it
   * and still reach much further. */
  assert.ok(
    second.items[second.items.length - 1]!.at > first.items[first.items.length - 1]!.at,
    "the plan must reach further than it did",
  );

  /* And the events that are still to come are all there, with their own
   * times, and the new ones follow on after them. */
  assert.ok(
    secondTimes.length > firstTimes.length,
    "the plan must hold more of the events that are still to come",
  );
});

test("the plan starts now, so a frame gets a picture at once", async (t) => {
  const server = await makeServer();
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
  db.prepare(
    `INSERT INTO device_sync_rules
       (device_id, days, start_minute, end_minute, sync_interval, priority)
     VALUES (?, 127, 480, 1320, 300, 0)`,
  ).run(deviceRowId);

  const schedules = new ScheduleService(db, server.assets);
  const now = Date.now();
  const window = schedules.getForDevice(deviceRowId, now);

  /* The first event must not be in the future.
   *
   * A frame that has just been set up, or one that has just checked in,
   * has nothing to show until its first event arrives. If that first
   * event were in the future the frame would sit blank, which is what
   * happened when the window was aligned to a period that had not yet
   * begun. */
  assert.ok(window.items.length > 0, "the plan must hold at least one event");
  assert.ok(
    window.items[0]!.at <= now,
    `the first event must be due now, not at ${new Date(window.items[0]!.at).toISOString()}`,
  );
});

test("the schedule reaches through the frame's longest sleep", async (t) => {
  const server = await makeServer();
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

  /* One rule, covering the daytime only.
   *
   * Nothing covers the night, so the frame has nothing to check in for
   * between ten at night and eight in the morning, and sleeps for those
   * ten hours. The plan it is given has to reach through that sleep, or
   * the frame wakes in the small hours to find that its schedule has run
   * out and it has nothing to show. */
  db.prepare(
    `INSERT INTO device_sync_rules
       (device_id, days, start_minute, end_minute, sync_interval, priority)
     VALUES (?, 127, 480, 1320, 300, 0)`,
  ).run(deviceRowId);

  const schedules = new ScheduleService(db, server.assets);
  const now = Date.now();
  const window = schedules.getForDevice(deviceRowId, now);

  /* The window must reach past the end of the sleep, and past the
   * lookahead that the frame asks for when it wakes. */
  const span = window.items.length > 0
    ? window.items[window.items.length - 1]!.at - now
    : 0;

  assert.ok(
    span >= 10 * 3600_000,
    `the plan must cover the ten-hour sleep, got ${span} ms of cover`,
  );

  /* The events must be spread across the night rather than bunched at the
   * start, so that the frame has something to show when it wakes. */
  const during = window.items.filter((item) => item.at > now + 6 * 3600_000);
  assert.ok(
    during.length > 0,
    "the plan must hold events for the small hours, not just the evening",
  );
});

test("a changed gallery is handed over at the frame's next check-in", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const { galleryId } = await seedGallery(server);
  const db = server.db;

  const deviceId = `dev-${randomUUID()}`;
  const keys = generateKeyPair();

  db.prepare(
    `INSERT INTO devices (name, device_id, public_key, state, user_id)
     VALUES ('d', ?, ?, 'claimed', 1)`,
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
  db.prepare(
    `INSERT INTO device_sync_rules
       (device_id, days, start_minute, end_minute, sync_interval, priority)
     VALUES (?, 127, 480, 1320, 300, 0)`,
  ).run(deviceRowId);

  const schedules = new ScheduleService(db, server.assets);
  const now = Date.now();

  /* The frame has a plan, and is working to it. */
  const first = schedules.getForDevice(deviceRowId, now);
  assert.ok(first.items.length > 0, "the frame must have a plan");

  /* The gallery changes. The plan is not thrown away: it is to be handed
   * over at the frame's next check-in. */
  schedules.invalidate(deviceRowId, now);

  const handover = db
    .prepare("SELECT handover_at FROM schedules WHERE device_id = ?")
    .get(deviceRowId) as { handover_at: number | null };
  assert.ok(handover.handover_at !== null, "the plan must be marked to change");
  const handoverAt = handover.handover_at!;
  assert.ok(
    handoverAt > now,
    "the change must be in the future, not now",
  );

  /* The frame is given the plan it is already following, so that the two
   * are working to the same one. */
  const second = schedules.getForDevice(deviceRowId, now + 1000);
  assert.equal(second.revision, first.revision, "the plan must not change yet");
  assert.deepEqual(second.items, first.items, "the events must not change yet");

  /* The owner can see what the plan will become. */
  const plans = schedules.planWithProjection(deviceRowId, now + 1000);
  assert.ok(plans.projected !== null, "the owner must be shown the plan to come");
  assert.equal(plans.handoverAt, handoverAt);

  /* Once the frame comes back for it, the plan is changed. */
  const third = schedules.getForDevice(deviceRowId, handoverAt);
  assert.notEqual(third.revision, first.revision, "the plan must change at the check-in");
});
