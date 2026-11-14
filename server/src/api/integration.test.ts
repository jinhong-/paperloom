/**
 * Full-stack integration test.
 *
 * Drives the server exactly the way the firmware does: sign a request,
 * claim the device, sync, download the assets, and check that the
 * downloaded bytes are a valid panel frame.
 *
 * The simulator lives in src/tools/simulate-device.ts so it can also be
 * run against a live server with `npx tsx src/tools/simulate-device.ts`.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildServer, type BuiltServer } from "../index.js";
import { renderAsset } from "../image.js";
import { AssetStore } from "../assets/store.js";
import { randomUUID } from "node:crypto";

/**
 * Build a server on a throwaway database.
 */
async function makeServer(): Promise<BuiltServer> {
  const dir = mkdtempSync(join(tmpdir(), "paperloom-e2e-"));
  return buildServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    logLevel: "silent",
  });
}

/**
 * Register an account and return a session cookie.
 */
async function signIn(server: BuiltServer): Promise<string> {
  const username = `u-${randomUUID()}`;
  await server.app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username, password: "a-long-enough-password" },
  });

  const login = await server.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password: "a-long-enough-password" },
  });
  assert.equal(login.statusCode, 200);

  const setCookie = login.headers["set-cookie"];
  assert.ok(setCookie, "the login must set a session cookie");
  return String(setCookie).split(";")[0]!;
}

/**
 * Create a gallery with one real rendered photo.
 */
async function createGalleryWithPhoto(
  server: BuiltServer,
  cookie: string,
): Promise<{ galleryId: number; contentHash: string; byteSize: number }> {
  const created = await server.app.inject({
    method: "POST",
    url: "/api/galleries",
    headers: { cookie },
    payload: { name: "Test gallery", rotation_mode: "sequential", min_interval: 900, max_interval: 900 },
  });
  assert.equal(created.statusCode, 200);
  const galleryId = (created.json() as { id: number }).id;

  // A small red square, so the dither has something to work with.
  const png = await renderTestImage();

  const uploaded = await server.app.inject({
    method: "POST",
    url: `/api/galleries/${galleryId}/photos`,
    headers: { cookie },
    payload: { filename: "red.png", data: png.toString("base64") },
  });
  assert.equal(uploaded.statusCode, 200, uploaded.body);

  const result = uploaded.json() as { content_hash: string; byte_size: number };
  return {
    galleryId,
    contentHash: result.content_hash,
    byteSize: result.byte_size,
  };
}

/**
 * A tiny solid-red PNG.
 */
async function renderTestImage(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
}

test("a device can enrol, be claimed, sync and download its assets", async (t) => {
  const server = await makeServer();
  t.after(async () => {
    await server.app.close();
  });

  const cookie = await signIn(server);
  const { galleryId, contentHash, byteSize } = await createGalleryWithPhoto(server, cookie);

  // --- Enrol ----------------------------------------------------------
  const deviceId = `dev-${randomUUID()}`;
  const { generateKeyPairSync, sign } = await import("node:crypto");
  const { publicKeyToBase64, canonicalString } = await import("../auth/signing.js");

  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }) as string;

  const enroll = await server.app.inject({
    method: "POST",
    url: "/api/device/enroll",
    payload: {
      device_id: deviceId,
      name: "E2E frame",
      public_key: publicKeyToBase64(keys.publicKey.export({ type: "spki", format: "pem" }) as string),
    },
  });
  assert.equal(enroll.statusCode, 200);
  const claimCode = (enroll.json() as { claim_code: string }).claim_code;

  // --- Claim ----------------------------------------------------------
  const claim = await server.app.inject({
    method: "POST",
    url: `/api/device/claim/${claimCode}`,
    headers: { cookie },
  });
  assert.equal(claim.statusCode, 200);

  // --- Assign the gallery ---------------------------------------------
  const devices = await server.app.inject({
    method: "GET",
    url: "/api/devices",
    headers: { cookie },
  });
  const device = (devices.json() as Array<{ id: number; device_id: string }>).find(
    (d) => d.device_id === deviceId,
  );
  assert.ok(device, "the claimed device must be listed");

  const assign = await server.app.inject({
    method: "POST",
    url: `/api/devices/${device.id}/galleries`,
    headers: { cookie },
    payload: { gallery_id: galleryId },
  });
  assert.equal(assign.statusCode, 200);

  // --- Sync -----------------------------------------------------------
  const signed = async (method: string, path: string, body: Buffer) => {
    const timestamp = Date.now();
    const nonce = randomUUID();
    const canonical = canonicalString({ method, path, timestamp, nonce, deviceId, body });
    const signature = sign("sha256", Buffer.from(canonical, "utf8"), {
      key: privateKey,
      dsaEncoding: "der",
    }).toString("base64url");

    return server.app.inject({
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
  };

  const sync = await signed(
    "POST",
    "/api/device/sync",
    Buffer.from(JSON.stringify({ device_id: deviceId, cached_assets: [] })),
  );
  assert.equal(sync.statusCode, 200, sync.body);

  const syncBody = sync.json() as {
    server_time: string;
    next_sync_at: string;
    schedule: { revision: string; items: Array<{ at: string; asset: string }> };
    assets: Record<string, { url: string; sha256: string; size: number }>;
  };

  assert.ok(syncBody.schedule.items.length > 0, "the schedule must have events");
  assert.equal(syncBody.schedule.items[0]!.asset, contentHash);
  assert.ok(new Date(syncBody.next_sync_at) > new Date(syncBody.server_time));

  // The asset must be offered for download with the right size.
  const entry = syncBody.assets[contentHash];
  assert.ok(entry, "the asset must be in the manifest");
  assert.equal(entry.size, byteSize);
  assert.equal(entry.sha256, contentHash);

  // --- Download -------------------------------------------------------
  const download = await signed("GET", entry.url, Buffer.alloc(0));
  assert.equal(download.statusCode, 200);

  const bytes = download.rawPayload;
  assert.equal(bytes.length, byteSize);
  assert.equal(AssetStore.hash(bytes), contentHash, "the bytes must match the advertised hash");

  // The asset must be a gzip of exactly one panel frame.
  const { gunzipSync } = await import("node:zlib");
  const { RAW_FRAME_BYTES, unpackIndices } = await import("../panel.js");
  const frame = gunzipSync(bytes);
  assert.equal(frame.length, RAW_FRAME_BYTES);

  const indices = unpackIndices(frame);
  assert.equal(indices.length, 1200 * 1600);
  for (const index of indices) {
    assert.ok(index <= 6 && index !== 4, `invalid colour index ${index}`);
  }

  // A red picture must dither to mostly red.
  //
  // Pure red (255,0,0) is not one of the palette's exact colours, so error
  // diffusion has work to do: it renders a coarse checkerboard of red and
  // white with a few other colours at the edges. That is the expected
  // behaviour and matches the reference implementation exactly.
  //
  // The picture is a small square, and it is fitted inside the panel rather
  // than cropped to fill it, so the panel is red in the middle and the
  // panel's black around it.
  const counts = new Map<number, number>();
  for (const index of indices) {
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  const redPixels = counts.get(3) ?? 0;
  const total = indices.length;
  assert.ok(
    redPixels / total > 0.5,
    `expected mostly red pixels, got ${((redPixels / total) * 100).toFixed(1)}%`,
  );
  assert.ok(
    (counts.get(0) ?? 0) / total > 0.1,
    "the space around the picture must be the panel's black",
  );
  assert.equal(counts.get(4) ?? 0, 0, "the reserved colour code 4 must never appear");

  // --- Acknowledge ----------------------------------------------------
  // The device reports what it actually put on the panel; the server
  // records it.
  const ack = await signed(
    "POST",
    "/api/device/sync",
    Buffer.from(JSON.stringify({ device_id: deviceId, displayed_asset: contentHash })),
  );
  assert.equal(ack.statusCode, 200);

  const state = await server.app.inject({
    method: "GET",
    url: "/api/devices",
    headers: { cookie },
  });
  const updated = (state.json() as Array<{ device_id: string; displayed_asset: string | null }>).find(
    (d) => d.device_id === deviceId,
  );
  assert.equal(updated?.displayed_asset, contentHash, "the server must record the displayed asset");

  // --- A second sync must not re-send what we already have -------------
  const second = await signed(
    "POST",
    "/api/device/sync",
    Buffer.from(JSON.stringify({ device_id: deviceId, cached_assets: [contentHash] })),
  );
  const secondBody = second.json() as { assets: Record<string, unknown> };
  assert.equal(
    Object.keys(secondBody.assets).length,
    0,
    "an already-cached asset must not be sent again",
  );
});

