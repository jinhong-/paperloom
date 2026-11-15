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
import type { GalleryRule } from "./galleryRules.js";
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
   * Note that a device's plan is to change.
   *
   * A plan is not thrown away when the gallery it shows changes. The frame
   * is following a plan, and it has to be given the same plan until it is
   * ready to take a new one. Throwing the plan away leaves the frame and
   * the server out of step: the frame carries on with a plan the server
   * no longer has, and when it does check in it is given a plan with
   * different times, so pictures are skipped or shown twice.
   *
   * The plan changes at the frame's next check-in, which is the moment the
   * frame is certain to be in touch. Until then the frame is given the
   * plan it is already following.
   */
  invalidate(deviceId: number, now: number): void {
    const handoverAt = this.nextCheckIn(deviceId, now);
    this.db
      .prepare(
        `UPDATE schedules
         SET handover_at = COALESCE(handover_at, ?)
         WHERE device_id = ?`,
      )
      .run(handoverAt, deviceId);
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
    if (current) {
      /* The plan is handed over when the moment for it has arrived. Until
       * then the frame is given the plan it is already following, so that
       * the two are always working to the same plan.
       *
       * A plan that is due to be handed over is rebuilt from scratch,
       * because the gallery it shows has changed and the old plan no
       * longer says what should be shown. */
      const handoverDue = current.handoverAt !== null && current.handoverAt <= now;

      /* A plan with nothing in it is not worth keeping. A frame that has
       * been given its first gallery would otherwise show nothing until its
       * next check-in, which is up to an hour overnight. */
      const empty = current.items.length === 0;

      if (!handoverDue && !empty && current.windowEnd >= nextCheckIn) {
        return { revision: current.revision, items: current.items };
      }

      if (handoverDue || empty) {
        /* The gallery changed and the frame has now come back for it, so
         * the plan is built afresh from this moment. */
        return this.buildPlanForDevice(deviceId, now, nextCheckIn, span, policy, device);
      }
    }

    /* The plan does not reach far enough, so it is extended. The events
     * already in it keep their times, and the new ones follow on. */
    return this.extendPlanForDevice(deviceId, current, now, nextCheckIn, span, policy, device);
  }

  /**
  /**
   * Add a pinned picture to a frame's plan.
   *
   * The picture has to reach the frame now, because the frame's next wake
   * is the moment it is pinned to: there is no later check-in to wait for.
   *
   * The plan is extended rather than handed over, so that the times
   * already in it do not move. The picture is put in at its own moment,
   * and the plan reaches far enough to cover it.
   */
  addPinnedEvent(deviceId: number, at: number, photoId: number): void {
    const device = this.db
      .prepare("SELECT id, displayed_asset, timezone FROM devices WHERE id = ?")
      .get(deviceId) as
      | { id: number; displayed_asset: string | null; timezone: string }
      | undefined;
    if (!device) return;

    const policy = this.policyFor(deviceId);
    const span = this.coverageSpan(deviceId, policy);
    const now = Date.now();
    const nextCheckIn = this.nextCheckIn(deviceId, now);
    const current = this.currentPlan(deviceId);

    /* The plan has to reach the moment the picture is pinned to. */
    const windowEnd = Math.max(
      current?.windowEnd ?? 0,
      at + 1000,
      nextCheckIn + span * 1000,
    );

    this.extendPlanForDevice(
      deviceId,
      current,
      now,
      nextCheckIn,
      span,
      policy,
      device,
      true,
      windowEnd,
    );
  }

  /**
   * The plan a frame is following, and what it will become.
   *
   * The plan the frame is following now is what it is actually working to.
   * When the gallery has changed, the plan is handed over at the frame's
   * next check-in, and the projected plan is what it will be then.
   *
   * The two are shown together, so that the owner can see what a change
   * is going to do before it happens, and so that it is clear that the
   * frame is still working to the old one.
   */
  planWithProjection(deviceId: number, now: number): {
    current: ScheduleWindow;
    projected: ScheduleWindow | null;
    handoverAt: number | null;
  } {
    const device = this.db
      .prepare("SELECT id, displayed_asset, timezone FROM devices WHERE id = ?")
      .get(deviceId) as
      | { id: number; displayed_asset: string | null; timezone: string }
      | undefined;
    if (!device) throw new Error(`unknown device ${deviceId}`);

    const current = this.currentPlan(deviceId);
    if (!current) {
      const built = this.getForDevice(deviceId, now);
      return { current: built, projected: null, handoverAt: null };
    }

    if (current.handoverAt === null) {
      return {
        current: { revision: current.revision, items: current.items },
        projected: null,
        handoverAt: null,
      };
    }

    /* The plan is to change. The projected plan is what it will be when
     * it does, worked out as though the frame were checking in at that
     * moment. */
    const policy = this.policyFor(deviceId);
    const span = this.coverageSpan(deviceId, policy);
    const handoverAt = current.handoverAt;
    const projectedNextCheckIn = this.nextCheckIn(deviceId, handoverAt);

    const projected = this.extendPlanForDevice(
      deviceId,
      null,
      handoverAt,
      projectedNextCheckIn,
      span,
      policy,
      device,
      /* The projected plan is only worked out, not kept. */
      false,
    );

    return {
      current: { revision: current.revision, items: current.items },
      projected: { revision: projected.revision, items: projected.items },
      handoverAt,
    };
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
    handoverAt: number | null;
    items: DisplayEvent[];
  } | null {
    const row = this.db
      .prepare(
        `SELECT revision, window_start, window_end, handover_at, events_json
         FROM schedules
         WHERE device_id = ?
         ORDER BY window_start DESC
         LIMIT 1`,
      )
      .get(deviceId) as
      | {
          revision: string;
          window_start: string;
          window_end: string;
          handover_at: number | null;
          events_json: string;
        }
      | undefined;

    if (!row) return null;

    const windowStart = Date.parse(row.window_start);
    const windowEnd = Date.parse(row.window_end);
    if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) return null;

    return {
      revision: row.revision,
      windowStart,
      windowEnd,
      handoverAt: row.handover_at,
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
   * Build a plan for a device from scratch.
   *
   * This is used when the gallery has changed and the frame has come back
   * for it. The old plan said what should be shown before the change, and
   * the frame has been working to it, so the new plan starts afresh from
   * the moment the frame is in touch.
   */
  private buildPlanForDevice(
    deviceId: number,
    now: number,
    nextCheckIn: number,
    span: number,
    policy: DevicePolicy,
    device: { displayed_asset: string | null; timezone: string },
  ): ScheduleWindow {
    return this.extendPlanForDevice(deviceId, null, now, nextCheckIn, span, policy, device);
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
      handoverAt: number | null;
      items: DisplayEvent[];
    } | null,
    now: number,
    nextCheckIn: number,
    span: number,
    policy: DevicePolicy,
    device: { displayed_asset: string | null; timezone: string },
    keep = true,
    windowEndOverride?: number,
  ): ScheduleWindow {
    const galleries = this.galleriesFor(deviceId);
    const candidates = this.candidatesFor(deviceId);

    const lastPhotoId = device.displayed_asset
      ? this.photoIdForAsset(device.displayed_asset)
      : undefined;

    /* The plan starts where it started before, so that the times in it do
     * not move. A frame that has no plan yet starts now, so that it has a
     * picture to show at once.
     *
     * The start is on the minute, because the times in the plan are. The
     * first event is at the start, so it is at the minute the plan began
     * rather than at some point during it. */
    const windowStart = current ? current.windowStart : Math.floor(now / 60_000) * 60_000;

    /* How far the plan has to reach.
     *
     * The plan has to cover the frame's next check-in, because that is
     * when the frame wakes and asks for more. A plan that stops short of
     * it would leave the frame with nothing to show.
     *
     * It has to reach the lookahead beyond that as well, so that a
     * check-in that fails does not leave the frame with nothing to show.
     * The two are therefore added: a frame that checks in every five
     * minutes and plans three hours ahead needs a plan that reaches three
     * hours and five minutes, so that it is still showing something three
     * hours after the check-in it is waiting for.
     *
     * The plan is never shortened. A plan that already reaches further is
     * left as it is, so that the times in it do not move. */
    const windowEnd = Math.max(
      current?.windowEnd ?? 0,
      nextCheckIn + span * 1000,
      windowEndOverride ?? 0,
    );

    /* A picture that arrived from a chat is pinned to this frame's next
     * check-in, so that it is shown on the next wake rather than waiting
     * for its turn in the rotation.
     *
     * The plan reaches the frame's next check-in, so the pin falls inside
     * it and is part of the plan. */
    const pinned = this.pinnedFor(deviceId);

    const items = materializeSchedule({
      deviceId: String(deviceId),
      windowStart,
      windowEnd,
      existing: current?.items,
      candidates,
      galleries,
      policy: {
        ...policy,
        timezone: device.timezone || policy.timezone,
      },
      currentAsset: device.displayed_asset ?? undefined,
      lastPhotoId,
      pinned,
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

    /* A plan that is only being worked out is not kept: it is a projection
     * of what the plan will be, and keeping it would throw away the plan
     * the frame is following. */
    if (!keep) {
      return { revision, items: live };
    }

    /* There is one plan for each frame, and it is replaced by the plan
     * that has just been extended. The events in it keep their times: the
     * new ones are added after the old ones.
     *
     * A plan that is waiting to be handed over keeps waiting. The change
     * to the gallery has not reached the frame yet, so the plan that is
     * being built is still the one the frame is following, and it is still
     * to be handed over at the moment that was set. */
    const handoverAt = current?.handoverAt ?? null;

    this.db
      .prepare(
        `DELETE FROM schedules WHERE device_id = ?`,
      )
      .run(deviceId);

    this.db
      .prepare(
        `INSERT INTO schedules (device_id, revision, window_start, window_end, events_json, handover_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        deviceId,
        revision,
        new Date(windowStart).toISOString(),
        new Date(windowEnd).toISOString(),
        JSON.stringify(live),
        handoverAt,
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
    const rotation = this.rotationFor(deviceId);

    const rows = this.db
      .prepare(
        `SELECT g.id, g.schedule_enabled,
                COALESCE(mp.content_hash, pa.content_hash) AS manual_asset
         FROM galleries g
         JOIN devices d ON d.gallery_id = g.id
         LEFT JOIN gallery_manual_pictures mp ON mp.gallery_id = g.id
         LEFT JOIN photos p ON p.id = mp.photo_id
         LEFT JOIN photo_assets pa ON pa.photo_id = mp.photo_id AND pa.rotation = ?
         WHERE d.id = ? AND g.enabled = 1
         ORDER BY g.id`,
      )
      .all(rotation, deviceId) as Array<{
      id: number;
      schedule_enabled: number;
      manual_asset: string | null;
    }>;

    return rows.map((r) => ({
      galleryId: r.id,
      rules: this.galleryRulesFor(r.id),
      scheduleEnabled: r.schedule_enabled === 1,
      manualAsset: r.manual_asset,
    }));
  }

  /**
   * The rules that say when a gallery changes its picture.
   */
  galleryRulesFor(galleryId: number): GalleryRule[] {
    const rows = this.db
      .prepare(
        `SELECT id, days, start_minute, end_minute, min_interval, max_interval,
                priority, rotation_mode
         FROM gallery_schedule_rules WHERE gallery_id = ?
         ORDER BY priority, id`,
      )
      .all(galleryId) as Array<{
      id: number;
      days: number;
      start_minute: number;
      end_minute: number;
      min_interval: number | null;
      max_interval: number | null;
      priority: number;
      rotation_mode: "random" | "sequential";
    }>;

    return rows.map((r) => ({
      id: r.id,
      days: r.days,
      startMinute: r.start_minute,
      endMinute: r.end_minute,
      minInterval: r.min_interval,
      maxInterval: r.max_interval,
      priority: r.priority,
      rotationMode: r.rotation_mode,
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
         JOIN devices d ON d.gallery_id = p.gallery_id
         LEFT JOIN photo_assets pa ON pa.photo_id = p.id AND pa.rotation = ?
         WHERE d.id = ?
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
   * The picture pinned to a frame, and the moment it is to be shown.
   *
   * The asset is looked up for the frame's own rotation, as it is for
   * every other picture, so that a turned frame shows the pinned picture
   * the right way up.
   */
  private pinnedFor(deviceId: number): Array<{ at: number; contentHash: string }> {
    const rotation = this.rotationFor(deviceId);

    const rows = this.db
      .prepare(
        `SELECT pp.at, COALESCE(pa.content_hash, p.content_hash) AS content_hash
         FROM pinned_photos pp
         JOIN photos p ON p.id = pp.photo_id
         LEFT JOIN photo_assets pa ON pa.photo_id = pp.photo_id AND pa.rotation = ?
         WHERE pp.device_id = ? AND pp.shown = 0
         ORDER BY pp.at`,
      )
      .all(rotation, deviceId) as Array<{ at: number; content_hash: string | null }>;

    const pins: Array<{ at: number; contentHash: string }> = [];
    for (const row of rows) {
      if (row.content_hash) {
        pins.push({ at: row.at, contentHash: row.content_hash });
      }
    }
    return pins;
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
