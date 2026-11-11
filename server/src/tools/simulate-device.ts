/**
 * A simulated device, used to exercise the server the way the firmware
 * does.
 *
 * This mirrors the firmware's behaviour closely enough to catch protocol
 * drift: the same canonical string, the same headers, the same hash
 * verification. If the firmware and this simulator disagree, the firmware
 * is the one that is wrong.
 *
 * Run it against a live server:
 *
 *     npx tsx src/tools/simulate-device.ts --server http://localhost:8080
 */

import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { canonicalString, publicKeyToBase64 } from "../auth/signing.js";
import { PANEL_HEIGHT, PANEL_WIDTH, RAW_FRAME_BYTES, unpackIndices } from "../panel.js";

interface SyncResponse {
  readonly server_time: string;
  readonly next_sync_at: string;
  readonly schedule: {
    readonly revision: string;
    readonly items: ReadonlyArray<{ readonly at: string; readonly asset: string }>;
  };
  readonly assets: Record<string, { readonly url: string; readonly sha256: string; readonly size: number }>;
}

/**
 * A simulated device.
 */
class SimulatedDevice {
  private readonly privateKey: string;
  private readonly publicKey: string;
  readonly deviceId: string;

  private cached = new Set<string>();
  private displayedAsset: string | null = null;

  constructor(private readonly serverUrl: string) {
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    this.publicKey = keys.publicKey.export({ type: "spki", format: "pem" }) as string;
    this.deviceId = `sim-${randomUUID().slice(0, 12)}`;
  }

  /**
   * Sign and send a request.
   */
  private async request(
    method: string,
    path: string,
    body: Buffer,
  ): Promise<{ status: number; body: Buffer; json: unknown }> {
    const timestamp = Date.now();
    const nonce = randomUUID();
    const canonical = canonicalString({
      method,
      path,
      timestamp,
      nonce,
      deviceId: this.deviceId,
      body,
    });

    const signature = sign("sha256", Buffer.from(canonical, "utf8"), {
      key: this.privateKey,
      dsaEncoding: "der",
    }).toString("base64url");

    const response = await fetch(`${this.serverUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-paperloom-device": this.deviceId,
        "x-paperloom-timestamp": String(timestamp),
        "x-paperloom-nonce": nonce,
        "x-paperloom-signature": signature,
      },
      body: method === "GET" ? undefined : body,
    });

    const bytes = Buffer.from(await response.arrayBuffer());
    let json: unknown;
    try {
      json = JSON.parse(bytes.toString("utf8"));
    } catch {
      json = undefined;
    }
    return { status: response.status, body: bytes, json };
  }

  /**
   * Open a pending enrollment and return the claim code.
   */
  async enroll(): Promise<string> {
    const response = await fetch(`${this.serverUrl}/api/device/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_id: this.deviceId,
        name: "Simulated frame",
        public_key: publicKeyToBase64(this.publicKey),
      }),
    });

    if (response.status !== 200) {
      throw new Error(`Enrollment failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as { claim_code: string };
    return body.claim_code;
  }

  /**
   * Perform a sync, downloading any missing assets.
   */
  async sync(): Promise<SyncResponse> {
    const body = Buffer.from(
      JSON.stringify({
        device_id: this.deviceId,
        displayed_asset: this.displayedAsset,
        cached_assets: [...this.cached],
        battery_mv: 3850,
        firmware_version: "sim-0.1.0",
        wake_reason: "timer",
      }),
    );

    const response = await this.request("POST", "/api/device/sync", body);
    if (response.status !== 200) {
      throw new Error(`Sync failed: ${response.status} ${response.body.toString()}`);
    }

    const sync = response.json as SyncResponse;

    for (const [hash, entry] of Object.entries(sync.assets)) {
      await this.download(hash, entry.url);
    }

    return sync;
  }

  /**
   * Download an asset and verify its hash and its contents.
   */
  async download(hash: string, url: string): Promise<void> {
    const response = await this.request("GET", url, Buffer.alloc(0));
    if (response.status !== 200) {
      throw new Error(`Asset download failed: ${response.status}`);
    }

    const computed = createHash("sha256").update(response.body).digest("hex");
    if (computed !== hash) {
      throw new Error(`Asset ${hash} failed its hash check`);
    }

    // The asset is a gzip of one 4bpp frame. Check that it really is.
    const inflated = gunzipSync(response.body);
    if (inflated.length !== RAW_FRAME_BYTES) {
      throw new Error(
        `Asset ${hash} inflated to ${inflated.length} bytes, expected ${RAW_FRAME_BYTES}`,
      );
    }

    const indices = unpackIndices(inflated);
    for (const index of indices) {
      if (index > 6 || index === 4) {
        throw new Error(`Asset ${hash} contains an invalid colour index ${index}`);
      }
    }

    this.cached.add(hash);
  }

  /**
   * Apply the first due event, as the firmware would.
   */
  async applyDueEvent(sync: SyncResponse): Promise<void> {
    const now = Date.now();
    const due = sync.schedule.items.find((item) => new Date(item.at).getTime() <= now);
    if (!due) return;

    if (!this.cached.has(due.asset)) {
      throw new Error(`The due asset ${due.asset} was not downloaded`);
    }

    this.displayedAsset = due.asset;
  }
}

/**
 * Run the simulation.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const serverIndex = args.indexOf("--server");
  const serverUrl =
    serverIndex >= 0 && args[serverIndex + 1]
      ? args[serverIndex + 1]!
      : (process.env.PAPERLOOM_URL ?? "http://127.0.0.1:8080");

  console.log(`Simulating a device against ${serverUrl}`);

  const device = new SimulatedDevice(serverUrl);

  const claimCode = await device.enroll();
  console.log(`Enrolled. Claim code: ${claimCode}`);
  console.log("Claim this device in the web UI, then re-run this script.");

  // The device cannot sync until it has been claimed.
  try {
    await device.sync();
    console.log("The device is already claimed; the sync succeeded.");
  } catch (error) {
    console.log(`The sync was refused, as expected: ${(error as Error).message}`);
  }
}

if (process.argv[1]?.endsWith("simulate-device.ts")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

export { SimulatedDevice };
