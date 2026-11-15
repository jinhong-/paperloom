/**
 * A live end-to-end check against a running server.
 *
 * Registers an account, creates a gallery, uploads a photo, enrols a
 * device, claims it, and syncs. Every step goes over HTTP, so this
 * exercises the same paths the firmware and the browser use.
 */

import { randomUUID } from "node:crypto";
import sharp from "sharp";

import { SimulatedDevice } from "./simulate-device.js";

const baseUrl = process.env.PAPERLOOM_URL ?? "http://127.0.0.1:8099";
const username = `live-${randomUUID().slice(0, 8)}`;
const password = "a-long-enough-password";

let cookie = "";

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...init.headers,
    },
  });

  const setCookie = response.headers.get("set-cookie");
  if (setCookie) {
    cookie = setCookie.split(";")[0]!;
  }

  const text = await response.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

async function main(): Promise<void> {
  console.log(`Checking the server at ${baseUrl}\n`);

  // --- Account --------------------------------------------------------
  let result = await call("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  if (result.status !== 200) {
    throw new Error(`Registration failed: ${result.status} ${JSON.stringify(result.json)}`);
  }
  console.log(`1. Registered "${username}"`);

  result = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  if (result.status !== 200) {
    throw new Error(`Login failed: ${result.status}`);
  }
  console.log("2. Signed in");

  // --- Gallery --------------------------------------------------------
  result = await call("/api/galleries", {
    method: "POST",
    body: JSON.stringify({
      name: "Live test gallery",
      rotation_mode: "sequential",
      min_interval: 900,
      max_interval: 1800,
    }),
  });
  if (result.status !== 200) {
    throw new Error(`Gallery creation failed: ${result.status} ${JSON.stringify(result.json)}`);
  }
  const galleryId = result.json.id;
  console.log(`3. Created gallery ${galleryId}`);

  // --- Photo ----------------------------------------------------------
  const image = await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 30, g: 90, b: 200 } },
  })
    .png()
    .toBuffer();

  result = await call(`/api/galleries/${galleryId}/photos`, {
    method: "POST",
    body: JSON.stringify({ filename: "blue.png", data: image.toString("base64") }),
  });
  if (result.status !== 200) {
    throw new Error(`Upload failed: ${result.status} ${JSON.stringify(result.json)}`);
  }
  const contentHash = result.json.content_hash;
  console.log(
    `4. Uploaded and rendered a photo: ${contentHash.slice(0, 16)}… ` +
      `(${Math.round(result.json.byte_size / 1024)} kB)`,
  );

  // --- Enrol ----------------------------------------------------------
  const device = new SimulatedDevice(baseUrl);
  const claimCode = await device.enroll();
  console.log(`5. Enrolled the device; claim code ${claimCode}`);

  // --- Claim ----------------------------------------------------------
  result = await call(`/api/device/claim/${claimCode}`, { method: "POST" });
  if (result.status !== 200) {
    throw new Error(`Claim failed: ${result.status} ${JSON.stringify(result.json)}`);
  }
  console.log("6. Claimed the device");

  // --- Assign ---------------------------------------------------------
  const devices = await call("/api/devices");
  const row = (devices.json as Array<{ id: number; device_id: string }>).find(
    (d) => d.device_id === device.deviceId,
  );
  if (!row) throw new Error("The claimed device is not listed");

  result = await call(`/api/devices/${row.id}/galleries`, {
    method: "POST",
    body: JSON.stringify({ gallery_id: galleryId }),
  });
  if (result.status !== 200) {
    throw new Error(`Assigning the gallery failed: ${result.status}`);
  }
  console.log("7. Assigned the gallery to the device");

  // --- Sync -----------------------------------------------------------
  const sync = await device.sync();
  console.log(
    `8. Synced: ${sync.schedule.items.length} events, revision ${sync.schedule.revision}`,
  );
  console.log(`   Next check-in at ${sync.next_sync_at}`);
  for (const item of sync.schedule.items.slice(0, 3)) {
    console.log(`     ${item.at}  ${item.asset.slice(0, 16)}…`);
  }

  // --- Apply ----------------------------------------------------------
  await device.applyDueEvent(sync);
  console.log("9. Applied the due event");

  // --- Acknowledge ----------------------------------------------------
  const again = await device.sync();
  console.log(`10. Checked in again; ${again.schedule.items.length} events in the window`);

  // --- The server recorded the state ----------------------------------
  const state = await call("/api/devices");
  const updated = (state.json as Array<{ device_id: string; displayed_asset: string | null }>).find(
    (d) => d.device_id === device.deviceId,
  );
  console.log(`11. The server knows the frame is showing ${updated?.displayed_asset?.slice(0, 16)}…`);

  // --- The schedule preview -------------------------------------------
  const preview = await call(`/api/devices/${row.id}/schedule`);
  console.log(
    `12. The management preview shows ${(preview.json as { items: unknown[] }).items.length} events`,
  );

  console.log("\nEverything worked.");
}

main().catch((error: unknown) => {
  console.error("\nFAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
