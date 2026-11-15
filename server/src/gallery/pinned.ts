/**
 * Pinned photos.
 *
 * A picture sent from Telegram is not left to wait for its turn in the
 * rotation. It is pinned to the next check-in of each frame that shows
 * its gallery, so that it appears on the frame's next wake.
 *
 * The moment a picture is pinned to is the frame's next check-in, as the
 * server works it out from the frame's policy and rules. That is the
 * moment the frame is certain to be in touch, and it is the same moment
 * the frame is told about at every check-in.
 *
 * A frame holds one pinned picture at a time. A newer picture replaces
 * the older one, which is what somebody sending a second photograph
 * expects.
 */

import type { Db } from "../db/index.js";
import type { ScheduleService } from "../schedule/service.js";

/** How long a pin is kept before it is considered stale. */
const PIN_TTL_MS = 24 * 60 * 60 * 1000;

export interface PinnedPhoto {
  readonly id: number;
  readonly device_id: number;
  readonly photo_id: number;
  readonly at: number;
  readonly shown: boolean;
}

export interface PinOptions {
  readonly db: Db;
  readonly schedules: ScheduleService;
}

/** The frames that show a gallery. */
export interface Frame {
  readonly id: number;
  readonly name: string;
}

export class PinnedPhotoService {
  constructor(private readonly options: PinOptions) {}

  /**
   * The frames that show a gallery.
   */
  framesFor(galleryId: number): Frame[] {
    const rows = this.options.db
      .prepare(
        `SELECT id, name FROM devices
         WHERE gallery_id = ?
         ORDER BY id`,
      )
      .all(galleryId) as Array<{ id: number; name: string }>;
    return rows;
  }

  /**
   * When a frame expects to check in next.
   *
   * The server works this out from the frame's own policy and the rules
   * that say when it should check in, and it is the same answer the
   * frame is given at every check-in.
   *
   * A frame wakes for two reasons: a picture is due, or it is time to
   * check in. The pin goes on the check-in, because that is the moment
   * the frame is certain to be in touch and pick up something new.
   */
  nextSyncFor(deviceId: number, now: number): number {
    return this.options.schedules.nextCheckIn(deviceId, now);
  }

  /**
   * Pin a picture that the owner has asked for by hand.
   *
   * The picture is shown at the next moment the frame wakes, which is
   * whichever comes first of a picture being due and a check-in. The
   * owner is looking at the frame and has said what they want to see, so
   * it is shown at the first chance rather than at the next check-in,
   * which may be an hour away.
   *
   * A picture that is already waiting is replaced, because the owner is
   * looking at the frame now and this is the picture they want.
   */
  pinForOwner(deviceId: number, photoId: number, now: number): PinnedPhoto {
    const { db } = this.options;

    /* The picture that is waiting is replaced. */
    const waiting = db
      .prepare(
        `SELECT id, at FROM pinned_photos
         WHERE device_id = ? AND shown = 0
         ORDER BY at ASC LIMIT 1`,
      )
      .get(deviceId) as { id: number; at: number } | undefined;

    if (waiting !== undefined) {
      db.prepare("DELETE FROM pinned_photos WHERE device_id = ? AND shown = 0").run(deviceId);
    }

    const at = this.options.schedules.nextWake(deviceId, now);

    const result = db
      .prepare("INSERT INTO pinned_photos (device_id, photo_id, at) VALUES (?, ?, ?)")
      .run(deviceId, photoId, at);

    return {
      id: Number(result.lastInsertRowid),
      device_id: deviceId,
      photo_id: photoId,
      at,
      shown: false,
    };
  }

  /**
   * Pin a picture to a frame.
   *
   * There are two ways the pictures can arrive.
   *
   * In the queue mode the pictures are a queue. Each one takes the place
   * after the last in the queue, and is shown at the check-in after that,
   * so that the pictures arrive in the order they were sent rather than
   * replacing one another.
   *
   * In the latest mode a picture replaces the one that is waiting. A
   * gallery that changes once a day has no use for a queue of pictures:
   * only the last one sent is of any interest, and the ones before it
   * would only be shown long after they had been sent.
   *
   * The mode belongs to the gallery, because it is about the pictures.
   *
   * @return the pins that were made, so that the caller can say how many
   *         frames the picture is going to appear on.
   */
  pinForGallery(galleryId: number, photoId: number, now: number): PinnedPhoto[] {
    const { db } = this.options;
    const pins: PinnedPhoto[] = [];
    const mode = this.modeFor(galleryId);

    for (const frame of this.framesFor(galleryId)) {
      let at: number;

      if (mode === "latest") {
        /* The picture that is waiting is replaced, and the new one takes
         * its place. The frame is shown the new picture at the check-in
         * the old one was waiting for, so that the picture changes as
         * soon as the frame is next in touch. */
        const waiting = db
          .prepare(
            `SELECT at FROM pinned_photos
             WHERE device_id = ? AND shown = 0
             ORDER BY at ASC LIMIT 1`,
          )
          .get(frame.id) as { at: number } | undefined;

        if (waiting !== undefined) {
          db.prepare("DELETE FROM pinned_photos WHERE device_id = ? AND shown = 0").run(frame.id);
          at = waiting.at;
        } else {
          at = this.nextSyncAfter(frame.id, now);
        }
      } else {
        /* The moment this picture is for is the check-in after the last
         * one already in the queue, so that the pictures come out in
         * order. */
        const last = db
          .prepare(
            `SELECT at FROM pinned_photos
             WHERE device_id = ? AND shown = 0
             ORDER BY at DESC LIMIT 1`,
          )
          .get(frame.id) as { at: number } | undefined;

        const from = last !== undefined ? last.at : now;
        at = this.nextSyncAfter(frame.id, from);
      }

      const result = db
        .prepare(
          `INSERT INTO pinned_photos (device_id, photo_id, at) VALUES (?, ?, ?)`,
        )
        .run(frame.id, photoId, at);

      pins.push({
        id: Number(result.lastInsertRowid),
        device_id: frame.id,
        photo_id: photoId,
        at,
        shown: false,
      });
    }

    return pins;
  }

  /**
   * How the pictures of a gallery arrive.
   *
   * The queue is the default, because it is what a gallery that is sent
   * pictures one after another wants.
   */
  private modeFor(galleryId: number): "queue" | "latest" {
    const row = this.options.db
      .prepare("SELECT telegram_mode FROM galleries WHERE id = ?")
      .get(galleryId) as { telegram_mode: string | null } | undefined;

    return row?.telegram_mode === "latest" ? "latest" : "queue";
  }

  /**
   * The next check-in at or after a moment.
   *
   * The check-in is worked out from the frame's own policy and rules. The
   * moment asked about is the last moment in the queue, so that the next
   * picture is shown at the check-in after it.
   */
  private nextSyncAfter(deviceId: number, from: number): number {
    const next = this.options.schedules.nextCheckIn(deviceId, from);
    /* The check-in may be the very moment asked about, which would put
     * two pictures in the same instant. It is moved on by a second so
     * that they are separate. */
    return next <= from ? from + 1000 : next;
  }

  /**
   * The pins for a frame that are due at or before a moment.
   *
   * These are the pictures the frame is to be shown.
   */
  dueFor(deviceId: number, at: number): PinnedPhoto[] {
    const rows = this.options.db
      .prepare(
        `SELECT id, device_id, photo_id, at, shown FROM pinned_photos
         WHERE device_id = ? AND at <= ? AND shown = 0
         ORDER BY at`,
      )
      .all(deviceId, at) as Array<{
      id: number;
      device_id: number;
      photo_id: number;
      at: number;
      shown: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      device_id: row.device_id,
      photo_id: row.photo_id,
      at: row.at,
      shown: row.shown === 1,
    }));
  }

  /**
   * The pins for a frame that are waiting to be shown, in order.
   *
   * These are the pictures the frame is about to be shown.
   */
  pendingFor(deviceId: number): PinnedPhoto[] {
    const rows = this.options.db
      .prepare(
        `SELECT id, device_id, photo_id, at, shown FROM pinned_photos
         WHERE device_id = ? AND shown = 0
         ORDER BY at`,
      )
      .all(deviceId) as Array<{
      id: number;
      device_id: number;
      photo_id: number;
      at: number;
      shown: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      device_id: row.device_id,
      photo_id: row.photo_id,
      at: row.at,
      shown: row.shown === 1,
    }));
  }

  /**
   * The pin for a frame, if it has one.
   */
  pinFor(deviceId: number): PinnedPhoto | undefined {
    const row = this.options.db
      .prepare(
        `SELECT id, device_id, photo_id, at, shown FROM pinned_photos
         WHERE device_id = ? ORDER BY at LIMIT 1`,
      )
      .get(deviceId) as
      | { id: number; device_id: number; photo_id: number; at: number; shown: number }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      device_id: row.device_id,
      photo_id: row.photo_id,
      at: row.at,
      shown: row.shown === 1,
    };
  }

  /**
   * Mark a pin as shown, so that it is not shown again.
   */
  markShown(pinId: number): void {
    this.options.db
      .prepare(
        "UPDATE pinned_photos SET shown = 1, updated_at = datetime('now') WHERE id = ?",
      )
      .run(pinId);
  }

  /**
   * Remove the pins that can no longer be shown.
   *
   * A pin whose moment has long passed will never be shown, because the
   * frame has already woken and gone back to sleep. Such a pin is
   * dropped, so that it does not sit in the table for ever.
   */
  clearStale(now: number): void {
    this.options.db
      .prepare("DELETE FROM pinned_photos WHERE at < ?")
      .run(now - PIN_TTL_MS);
  }

  /**
   * Remove every pin for a picture.
   *
   * Used when the picture is deleted, so that a frame is not left
   * waiting for a picture that is no longer there.
   */
  clearForPhoto(photoId: number): void {
    this.options.db.prepare("DELETE FROM pinned_photos WHERE photo_id = ?").run(photoId);
  }
}
