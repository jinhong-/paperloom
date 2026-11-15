/**
 * Asset storage.
 *
 * Rendered assets are content-addressed by the SHA-256 of their bytes. The
 * database holds the metadata; the bytes live on disk under a sharded
 * directory so that a single directory never holds tens of thousands of
 * entries.
 *
 * The original upload is kept as well, under its own hash. The rendered
 * asset is what the frame shows, but the original is what the owner
 * recognises, and it is what the preview in the gallery shows.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Db } from "../db/index.js";

export interface AssetRecord {
  readonly contentHash: string;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Filesystem-backed asset store.
 */
export class AssetStore {
  constructor(
    private readonly db: Db,
    private readonly root: string,
    private readonly sourceRoot: string,
  ) {}

  /**
   * The on-disk path for an asset hash.
   *
   * Sharded as `ab/cd/abcdef...` to keep directory sizes reasonable.
   */
  pathFor(contentHash: string): string {
    const safe = contentHash.replace(/[^a-f0-9]/gi, "");
    return join(this.root, safe.slice(0, 2), safe.slice(2, 4), safe);
  }

  /**
   * The on-disk path for an original upload.
   */
  sourcePathFor(sourceHash: string): string {
    const safe = sourceHash.replace(/[^a-f0-9]/gi, "");
    return join(this.sourceRoot, safe.slice(0, 2), safe.slice(2, 4), safe);
  }

  /**
   * Store an asset, writing it atomically.
   *
   * The bytes are written to a temporary file and renamed into place, so a
   * crash mid-write never leaves a truncated asset that a device would
   * download and fail to verify.
   */
  async put(contentHash: string, data: Buffer, width: number, height: number): Promise<AssetRecord> {
    const target = this.pathFor(contentHash);
    await mkdir(dirname(target), { recursive: true });

    const existing = await stat(target).catch(() => null);
    if (existing === null) {
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, data);
      await rename(temp, target);
    }

    this.db
      .prepare(
        `INSERT INTO assets (content_hash, byte_size, width, height)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(content_hash) DO UPDATE SET byte_size = excluded.byte_size`,
      )
      .run(contentHash, data.length, width, height);

    return { contentHash, byteSize: data.length, width, height };
  }

  /**
   * Store an original upload.
   *
   * The file is named after the hash of its contents, so the same photo
   * uploaded twice is stored once.
   */
  async putSource(sourceHash: string, data: Buffer): Promise<void> {
    const target = this.sourcePathFor(sourceHash);
    await mkdir(dirname(target), { recursive: true });

    const existing = await stat(target).catch(() => null);
    if (existing !== null) return;

    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, data);
    await rename(temp, target);
  }

  /**
   * Read an asset's bytes.
   */
  async get(contentHash: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(contentHash));
    } catch {
      return null;
    }
  }

  /**
   * Read an original upload's bytes.
   */
  async getSource(sourceHash: string): Promise<Buffer | null> {
    try {
      return await readFile(this.sourcePathFor(sourceHash));
    } catch {
      return null;
    }
  }

  /**
   * Create a read stream for an asset, for range requests and large files.
   */
  createReadStream(contentHash: string) {
    return createReadStream(this.pathFor(contentHash));
  }

  /**
   * Whether an asset exists both in the database and on disk.
   */
  async has(contentHash: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT 1 FROM assets WHERE content_hash = ?")
      .get(contentHash);
    if (!row) return false;
    const info = await stat(this.pathFor(contentHash)).catch(() => null);
    return info !== null;
  }

  /**
   * Delete an asset that is no longer referenced.
   *
   * An asset is kept as long as anything names it: a photo, any way of
   * mounting a frame that shows it, or the picture a gallery shows while
   * it is off. The last of these matters because the frame is told about
   * it at a check-in, and a frame that cannot download it is left with
   * the picture it already had.
   *
   * Returns true if something was removed.
   */
  async remove(contentHash: string): Promise<boolean> {
    const referenced = this.db
      .prepare(
        `SELECT 1 FROM photos WHERE content_hash = ? LIMIT 1`,
      )
      .get(contentHash);
    if (referenced) return false;

    const inAFrame = this.db
      .prepare("SELECT 1 FROM photo_assets WHERE content_hash = ? LIMIT 1")
      .get(contentHash);
    if (inAFrame) return false;

    const isSetAside = this.db
      .prepare("SELECT 1 FROM gallery_manual_pictures WHERE content_hash = ? LIMIT 1")
      .get(contentHash);
    if (isSetAside) return false;

    await rm(this.pathFor(contentHash), { force: true });
    this.db.prepare("DELETE FROM assets WHERE content_hash = ?").run(contentHash);
    return true;
  }

  /**
   * Compute the content hash of some bytes.
   */
  static hash(data: Buffer): string {
    return createHash("sha256").update(data).digest("hex");
  }
}
