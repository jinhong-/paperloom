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

/**
 * How much of the past a stored plan keeps.
 *
 * The plan grows as it is extended, and the events that have long since
 * passed are of no use: the frame knows from its own memory which of them
 * it has already shown. A little of the recent past is kept so that the
 * frame has the event it is about to show even if its clock is a little
 * behind the server's.
 */
const PLAN_PAST_MS = 30 * 60 * 1000;

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
   * Get the schedule for a device.
   *
   * There is one plan for each frame, and it grows. The events in it keep
   * their times and their photos, and new ones are added after them. The
   * plan the frame is following and the plan shown in the management page
   * are therefore the same plan, and neither changes while the frame is
   * following it.
   *
   * The plan reaches far enough to cover the frame's next check-in, and a
   * good deal further than that, so that it does not have to be extended on
   * every single check-in. The span also covers the frame's longest sleep:
   * a frame that checks in every five minutes during the day and sleeps
   * from ten at night until eight in the morning must be given a plan that
   * reaches through the night, or it wakes in the small hours with nothing
   * to show. See `coverageSpan`.
   */
  getForDevice(deviceId: number, now: number): ScheduleWindow {
    const device = this.db
      .prepare("SELECT id, displayed_asset, timezone FROM devices WHERE id = ?")
      .get(deviceId) as
      | { id: number; displayed_asset: string | null; timezone: string }
      | undefined;
    if (!device) throw new Error(`unknown device ${deviceId}`);

    const policy = this.policyFor(deviceId);
    /* The plan is stored, and the stored plan is the plan.
     *
     * There is one plan for each frame, and it grows. The events in it
     * keep their times and their photos, and new ones are added after
     * them. The frame is told which plan it is holding, and that plan is
     * the one it is given.
     *
     * This is what makes the schedule stable. The times and the photos in
     * the plan do not change while the frame is following it, so the plan
     * the frame is following is the plan it was given, and the times shown
     * in the management page are the times the frame shows the pictures
     * at.
     *
     * The plan has to reach past the frame's next check-in, because that
     * is when the frame wakes and asks for more. When the plan does not
     * reach that far, it is extended, and the events that are added carry
     * on from where it left off.
     *
     * The plan is therefore extended rarely: a frame that checks in every
     * five minutes and plans three hours ahead has a plan that reaches
     * three hours ahead, so the plan only has to be extended when it has
     * run nearly all the way out.
     *
     * A frame that has no plan yet is given one that starts now, so that
     * it has a picture to show at once. The frame only shows the events
     * whose time has arrived, so a plan that starts now is shown at once.
     */
    const span = this.coverageSpan(deviceId, policy);
    const nextCheckIn = this.nextCheckIn(deviceId, now);

    const current = this.currentPlan(deviceId);
    if (current && current.windowEnd >= nextCheckIn) {
      return { revision: current.revision, items: current.items };
    }

    /* The plan does not reach far enough, so it is extended. The events
     * already in it keep their times, and the new ones follow on. */
    return this.extendPlanForDevice(deviceId, current, now, nextCheckIn, span, policy, device);
  }

  /**
   * The plan a frame is currently following, if it has one.
   *
   * There is one plan for each frame. The frame is told which plan it is
   * holding, and that plan is the one it is given, so that the times and
   * the photos in it do not change while the frame is following it.
   */
  private currentPlan(deviceId: number): {
    revision: string;
    windowStart: number;
    windowEnd: number;
    items: DisplayEvent[];
  } | null {
    const row = this.db
      .prepare(
        `SELECT revision, window_start, window_end, events_json
         FROM schedules
         WHERE device_id = ?
         ORDER BY window_start DESC
         LIMIT 1`,
      )
      .get(deviceId) as
      | { revision: string; window_start: string; window_end: string; events_json: string }
      | undefined;

    if (!row) return null;

    const windowStart = Date.parse(row.window_start);
    const windowEnd = Date.parse(row.window_end);
    if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) return null;

    return {
      revision: row.revision,
      windowStart,
      windowEnd,
      items: JSON.parse(row.events_json) as DisplayEvent[],
    };
  }

  /**
   * How far ahead the plan has to reach, in seconds.
   *
   * The plan must cover the frame until it next checks in, because that is
   * the moment it wakes and asks for a new plan. If the plan stops short
   * of that, the frame wakes to find that its schedule has run out and it
   * has nothing to show.
   *
   * The frame's longest sleep is the longest stretch that no rule covers,
   * because a frame with nothing to check in for sleeps until a rule
   * covers the time again. The rules repeat every week, so the longest
   * such stretch is found by looking at a week.
   *
   * The span is a property of the rules and the policy, and not of the
   * moment the schedule is asked for. That matters: a schedule must be the
   * same every time it is asked for within its window, so that a device
   * that retries a sync is given the schedule it was given the first time.
   */
  private coverageSpan(deviceId: number, policy: DevicePolicy): number {
    const rules = this.rulesFor(deviceId);
    const lookahead = policy.lookahead;

    /* With no rules there is nothing to plan for at all, and the frame
     * never checks in. The lookahead on its own is as far as the plan can
     * usefully reach. */
    if (rules.length === 0) return lookahead;

    /* The longest stretch that no rule covers, in seconds.
     *
     * The rules repeat every week, so a week of minutes is enough to see
     * every gap, including the one that runs over the end of the week. */
    const minutesInWeek = 7 * 24 * 60;
    let longestGap = 0;
    let gapStart = -1;

    for (let minute = 0; minute < minutesInWeek; minute++) {
      const day = Math.floor(minute / (24 * 60)) % 7;
      const minuteOfDay = minute % (24 * 60);

      if (resolveInterval(rules, day, minuteOfDay) === null) {
        if (gapStart < 0) gapStart = minute;
      } else if (gapStart >= 0) {
        longestGap = Math.max(longestGap, minute - gapStart);
        gapStart = -1;
      }
    }
    if (gapStart >= 0) {
      longestGap = Math.max(longestGap, minutesInWeek - gapStart);
    }

    /* The frame wakes at the start of the next rule, and then asks for a
     * window of its own. The plan has to reach through that whole window,
     * or the frame wakes to a plan that has already run out. */
    const span = longestGap * 60 + lookahead;

    /* A plan longer than a week is of no use: the rules repeat every week,
     * so there is nothing new to plan beyond that, and the device would
     * have to hold far more than it can. */
    return Math.min(span, minutesInWeek * 60);
  }

  /**
   * Build and persist the schedule window for a device.
   */
  private extendPlanForDevice(
    deviceId: number,
    current: {
      revision: string;
      windowStart: number;
      windowEnd: number;
      items: DisplayEvent[];
    } | null,
    now: number,
    nextCheckIn: number,
    span: number,
    policy: DevicePolicy,
    device: { displayed_asset: string | null; timezone: string },
  ): ScheduleWindow {
    const galleries = this.galleriesFor(deviceId);
    const candidates = this.candidatesFor(deviceId);

    const lastPhotoId = device.displayed_asset
      ? this.photoIdForAsset(device.displayed_asset)
      : undefined;

    /* The plan starts where it started before, so that the times in it do
     * not move. A frame that has no plan yet starts now, so that it has a
     * picture to show at once. */
    const windowStart = current ? current.windowStart : now;

    /* How far the plan has to reach.
     *
     * The lookahead is how far ahead the plan is planned, and it is what
     * the plan is for. The plan also has to reach the frame's next
     * check-in, because that is when the frame wakes and asks for more;
     * a plan that stops short of it would leave the frame with nothing to
     * show.
     *
     * The two are separate things and are not added together. A frame that
     * checks in every five minutes and plans three hours ahead needs a
     * plan that reaches three hours ahead, not three hours and five
     * minutes: the check-in is when the frame asks, not how far the plan
     * reaches.
     *
     * The plan is never shortened. A plan that already reaches further is
     * left as it is, so that the times in it do not move. */
    const lookaheadEnd = now + span * 1000;
    const windowEnd = Math.max(
      current?.windowEnd ?? 0,
      lookaheadEnd,
      nextCheckIn,
    );

    const items = materializeSchedule({
      deviceId: String(deviceId),
      windowStart,
      windowEnd,
      existing: current?.items,
      candidates,
      galleries,
      policy: { ...policy, timezone: device.timezone || policy.timezone },
      currentAsset: device.displayed_asset ?? undefined,
      lastPhotoId,
    });

    /* The events that have long since passed are dropped.
     *
     * The plan grows as it is extended, and without this it would grow for
     * ever. The events that are gone are the ones the frame has already
     * shown: the frame keeps the time of the last one it showed in its
     * own memory, and uses that to know what it has already done, so it
     * does not need them here.
     *
     * A little of the recent past is kept, so that the frame has the
     * event it is about to show even if its clock is a little behind. */
    const keepFrom = now - PLAN_PAST_MS;
    const live = items.filter((item) => item.at > keepFrom);

    const revision = this.computeRevision(deviceId, windowStart, live);

    /* There is one plan for each frame, and it is replaced by the plan
     * that has just been extended. The events in it keep their times: the
     * new ones are added after the old ones. */
    this.db
      .prepare(
        `DELETE FROM schedules WHERE device_id = ?`,
      )
      .run(deviceId);

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
        JSON.stringify(live),
      );

    return { revision, items: live };
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
    const next = this.nextRuleStart(rules, at, day, minute, policy.timezone);
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
    at: number,
    day: number,
    minute: number,
    timezone: string,
  ): number | null {
    if (rules.length === 0) return null;

    /* The search starts at the moment asked about, rounded down to the
     * minute, so that the moment found is always ahead of it.
     *
     * It has to start from the moment asked about rather than from the
     * clock now, because the two are not the same: the moment asked
     * about is often a little ahead of the clock, and a rule that begins
     * between the two would be found in the past. */
    const base = new Date(Math.floor(at / 60_000) * 60_000);

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
