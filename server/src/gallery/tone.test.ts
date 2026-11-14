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
        `INSERT INTO galleries (user_id, name, rotation_mode, min_interval, max_interval)
         VALUES (?, 'Gallery', 'random', 900, 900)`,
      )
      .run(user.id).lastInsertRowid,
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

    /* The rendering that was replaced is gone, and the new one is there. */
    assert.equal(await world.assets.get(added.contentHash), null);
    assert.ok(await world.assets.get(after.content_hash));
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
