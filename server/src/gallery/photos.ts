/**
 * Photo ingestion.
 *
 * Adding a photo to a gallery is the same job whoever asks for it: the
 * management UI uploading a file, or the Telegram bot receiving a picture
 * in a chat. This module is that job, in one place, so that the two
 * callers cannot drift apart.
 *
 * The work is:
 *
 *   1. Keep the original, so the gallery can show the photo as it was
 *      uploaded rather than only the panel's six-colour rendering of it.
 *   2. Render the photo for each way a frame might be mounted.
 *   3. Record the photo and its renderings.
 *   4. Discard the materialised schedules of the devices that show the
 *      gallery, because a new photo changes what they can be shown.
 */

import { AssetStore } from "../assets/store.js";
import type { Db } from "../db/index.js";
import { PANEL_HEIGHT, PANEL_WIDTH, ROTATIONS } from "../panel.js";
import type { ScheduleService } from "../schedule/service.js";
import type { PinnedPhotoService } from "./pinned.js";

export interface GalleryPhotoServiceOptions {
  readonly db: Db;
  readonly assets: AssetStore;
  readonly schedules: ScheduleService;
  /**
   * The pins, when photos are to be pinned to a frame's next check-in.
   *
   * It is optional so that the service can be built without it, which is
   * what the tests that do not care about pinning do.
   */
  readonly pins?: PinnedPhotoService;
}

/** The result of adding a photo to a gallery. */
export interface AddedPhoto {
  /** The row id of the new photo. */
  readonly id: number;
  /** The name the photo is known by. */
  readonly filename: string;
  /** The hash of the uploaded bytes. */
  readonly sourceHash: string;
  /** The hash of the upright rendering, which is the photo's asset identity. */
  readonly contentHash: string;
  /** The size of the upright rendering, in bytes. */
  readonly byteSize: number;
  /**
   * The frames the photo was pinned to, if it was pinned.
   *
   * A pinned photo is shown at the next check-in of each frame showing
   * the gallery, rather than waiting for its turn in the rotation.
   */
  readonly pinnedTo?: readonly { readonly deviceId: number; readonly at: number }[];
}

export class GalleryPhotoService {
  constructor(private readonly options: GalleryPhotoServiceOptions) {}

  /**
   * The name a photo is given when the caller does not supply one.
   */
  static defaultFilename(sourceHash: string): string {
    return `${sourceHash.slice(0, 12)}.jpg`;
  }

  /**
   * Add a photo to a gallery and render it for every rotation.
   *
   * The rendering happens here rather than on the device so that the
   * device never has to do image work, and so that the asset hash is
   * known before the device asks for it.
   *
   * @param pin when true, the photo is pinned to the next check-in of
   *            every frame showing the gallery, so that it is shown on
   *            the next wake rather than waiting for its turn.
   */
  async addPhoto(
    galleryId: number,
    filename: string | undefined,
    source: Buffer,
    options: { readonly pin?: boolean } = {},
  ): Promise<AddedPhoto> {
    const { db, assets } = this.options;

    const sourceHash = AssetStore.hash(source);
    const name = filename ?? GalleryPhotoService.defaultFilename(sourceHash);

    /* Keep the original so the gallery can show the photo the owner
     * uploaded, rather than only the panel's rendering of it. */
    await assets.putSource(sourceHash, source);

    const { renderAsset } = await import("../image.js");

    /* Render the photo for each way a frame might be mounted.
     *
     * A frame that is turned needs the photo rendered at the turned
     * dimensions and then turned back, which is a different picture and
     * so a different asset. Rendering them all now means a frame can be
     * turned later without waiting for the photo to be rendered again. */
    const renderedByRotation = new Map<number, { hash: string; size: number }>();
    for (const rotation of ROTATIONS) {
      const rendered = await renderAsset(source, { rotation });
      const hash = AssetStore.hash(rendered.data);
      await assets.put(hash, rendered.data, PANEL_WIDTH, PANEL_HEIGHT);
      renderedByRotation.set(rotation, { hash, size: rendered.data.length });
    }

    const upright = renderedByRotation.get(0)!;

    const result = db
      .prepare(
        `INSERT INTO photos
           (gallery_id, filename, source_hash, content_hash, width, height, byte_size, weight)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1.0)`,
      )
      .run(
        galleryId,
        name,
        sourceHash,
        upright.hash,
        PANEL_WIDTH,
        PANEL_HEIGHT,
        upright.size,
      );

    const photoId = Number(result.lastInsertRowid);

    /* Record the other renderings, so a frame that is turned can be told
     * about the right asset. */
    const insertAsset = db.prepare(
      "INSERT OR REPLACE INTO photo_assets (photo_id, rotation, content_hash) VALUES (?, ?, ?)",
    );
    for (const [rotation, rendered] of renderedByRotation) {
      insertAsset.run(photoId, rotation, rendered.hash);
    }

    /* A new photo changes what the gallery can show, so the plans of the
     * devices that show it are to change. They change at the frame's next
     * check-in, so that the frame and the server keep working to the same
     * plan until then. */
    this.invalidateGallery(galleryId, Date.now());

    /* The photo is pinned to the next check-in of each frame showing the
     * gallery, so that it is shown on the next wake rather than at some
     * arbitrary point in the rotation. */
    let pinnedTo: AddedPhoto["pinnedTo"];
    if (options.pin && this.options.pins) {
      const pins = this.options.pins.pinForGallery(galleryId, photoId, Date.now());
      pinnedTo = pins.map((pin) => ({ deviceId: pin.device_id, at: pin.at }));

      /* The plan has to include the pin, and it has to include it now: the
       * frame's next wake is the moment the picture is pinned to, so
       * there is no later check-in to wait for.
       *
       * The plan is extended rather than handed over, so that the times
       * already in it do not move. */
      for (const pin of pins) {
        this.options.schedules.addPinnedEvent(pin.device_id, pin.at, pin.photo_id);
      }
    }

    return {
      id: photoId,
      filename: name,
      sourceHash,
      contentHash: upright.hash,
      byteSize: upright.size,
      pinnedTo,
    };
  }

  /**
   * Discard the materialised schedules of every device that shows a
   * gallery.
   *
   * A gallery's contents and policy decide what its devices are shown and
   * when, so a change to the gallery makes their plans out of date.
   *
   * The plan is not thrown away. It is handed over at the frame's next
   * check-in, so that the frame and the server are working to the same
   * plan until then.
   */
  invalidateGallery(galleryId: number, now: number): void {
    const { db, schedules } = this.options;
    const devices = db
      .prepare("SELECT device_id FROM device_galleries WHERE gallery_id = ?")
      .all(galleryId) as Array<{ device_id: number }>;
    for (const device of devices) {
      schedules.invalidate(device.device_id, now);
    }
  }
}
