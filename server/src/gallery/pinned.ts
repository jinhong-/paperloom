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
        `SELECT d.id, d.name FROM devices d
         JOIN device_galleries dg ON dg.device_id = d.id
         WHERE dg.gallery_id = ?
         ORDER BY d.id`,
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
   * Pin a picture to the next check-in of every frame showing a gallery.
   *
   * Returns the pins that were made, so that the caller can say how many
   * frames the picture is going to appear on.
   */
  pinForGallery(galleryId: number, photoId: number, now: number): PinnedPhoto[] {
    const { db } = this.options;
    const pins: PinnedPhoto[] = [];

    for (const frame of this.framesFor(galleryId)) {
      const at = this.nextSyncFor(frame.id, now);

      /* A frame holds one picture at a time, so a new one replaces
       * whatever was pinned before. */
      db.prepare("DELETE FROM pinned_photos WHERE device_id = ?").run(frame.id);

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
