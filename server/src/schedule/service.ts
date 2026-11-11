/**
 * Schedule service.
 *
 * Owns the lifecycle of a materialised schedule window: building it from
 * gallery policy, persisting it, and returning it to a device.
 *
 * The key invariant is that a device asking twice for the same window gets
 * the same schedule. We achieve that by persisting the materialised window
 * and, when a request falls inside an already-materialised window, serving
 * the stored copy rather than regenerating.
 */

import { createHash } from "node:crypto";

import type { AssetStore } from "../assets/store.js";
import type { Db } from "../db/index.js";
import {
  materializeSchedule,
  type Candidate,
  type DevicePolicy,
  type DisplayEvent,
  type GalleryPolicy,
} from "./materialize.js";

/** A schedule window as handed to a device. */
export interface ScheduleWindow {
  /** Identity of this window; the device echoes it back to acknowledge. */
  readonly revision: string;
  readonly items: readonly DisplayEvent[];
}

export class ScheduleService {
  constructor(
    private readonly db: Db,
    private readonly assets: AssetStore,
  ) {}

  /**
   * Get the schedule for a device covering the window that contains `now`.
   *
   * The window is aligned to the device's sync interval so that successive
   * windows tile the timeline without gaps or overlaps.
   */
  getForDevice(deviceId: number, now: number): ScheduleWindow {
    const device = this.db
      .prepare("SELECT id, displayed_asset, timezone FROM devices WHERE id = ?")
      .get(deviceId) as
      | { id: number; displayed_asset: string | null; timezone: string }
      | undefined;
    if (!device) throw new Error(`unknown device ${deviceId}`);

    const policy = this.policyFor(deviceId);
    const windowStart = this.alignWindowStart(now, policy.syncInterval);
    const windowEnd = windowStart + policy.lookahead * 1000;

    // Serve a previously materialised window if one exists.
    const stored = this.db
      .prepare(
        `SELECT revision, events_json FROM schedules
         WHERE device_id = ? AND window_start = ? AND window_end = ?
         LIMIT 1`,
      )
      .get(deviceId, new Date(windowStart).toISOString(), new Date(windowEnd).toISOString()) as
      | { revision: string; events_json: string }
      | undefined;

    if (stored) {
      return { revision: stored.revision, items: JSON.parse(stored.events_json) as DisplayEvent[] };
    }

    return this.materializeForDevice(deviceId, windowStart, windowEnd, policy, device);
  }

  /**
   * Build and persist the schedule window for a device.
   */
  private materializeForDevice(
    deviceId: number,
    windowStart: number,
    windowEnd: number,
    policy: DevicePolicy,
    device: { displayed_asset: string | null; timezone: string },
  ): ScheduleWindow {
    const galleries = this.galleriesFor(deviceId);
    const candidates = this.candidatesFor(deviceId);

    const lastPhotoId = device.displayed_asset
      ? this.photoIdForAsset(device.displayed_asset)
      : undefined;

    const items = materializeSchedule({
      deviceId: String(deviceId),
      windowStart,
      candidates,
      galleries,
      policy: { ...policy, timezone: device.timezone || policy.timezone },
      currentAsset: device.displayed_asset ?? undefined,
      lastPhotoId,
    });

    const revision = this.computeRevision(deviceId, windowStart, items);

    this.db
      .prepare(
        `INSERT INTO schedules (device_id, revision, window_start, window_end, events_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        deviceId,
        revision,
        new Date(windowStart).toISOString(),
        new Date(windowEnd).toISOString(),
        JSON.stringify(items),
      );

    return { revision, items };
  }

  /**
   * The content hash identifying a schedule window.
   *
   * The revision is derived from the schedule's contents, so an unchanged
   * window keeps its identity and a changed one gets a new one. It is
   * independent of wall-clock time, which is what lets a device that
   * retries a sync recognise that it already has this schedule.
   */
  private computeRevision(
    deviceId: number,
    windowStart: number,
    items: readonly DisplayEvent[],
  ): string {
    const hash = createHash("sha256");
    hash.update(String(deviceId));
    hash.update(":");
    hash.update(String(windowStart));
    for (const item of items) {
      hash.update(":");
      hash.update(String(item.at));
      hash.update(":");
      hash.update(item.asset);
    }
    return `sha256:${hash.digest("hex").slice(0, 32)}`;
  }

  /**
   * Align a timestamp to the start of its sync window.
   */
  private alignWindowStart(now: number, syncInterval: number): number {
    const interval = Math.max(1, syncInterval) * 1000;
    return Math.floor(now / interval) * interval;
  }

  /**
   * The scheduling policy for a device.
   */
  policyFor(deviceId: number): DevicePolicy {
    const row = this.db
      .prepare(
        `SELECT sync_interval, lookahead, quiet_start, quiet_end, timezone
         FROM device_policies WHERE device_id = ?`,
      )
      .get(deviceId) as
      | {
          sync_interval: number;
          lookahead: number;
          quiet_start: number | null;
          quiet_end: number | null;
          timezone: string;
        }
      | undefined;

    if (!row) {
      return { syncInterval: 3600, lookahead: 10800, quietStart: null, quietEnd: null, timezone: "UTC" };
    }

    return {
      syncInterval: row.sync_interval,
      lookahead: row.lookahead,
      quietStart: row.quiet_start,
      quietEnd: row.quiet_end,
      timezone: row.timezone,
    };
  }

  /**
   * The galleries assigned to a device, with their policy.
   */
  private galleriesFor(deviceId: number): GalleryPolicy[] {
    const rows = this.db
      .prepare(
        `SELECT g.id, g.rotation_mode, g.min_interval, g.max_interval
         FROM galleries g
         JOIN device_galleries dg ON dg.gallery_id = g.id
         WHERE dg.device_id = ? AND g.enabled = 1
         ORDER BY g.id`,
      )
      .all(deviceId) as Array<{
      id: number;
      rotation_mode: "random" | "sequential";
      min_interval: number;
      max_interval: number;
    }>;

    return rows.map((r) => ({
      galleryId: r.id,
      rotationMode: r.rotation_mode,
      minInterval: r.min_interval,
      maxInterval: r.max_interval,
    }));
  }

  /**
   * The photos eligible for scheduling, grouped by gallery.
   */
  private candidatesFor(deviceId: number): Candidate[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.content_hash, p.weight, p.gallery_id
         FROM photos p
         JOIN galleries g ON g.id = p.gallery_id
         JOIN device_galleries dg ON dg.gallery_id = p.gallery_id
         WHERE dg.device_id = ?
           AND g.enabled = 1
           AND p.content_hash IS NOT NULL
         ORDER BY p.id`,
      )
      .all(deviceId) as Array<{
      id: number;
      content_hash: string;
      weight: number;
      gallery_id: number;
    }>;

    return rows.map((r) => ({
      photoId: r.id,
      contentHash: r.content_hash,
      weight: r.weight,
      belongsTo: r.gallery_id,
    }));
  }

  /**
   * Find the photo id that produced a given asset hash.
   */
  private photoIdForAsset(contentHash: string): number | undefined {
    const row = this.db
      .prepare("SELECT id FROM photos WHERE content_hash = ? LIMIT 1")
      .get(contentHash) as { id: number } | undefined;
    return row?.id;
  }
}
