/**
 * Put back an asset that a frame's plan still names.
 *
 * A rendering is removed when it is replaced, so that the storage does
 * not fill up with renderings nobody will ask for. A rendering that a
 * frame's plan still names has to be kept, because the frame will ask for
 * it until the plan is handed over.
 *
 * This tool puts one back when it has been removed by mistake. The photo
 * it belongs to is rendered again, and the bytes are stored under the
 * hash the plan names.
 *
 * Usage:
 *   npx tsx src/tools/recover-asset.ts <hash>
 */

import { readFileSync, existsSync } from "node:fs";
import Database from "better-sqlite3";

import { AssetStore } from "../assets/store.js";
import { PANEL_HEIGHT, PANEL_WIDTH, isRotation } from "../panel.js";
import { renderAsset } from "../image.js";

const wanted = process.argv[2];
if (!wanted) {
  console.error("Usage: npx tsx src/tools/recover-asset.ts <hash>");
  process.exit(2);
}

const db = new Database("data/paperloom.db");
const assets = new AssetStore(db, "data/assets", "data/sources");

const row = db
  .prepare("SELECT photo_id, rotation FROM photo_assets WHERE content_hash = ?")
  .get(wanted) as { photo_id: number; rotation: number } | undefined;

if (!row) {
  console.error(`No picture has a rendering called ${wanted}`);
  process.exit(1);
}

const photo = db
  .prepare("SELECT filename, source_hash FROM photos WHERE id = ?")
  .get(row.photo_id) as { filename: string; source_hash: string };

const sourcePath = assets.sourcePathFor(photo.source_hash);
if (!existsSync(sourcePath)) {
  console.error(`The original of ${photo.filename} is missing`);
  process.exit(1);
}

if (!isRotation(row.rotation)) {
  console.error(`The rendering is at ${row.rotation}°, which is not a way a frame is mounted`);
  process.exit(1);
}

const rendered = await renderAsset(readFileSync(sourcePath), { rotation: row.rotation });
const hash = AssetStore.hash(rendered.data);

if (hash !== wanted) {
  console.error(
    `The picture renders to ${hash}, which is not the asset wanted.\n` +
      `The plan asks for ${wanted}.`,
  );
  process.exit(1);
}

await assets.put(hash, rendered.data, PANEL_WIDTH, PANEL_HEIGHT);
console.log(`Put back ${wanted} for ${photo.filename} at ${row.rotation}°`);

db.close();
