/**
 * Test of the way a gallery's pictures are prepared.
 *
 * The way of preparing a picture is the gallery's, not the picture's, so
 * changing it changes every picture in the gallery. The pictures are
 * rendered again from their originals, and the renderings that are
 * replaced are removed.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openDatabase, type Db } from "../db/index.js";
import { AssetStore } from "../assets/store.js";
import { ScheduleService } from "../schedule/service.js";
import { GalleryPhotoService } from "./photos.js";

/**
 * A small solid-colour PNG.
 */
async function image(r: number, g: number, b: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: { width: 64, height: 64, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
}

/**
 * A gallery with a frame and a picture service.
 */
async function makeWorld(): Promise<{
  db: Db;
  assets: AssetStore;
  photos: GalleryPhotoService;
  galleryId: number;
}> {
  const dir = mkdtempSync(join(tmpdir(), "paperloom-tone-"));
  const db = openDatabase({ path: join(dir, "paperloom.db") });

  const assets = new AssetStore(db, join(dir, "assets"), join(dir, "sources"));
  const schedules = new ScheduleService(db, assets);
  const photos = new GalleryPhotoService({ db, assets, schedules });

  db.prepare("INSERT INTO users (username, password_hash) VALUES ('u', 'x')").run();
  const user = db.prepare("SELECT id FROM users WHERE username = 'u'").get() as { id: number };

  const galleryId = Number(
    db
      .prepare(
        `INSERT INTO galleries (user_id, name) VALUES (?, \'Gallery\')`,
      )
      .run(user.id).lastInsertRowid,
  );

  /* The rules say how often the gallery changes and how the pictures are
   * picked, so a gallery needs one to change at all. */
  db.prepare(
    `INSERT INTO gallery_schedule_rules
       (gallery_id, days, start_minute, end_minute, min_interval, max_interval, rotation_mode)
     VALUES (?, 127, 0, 1440, 900, 900, 'random')`,
  ).run(galleryId);

  /* A frame, so that a plan can be made for it. */
  db.prepare("INSERT INTO devices (user_id, name, device_id) VALUES (?, 'Frame', 'dev-1')").run(
    user.id,
  );

  return { db, assets, photos, galleryId };
}

describe("the way a gallery's pictures are prepared", () => {
  it("renders the pictures again when the way changes", async () => {
    const world = await makeWorld();

    const added = await world.photos.addPhoto(
      world.galleryId,
      "one.png",
      await image(220, 30, 30),
    );
    assert.ok(added.contentHash);

    /* The rendering is the one the gallery's own way produced. */
    const before = world.db
      .prepare("SELECT content_hash FROM photos WHERE id = ?")
      .get(added.id) as { content_hash: string };
    assert.equal(before.content_hash, added.contentHash);

    /* Changing the way of preparing the pictures changes the rendering. */
    world.db
      .prepare("UPDATE galleries SET tone_preset = 'grayscale' WHERE id = ?")
      .run(world.galleryId);

    const rendered = await world.photos.rerenderGallery(world.galleryId);
    assert.equal(rendered, 1);

    const after = world.db
      .prepare("SELECT content_hash FROM photos WHERE id = ?")
      .get(added.id) as { content_hash: string };
    assert.notEqual(after.content_hash, added.contentHash);

    /* The new rendering is there. */
    assert.ok(await world.assets.get(after.content_hash));
  });

  it("keeps a rendering that a frame's plan still names", async () => {
    const world = await makeWorld();

    const added = await world.photos.addPhoto(
      world.galleryId,
      "one.png",
      await image(220, 30, 30),
    );

    /* A frame is working to a plan that names the rendering. The plan is
     * not rebuilt until the frame checks in, and until then the frame
     * will ask for the asset the plan names. */
    world.db
      .prepare(
        `INSERT INTO schedules (device_id, revision, window_start, window_end, events_json)
         VALUES ((SELECT id FROM devices WHERE device_id = 'dev-1'), 'rev-1',
                 '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', ?)`,
      )
      .run(JSON.stringify([{ at: 1767225600000, asset: added.contentHash }]));

    world.db
      .prepare("UPDATE galleries SET tone_preset = 'grayscale' WHERE id = ?")
      .run(world.galleryId);

    await world.photos.rerenderGallery(world.galleryId);

    /* The rendering the plan names is still there to be downloaded. */
    assert.ok(
      await world.assets.get(added.contentHash),
      "a rendering a plan names must not be removed",
    );
  });

  it("removes a rendering that nothing refers to", async () => {
    const world = await makeWorld();

    const added = await world.photos.addPhoto(
      world.galleryId,
      "one.png",
      await image(220, 30, 30),
    );

    world.db
      .prepare("UPDATE galleries SET tone_preset = 'grayscale' WHERE id = ?")
      .run(world.galleryId);

    await world.photos.rerenderGallery(world.galleryId);

    assert.equal(
      await world.assets.get(added.contentHash),
      null,
      "a rendering nothing refers to is removed",
    );
  });

  it("keeps the original, so the picture can be rendered again", async () => {
    const world = await makeWorld();

    const added = await world.photos.addPhoto(
      world.galleryId,
      "one.png",
      await image(30, 220, 30),
    );

    const original = await world.assets.getSource(added.sourceHash);
    assert.ok(original, "the original must be kept");
  });

  it("does nothing for a gallery with no pictures", async () => {
    const world = await makeWorld();
    assert.equal(await world.photos.rerenderGallery(world.galleryId), 0);
  });

  it("renders the same bytes when the way has not changed", async () => {
    const world = await makeWorld();

    const added = await world.photos.addPhoto(
      world.galleryId,
      "one.png",
      await image(30, 30, 220),
    );

    await world.photos.rerenderGallery(world.galleryId);

    const after = world.db
      .prepare("SELECT content_hash FROM photos WHERE id = ?")
      .get(added.id) as { content_hash: string };
    assert.equal(after.content_hash, added.contentHash);
  });
});
