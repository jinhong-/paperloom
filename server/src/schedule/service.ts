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
import {
  localDayAndMinute,
  resolveInterval,
  type SyncRule,
} from "./rules.js";

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
   * Discard a device's materialised schedule windows.
   *
   * A window is materialised once and then reused, so that a device that
   * retries a sync is given the same schedule it was given the first
   * time. That reuse is only correct while the inputs are unchanged.
   *
   * When the galleries assigned to a device change, or when its policy
   * changes, the stored windows no longer describe what the device should
   * be shown, so they are discarded and rebuilt on the next sync.
   */
  invalidate(deviceId: number): void {
    this.db.prepare("DELETE FROM schedules WHERE device_id = ?").run(deviceId);
  }

  /**
   * Get the schedule for a device covering the window that contains `now`.
   *
   * The window is aligned to the lookahead, so that successive windows
   * tile the timeline without gaps or overlaps, and so that a plan is
   * stable for the whole of the period it covers.
   *
   * Aligning it to the check-in interval instead would mean a new window,
   * and so a new set of times and photos, every time the device checked
   * in. The device would be told one thing and then another, and the
   * plan it was following would never be the plan it was given.
   */
  getForDevice(deviceId: number, now: number): ScheduleWindow {
    const device = this.db
      .prepare("SELECT id, displayed_asset, timezone FROM devices WHERE id = ?")
      .get(deviceId) as
      | { id: number; displayed_asset: string | null; timezone: string }
      | undefined;
    if (!device) throw new Error(`unknown device ${deviceId}`);

    const policy = this.policyFor(deviceId);
    const windowStart = this.alignWindowStart(now, policy.lookahead);
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
      now: Date.now(),
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
  private alignWindowStart(now: number, lookahead: number): number {
    const interval = Math.max(1, lookahead) * 1000;
    return Math.floor(now / interval) * interval;
  }

  /**
   * The check-in rules for a device.
   */
  rulesFor(deviceId: number): SyncRule[] {
    const rows = this.db
      .prepare(
        `SELECT id, days, start_minute, end_minute, sync_interval, priority
         FROM device_sync_rules WHERE device_id = ?
         ORDER BY priority, id`,
      )
      .all(deviceId) as Array<{
      id: number;
      days: number;
      start_minute: number;
      end_minute: number;
      sync_interval: number;
      priority: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      days: r.days,
      startMinute: r.start_minute,
      endMinute: r.end_minute,
      syncInterval: r.sync_interval,
      priority: r.priority,
    }));
  }

  /**
   * The check-in interval that applies at a given moment.
   *
   * This is the device's own interval unless one of its rules covers the
   * moment, in which case the rule's interval applies.
   */
  intervalAt(deviceId: number, at: number): number | null {
    const policy = this.policyFor(deviceId);
    const { day, minute } = localDayAndMinute(at, policy.timezone);
    return resolveInterval(this.rulesFor(deviceId), day, minute);
  }

  /**
   * When the frame should next check in.
   *
   * This is the moment the next rule begins, or the next check-in if a
   * rule already covers now.
   *
   * A frame with no rule covering the present has nothing to check in
   * for, so it is told to come back when a rule starts rather than being
   * left to guess.
   */
  nextCheckIn(deviceId: number, at: number): number {
    const policy = this.policyFor(deviceId);
    const rules = this.rulesFor(deviceId);
    const { day, minute } = localDayAndMinute(at, policy.timezone);

    const interval = resolveInterval(rules, day, minute);
    if (interval !== null) {
      return at + interval * 1000;
    }

    /* No rule covers now. Find the next moment one does. */
    const next = this.nextRuleStart(rules, day, minute, policy.timezone);
    return next ?? at + 60 * 60 * 1000;
  }

  /**
   * The next moment a rule covers, or null if none ever does.
   *
   * The search looks a week ahead, which is enough because a rule names
   * the days of the week it applies to.
   */
  private nextRuleStart(
    rules: readonly SyncRule[],
    day: number,
    minute: number,
    timezone: string,
  ): number | null {
    if (rules.length === 0) return null;

    /* The current minute, in the frame's own zone, is what the rules are
     * written against. The minute of the day it is now is not needed here;
     * only the clock matters. */
    const base = new Date();
    base.setSeconds(0, 0);

    for (let ahead = 0; ahead < 8 * 24 * 60; ahead++) {
      const moment = new Date(base.getTime() + ahead * 60 * 1000);
      const { day: d, minute: m } = localDayAndMinute(moment.getTime(), timezone);
      if (resolveInterval(rules, d, m) !== null) {
        return moment.getTime();
      }
    }

    return null;
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
   *
   * A frame that is mounted with the picture turned needs a different
   * rendering of each photo, so the asset is looked up for the frame's
   * own rotation. A photo that has not been rendered at that rotation yet
   * falls back to its upright rendering.
   */
  private candidatesFor(deviceId: number): Candidate[] {
    const rotation = this.rotationFor(deviceId);

    const rows = this.db
      .prepare(
        `SELECT p.id, COALESCE(pa.content_hash, p.content_hash) AS content_hash,
                p.weight, p.gallery_id
         FROM photos p
         JOIN galleries g ON g.id = p.gallery_id
         JOIN device_galleries dg ON dg.gallery_id = p.gallery_id
         LEFT JOIN photo_assets pa ON pa.photo_id = p.id AND pa.rotation = ?
         WHERE dg.device_id = ?
           AND g.enabled = 1
           AND COALESCE(pa.content_hash, p.content_hash) IS NOT NULL
         ORDER BY p.id`,
      )
      .all(rotation, deviceId) as Array<{
      id: number;
      content_hash: string | null;
      weight: number;
      gallery_id: number;
    }>;

    return rows.map((r) => ({
      photoId: r.id,
      contentHash: r.content_hash!,
      weight: r.weight,
      belongsTo: r.gallery_id,
    }));
  }

  /**
   * How far the picture is turned on a frame.
   */
  rotationFor(deviceId: number): number {
    const row = this.db
      .prepare("SELECT rotation FROM devices WHERE id = ?")
      .get(deviceId) as { rotation: number } | undefined;
    return row?.rotation ?? 0;
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
